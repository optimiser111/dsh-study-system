param([string]$ProxyUrl = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$studyRoot = $PSScriptRoot
$studyAssetDir = Join-Path $studyRoot '.probe/audio-native-assets'
New-Item -ItemType Directory -Force -Path $studyAssetDir | Out-Null
$studyAssets = Get-Content -LiteralPath (Join-Path $studyRoot 'server/audio/native/build-assets.json') -Raw | ConvertFrom-Json
foreach ($studyAsset in $studyAssets) {
  $studyTarget = Join-Path $studyAssetDir $studyAsset.name
  if (!(Test-Path -LiteralPath $studyTarget) -or (Get-FileHash -LiteralPath $studyTarget -Algorithm SHA256).Hash.ToLower() -ne $studyAsset.sha256) {
    $studyArguments = @('--fail','--location','--connect-timeout','20','--max-time','180','--output',($studyTarget+'.part'))
    if ($ProxyUrl) { $studyArguments += @('--proxy',$ProxyUrl) }
    & curl.exe @studyArguments $studyAsset.url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $($studyAsset.name)" }
    if ((Get-FileHash -LiteralPath ($studyTarget+'.part') -Algorithm SHA256).Hash.ToLower() -ne $studyAsset.sha256) { throw 'Build asset hash mismatch' }
    Move-Item -LiteralPath ($studyTarget+'.part') -Destination $studyTarget -Force
  }
}
& tar.exe -xzf (Join-Path $studyAssetDir 'node-headers.tar.gz') -C $studyAssetDir
if ($LASTEXITCODE -ne 0) { throw 'Node header extraction failed' }
& tar.exe -xzf (Join-Path $studyAssetDir 'node-addon-api.tgz') -C $studyAssetDir
if ($LASTEXITCODE -ne 0) { throw 'N-API header extraction failed' }
Expand-Archive -LiteralPath (Join-Path $studyAssetDir 'wil.zip') -DestinationPath (Join-Path $studyAssetDir 'wil') -Force
$studyVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$studyVsInstall = & $studyVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath -utf8
if (!$studyVsInstall) { throw 'Visual Studio C++ tools and Windows SDK are required to rebuild the capture runtime' }
$studyCmake = Join-Path $studyVsInstall 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
if (!(Test-Path -LiteralPath $studyCmake)) { $studyCmake = (Get-Command cmake.exe).Source }
& node.exe (Join-Path $studyRoot 'server/audio/native/prepare.mjs') $studyRoot
if ($LASTEXITCODE -ne 0) { throw 'Capture patch failed' }
$studyStage = Join-Path $studyRoot '.probe/audio-native-source'
$studyBuild = Join-Path $studyRoot '.probe/audio-native-build'
$studyCompilerVersion = Get-ChildItem -LiteralPath (Join-Path $studyVsInstall 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$studyCompiler = (Join-Path $studyCompilerVersion.FullName 'bin/Hostx64/x64/cl.exe').Replace('\','/')
& $studyCmake --fresh -S $studyStage -B $studyBuild -G 'Visual Studio 17 2022' -A x64 "-DCMAKE_CXX_COMPILER=$studyCompiler"
if ($LASTEXITCODE -ne 0) { throw 'Capture configure failed' }
& $studyCmake --build $studyBuild --config Release --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Capture build failed' }
$studyRuntime = Join-Path $studyRoot 'models/loopback'
New-Item -ItemType Directory -Force -Path $studyRuntime | Out-Null
Copy-Item -LiteralPath (Join-Path $studyBuild 'Release/loopback_capture_addon.node') -Destination $studyRuntime -Force
Copy-Item -LiteralPath (Join-Path $studyStage 'LICENSE') -Destination $studyRuntime -Force
$studyRuntimeHash = (Get-FileHash -LiteralPath (Join-Path $studyRuntime 'loopback_capture_addon.node') -Algorithm SHA256).Hash.ToLower()
@{ version='pcm-silence-v1'; upstream='loopback-capture@4.0.0'; napi=9; sha256=$studyRuntimeHash } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $studyRuntime 'build.json') -Encoding Ascii
Write-Output "Built silence-preserving capture runtime: $studyRuntimeHash"
