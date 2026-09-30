@echo off
rem Ma3loma Studio launcher - double-click to start the local server and open the site.
title Ma3loma Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Install it once with:  winget install OpenJS.NodeJS.LTS
  echo Then open this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Ma3loma Studio...  (keep this window open while you use the site)
echo Site: http://127.0.0.1:4545
echo To stop: close this window.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:4545"
node server.js
echo.
pause
