[CmdletBinding(PositionalBinding=$false)]
param(
  [switch]$OpenBrowser,
  [switch]$Build,
  [Alias('h')][switch]$Help,
  [switch]$CheckConfig,
  [ValidateSet('standalone','server','client')][string]$Mode,
  [string]$ServerUrl,
  [string]$WorkspaceId,
  [string]$ClientKey,
  [string]$ClientKeyFile,
  [string]$CodexHome,
  [string]$DataDir,
  [string]$PollMs,
  [string]$PricingFile,
  [ValidateSet('true','false')][string]$CodexAutoStart,
  [string]$CodexCheckMs,
  [string]$CodexDesktop,
  [string]$CodexCli,
  [string]$CodexPipe,
  [string]$ListenHost,
  [string]$Port
)
$ErrorActionPreference='Stop'
if($Help){
  Write-Output @'
Codex Monitor Windows background launcher

  .\start.cmd -Mode client -ServerUrl ws://server:4317 -WorkspaceId <id> -ClientKey <key>
  .\start.ps1 -Mode client -ServerUrl ws://server:4317 -WorkspaceId <id> -ClientKeyFile "D:\private\client.key"

  -Mode standalone|server|client    Default: standalone
  -ServerUrl <url>                  Server http(s) or ws(s) origin
  -WorkspaceId <id>                 Registered workspace ID
  -ClientKey <key>                  Workspace AES key
  -ClientKeyFile <path>             Private text file containing the key
  -CodexHome <path>                 Default: current user's .codex
  -DataDir <path>                   Client default: .monitor-client
  -PollMs <milliseconds>            Default: 1500 (min: 500)
  -PricingFile <path>               Model pricing JSON file
  -CodexAutoStart true|false        Windows desktop watchdog
  -CodexCheckMs <milliseconds>      Default: 15000
  -CodexDesktop <absolute-path>     Desktop GUI executable
  -CodexCli <path>                  Codex CLI executable for native RPCs
  -CodexPipe <path>                 Select a desktop app pipe
  -ListenHost <address> -Port <n>    Server listen address and port
  -Build                           Rebuild before starting
  -CheckConfig                     Validate and exit without starting
  -OpenBrowser                     Open Web UI (server/standalone only)
  -Help                            Show this help

Priority: command-line parameters > process environment > project .env > defaults.
Use either -ClientKey or -ClientKeyFile. Paths are relative to the project folder.
Stop a client with .\stop.cmd -Mode client [-DataDir <same-path>].
'@
  exit 0
}
Set-Location -LiteralPath $PSScriptRoot
$taskData=Join-Path $PSScriptRoot '.monitor'
$taskOptions=[ordered]@{
  Mode='MONITOR_MODE';ServerUrl='MONITOR_SERVER_URL';WorkspaceId='MONITOR_WORKSPACE_ID'
  ClientKey='MONITOR_CLIENT_KEY';ClientKeyFile='MONITOR_CLIENT_KEY_FILE';CodexHome='CODEX_HOME'
  DataDir='MONITOR_DATA_DIR';PollMs='MONITOR_POLL_MS';PricingFile='MONITOR_PRICING_FILE'
  CodexAutoStart='MONITOR_CODEX_AUTOSTART';CodexCheckMs='MONITOR_CODEX_CHECK_MS'
  CodexDesktop='MONITOR_CODEX_DESKTOP';CodexCli='MONITOR_CODEX_CLI';CodexPipe='MONITOR_CODEX_PIPE'
  ListenHost='HOST';Port='PORT'
}
if($PSBoundParameters.ContainsKey('ClientKey') -and $PSBoundParameters.ContainsKey('ClientKeyFile')){throw 'Use either -ClientKey or -ClientKeyFile, not both'}
$taskInheritedKeySource=$env:MONITOR_CLIENT_KEY -or $env:MONITOR_CLIENT_KEY_FILE
if(Test-Path -LiteralPath '.env'){
  foreach($line in Get-Content -LiteralPath '.env'){
    if($line -match '^\s*(PORT|HOST|CODEX_HOME|MONITOR_DATA_DIR|MONITOR_ORIGINS|MONITOR_HTTPS|MONITOR_TLS_CERT|MONITOR_TLS_KEY|MONITOR_POLL_MS|MONITOR_CODEX_PIPE|MONITOR_CODEX_CLI|MONITOR_CODEX_AUTOSTART|MONITOR_CODEX_CHECK_MS|MONITOR_CODEX_DESKTOP|MONITOR_PRICING_FILE|MONITOR_MODE|MONITOR_SERVER_URL|MONITOR_WORKSPACE_ID|MONITOR_CLIENT_KEY|MONITOR_CLIENT_KEY_FILE)\s*=\s*(.*?)\s*$'){
      if($taskInheritedKeySource -and $Matches[1] -in @('MONITOR_CLIENT_KEY','MONITOR_CLIENT_KEY_FILE')){continue}
      if($null -eq [Environment]::GetEnvironmentVariable($Matches[1],'Process')){
        [Environment]::SetEnvironmentVariable($Matches[1],$Matches[2].Trim('"').Trim("'"),'Process')
      }
    }
  }
}
foreach($taskOption in $taskOptions.GetEnumerator()){
  if($PSBoundParameters.ContainsKey($taskOption.Key)){
    $taskValue=[string]$PSBoundParameters[$taskOption.Key]
    if([string]::IsNullOrWhiteSpace($taskValue)){throw "-$($taskOption.Key) requires a non-empty value"}
    if($taskOption.Key -in @('Mode','CodexAutoStart')){$taskValue=$taskValue.ToLowerInvariant()}
    [Environment]::SetEnvironmentVariable($taskOption.Value,$taskValue,'Process')
  }
}
if($PSBoundParameters.ContainsKey('ClientKey')){[Environment]::SetEnvironmentVariable('MONITOR_CLIENT_KEY_FILE',$null,'Process')}
if($PSBoundParameters.ContainsKey('ClientKeyFile')){[Environment]::SetEnvironmentVariable('MONITOR_CLIENT_KEY',$null,'Process')}
if(!(Test-Path -LiteralPath 'node_modules')){& npm.cmd ci --no-fund; if($LASTEXITCODE -ne 0){throw 'npm ci failed'}}
if($Build -or !(Test-Path -LiteralPath 'dist/server.mjs')){& npm.cmd run build;if($LASTEXITCODE -ne 0){throw 'Build failed'}}
$taskNode=(Get-Command node.exe).Source
$taskServer=Join-Path $PSScriptRoot 'dist/server.mjs'
& $taskNode --disable-warning=ExperimentalWarning $taskServer --check-config
if($LASTEXITCODE -ne 0){throw 'Invalid startup configuration; see the error above. Use -Help for parameters.'}
if($CheckConfig){exit 0}
# Select the module for this PowerShell host even if PSModulePath was inherited from another version.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
# Store only a digest, so repeating a command is safe without persisting its key.
$taskSettingsVariables=@($taskOptions.Values)+@('MONITOR_ORIGINS','MONITOR_HTTPS','MONITOR_TLS_CERT','MONITOR_TLS_KEY')
$taskSettings=@($taskSettingsVariables | ForEach-Object {"$_=$([Environment]::GetEnvironmentVariable($_,'Process'))"}) -join "`n"
if($env:MONITOR_MODE -eq 'client' -and $env:MONITOR_CLIENT_KEY_FILE){
  $taskSettings+="`nkey-file-content=$([System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($env:MONITOR_CLIENT_KEY_FILE)).Trim())"
}
$taskHasher=[Security.Cryptography.SHA256]::Create()
try{$taskSettingsHash=[BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskSettings)))}finally{$taskHasher.Dispose()}
$taskSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Protect-MonitorPrivatePath([string]$taskPrivatePath,[bool]$taskIsDirectory){
  # icacls changes only the DACL and does not require access to Windows audit policy.
  $taskAllowedSids=@($taskSid,'S-1-5-18')
  $taskGrants=if($taskIsDirectory){@("*$($taskSid):(OI)(CI)F",'*S-1-5-18:(OI)(CI)F')}else{@("*$($taskSid):F",'*S-1-5-18:F')}
  & icacls $taskPrivatePath /inheritance:r /grant:r $taskGrants | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot secure monitor data path'}
  $taskRules=(Get-Acl -LiteralPath $taskPrivatePath).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
  foreach($taskRuleSid in @($taskRules | ForEach-Object {$_.IdentityReference.Value} | Select-Object -Unique)){
    if($taskRuleSid -notin $taskAllowedSids){
      & icacls $taskPrivatePath /remove "*$taskRuleSid" | Out-Null
      if($LASTEXITCODE -ne 0){throw 'Cannot remove an obsolete monitor permission'}
    }
  }
}
$taskPrivateData=if($env:MONITOR_DATA_DIR){[System.IO.Path]::GetFullPath($env:MONITOR_DATA_DIR)}elseif($env:MONITOR_MODE -eq 'client'){Join-Path $PSScriptRoot '.monitor-client'}else{$taskData}
if($env:MONITOR_MODE -eq 'client'){$taskData=$taskPrivateData}
foreach($taskPrivateDirectory in @($taskData,$taskPrivateData) | Select-Object -Unique){
  $taskPrivateDirectory=[System.IO.Path]::GetFullPath($taskPrivateDirectory).TrimEnd('\')
  $taskVolumeRoot=[System.IO.Path]::GetPathRoot($taskPrivateDirectory).TrimEnd('\')
  if($taskPrivateDirectory -eq $taskVolumeRoot -or $PSScriptRoot -eq $taskPrivateDirectory -or $PSScriptRoot.StartsWith($taskPrivateDirectory+'\',[StringComparison]::OrdinalIgnoreCase) -or $taskPrivateDirectory -eq $env:USERPROFILE){throw 'MONITOR_DATA_DIR must be a dedicated private directory'}
  New-Item -ItemType Directory -Path $taskPrivateDirectory -Force | Out-Null
  Protect-MonitorPrivatePath $taskPrivateDirectory $true
  # Existing credential/database files can carry explicit grants from an older setup.
  foreach($taskPrivateFile in Get-ChildItem -LiteralPath $taskPrivateDirectory -File){
    if($taskPrivateFile.Name -notmatch '^(?:(?:monitor|usage)\.sqlite(?:-wal|-shm)?|setup-key\.txt|initial-credentials\.txt|local-client-key|server(?:-error)?\.log|server\.pid|server-process\.json)$'){continue}
    if($taskPrivateFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint){throw 'Private monitor files must not be symbolic links'}
    Protect-MonitorPrivatePath $taskPrivateFile.FullName $false
  }
}
foreach($taskKeyPath in @((Join-Path $PSScriptRoot '.env'),$env:MONITOR_CLIENT_KEY_FILE)){
  if($taskKeyPath -and (Test-Path -LiteralPath $taskKeyPath -PathType Leaf)){Protect-MonitorPrivatePath ([System.IO.Path]::GetFullPath($taskKeyPath)) $false}
}
$taskPort=if($env:PORT){[int]$env:PORT}else{4317}
$taskScheme=if($env:MONITOR_HTTPS -eq 'true'){'https'}else{'http'}
$taskUrl="$($taskScheme)://localhost:$taskPort"
$taskHealthUrl="$($taskScheme)://127.0.0.1:$taskPort/api/health"
$taskPidFile=Join-Path $taskData 'server.pid'
$taskStateFile=Join-Path $taskData 'server-process.json'
if(Test-Path -LiteralPath $taskStateFile){
  $taskSaved=Get-Content -LiteralPath $taskStateFile -Raw | ConvertFrom-Json
  $taskExisting=Get-Process -Id $taskSaved.pid -ErrorAction SilentlyContinue
  if($taskExisting -and $taskExisting.StartTime.ToUniversalTime().Ticks.ToString() -eq $taskSaved.started -and $taskExisting.Path -eq $taskSaved.executable){
    $taskHasOverrides=@($taskOptions.Keys | Where-Object {$PSBoundParameters.ContainsKey($_)}).Count -gt 0
    if(($taskSaved.settingsHash -and $taskSaved.settingsHash -ne $taskSettingsHash) -or (!$taskSaved.settingsHash -and $taskHasOverrides)){
      $taskStopHint=if($env:MONITOR_MODE -eq 'client'){"stop.cmd -Mode client -DataDir `"$taskData`""}else{'stop.cmd'}
      throw "Codex Monitor is already running with other settings. Stop it first: $taskStopHint"
    }
    if($env:MONITOR_MODE -eq 'client'){Write-Host "Codex Monitor client is already running. Connection status: $taskData\server.log"}else{Write-Host "Codex Monitor is already running: $taskUrl"}
    if($OpenBrowser -and $env:MONITOR_MODE -ne 'client'){Start-Process $taskUrl}
    exit 0
  }
}
$taskProcess=Start-Process -FilePath $taskNode -ArgumentList @('--disable-warning=ExperimentalWarning',('"'+$taskServer+'"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'server.log') -RedirectStandardError (Join-Path $taskData 'server-error.log')
Set-Content -LiteralPath $taskPidFile -Value $taskProcess.Id
@{pid=$taskProcess.Id;started=$taskProcess.StartTime.ToUniversalTime().Ticks.ToString();executable=$taskNode;server=$taskServer;settingsHash=$taskSettingsHash} | ConvertTo-Json | Set-Content -LiteralPath $taskStateFile
if($env:MONITOR_MODE -eq 'client'){
  Start-Sleep -Milliseconds 700
  $taskProcess.Refresh()
  if($taskProcess.HasExited){throw "Client exited. See $taskData\server-error.log"}
  Write-Host "Codex Monitor client started. Connection status: $taskData\server.log"
  exit 0
}
$taskReady=$false
for($taskTry=0;$taskTry -lt 30;$taskTry++){
  if($taskProcess.HasExited){throw "Server exited. See $taskData\server-error.log"}
  if($taskScheme -eq 'https'){
    $taskTcp=New-Object Net.Sockets.TcpClient
    try{$taskTcp.Connect('127.0.0.1',$taskPort);$taskReady=$taskTcp.Connected}catch{}finally{$taskTcp.Dispose()}
    if($taskReady){break}
  }else{
    try{$taskHealth=Invoke-RestMethod $taskHealthUrl -TimeoutSec 2;if($taskHealth.ok -and $taskHealth.app -eq 'codex-monitor'){$taskReady=$true;break}}catch{}
  }
  Start-Sleep -Milliseconds 300
}
if(!$taskReady){throw "Server did not become ready. See $taskData\server-error.log"}
Write-Host "Codex Monitor is running: $taskUrl"
$taskSetup=Join-Path $(if($env:MONITOR_DATA_DIR){$env:MONITOR_DATA_DIR}else{$taskData}) 'setup-key.txt'
if(Test-Path -LiteralPath $taskSetup){$taskKey=(Get-Content -LiteralPath $taskSetup -Raw).Trim();$taskUrl="$taskUrl/#setup=$taskKey";Write-Host "First setup (private): $taskUrl"}
if($OpenBrowser){Start-Process $taskUrl}
