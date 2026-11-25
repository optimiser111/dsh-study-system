param([int]$TimeoutSeconds = 3)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StudyDesktopNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,System.Text.StringBuilder text,int length);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
}
'@
function Await-WinRT($Operation, $ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  if (-not $task.Wait($TimeoutSeconds * 1000)) { throw 'media-timeout' }
  return $task.Result
}
$clientName = [string][char]0x54d4+[char]0x54e9+[char]0x54d4+[char]0x54e9
$clients = @(Get-Process -Name $clientName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
if (-not $clients.Count) { @{ detected = $false; errorCode = 'client-not-running' } | ConvertTo-Json -Compress; exit 0 }
$front = [StudyDesktopNative]::GetForegroundWindow()
$client = $clients | Where-Object { $_.MainWindowHandle -eq $front } | Select-Object -First 1
if (-not $client) { $client = $clients | Select-Object -First 1 }
$frontProcessId = [uint32]0
[StudyDesktopNative]::GetWindowThreadProcessId($front,[ref]$frontProcessId) | Out-Null
$isForeground = $false
$targetHandle = $client.MainWindowHandle
try { $isForeground = (Get-Process -Id $frontProcessId -ErrorAction Stop).Path -eq $client.Path } catch { }
if ($isForeground) { $targetHandle = $front }
$targetTitle = New-Object System.Text.StringBuilder 512
[StudyDesktopNative]::GetWindowText($targetHandle,$targetTitle,512) | Out-Null
$inputDesktop = [StudyDesktopNative]::OpenInputDesktop(0,$false,1)
$locked = $inputDesktop -eq [IntPtr]::Zero
if (-not $locked) { [StudyDesktopNative]::CloseDesktop($inputDesktop) | Out-Null }
$result = @{ detected = $true; app = @{ processId = $client.Id; name = $client.ProcessName; executable = $client.Path; windowTitle = $targetTitle.ToString(); foreground = $isForeground }; locked = $locked; nodes = @(); media = $null; errors = @() }
if ($locked) { $result | ConvertTo-Json -Depth 7 -Compress; exit 0 }
try {
  $command = (Get-CimInstance Win32_Process -Filter "ProcessId=$($client.Id)").CommandLine
  if ($command -match '--remote-debugging-port=7790(?:\s|$)') {
    $listeners = @(Get-NetTCPConnection -LocalPort 7790 -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0 -and @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count -eq 0) {
      $owners = @($listeners | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction Stop).Path } | Select-Object -Unique)
      if ($owners.Count -eq 1 -and $owners[0] -eq $client.Path) { $result.bridgePort = 7790 }
    }
  }
} catch { $result.errors += 'bridge-unavailable' }
try {
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $manager = Await-WinRT ($managerType::RequestAsync()) $managerType
  $sessions = @($manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'bilibili' -or $_.SourceAppUserModelId -like ('*'+$clientName+'*') })
  if ($sessions.Count -eq 1) {
    $session = $sessions[0]
    $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
    $props = Await-WinRT ($session.TryGetMediaPropertiesAsync()) $propsType
    $timeline = $session.GetTimelineProperties()
    $info = $session.GetPlaybackInfo()
    $result.media = @{ appId = $session.SourceAppUserModelId; title = $props.Title; subtitle = $props.Subtitle; position = $timeline.Position.TotalSeconds; duration = $timeline.EndTime.TotalSeconds; status = $info.PlaybackStatus.ToString(); rate = $info.PlaybackRate; updatedAt = $timeline.LastUpdatedTime.ToString('o') }
  } elseif ($sessions.Count -gt 1) { $result.errors += 'multiple-media-sessions' }
} catch { $result.errors += 'media-unavailable' }
try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($targetHandle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ element = $root; parent = '' })
  $count = 0
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  while ($queue.Count -gt 0 -and $count -lt 600 -and $timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $entry = $queue.Dequeue(); $element = $entry.element; $count++
    try {
      $current = $element.Current
      if ($current.IsPassword) { continue }
      $kind = $current.ControlType.ProgrammaticName.Replace('ControlType.','')
      $name = $current.Name
      $id = $current.AutomationId
      $node = @{ type = $kind; name = $(if ($name.Length -gt 300) { $name.Substring(0,300) } else { $name }); id = $id; parent = $entry.parent }
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $value = $pattern.Current.Value; if ($value.Length -le 500) { $node.value = $value } }
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { $node.selected = $pattern.Current.IsSelected }
      if ($name -or $node.value -or $node.selected) { $result.nodes += $node }
      $child = $walker.GetFirstChild($element)
      $parentKey = [string]$count
      while ($child -and $queue.Count -lt 600) { $queue.Enqueue(@{ element = $child; parent = $parentKey }); $child = $walker.GetNextSibling($child) }
    } catch { }
  }
} catch { $result.errors += 'accessibility-unavailable' }
$result | ConvertTo-Json -Depth 7 -Compress
