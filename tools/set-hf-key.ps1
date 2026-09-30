# set-hf-key.ps1 — شغّله مرة واحدة بس
# بيحفظ مفتاح Higgsfield API في متغير بيئة للمستخدم: HF_KEY = KEY_ID:KEY_SECRET
# الـSecret بيتكتب مخفي، ومش بيتسجل في history بتاع PowerShell
# بعد ما يخلص: افتح ترمينال جديد عشان يشوف المتغير

$ErrorActionPreference = 'Stop'

$keyId = Read-Host 'Higgsfield Key ID'
$secure = Read-Host 'Higgsfield Key Secret (hidden)' -AsSecureString

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($keyId) -or [string]::IsNullOrWhiteSpace($secret)) {
    Write-Host 'Empty value - nothing was saved.' -ForegroundColor Red
    exit 1
}

[Environment]::SetEnvironmentVariable('HF_KEY', ($keyId.Trim() + ':' + $secret.Trim()), 'User')
Write-Host 'Saved as user variable HF_KEY. Open a NEW terminal before running first-call.ps1.' -ForegroundColor Green
