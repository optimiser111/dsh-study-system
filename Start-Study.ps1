param([switch]$Restart, [int]$Port = 7788, [string]$DataDir, [string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$entryFile = Join-Path $projectDir 'server\cli.mjs'
$nodeFile = if ($NodePath) { (Get-Item -LiteralPath $NodePath).FullName } else { (Get-Command node.exe).Source }
if ($Port -ne 7788 -and -not $DataDir) { throw 'A non-production port requires an explicit isolated DataDir.' }
$targetDataDir = if ($DataDir) { [System.IO.Path]::GetFullPath($DataDir) } else { Join-Path $env:APPDATA 'study-system' }
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  $serviceProcessId = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($serviceProcessId.Count -ne 1) { throw 'Multiple listeners; inspect manually.' }
  $owned = Get-CimInstance Win32_Process -Filter "ProcessId=$($serviceProcessId[0])"
  if (-not $owned.CommandLine -or -not $owned.CommandLine.Contains($entryFile) -or $owned.Name -ne 'node.exe') {
    throw 'Port is occupied by another or unidentified process; refusing to stop it.'
  }
  if (-not $Restart) { Write-Output "Study service is already running, PID $($serviceProcessId[0])"; return }
  Stop-Process -Id $serviceProcessId[0]
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
}
$launchLogs = Join-Path $projectDir '.probe\service'
New-Item -ItemType Directory -Path $launchLogs -Force | Out-Null
New-Item -ItemType Directory -Path $targetDataDir -Force | Out-Null
$databasePath = Join-Path $targetDataDir 'study.db'
$serviceArguments = @('"' + $entryFile + '"', 'serve', "$Port", '"' + $databasePath + '"')
$service = Start-Process -FilePath $nodeFile -ArgumentList $serviceArguments -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $launchLogs "stdout-$Port.log") -RedirectStandardError (Join-Path $launchLogs "stderr-$Port.log")
Write-Output "Started Study service, PID $($service.Id), port $Port"
