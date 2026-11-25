param([switch]$Trial)
$ErrorActionPreference = 'Stop'
$captureProject = $PSScriptRoot
$captureData = Join-Path $env:APPDATA 'study-system'
if ($Trial) {
  $captureManifest = Get-Content -LiteralPath (Join-Path $captureProject '.probe\m1-evidence\m2-demo-ready.json') -Raw | ConvertFrom-Json
  $captureData = [System.IO.Path]::GetFullPath($captureManifest.dataDir)
}
if (-not (Test-Path -LiteralPath (Join-Path $captureData 'study.db') -PathType Leaf)) { throw 'Existing study database not found; start the correct service first.' }
$capturePreviousData = $env:STUDY_DATA_DIR
try {
  $env:STUDY_DATA_DIR = $captureData
  Write-Output $(if ($Trial) { 'Trial collector: select port 7789 in the extension.' } else { 'Production collector: select port 7788 in the extension.' })
  Write-Output 'Local pairing code (paste into the extension; do not send to DSH chat):'
  & node (Join-Path $captureProject 'server\cli.mjs') capture-key
  if ($LASTEXITCODE -ne 0) { throw 'Pairing setup failed.' }
  Write-Output ('Load unpacked extension folder: ' + (Join-Path $captureProject 'browser-extension'))
} finally { $env:STUDY_DATA_DIR = $capturePreviousData }
