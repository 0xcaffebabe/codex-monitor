[CmdletBinding(PositionalBinding=$false)]
param(
  [ValidateSet('standalone','server','client')][string]$Mode,
  [string]$DataDir,
  [Alias('h')][switch]$Help
)
$ErrorActionPreference='Stop'
if($Help){Write-Output '.\stop.cmd [-Mode standalone|server|client] [-DataDir <client-data-directory>]';exit 0}
Set-Location -LiteralPath $PSScriptRoot
if(Test-Path -LiteralPath '.env'){
  foreach($line in Get-Content -LiteralPath '.env'){
    if($line -match '^\s*(MONITOR_MODE|MONITOR_DATA_DIR)\s*=\s*(.*?)\s*$'){
      if($null -eq [Environment]::GetEnvironmentVariable($Matches[1],'Process')){
        [Environment]::SetEnvironmentVariable($Matches[1],$Matches[2].Trim('"').Trim("'"),'Process')
      }
    }
  }
}
if($PSBoundParameters.ContainsKey('Mode')){$env:MONITOR_MODE=$Mode}
if($PSBoundParameters.ContainsKey('DataDir')){
  if([string]::IsNullOrWhiteSpace($DataDir)){throw '-DataDir requires a non-empty value'}
  $env:MONITOR_DATA_DIR=$DataDir
}
$taskData=if($env:MONITOR_MODE -eq 'client'){
  if($env:MONITOR_DATA_DIR){[System.IO.Path]::GetFullPath($env:MONITOR_DATA_DIR)}else{Join-Path $PSScriptRoot '.monitor-client'}
}else{Join-Path $PSScriptRoot '.monitor'}
$taskPidFile=Join-Path $taskData 'server.pid'
$taskStateFile=Join-Path $taskData 'server-process.json'
if(!(Test-Path -LiteralPath $taskStateFile)){Write-Host 'Codex Monitor has no verified process record.';exit 0}
$taskSaved=Get-Content -LiteralPath $taskStateFile -Raw | ConvertFrom-Json
$taskSavedPid=[int]$taskSaved.pid
$taskProcess=Get-Process -Id $taskSavedPid -ErrorAction SilentlyContinue
if($taskProcess){
  if($taskProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $taskSaved.started -or $taskProcess.Path -ne $taskSaved.executable -or $taskSaved.server -ne (Join-Path $PSScriptRoot 'dist/server.mjs')){throw 'Process identity changed; refusing to stop it.'}
  Stop-Process -Id $taskSavedPid
}
if(Test-Path -LiteralPath $taskPidFile){Remove-Item -LiteralPath $taskPidFile}
Remove-Item -LiteralPath $taskStateFile
Write-Host 'Codex Monitor stopped.'
