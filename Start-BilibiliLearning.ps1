param([string]$ClientPath, [switch]$PlayerBridge, [switch]$Restart)
$ErrorActionPreference = 'Stop'
if (-not $ClientPath) {
  $shortcut = Join-Path $env:ProgramData ('Microsoft\Windows\Start Menu\Programs\'+[char]0x54d4+[char]0x54e9+[char]0x54d4+[char]0x54e9+'.lnk')
  if (Test-Path -LiteralPath $shortcut) { $ClientPath = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath }
}
if (-not $ClientPath -or -not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) { throw 'Bilibili client not found. Provide -ClientPath with the official client executable.' }
$clientTarget = (Resolve-Path -LiteralPath $ClientPath).Path
$expectedName = [string][char]0x54d4+[char]0x54e9+[char]0x54d4+[char]0x54e9+'.exe'
if ([System.IO.Path]::GetFileName($clientTarget) -ne $expectedName) { throw 'Only the official Bilibili client is supported by this launcher.' }
$running = @(Get-CimInstance Win32_Process -Filter "Name='$expectedName'" | Where-Object { $_.ExecutablePath -eq $clientTarget })
if ($running.Count) {
  if (-not $Restart) { throw 'Bilibili is still running in the tray. Run Start-BilibiliLearning.cmd -PlayerBridge -Restart to restart this client explicitly.' }
  # Only the exact resolved official-client executable is stopped, never a browser or Node service.
  foreach ($clientProcess in $running) {
    $stillOwned = Get-CimInstance Win32_Process -Filter "ProcessId=$($clientProcess.ProcessId)" -ErrorAction SilentlyContinue
    if ($stillOwned.ExecutablePath -eq $clientTarget) { Stop-Process -Id $clientProcess.ProcessId -ErrorAction SilentlyContinue }
  }
  for ($clientWait = 0; $clientWait -lt 30; $clientWait++) {
    if (-not @(Get-CimInstance Win32_Process -Filter "Name='$expectedName'" | Where-Object { $_.ExecutablePath -eq $clientTarget }).Count) { break }
    Start-Sleep -Milliseconds 100
  }
  if (@(Get-CimInstance Win32_Process -Filter "Name='$expectedName'" | Where-Object { $_.ExecutablePath -eq $clientTarget }).Count) { throw 'The Bilibili process did not exit. Please exit it from the tray and retry.' }
}
$clientArguments = @('--force-renderer-accessibility')
if ($PlayerBridge) {
  if (Get-NetTCPConnection -LocalPort 7790 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 7790 is already occupied; refusing to use another application.' }
  $clientArguments += @('--remote-debugging-address=127.0.0.1','--remote-debugging-port=7790')
  Write-Output 'Player bridge enabled on localhost:7790 for this client run. Close the client to disable it.'
}
Start-Process -FilePath $clientTarget -ArgumentList $clientArguments -WindowStyle Normal | Out-Null
Write-Output 'Bilibili started for learning. Open the lecture, then enable desktop detection in the study panel.'
