param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$startupFolder = [Environment]::GetFolderPath('Startup')
if (-not $startupFolder -or -not (Test-Path -LiteralPath $startupFolder -PathType Container)) {
  throw 'The current user Startup folder was not found.'
}
$shortcutPath = Join-Path $startupFolder 'DSH Study Services.lnk'
if ($Disable) {
  if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
  Write-Output 'DSH study services will no longer start automatically.'
  return
}

$nodePath = (Get-Command node.exe).Source
$powerShell = (Get-Command powershell.exe).Source
$entryPath = Join-Path $PSScriptRoot 'Start-Study-AtLogon.ps1'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShell
$shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}"' -f $entryPath, $nodePath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Start the local DSH study and trial services at Windows sign-in.'
$shortcut.Save()
Write-Output "Installed startup shortcut: $shortcutPath"
