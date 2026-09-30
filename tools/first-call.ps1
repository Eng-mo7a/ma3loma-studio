# first-call.ps1 — أول طلب لـ Higgsfield API من الترمينال، من غير الموقع
# بيعرض بالترتيب: الطلب (والمفتاح محجوب) ← التقدير بالدولار ← الرد (queued + request_id) ← الحالة لحد ما يخلص ← الصورة
# المفتاح بيتقري من متغير البيئة HF_KEY — شغّل set-hf-key.ps1 مرة واحدة الأول
# الـoutput إنجليزي عشان يتقري صح في الترمينال
# الموديل الافتراضي Soul 2 على 720p لأنه أرخص حاجة في الكتالوج

param(
    [string]$Prompt = 'A quiet river at sunrise, soft mist over the water, a single wooden boat, editorial photography, 35mm, natural light',
    [string]$Model = 'higgsfield-ai/soul/v2/standard',
    [string]$AspectRatio = '16:9',
    [string]$Resolution = '720p'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$key = $env:HF_KEY
if ([string]::IsNullOrWhiteSpace($key) -or -not $key.Contains(':')) {
    Write-Host 'HF_KEY is missing. Run set-hf-key.ps1 first, then open a new terminal.' -ForegroundColor Red
    exit 1
}

$base = 'https://api.higgsfield.ai'
$headers = @{ Authorization = "Key $key" }
$keyId = $key.Split(':')[0]
$shownAuth = 'Key ' + $keyId.Substring(0, [Math]::Min(4, $keyId.Length)) + '****:********'

$body = [ordered]@{ prompt = $Prompt; aspect_ratio = $AspectRatio; resolution = $Resolution } | ConvertTo-Json -Compress

function Write-Step([string]$Title) {
    Write-Host ''
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Write-Json($Obj) {
    Write-Host ($Obj | ConvertTo-Json -Depth 8) -ForegroundColor Yellow
}

function Invoke-HF([string]$Method, [string]$Uri, [string]$Json) {
    try {
        if ($Json) {
            $bytes = [Text.Encoding]::UTF8.GetBytes($Json)
            return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
        }
        return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
    } catch {
        $code = ''
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        Write-Host ('HTTP {0} {1}' -f $code, $_.ErrorDetails.Message) -ForegroundColor Red
        exit 1
    }
}

Write-Step '1) ESTIMATE  (free - nothing is charged)'
Write-Host "POST $base/estimate/$Model"
Write-Host "Authorization: $shownAuth"
Write-Host $body
$est = Invoke-HF 'Post' "$base/estimate/$Model" $body
Write-Json $est
Write-Host ('Estimated cost: $' + $est.usd) -ForegroundColor Green

Write-Step '2) SUBMIT'
Write-Host "POST $base/$Model"
$sub = Invoke-HF 'Post' "$base/$Model" $body
Write-Json $sub

Write-Step '3) POLL status_url'
$terminal = @('completed', 'failed', 'nsfw', 'canceled')
$delay = 2.0
$clock = [Diagnostics.Stopwatch]::StartNew()
do {
    $jitter = Get-Random -Minimum 0.0 -Maximum 0.5
    Start-Sleep -Milliseconds ([int](($delay + $jitter) * 1000))
    $st = Invoke-HF 'Get' $sub.status_url $null
    Write-Host ('[{0,5:N1}s] {1}' -f $clock.Elapsed.TotalSeconds, $st.status)
    $delay = [Math]::Min($delay * 1.5, 10)
} while (($terminal -notcontains $st.status) -and ($clock.Elapsed.TotalMinutes -lt 10))

Write-Step '4) RESULT'
Write-Json $st
if ($st.status -ne 'completed') {
    Write-Host ('Final status: ' + $st.status + ' - failed and nsfw requests are not charged.') -ForegroundColor Magenta
    exit 0
}

$url = $null
if ($st.images) { $url = $st.images[0].url }
elseif ($st.video) { $url = $st.video.url }
if (-not $url) {
    Write-Host 'No output URL in the response.' -ForegroundColor Red
    exit 1
}

$outDir = [IO.Path]::Combine((Get-Location).Path, 'first-call-output')
[void][IO.Directory]::CreateDirectory($outDir)
$ext = [IO.Path]::GetExtension(([Uri]$url).AbsolutePath)
if (-not $ext) { $ext = '.jpg' }
$file = [IO.Path]::Combine($outDir, $sub.request_id + $ext)
(New-Object Net.WebClient).DownloadFile($url, $file)
Write-Host "Saved: $file" -ForegroundColor Green
Invoke-Item -LiteralPath $file
