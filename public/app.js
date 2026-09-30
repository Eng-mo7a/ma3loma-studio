'use strict';
// Ma3loma Studio — الواجهة. كل الطلبات بتروح للسيرفر المحلي بس، والمفتاح عمره ما بيوصل هنا.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const STATUS = {
  waiting: ['في الطابور عندك', 'run'],
  submitting: ['بيتبعت', 'run'],
  queued: ['في طابور Higgsfield', 'run'],
  in_progress: ['بيتولّد', 'run'],
  completed: ['خلص', 'done'],
  failed: ['فشل', 'fail'],
  nsfw: ['الفلتر رفضه', 'fail'],
  canceled: ['اتلغى', 'fail'],
  error: ['خطأ', 'fail'],
  timeout: ['طوّل', 'run'],
};
const RUNNING = new Set(['waiting', 'submitting', 'queued', 'in_progress']);
const FREE = new Set(['failed', 'nsfw', 'canceled', 'error']);

const state = {
  models: {},
  settings: null,
  type: 'image',
  modelId: null,
  values: {},
  previews: {},
  uploadingField: null,
  estimate: null,
  estimateSeq: 0,
  submitting: false,
  jobs: [],
  jobsKey: '',
  view: 'create',
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* المتصفح قافل التخزين */ } },
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body !== undefined && !(body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method: opts.method || (body !== undefined ? 'POST' : 'GET'), headers, body });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.detail = data.detail;
    e.status = res.status;
    throw e;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  n = Number(n);
  if (n === 0) return '$0';
  return '$' + (n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2));
}

const fileUrl = (file) => '/' + file.split('/').map(encodeURIComponent).join('/');

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'دلوقتي';
  if (s < 3600) return `من ${Math.floor(s / 60)} د`;
  if (s < 86400) return `من ${Math.floor(s / 3600)} س`;
  return new Date(iso).toLocaleDateString('ar-EG');
}

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 4200);
}

function htmlToNode(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- views ----------

function showView(name) {
  if (!['create', 'library', 'bill', 'settings'].includes(name)) name = 'create';
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + name));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  if (name === 'create' || name === 'library') refreshJobs(true);
  if (name === 'bill') renderBill();
  if (name === 'settings') renderSettings();
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  const ok = state.settings.hasKey;
  const pill = $('#keyPill');
  pill.textContent = ok ? '● متصل بالمفتاح' : '● مفيش مفتاح';
  pill.className = 'pill ' + (ok ? 'ok' : 'bad');
  $('#noKey').classList.toggle('hidden', ok);
  updateGenButton();
}

// ---------- composer ----------

const modelsOfType = (type) => Object.entries(state.models).filter(([, m]) => m.type === type);

function renderModelSelect() {
  const list = modelsOfType(state.type);
  $('#modelSelect').innerHTML = list.map(([id, m]) => `<option value="${esc(id)}">${esc(m.label)} — ${esc(m.mode)}</option>`).join('');
  if (!state.models[state.modelId] || state.models[state.modelId].type !== state.type) state.modelId = list[0] && list[0][0];
  $('#modelSelect').value = state.modelId;
}

function setType(type) {
  state.type = type;
  $$('#typeTabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  renderModelSelect();
  selectModel(state.modelId);
}

function fieldAccepts(f, v) {
  if (f.kind === 'select') return f.options.some((o) => String(o) === String(v));
  if (f.kind === 'range') return Number(v) >= f.min && Number(v) <= f.max;
  if (f.kind === 'images') return Array.isArray(v);
  if (f.kind === 'image') return typeof v === 'string';
  if (f.kind === 'toggle') return typeof v === 'boolean';
  return typeof v === 'string';
}

function selectModel(id) {
  const prev = state.values;
  const m = state.models[id];
  state.modelId = id;
  $('#modelSelect').value = id;
  $('#modelNote').textContent = m.note || '';
  const vals = {};
  for (const [name, f] of Object.entries(m.fields)) {
    if (prev[name] !== undefined && fieldAccepts(f, prev[name])) vals[name] = prev[name];
    else if (f.default !== undefined) vals[name] = f.default;
  }
  // الصورة المرفوعة بتنتقل معاك بين الموديلات
  const img = prev.image_url || (Array.isArray(prev.image_urls) ? prev.image_urls[0] : null);
  if (m.fields.image_url && !vals.image_url && img) vals.image_url = img;
  if (m.fields.image_urls && !(vals.image_urls && vals.image_urls.length) && img) vals.image_urls = [img];
  state.values = vals;
  renderFields();
  scheduleEstimate();
}

function renderFields() {
  const m = state.models[state.modelId];
  const parts = [];
  for (const [name, f] of Object.entries(m.fields)) {
    const req = f.required ? ' <b class="req">*</b>' : '';
    if (f.kind === 'text') {
      parts.push(`<label class="field wide prompt-box"><span>${esc(f.label)}${req}</span>
        <textarea data-field="${name}" placeholder="اوصف اللي عاوزه بالتفصيل — الإنجليزي بيدي نتيجة أدق">${esc(state.values[name] || '')}</textarea>
        <small class="muted" data-count="${name}"></small></label>`);
    } else if (f.kind === 'select') {
      const opts = f.options.map((o) => `<option value="${esc(o)}"${String(state.values[name]) === String(o) ? ' selected' : ''}>${esc((f.optionLabels && f.optionLabels[o]) || o)}</option>`).join('');
      parts.push(`<label class="field"><span>${esc(f.label)}</span><select data-field="${name}">${opts}</select></label>`);
    } else if (f.kind === 'range') {
      let opts = '';
      for (let i = f.min; i <= f.max; i++) opts += `<option value="${i}"${Number(state.values[name]) === i ? ' selected' : ''}>${i}</option>`;
      parts.push(`<label class="field"><span>${esc(f.label)}</span><select data-field="${name}" data-int="1">${opts}</select></label>`);
    } else if (f.kind === 'toggle') {
      parts.push(`<label class="field toggle"><input type="checkbox" data-field="${name}"${state.values[name] ? ' checked' : ''}><span>${esc(f.label)}</span></label>`);
    } else if (f.kind === 'image' || f.kind === 'images') {
      parts.push(`<div class="field wide"><span>${esc(f.label)}${req}</span><div class="drop" data-drop="${name}"></div></div>`);
    }
  }
  $('#fields').innerHTML = parts.join('');
  $$('[data-drop]').forEach(renderDrop);
  updateCounts();
}

function renderDrop(el) {
  const name = el.dataset.drop;
  const f = state.models[state.modelId].fields[name];
  const list = f.kind === 'images' ? (state.values[name] || []) : (state.values[name] ? [state.values[name]] : []);
  const max = f.kind === 'images' ? (f.max || 4) : 1;
  el.innerHTML = list.map((u, i) => `<div class="thumb"><img src="${esc(state.previews[u] || u)}" alt=""><button type="button" class="x" data-remove="${name}" data-i="${i}" aria-label="شيل الصورة">×</button></div>`).join('')
    + (state.uploadingField === name ? '<div class="thumb"><div class="state">بيترفع…</div></div>' : '')
    + (list.length < max && state.uploadingField !== name ? `<label class="upload-btn">+ ارفع صورة<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-file="${name}"></label>` : '');
}

function updateCounts() {
  $$('[data-count]').forEach((el) => {
    const v = state.values[el.dataset.count] || '';
    el.textContent = v ? `${v.length} حرف` : '';
  });
}

function readInput(t) {
  const name = t.dataset.field;
  const f = state.models[state.modelId].fields[name];
  if (t.type === 'checkbox') return t.checked;
  if (t.dataset.int) return parseInt(t.value, 10);
  if (t.tagName === 'SELECT') {
    const opt = f.options.find((o) => String(o) === t.value);
    return opt !== undefined ? opt : t.value;
  }
  return t.value;
}

async function uploadFile(name, file) {
  if (!state.settings || !state.settings.hasKey) { toast('اربط مفتاحك الأول — الرفع بيعدّي على Higgsfield.', true); return; }
  if (file.size > 20 * 1024 * 1024) { toast('الصورة أكبر من 20MB.', true); return; }
  state.uploadingField = name;
  $$('[data-drop]').forEach(renderDrop);
  try {
    const r = await api('/api/upload', { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
    state.previews[r.publicUrl] = URL.createObjectURL(file);
    const f = state.models[state.modelId].fields[name];
    if (f.kind === 'images') state.values[name] = [...(state.values[name] || []), r.publicUrl].slice(0, f.max || 4);
    else state.values[name] = r.publicUrl;
    toast('الصورة اترفعت ✓');
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.uploadingField = null;
    $$('[data-drop]').forEach(renderDrop);
    scheduleEstimate();
  }
}

function missingRequired() {
  const m = state.models[state.modelId];
  const miss = [];
  for (const [n, f] of Object.entries(m.fields)) {
    if (!f.required) continue;
    const v = state.values[n];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)) miss.push(f.label);
  }
  return miss;
}

let estTimer = null;
function scheduleEstimate() {
  clearTimeout(estTimer);
  state.estimate = null;
  state.estimateSeq++;
  updateGenButton(true);
  estTimer = setTimeout(runEstimate, 550);
}

async function runEstimate() {
  const seq = ++state.estimateSeq;
  if (!state.settings || !state.settings.hasKey) { updateGenButton(); return; }
  const miss = missingRequired();
  if (miss.length) { state.estimate = { missing: miss }; updateGenButton(); return; }
  try {
    const r = await api('/api/estimate', { body: { model: state.modelId, params: state.values } });
    if (seq !== state.estimateSeq) return;
    state.estimate = { usd: r.usd };
  } catch (e) {
    if (seq !== state.estimateSeq) return;
    state.estimate = { error: e.message };
  }
  updateGenButton();
}

function updateGenButton(pending) {
  const btn = $('#genBtn');
  const info = $('#estInfo');
  btn.textContent = 'ولّد';
  btn.disabled = true;
  if (!state.settings || !state.settings.hasKey) { btn.textContent = 'اربط مفتاحك الأول'; info.textContent = ''; return; }
  if (pending) { info.textContent = 'بيحسب السعر…'; return; }
  const est = state.estimate;
  if (!est) { info.textContent = ''; return; }
  if (est.missing) { info.textContent = 'ناقص: ' + est.missing.join('، '); return; }
  if (est.error) { info.textContent = est.error; return; }
  btn.disabled = state.submitting;
  btn.textContent = `ولّد — ${usd(est.usd)}`;
  info.textContent = 'السعر ده جاي من Higgsfield نفسها قبل التوليد';
}

async function generate() {
  if (state.submitting) return;
  state.submitting = true;
  updateGenButton();
  const project = ($('#projectInput').value || '').trim() || 'general';
  store.set('project', project);
  try {
    const job = await api('/api/generate', { body: { model: state.modelId, params: state.values, project, source: 'web' } });
    toast(`اتبعت ✓ — التقدير ${usd(job.estimateUsd)}`);
    await refreshJobs(true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.submitting = false;
    updateGenButton();
  }
}

// ---------- jobs ----------

const jobSig = (j) => [j.status, (j.outputs || []).map((o) => o.file).join('|'), j.error || '', j.pollError || ''].join('~');

function jobCard(j) {
  const [label, cls] = STATUS[j.status] || [j.status, ''];
  const outs = (j.outputs || []).filter((o) => o.file);
  const first = outs[0];
  let media;
  if (first && first.kind === 'video') media = `<video src="${fileUrl(first.file)}" controls preload="metadata" playsinline></video>`;
  else if (first && first.kind === 'audio') media = `<audio src="${fileUrl(first.file)}" controls></audio>`;
  else if (first) media = `<a href="${fileUrl(first.file)}" target="_blank" rel="noopener"><img src="${fileUrl(first.file)}" alt="" loading="lazy"></a>`;
  else media = `<div class="ph ${RUNNING.has(j.status) ? 'busy' : ''}">${esc(label)}</div>`;
  const count = outs.length > 1 ? `<span class="count">${outs.length} صور</span>` : '';
  const cost = j.status === 'completed' ? `<span class="cost">${usd(j.chargedUsd)}</span>`
    : FREE.has(j.status) ? '<span class="cost free">$0</span>'
    : `<span class="cost" title="تقدير">~${usd(j.estimateUsd)}</span>`;
  const prompt = j.params && j.params.prompt ? `<div class="prompt" title="${esc(j.params.prompt)}">${esc(j.params.prompt)}</div>` : '';
  const err = j.error ? `<div class="err">${esc(j.error)}</div>` : j.pollError ? `<div class="err">${esc(j.pollError)}</div>` : '';
  const btns = [];
  if (first) btns.push(`<a class="btn sm" href="${fileUrl(first.file)}" download>تحميل</a>`);
  if (first && first.kind === 'image' && first.url) btns.push(`<button type="button" class="btn sm" data-act="animate" data-id="${j.id}">حرّكها</button>`);
  btns.push(`<button type="button" class="btn sm" data-act="again" data-id="${j.id}">إعادة</button>`);
  if (j.params && j.params.prompt) btns.push(`<button type="button" class="btn sm" data-act="copy" data-id="${j.id}">نسخ الأمر</button>`);
  if (j.status === 'timeout') btns.push(`<button type="button" class="btn sm" data-act="refresh" data-id="${j.id}">تحديث</button>`);
  if (j.status === 'waiting' || j.status === 'queued') btns.push(`<button type="button" class="btn sm" data-act="cancel" data-id="${j.id}">إلغاء</button>`);
  const source = j.source && j.source !== 'web' ? `<span>من ${esc(j.source)}</span>` : '';
  const rid = j.requestId ? `<span class="rid" data-act="rid" data-id="${j.id}" title="انسخ request_id">${esc(j.requestId.slice(0, 8))}…</span>` : '';
  return `<article class="job" data-id="${j.id}" data-sig="${esc(jobSig(j))}">
    <div class="media">${media}${count}</div>
    <div class="body">
      <div class="top"><span class="model">${esc(j.modelLabel)}</span><span class="badge ${cls}">${esc(label)}</span></div>
      <div class="meta"><span>${esc(j.mode || '')}</span>${cost}<span>${esc(timeAgo(j.createdAt))}</span>${source}</div>
      ${prompt}${err}
      <div class="meta"><span>${esc(j.project)}</span>${rid}</div>
      <div class="btns">${btns.join('')}</div>
    </div>
  </article>`;
}

// بيحدّث الكروت اللي اتغيرت بس — عشان الفيديو اللي شغال ميقفش
function patchGrid(grid, list, emptyHtml) {
  if (!list.length) { grid.innerHTML = emptyHtml; return; }
  const empty = grid.querySelector('.empty');
  if (empty) empty.remove();
  const want = new Set(list.map((j) => j.id));
  $$('.job', grid).forEach((n) => { if (!want.has(n.dataset.id)) n.remove(); });
  let prev = null;
  for (const j of list) {
    let n = grid.querySelector(`.job[data-id="${j.id}"]`);
    if (n && n.dataset.sig !== jobSig(j)) {
      const fresh = htmlToNode(jobCard(j));
      n.replaceWith(fresh);
      n = fresh;
    }
    if (!n) {
      n = htmlToNode(jobCard(j));
      if (prev) prev.after(n); else grid.prepend(n);
    }
    prev = n;
  }
}

function renderRecent() {
  patchGrid($('#recentGrid'), state.jobs.slice(0, 8), '<div class="empty">لسه مولّدتش حاجة. اكتب أمر فوق ودوس «ولّد».</div>');
}

function renderLibrary() {
  const p = $('#libProject').value;
  const t = $('#libType').value;
  const list = state.jobs.filter((j) => (!p || j.project === p) && (!t || j.type === t));
  patchGrid($('#libGrid'), list, '<div class="empty">مفيش حاجة هنا لسه.</div>');
}

function fillProjectFilter() {
  const sel = $('#libProject');
  const cur = sel.value;
  const projects = [...new Set(state.jobs.map((j) => j.project))];
  sel.innerHTML = '<option value="">كل المشاريع</option>' + projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  sel.value = projects.includes(cur) ? cur : '';
}

async function refreshJobs(force) {
  let data;
  try { data = await api('/api/jobs?limit=300'); } catch { return; }
  const key = JSON.stringify(data.jobs.map((j) => [j.id, jobSig(j)]));
  if (!force && key === state.jobsKey) return;
  state.jobsKey = key;
  state.jobs = data.jobs;
  fillProjectFilter();
  renderRecent();
  renderLibrary();
}

function animateFrom(j) {
  const img = (j.outputs || []).find((o) => o.kind === 'image' && o.url && o.file);
  if (!img) return;
  state.previews[img.url] = fileUrl(img.file);
  state.type = 'video';
  $$('#typeTabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === 'video'));
  state.modelId = 'kling-3-std-i2v';
  renderModelSelect();
  state.values = { image_url: img.url, prompt: '' };
  selectModel('kling-3-std-i2v');
  $('#projectInput').value = j.project;
  location.hash = '#create';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('الصورة جاهزة — اكتب الحركة ودوس «ولّد»');
}

async function onGridClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const j = state.jobs.find((x) => x.id === b.dataset.id);
  if (!j) return;
  try {
    switch (b.dataset.act) {
      case 'animate': animateFrom(j); break;
      case 'again': {
        const r = await api('/api/generate', { body: { model: j.model, params: j.params, project: j.project, source: 'web' } });
        toast(`اتبعت تاني ✓ — التقدير ${usd(r.estimateUsd)}`);
        refreshJobs(true);
        break;
      }
      case 'copy': await navigator.clipboard.writeText(j.params.prompt); toast('الأمر اتنسخ ✓'); break;
      case 'rid': await navigator.clipboard.writeText(j.requestId); toast('request_id اتنسخ ✓'); break;
      case 'refresh': await api(`/api/jobs/${j.id}/refresh`, { body: {} }); toast('بنتابعه تاني…'); break;
      case 'cancel': await api(`/api/jobs/${j.id}/cancel`, { body: {} }); toast('اتبعت طلب الإلغاء'); refreshJobs(true); break;
      default: break;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- bill ----------

async function renderBill() {
  let d;
  try { d = await api('/api/ledger'); } catch (e) { toast(e.message, true); return; }
  $('#kpis').innerHTML = [
    ['النهارده', usd(d.today)], ['الشهر ده', usd(d.month)], ['الإجمالي', usd(d.total)],
    ['عدد الطلبات', String(d.requests)], ['اتحسبوا $0', String(d.free)], ['محجوز دلوقتي', usd(d.pendingUsd)], ['سقف اليوم', usd(d.dailyCapUsd)],
  ].map(([k, v]) => `<div class="kpi"><small>${k}</small><b>${v}</b></div>`).join('');
  const groupTable = (rows) => rows.length
    ? '<tr><th>الاسم</th><th>طلبات</th><th>التكلفة</th></tr>' + rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.count}</td><td class="cost">${usd(r.usd)}</td></tr>`).join('')
    : '<tr><td class="muted">لسه مفيش.</td></tr>';
  $('#byModel').innerHTML = groupTable(d.byModel);
  $('#byProject').innerHTML = groupTable(d.byProject);
  $('#ledgerTable').innerHTML = d.entries.length
    ? '<tr><th>الوقت</th><th>الموديل</th><th>المشروع</th><th>الحالة</th><th>التقدير</th><th>اتحسب</th><th>request_id</th></tr>'
      + d.entries.map((e) => {
        const [label, cls] = STATUS[e.status] || [e.status, ''];
        return `<tr><td>${esc(new Date(e.time).toLocaleString('ar-EG'))}</td><td>${esc(e.modelLabel)} <span class="muted">${esc(e.mode || '')}</span></td>
          <td>${esc(e.project)}</td><td><span class="badge ${cls}">${esc(label)}</span></td><td class="cost">${usd(e.estimateUsd)}</td>
          <td class="cost ${e.chargedUsd ? '' : 'free'}">${usd(e.chargedUsd)}</td><td class="rid">${esc((e.requestId || '').slice(0, 8))}</td></tr>`;
      }).join('')
    : '<tr><td class="muted">لسه مفيش طلبات.</td></tr>';
}

// ---------- settings ----------

async function renderSettings() {
  try { await loadSettings(); } catch (e) { toast(e.message, true); return; }
  const s = state.settings;
  $('#keyId').value = '';
  $('#keyId').placeholder = s.keyIdMasked ? `محفوظ: ${s.keyIdMasked}` : 'الصق Key ID';
  $('#keySecret').value = '';
  $('#keySecret').placeholder = s.hasKey ? 'محفوظ — اكتب جديد لو عاوز تغيّره' : 'الصق Key Secret';
  $('#maxConc').value = s.maxConcurrency;
  $('#dailyCap').value = s.dailyCapUsd;
}

function setMsg(el, text, ok) {
  el.className = 'msg ' + (ok === undefined ? '' : ok ? 'ok' : 'bad');
  el.textContent = text;
}

async function saveKey() {
  const keyId = $('#keyId').value.trim();
  const keySecret = $('#keySecret').value.trim();
  const msg = $('#keyMsg');
  if (!state.settings.hasKey && (!keyId || !keySecret)) return setMsg(msg, 'محتاج Key ID و Key Secret الاتنين.', false);
  if (!keyId && !keySecret) return setMsg(msg, 'مفيش حاجة جديدة تتحفظ.', false);
  try {
    await api('/api/settings', { body: { keyId, keySecret } });
    await renderSettings();
    setMsg(msg, 'اتحفظ ✓ — دوس «اختبر الاتصال»', true);
    scheduleEstimate();
  } catch (e) {
    setMsg(msg, e.message, false);
  }
}

async function testKey() {
  const msg = $('#keyMsg');
  setMsg(msg, 'بيختبر…');
  try {
    const r = await api('/api/settings/test', { body: {} });
    setMsg(msg, `الاتصال شغال ✓ — صورة Soul 2 بدقة 720p بتتكلف ${usd(r.sampleUsd)}، ومتخصمش حاجة دلوقتي`, true);
  } catch (e) {
    setMsg(msg, e.message, false);
  }
}

async function saveLimits() {
  const msg = $('#limitsMsg');
  try {
    await api('/api/settings', { body: { maxConcurrency: $('#maxConc').value, dailyCapUsd: $('#dailyCap').value } });
    await renderSettings();
    setMsg(msg, 'اتحفظ ✓', true);
  } catch (e) {
    setMsg(msg, e.message, false);
  }
}

// ---------- start ----------

async function tick() {
  if (document.hidden || (state.view !== 'create' && state.view !== 'library')) return;
  tick.n = (tick.n || 0) + 1;
  const running = state.jobs.some((j) => RUNNING.has(j.status));
  if (running || tick.n % 4 === 0) refreshJobs(false);
}

async function init() {
  try {
    state.models = (await api('/api/models')).models;
  } catch (e) {
    toast('السيرفر المحلي مش شغال؟ شغّله بـ npm start. ' + e.message, true);
    return;
  }
  try { await loadSettings(); } catch { /* هيبان في صفحة الإعدادات */ }
  $('#projectInput').value = store.get('project', 'general');
  $$('#typeTabs button').forEach((b) => { b.onclick = () => setType(b.dataset.type); });
  $('#modelSelect').onchange = (e) => selectModel(e.target.value);
  $('#genBtn').onclick = generate;
  $('#fields').addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.field) return;
    state.values[t.dataset.field] = readInput(t);
    updateCounts();
    scheduleEstimate();
  });
  $('#fields').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.file && t.files && t.files[0]) uploadFile(t.dataset.file, t.files[0]);
  });
  $('#fields').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const name = b.dataset.remove;
    const f = state.models[state.modelId].fields[name];
    if (f.kind === 'images') {
      const arr = [...(state.values[name] || [])];
      arr.splice(Number(b.dataset.i), 1);
      state.values[name] = arr;
    } else {
      delete state.values[name];
    }
    $$('[data-drop]').forEach(renderDrop);
    scheduleEstimate();
  });
  ['#recentGrid', '#libGrid'].forEach((s) => $(s).addEventListener('click', onGridClick));
  const resetLib = () => { $('#libGrid').innerHTML = ''; renderLibrary(); };
  $('#libProject').onchange = resetLib;
  $('#libType').onchange = resetLib;
  $('#saveKey').onclick = saveKey;
  $('#testKey').onclick = testKey;
  $('#saveLimits').onclick = saveLimits;
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  setType('image');
  showView(location.hash.slice(1) || 'create');
  setInterval(tick, 2500);
}

init();
