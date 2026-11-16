@echo off
rem Starts Endpaper from this folder. Run "npm install" here once first if node_modules is missing.
cd /d "%~dp0"
if not exist node_modules\electron (
  echo Installing Endpaper's parts, this happens once...
  call npm install
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
