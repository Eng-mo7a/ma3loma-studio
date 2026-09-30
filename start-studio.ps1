# start-studio.ps1 — بيشغّل Ma3loma Studio ويفتحه في المتصفح
# كليك يمين ← Run with PowerShell، أو من الترمينال: .\start-studio.ps1

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is not installed. Run: winget install OpenJS.NodeJS.LTS  (then open a new terminal)' -ForegroundColor Red
    exit 1
}

Start-Job -ScriptBlock { Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4545' } | Out-Null
node server.js
