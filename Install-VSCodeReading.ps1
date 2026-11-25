param([string]$CodePath)
$ErrorActionPreference='Stop'
if(-not $CodePath){$CodePath=Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'}
if(-not (Test-Path -LiteralPath $CodePath)){throw 'VS Code CLI not found. Pass -CodePath with the path to code.cmd.'}
$taskPackage=Join-Path $PSScriptRoot '.probe\study-system-reading-bridge-0.1.0.vsix'
& (Join-Path $PSScriptRoot 'scripts\Build-VSCodeReading.ps1') -OutputPath $taskPackage
& $CodePath --install-extension $taskPackage --force
if($LASTEXITCODE -ne 0){throw 'VS Code reading extension installation failed.'}
Write-Output 'Installed study-system.reading-bridge. Reload VS Code if it is already running.'
