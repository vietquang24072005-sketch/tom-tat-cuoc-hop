@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai dat lan dau, vui long doi...
  call npm install --no-fund --no-audit
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
