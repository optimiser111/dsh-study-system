param([string]$NodePath)
$ErrorActionPreference = 'Stop'
$startScript = Join-Path $PSScriptRoot 'Start-Study.ps1'
$logFolder = Join-Path $PSScriptRoot '.probe\service'
New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
$logFile = Join-Path $logFolder 'startup.log'
$failed = $false
$startLock = New-Object System.Threading.Mutex($false, 'Local\DshStudyServicesLaunch')
$ownsLock = $false
try {
  try { $ownsLock = $startLock.WaitOne(25000) }
  catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
  if (-not $ownsLock) { throw 'Another launcher is still starting the study services.' }

  foreach ($port in @(7788, 7789)) {
    try {
      $startOptions = @{ NodePath = $NodePath; Port = $port }
      $expectedDatabase = Join-Path $env:APPDATA 'study-system\study.db'
      if ($port -eq 7789) {
        $manifestPath = Join-Path $PSScriptRoot '.probe\m1-evidence\m2-demo-ready.json'
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if (-not $manifest.dataDir -or -not (Test-Path -LiteralPath (Join-Path $manifest.dataDir 'study.db') -PathType Leaf)) {
          throw 'Existing trial database was not found.'
        }
        $startOptions.DataDir = $manifest.dataDir
        $expectedDatabase = Join-Path $manifest.dataDir 'study.db'
      }
      & $startScript @startOptions
      $ready = $false
      for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
          $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
          if ($health.ok -eq $true) {
            $ready = $health.database -eq $expectedDatabase
            break
          }
        } catch { }
        Start-Sleep -Milliseconds 500
      }
      if (-not $ready) { throw 'The expected database did not become ready.' }
      Add-Content -LiteralPath $logFile -Value "$([DateTimeOffset]::Now.ToString('o')) port=$port ready" -Encoding UTF8
    } catch {
      $failed = $true
      Add-Content -LiteralPath $logFile -Value "$([DateTimeOffset]::Now.ToString('o')) port=$port $($_.Exception.Message)" -Encoding UTF8
    }
  }
} finally {
  if ($ownsLock) { $startLock.ReleaseMutex() }
  $startLock.Dispose()
}
if ($failed) { exit 1 }
