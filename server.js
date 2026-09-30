'use strict';
// Ma3loma Studio — سيرفر محلي من غير أي مكتبات خارجية (Node 18+).
// كل كلام Higgsfield بيعدّي من هنا بس، والمفتاح عمره ما بيطلع للمتصفح.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.0';
const ROOT = __dirname;
const PATHS = {
  env: path.join(ROOT, '.env'),
  data: path.join(ROOT, 'data'),
  jobs: path.join(ROOT, 'data', 'jobs.json'),
  log: path.join(ROOT, 'data', 'server.log'),
  ledger: path.join(ROOT, 'ledger.jsonl'),
  outputs: path.join(ROOT, 'outputs'),
  uploads: path.join(ROOT, 'uploads'),
  public: path.join(ROOT, 'public'),
  models: path.join(ROOT, 'models.json'),
};
const API_BASE = 'https://api.higgsfield.ai';
// الطلب بيتبعت لـ api، وHiggsfield بترجّع status_url و cancel_url على platform — الاتنين بتوعها
const API_ORIGINS = new Set(['https://api.higgsfield.ai', 'https://platform.higgsfield.ai']);
const HOST = '127.0.0.1';
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const UPLOAD_TYPES = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

for (const dir of [PATHS.data, PATHS.outputs, PATHS.uploads]) fs.mkdirSync(dir, { recursive: true });

const MODELS = JSON.parse(fs.readFileSync(PATHS.models, 'utf8')).models;

// ---------- helpers ----------

class UserError extends Error {}
class HfError extends Error {
  constructor(message, status, detail, correlationId) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.correlationId = correlationId;
  }
}

const nowIso = () => new Date().toISOString();
const localDay = (d = new Date()) => d.toLocaleDateString('en-CA');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => Math.round((n || 0) * 10000) / 10000;

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function clampNum(v, min, max, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function detailText(detail) {
  if (detail === undefined || detail === null) return '';
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

function log(...parts) {
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${parts.join(' ')}`;
  console.log(line);
  fs.appendFile(PATHS.log, line + '\n', () => {});
}

function folderName(s) {
  return String(s || 'general').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').slice(0, 60) || 'general';
}

function cleanProject(s) {
  return String(s || '').trim().slice(0, 60) || 'general';
}

// ---------- settings (.env) ----------

function readEnvFile() {
  const env = {};
  if (!fs.existsSync(PATHS.env)) return env;
  for (const line of fs.readFileSync(PATHS.env, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function loadConfig() {
  const env = readEnvFile();
  return {
    keyId: env.HF_KEY_ID || '',
    keySecret: env.HF_KEY_SECRET || '',
    port: clampInt(env.PORT, 1024, 65535, 4545),
    maxConcurrency: clampInt(env.MAX_CONCURRENCY, 1, 50, 4),
    dailyCapUsd: clampNum(env.DAILY_CAP_USD, 0.1, 1000, 5),
  };
}

let config = loadConfig();
const hasKey = () => Boolean(config.keyId && config.keySecret);

function settingsView() {
  return {
    hasKey: hasKey(),
    keyIdMasked: config.keyId ? config.keyId.slice(0, 4) + '••••' : '',
    maxConcurrency: config.maxConcurrency,
    dailyCapUsd: config.dailyCapUsd,
    port: config.port,
  };
}

function saveSettings(input) {
  const env = readEnvFile();
  const clean = (s) => String(s).replace(/[\r\n\s]/g, '');
  if (typeof input.keyId === 'string' && clean(input.keyId)) env.HF_KEY_ID = clean(input.keyId);
  if (typeof input.keySecret === 'string' && clean(input.keySecret)) env.HF_KEY_SECRET = clean(input.keySecret);
  if (input.maxConcurrency !== undefined) env.MAX_CONCURRENCY = String(clampInt(input.maxConcurrency, 1, 50, 4));
  if (input.dailyCapUsd !== undefined) env.DAILY_CAP_USD = String(clampNum(input.dailyCapUsd, 0.1, 1000, 5));
  if (!env.PORT) env.PORT = String(config.port);
  const order = ['PORT', 'MAX_CONCURRENCY', 'DAILY_CAP_USD', 'HF_KEY_ID', 'HF_KEY_SECRET'];
  const keys = [...order.filter((k) => k in env), ...Object.keys(env).filter((k) => !order.includes(k))];
  fs.writeFileSync(PATHS.env, keys.map((k) => `${k}=${env[k]}`).join('\n') + '\n', 'utf8');
  config = loadConfig();
  pump();
}

// ---------- Higgsfield client ----------

function arabicError(status, detail) {
  const map = {
    400: 'الطلب اترفض: فيه مدخلات مش مظبوطة.',
    401: 'المفتاح غلط أو ناقص — راجعه في الإعدادات.',
    403: 'الرصيد مش كفاية — اشحن من الكونسول.',
    404: 'الموديل أو الطلب مش موجود على حسابك.',
    422: 'فيه قيمة مش مقبولة في الطلب.',
    423: 'الموديل متوقف مؤقتاً — جرّب بعد شوية.',
    503: 'الموديل مش متاح دلوقتي — جرّب بعد شوية.',
  };
  let msg = map[status] || (status >= 500 ? 'خطأ من سيرفر Higgsfield — جرّب تاني.' : 'حصل خطأ غير متوقع من Higgsfield.');
  if (status === 400 && /concurren/i.test(detail)) msg = 'وصلت لحد الطلبات المتزامنة على حسابك — استنى طلب يخلص.';
  return `${msg} (HTTP ${status})`;
}

async function hf(method, target, body, timeoutMs = 60000) {
  if (!hasKey()) throw new UserError('اربط مفتاحك الأول من صفحة الإعدادات.');
  const url = target.startsWith('http') ? target : API_BASE + target;
  if (!API_ORIGINS.has(new URL(url).origin)) throw new UserError(`رابط برّه Higgsfield رجع من الـAPI (${new URL(url).host}) — مش هبعتله المفتاح.`);
  const headers = { Authorization: `Key ${config.keyId}:${config.keySecret}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new HfError('مش قادر أوصل لسيرفر Higgsfield — اتأكد من النت.', 0, timeout ? 'timeout' : String(e && e.message), '');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const correlationId = res.headers.get('x-correlation-id') || '';
  if (!res.ok) {
    const detail = detailText(json && json.detail !== undefined ? json.detail : text);
    throw new HfError(arabicError(res.status, detail), res.status, detail, correlationId);
  }
  return { json: json || {}, correlationId };
}

// ---------- request bodies from models.json ----------

function buildBody(modelId, params) {
  const model = MODELS[modelId];
  if (!model) throw new UserError('اختار موديل من القايمة.');
  params = params || {};
  const body = {};
  const missing = [];
  for (const [name, f] of Object.entries(model.fields)) {
    let v = params[name];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) missing.push(f.label || name);
      continue;
    }
    switch (f.kind) {
      case 'text':
        v = String(v).trim();
        if (!v) { if (f.required) missing.push(f.label || name); continue; }
        if (f.max && v.length > f.max) throw new UserError(`${f.label}: أطول من ${f.max} حرف.`);
        break;
      case 'select': {
        const opt = f.options.find((o) => String(o) === String(v));
        if (opt === undefined) throw new UserError(`${f.label}: القيمة «${v}» مش مسموحة للموديل ده.`);
        v = opt;
        break;
      }
      case 'range':
        v = parseInt(v, 10);
        if (!Number.isInteger(v) || v < f.min || v > f.max) throw new UserError(`${f.label}: لازم من ${f.min} لـ ${f.max}.`);
        break;
      case 'toggle':
        v = v === true || v === 'true' || v === 1 || v === '1';
        break;
      case 'image':
        v = String(v);
        if (!/^https:\/\//i.test(v)) throw new UserError(`${f.label}: لازم رابط https — ارفع الصورة من الموقع.`);
        break;
      case 'images':
        v = (Array.isArray(v) ? v : [v]).map(String).filter((u) => /^https:\/\//i.test(u));
        if (f.max) v = v.slice(0, f.max);
        if (!v.length) { if (f.required) missing.push(f.label || name); continue; }
        break;
      default:
        continue;
    }
    body[name] = v;
  }
  if (missing.length) throw new UserError('ناقص: ' + missing.join('، '));
  return body;
}

async function estimate(modelId, body) {
  const { json } = await hf('POST', '/estimate' + MODELS[modelId].endpoint, body, 30000);
  const usd = parseFloat(json.usd);
  const credits = parseFloat(json.credits);
  return { usd: Number.isFinite(usd) ? usd : null, credits: Number.isFinite(credits) ? credits : null };
}

// ---------- jobs + ledger ----------

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(PATHS.jobs, 'utf8')); } catch { return []; }
}

let jobs = loadJobs();
let saveTimer = null;

function saveJobs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveJobsNow, 150);
}

function saveJobsNow() {
  const tmp = PATHS.jobs + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs.slice(0, 2000), null, 1));
  fs.renameSync(tmp, PATHS.jobs);
}

const findJob = (id) => jobs.find((j) => j.id === id);

function appendLedger(job) {
  const entry = {
    time: nowIso(), day: localDay(), jobId: job.id, model: job.model, modelLabel: job.modelLabel, mode: job.mode,
    type: job.type, project: job.project, source: job.source, status: job.status,
    estimateUsd: job.estimateUsd, chargedUsd: job.chargedUsd || 0,
    requestId: job.requestId || null, correlationId: job.correlationId || null,
    params: job.params, files: (job.outputs || []).map((o) => o.file).filter(Boolean), error: job.error || null,
  };
  fs.appendFileSync(PATHS.ledger, JSON.stringify(entry) + '\n');
}

function readLedger() {
  try {
    return fs.readFileSync(PATHS.ledger, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function spentToday() {
  const d = localDay();
  return readLedger().filter((e) => e.day === d).reduce((s, e) => s + (e.chargedUsd || 0), 0);
}

// لسه ممكن يتحسب: أي طلب مخلصش (ومنهم اللي طوّل)
function pendingUsd() {
  return jobs.filter((j) => !TERMINAL.has(j.status) && j.status !== 'error').reduce((s, j) => s + (j.estimateUsd || 0), 0);
}

function ledgerView() {
  const entries = readLedger();
  const today = localDay();
  const month = today.slice(0, 7);
  const sum = (arr) => money(arr.reduce((s, e) => s + (e.chargedUsd || 0), 0));
  const group = (key) => {
    const g = {};
    for (const e of entries) {
      const k = e[key] || '—';
      g[k] = g[k] || { usd: 0, count: 0 };
      g[k].usd += e.chargedUsd || 0;
      g[k].count++;
    }
    return Object.entries(g).map(([name, v]) => ({ name, usd: money(v.usd), count: v.count })).sort((a, b) => b.usd - a.usd);
  };
  return {
    today: sum(entries.filter((e) => e.day === today)),
    month: sum(entries.filter((e) => (e.day || '').startsWith(month))),
    total: sum(entries),
    requests: entries.length,
    free: entries.filter((e) => !e.chargedUsd).length,
    pendingUsd: money(pendingUsd()),
    dailyCapUsd: config.dailyCapUsd,
    byModel: group('modelLabel'),
    byProject: group('project'),
    entries: entries.slice(-300).reverse(),
  };
}

// ---------- queue ----------

const waitQueue = [];
const polling = new Set();
let active = 0;

function enqueue(job) {
  waitQueue.push(job.id);
  pump();
}

function pump() {
  if (!hasKey()) return;
  while (active < config.maxConcurrency && waitQueue.length) {
    const job = findJob(waitQueue.shift());
    if (!job || job.status !== 'waiting') continue;
    active++;
    runJob(job).catch((e) => log('runJob crash:', e.stack || e.message)).finally(() => { active--; pump(); });
  }
}

async function createJob(input) {
  const model = MODELS[input.model];
  if (!model) throw new UserError('اختار موديل من القايمة.');
  const body = buildBody(input.model, input.params);
  const est = await estimate(input.model, body);
  const usd = est.usd || 0;
  const committed = spentToday() + pendingUsd();
  if (committed + usd > config.dailyCapUsd + 1e-9) {
    throw new UserError(`كده هتعدّي سقف الصرف اليومي ($${config.dailyCapUsd}). المصروف والمحجوز النهارده $${money(committed)}، والطلب ده $${money(usd)} — غيّر السقف من الإعدادات لو عاوز.`);
  }
  const job = {
    id: crypto.randomUUID(), model: input.model, modelLabel: model.label, mode: model.mode, type: model.type,
    project: cleanProject(input.project), source: String(input.source || 'web').slice(0, 20), label: String(input.label || '').slice(0, 120),
    params: body, estimateUsd: usd, estimateCredits: est.credits, status: 'waiting', createdAt: nowIso(),
  };
  jobs.unshift(job);
  saveJobs();
  log(`job ${job.id.slice(0, 8)} created: ${job.model} est=$${usd} project=${job.project} source=${job.source}`);
  enqueue(job);
  return job;
}

async function runJob(job) {
  const model = MODELS[job.model];
  job.status = 'submitting';
  saveJobs();
  try {
    const { json, correlationId } = await hf('POST', model.endpoint, job.params, 90000);
    Object.assign(job, {
      requestId: json.request_id, statusUrl: json.status_url, cancelUrl: json.cancel_url,
      correlationId, status: json.status || 'queued', submittedAt: nowIso(),
    });
    log(`POST ${model.endpoint} -> ${job.status} request_id=${job.requestId} correlation=${correlationId}`);
    saveJobs();
  } catch (e) {
    const ambiguous = e instanceof HfError && e.status === 0 && e.detail === 'timeout';
    failJob(job, ambiguous ? 'مفيش رد وقت الإرسال — بص على Analytics في الكونسول قبل ما تعيد.' : e.message, e);
    return;
  }
  if (!job.requestId || !job.statusUrl) {
    failJob(job, 'الرد مفيهوش request_id — مش هقدر أتابعه.', null);
    return;
  }
  await pollJob(job);
}

function failJob(job, message, err) {
  job.status = 'error';
  job.error = message;
  job.errorDetail = err && err.detail ? err.detail : '';
  job.httpStatus = err && err.status ? err.status : null;
  if (err && err.correlationId) job.correlationId = err.correlationId;
  job.chargedUsd = 0;
  job.finishedAt = nowIso();
  log(`job ${job.id.slice(0, 8)} error: ${job.httpStatus || ''} ${job.errorDetail || ''}`);
  saveJobs();
  appendLedger(job);
}

async function pollJob(job) {
  if (polling.has(job.id)) return;
  polling.add(job.id);
  try {
    const limitMs = (MODELS[job.model].type === 'video' ? 30 : 10) * 60 * 1000;
    const started = Date.now();
    let delay = 2000;
    for (;;) {
      await sleep(delay + Math.random() * 500);
      let st;
      try {
        st = (await hf('GET', job.statusUrl, undefined, 30000)).json;
      } catch (e) {
        if (e instanceof HfError && (e.status === 401 || e.status === 404)) { failJob(job, e.message, e); return; }
        if (e instanceof UserError) { job.pollError = e.message; saveJobs(); return; }
        job.pollError = e.message;
        saveJobs();
        delay = Math.min(delay * 1.5, 10000);
        if (Date.now() - started > limitMs) { markTimeout(job); return; }
        continue;
      }
      job.pollError = null;
      if (st.status && st.status !== job.status) {
        job.status = st.status;
        log(`${job.requestId.slice(0, 8)} -> ${st.status}`);
        saveJobs();
      }
      if (TERMINAL.has(st.status)) { await finalizeJob(job, st); return; }
      delay = Math.min(delay * 1.5, 10000);
      if (Date.now() - started > limitMs) { markTimeout(job); return; }
    }
  } finally {
    polling.delete(job.id);
  }
}

function markTimeout(job) {
  job.status = 'timeout';
  job.error = 'الطلب طوّل — دوس «تحديث» من المكتبة بعد شوية.';
  log(`job ${job.id.slice(0, 8)} timeout (request ${job.requestId})`);
  saveJobs();
}

async function finalizeJob(job, st) {
  job.finishedAt = nowIso();
  if (st.status === 'completed') {
    const urls = [];
    if (Array.isArray(st.images)) st.images.forEach((i) => i && i.url && urls.push({ url: i.url, kind: 'image' }));
    if (st.video && st.video.url) urls.push({ url: st.video.url, kind: 'video' });
    if (st.audio && st.audio.url) urls.push({ url: st.audio.url, kind: 'audio' });
    job.outputs = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        job.outputs.push({ ...urls[i], file: await downloadOutput(job, urls[i], i, urls.length) });
      } catch (e) {
        job.outputs.push({ ...urls[i], file: null, downloadError: e.message });
        log(`download failed for ${job.requestId}: ${e.message}`);
      }
    }
    job.chargedUsd = job.estimateUsd || 0;
    job.error = null;
  } else {
    job.chargedUsd = 0;
    job.error = st.status === 'nsfw' ? 'الفلتر رفض الطلب — ومتحسبش عليك.'
      : st.status === 'canceled' ? 'اتلغى — ومتحسبش عليك.'
      : 'التوليد فشل — ومتحسبش عليك.' + (st.error ? ` (${detailText(st.error)})` : '');
  }
  saveJobs();
  appendLedger(job);
}

function extFor(url, contentType, kind) {
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  if (/^\.(jpe?g|png|webp|gif|mp4|mov|webm|mp3|wav)$/.test(fromUrl)) return fromUrl === '.jpeg' ? '.jpg' : fromUrl;
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/wav': '.wav' };
  const base = String(contentType || '').split(';')[0].trim();
  return map[base] || (kind === 'video' ? '.mp4' : kind === 'audio' ? '.mp3' : '.jpg');
}

async function downloadOutput(job, output, index, count) {
  const res = await fetch(output.url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const folder = folderName(job.project);
  const dir = path.join(PATHS.outputs, folder);
  await fsp.mkdir(dir, { recursive: true });
  const name = `${localDay()}_${job.model}_${(job.requestId || job.id).slice(0, 8)}${count > 1 ? '_' + (index + 1) : ''}${extFor(output.url, res.headers.get('content-type'), output.kind)}`;
  await fsp.writeFile(path.join(dir, name), buf);
  return ['outputs', folder, name].join('/');
}

async function cancelJob(job) {
  if (job.status === 'waiting') {
    const i = waitQueue.indexOf(job.id);
    if (i >= 0) waitQueue.splice(i, 1);
    job.status = 'canceled';
    job.error = 'اتلغى قبل ما يتبعت — ومتحسبش عليك.';
    job.chargedUsd = 0;
    job.finishedAt = nowIso();
    saveJobs();
    appendLedger(job);
    return job;
  }
  if (job.status !== 'queued' || !job.cancelUrl) throw new UserError('ينفع تلغي بس الطلب اللي لسه مستني في الطابور.');
  try {
    await hf('POST', job.cancelUrl, undefined, 30000);
  } catch (e) {
    if (e instanceof HfError && e.status === 400) throw new UserError('التوليد بدأ خلاص — مينفعش يتلغي.');
    throw e;
  }
  job.cancelRequested = true;
  saveJobs();
  return job;
}

// عند التشغيل بس: اللي كان مستني يرجع للطابور، واللي اتقطع وهو بيتبعت يتعلّم عليه
function resumeOnStartup() {
  for (const job of jobs) {
    if (job.status === 'waiting' && !waitQueue.includes(job.id)) waitQueue.push(job.id);
    else if (job.status === 'submitting') failJob(job, 'السيرفر اتقفل وقت الإرسال — بص على Analytics قبل ما تعيد.', null);
  }
  resumePolling();
}

// أي طلب اتبعت ولسه مخلصش ومحدش بيتابعه — نتابعه
function resumePolling() {
  if (!hasKey()) return;
  for (const job of jobs) {
    if (['queued', 'in_progress', 'timeout'].includes(job.status) && job.statusUrl && !polling.has(job.id)) {
      pollJob(job).catch((e) => log('resume poll crash:', e.message));
    }
  }
  pump();
}

// ---------- uploads ----------

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new UserError('الملف أكبر من المسموح (20MB).'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new UserError('الـbody مش JSON سليم.'); }
}

async function handleUpload(req, res) {
  if (!hasKey()) throw new UserError('اربط مفتاحك الأول من صفحة الإعدادات.');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_TYPES[type];
  if (!ext) throw new UserError('الصورة لازم JPG أو PNG أو WEBP.');
  const buf = await readBody(req, MAX_UPLOAD_BYTES);
  if (!buf.length) throw new UserError('الملف فاضي.');
  const localName = `${localDay()}_${crypto.randomUUID().slice(0, 8)}${ext}`;
  await fsp.writeFile(path.join(PATHS.uploads, localName), buf);
  const contentType = type === 'image/jpg' ? 'image/jpeg' : type;
  const { json } = await hf('POST', '/files/generate-upload-url', { content_type: contentType });
  const put = await fetch(json.upload_url, {
    method: 'PUT', headers: json.upload_headers || { 'Content-Type': contentType }, body: buf, signal: AbortSignal.timeout(120000),
  });
  if (!put.ok) throw new HfError(`رفع الصورة لـ Higgsfield فشل (HTTP ${put.status}).`, 502, '', '');
  log(`upload ${localName} -> ${json.public_url}`);
  sendJson(res, 200, { publicUrl: json.public_url, localFile: 'uploads/' + localName });
}

// ---------- http ----------

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendError(res, status, message, detail, correlationId) {
  sendJson(res, status, { error: message, detail: detail || undefined, correlationId: correlationId || undefined });
}

async function serveFile(req, res, baseDir, rel) {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) return sendError(res, 403, 'Forbidden');
  let st;
  try { st = await fsp.stat(full); } catch { return sendError(res, 404, 'مش موجود'); }
  if (!st.isFile()) return sendError(res, 404, 'مش موجود');
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const cache = baseDir === PATHS.public ? 'no-cache' : 'max-age=86400';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start);
    if (start >= st.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': cache });
    fs.createReadStream(full, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cache });
  fs.createReadStream(full).pipe(res);
}

async function api(req, res, url, p) {
  const m = req.method;
  if (m === 'POST' && p !== '/api/upload' && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return sendError(res, 415, 'لازم Content-Type: application/json');
  }
  let mm;
  if (m === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, hasKey: hasKey(), active, waiting: waitQueue.length });
  }
  if (m === 'GET' && p === '/api/settings') return sendJson(res, 200, settingsView());
  if (m === 'POST' && p === '/api/settings') {
    const b = await readJson(req);
    saveSettings(b);
    log('settings saved' + (b.keyId || b.keySecret ? ' (key updated)' : ''));
    resumePolling();
    return sendJson(res, 200, settingsView());
  }
  if (m === 'POST' && p === '/api/settings/test') {
    const r = await estimate('soul-2', buildBody('soul-2', { prompt: 'connection test', resolution: '720p' }));
    return sendJson(res, 200, { ok: true, sampleUsd: r.usd, note: 'الاتصال شغال — ومتخصمش أي حاجة (ده تقدير بس).' });
  }
  if (m === 'GET' && p === '/api/models') return sendJson(res, 200, { models: MODELS });
  if (m === 'POST' && p === '/api/estimate') {
    const b = await readJson(req);
    const body = buildBody(b.model, b.params);
    const r = await estimate(b.model, body);
    return sendJson(res, 200, { model: b.model, usd: r.usd, credits: r.credits, body });
  }
  if (m === 'POST' && p === '/api/generate') return sendJson(res, 202, await createJob(await readJson(req)));
  if (m === 'GET' && p === '/api/jobs') {
    const project = url.searchParams.get('project');
    const type = url.searchParams.get('type');
    const limit = clampInt(url.searchParams.get('limit'), 1, 2000, 200);
    const list = jobs.filter((j) => (!project || j.project === project) && (!type || j.type === type)).slice(0, limit);
    return sendJson(res, 200, { jobs: list, active, waiting: waitQueue.length });
  }
  if (m === 'GET' && (mm = p.match(/^\/api\/jobs\/([\w-]+)$/))) {
    const job = findJob(mm[1]);
    return job ? sendJson(res, 200, job) : sendError(res, 404, 'الطلب ده مش موجود.');
  }
  if (m === 'POST' && (mm = p.match(/^\/api\/jobs\/([\w-]+)\/refresh$/))) {
    const job = findJob(mm[1]);
    if (!job) return sendError(res, 404, 'الطلب ده مش موجود.');
    if (job.statusUrl && !TERMINAL.has(job.status) && job.status !== 'error') {
      pollJob(job).catch((e) => log('refresh poll crash:', e.message));
    }
    return sendJson(res, 200, job);
  }
  if (m === 'POST' && (mm = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/))) {
    const job = findJob(mm[1]);
    if (!job) return sendError(res, 404, 'الطلب ده مش موجود.');
    return sendJson(res, 200, await cancelJob(job));
  }
  if (m === 'POST' && p === '/api/upload') return handleUpload(req, res);
  if (m === 'GET' && p === '/api/ledger') return sendJson(res, 200, ledgerView());
  if (m === 'GET' && p === '/api/projects') {
    return sendJson(res, 200, { projects: [...new Set(jobs.map((j) => j.project))] });
  }
  return sendError(res, 404, 'مفيش endpoint بالاسم ده.');
}

async function route(req, res) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost') return sendError(res, 403, 'Forbidden');
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return sendError(res, 403, 'Forbidden');
  const url = new URL(req.url, `http://${HOST}`);
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return sendError(res, 400, 'Bad path'); }
  if (p.startsWith('/api/')) return api(req, res, url, p);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
  if (p.startsWith('/outputs/')) return serveFile(req, res, PATHS.outputs, p.slice('/outputs/'.length));
  return serveFile(req, res, PATHS.public, p === '/' ? 'index.html' : p.slice(1));
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof UserError) return sendError(res, 400, e.message);
    if (e instanceof HfError) return sendError(res, e.status >= 400 && e.status < 600 ? e.status : 502, e.message, e.detail, e.correlationId);
    log('server error:', e.stack || e.message);
    sendError(res, 500, 'حصل خطأ في السيرفر المحلي — شوف data/server.log.');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is busy — the studio is probably already running: http://${HOST}:${config.port}`);
    process.exit(1);
  }
  throw e;
});

server.listen(config.port, HOST, () => {
  log(`Ma3loma Studio ${VERSION} running at http://${HOST}:${config.port}`);
  log(hasKey() ? 'Higgsfield key: loaded' : 'Higgsfield key: missing — open Settings and connect it');
  resumeOnStartup();
});

function shutdown() {
  try { saveJobsNow(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
