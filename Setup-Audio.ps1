param([string]$ProxyUrl = '')
$ErrorActionPreference = 'Stop'
$studyAssets = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'server/audio/model-assets.json') -Raw | ConvertFrom-Json
$studyModelDir = Join-Path $PSScriptRoot 'models/sensevoice'
New-Item -ItemType Directory -Force -Path $studyModelDir | Out-Null
foreach($studyAsset in @($studyAssets.models.int8,$studyAssets.tokens,$studyAssets.vad)) {
  $studyTarget = Join-Path $studyModelDir $studyAsset.name
  if((Test-Path -LiteralPath $studyTarget) -and (Get-FileHash -LiteralPath $studyTarget -Algorithm SHA256).Hash.ToLower() -eq $studyAsset.sha256){Write-Output "Verified $($studyAsset.name)";continue}
  $studyPart = $studyTarget+'.part'
  $studyArguments = @('--fail','--location','--connect-timeout','20','--max-time','600','--retry','1','--output',$studyPart)
  if($ProxyUrl){$studyArguments += @('--proxy',$ProxyUrl)}
  $studyArguments += $studyAsset.url
  & curl.exe @studyArguments
  if($LASTEXITCODE -ne 0){throw "Download failed: $($studyAsset.name)"}
  if((Get-Item -LiteralPath $studyPart).Length -ne $studyAsset.bytes -or (Get-FileHash -LiteralPath $studyPart -Algorithm SHA256).Hash.ToLower() -ne $studyAsset.sha256){throw "Asset verification failed: $($studyAsset.name)"}
  Move-Item -LiteralPath $studyPart -Destination $studyTarget -Force
  Write-Output "Verified $($studyAsset.name)"
}
$studyCaptureBinary = Join-Path $PSScriptRoot 'models/loopback/loopback_capture_addon.node'
$studyCaptureManifest = Join-Path $PSScriptRoot 'models/loopback/build.json'
$studyCaptureValid = $false
if ((Test-Path -LiteralPath $studyCaptureBinary) -and (Test-Path -LiteralPath $studyCaptureManifest)) {
  try {
    $studyCaptureBuild = Get-Content -LiteralPath $studyCaptureManifest -Raw | ConvertFrom-Json
    $studyCaptureValid = $studyCaptureBuild.version -eq 'pcm-silence-v1' -and (Get-FileHash -LiteralPath $studyCaptureBinary -Algorithm SHA256).Hash.ToLower() -eq $studyCaptureBuild.sha256
  } catch { $studyCaptureValid = $false }
}
if (!$studyCaptureValid) { & (Join-Path $PSScriptRoot 'Build-AudioCapture.ps1') -ProxyUrl $ProxyUrl }
