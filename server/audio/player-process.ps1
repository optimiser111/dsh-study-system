param([ValidateSet('desktop','browser')][string]$Source='desktop',[int]$PlayerProcessId=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LearningAudioWindow {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
[uint32]$studyAudioPid=0
if($Source -eq 'desktop' -and $PlayerProcessId -gt 0){$studyAudioPid=[uint32]$PlayerProcessId}
else{[LearningAudioWindow]::GetWindowThreadProcessId([LearningAudioWindow]::GetForegroundWindow(),[ref]$studyAudioPid) | Out-Null}
$studyAudioProcess=Get-Process -Id $studyAudioPid -ErrorAction Stop
if($Source -eq 'desktop' -and $studyAudioProcess.ProcessName -notmatch '^(bilibili|\u54d4\u54e9\u54d4\u54e9)$'){throw 'Foreground Bilibili player changed.'}
if($Source -eq 'browser' -and ($studyAudioProcess.ProcessName -notmatch '^(chrome|msedge|firefox)$' -or $studyAudioProcess.MainWindowTitle -notmatch 'bilibili|\u54d4\u54e9\u54d4\u54e9')){throw 'Foreground Bilibili browser page changed.'}
@{pid=$studyAudioProcess.Id;name=$studyAudioProcess.ProcessName} | ConvertTo-Json -Compress
