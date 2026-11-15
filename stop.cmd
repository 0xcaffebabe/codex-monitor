@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
set "taskExitCode=%errorlevel%"
if not "%taskExitCode%"=="0" if "%~1"=="" pause
exit /b %taskExitCode%
