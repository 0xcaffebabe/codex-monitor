@echo off
chcp 65001 >nul
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -OpenBrowser
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
)
set "taskExitCode=%errorlevel%"
if not "%taskExitCode%"=="0" if "%~1"=="" pause
exit /b %taskExitCode%
