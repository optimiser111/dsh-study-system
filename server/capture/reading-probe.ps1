param([string]$ImagePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime]
$awaitMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
function Wait-WinRT($operation,[Type]$resultType){$task=$awaitMethod.MakeGenericMethod($resultType).Invoke($null,@($operation));$task.GetAwaiter().GetResult()}
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class StudyReadingWindow {
 public delegate bool EnumCallback(IntPtr hwnd,IntPtr data);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr data);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint processId);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
$null=[StudyReadingWindow]::SetProcessDPIAware()
function Window-Info([IntPtr]$handle){
 $builder=New-Object System.Text.StringBuilder 1024;$null=[StudyReadingWindow]::GetWindowText($handle,$builder,1024)
 [uint32]$windowProcessId=0;$null=[StudyReadingWindow]::GetWindowThreadProcessId($handle,[ref]$windowProcessId)
 try{$process=Get-Process -Id $windowProcessId -ErrorAction Stop; $started=$process.StartTime.ToUniversalTime().Ticks.ToString()}catch{return $null}
 [pscustomobject]@{id=$handle.ToInt64().ToString();processId=$windowProcessId;process=$process.ProcessName;started=$started;title=$builder.ToString().Trim()}
}
function Reading-Windows {
 $script:windowRows=New-Object System.Collections.Generic.List[object];$script:windowRank=0;$script:videoRank=9999
 $callback=[StudyReadingWindow+EnumCallback]{param($handle,$unused)
  if([StudyReadingWindow]::IsWindowVisible($handle) -and -not [StudyReadingWindow]::IsIconic($handle)){
   $info=Window-Info $handle
   if($info -and $info.title){
    if($info.process -match 'bilibili|哔哩哔哩'){$script:videoRank=[Math]::Min($script:videoRank,$script:windowRank)}
    $reader=$info.process -match '^(Acrobat|AcroRd32|FoxitPDFReader|FoxitReader|SumatraPDF|WINWORD|wps|wpspdf|zotero|PDFXEdit|notepad)$'
    $browser=$info.process -match '^(msedge|chrome|firefox|brave|vivaldi)$'
    $editor=$info.process -match '^(Code|Code - Insiders|code-insiders)$'
    if($reader -or $browser -or $editor){$info|Add-Member -NotePropertyName kind -NotePropertyValue $(if($editor){'editor'}else{'document'});$info|Add-Member -NotePropertyName strict -NotePropertyValue ([bool]($editor -or ($reader -and $info.process -notmatch 'notepad|zotero') -or $info.title -match '\.pdf(?:\b|$)|\bPDF\b'));$info|Add-Member -NotePropertyName rank -NotePropertyValue $script:windowRank;$script:windowRows.Add($info)}
   };$script:windowRank++
  };return $true
 }
 $null=[StudyReadingWindow]::EnumWindows($callback,[IntPtr]::Zero)
 @{windows=@($script:windowRows.ToArray());videoRank=$script:videoRank;languages=@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {$_.LanguageTag})}
}
function Bitmap-Ocr([System.Drawing.Bitmap]$image){
 $memory=New-Object System.IO.MemoryStream
 $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
 $software=$null;$writer=$null
 try{
  $image.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
  $writer=New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0));$writer.WriteBytes($memory.ToArray())
  $null=Wait-WinRT ($writer.StoreAsync()) ([uint32]);$null=$writer.DetachStream();$writer.Dispose();$writer=$null
  $stream.Seek(0)
  $decoder=Wait-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $software=Wait-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $languages=@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
  $engines=@();foreach($tag in @('zh-Hans-CN','en-GB','en-US')){if($languages.LanguageTag -contains $tag){$engines+=,[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($tag)))}}
  if(-not $engines.Count){$engines+=,[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
  if(-not $engines[0]){throw 'No installed OCR language'}
  $chosen=$null;$language=$null
  foreach($engine in $engines){
   $result=Wait-WinRT ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
   $chosen=$result;$language=$engine.RecognizerLanguage.LanguageTag
   if($language -notmatch '^zh' -or [regex]::Matches($result.Text,'[\p{IsCJKUnifiedIdeographs}]').Count -ge 5){break}
  }
  $lines=@($chosen.Lines | ForEach-Object {
   $words=@($_.Words);$left=($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum
   $top=($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
   $right=($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
   $bottom=($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
   @{text=$_.Text;x=$left;y=$top;width=$right-$left;height=$bottom-$top}
  })
  @{lines=$lines;width=$image.Width;height=$image.Height;language=$language;engine='windows-ocr'}
 }finally{if($writer){$writer.Dispose()};if($software){$software.Dispose()};$stream.Dispose();$memory.Dispose()}
}
function Check-Reading($request){
 $handle=[IntPtr]([long]$request.window.id);$info=Window-Info $handle
 if(-not $info -or $info.processId -ne $request.window.processId -or $info.started -ne $request.window.started){return @{state='window-closed'}}
 if($info.process -notmatch '^(Code|Code - Insiders|code-insiders)$' -and $info.title -ne $request.window.title){return @{state='document-changed'}}
 if([StudyReadingWindow]::GetForegroundWindow() -ne $handle -or [StudyReadingWindow]::IsIconic($handle)){return @{state='paused'}}
 return @{state='captured';window=$info}
}
function Capture-Reading($request){
 $check=Check-Reading $request;if($check.state -ne 'captured'){return $check}
 $handle=[IntPtr]([long]$request.window.id);$info=$check.window
 if($info.process -match '^(Code|Code - Insiders|code-insiders)$'){return @{state='editor-disconnected'}}
 $rect=New-Object StudyReadingWindow+Rect;$null=[StudyReadingWindow]::GetClientRect($handle,[ref]$rect)
 $width=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top
 if($width -lt 100 -or $height -lt 100 -or $width*$height -gt 32000000){return @{state='unreadable-window'}}
 $bitmap=New-Object System.Drawing.Bitmap($width,$height)
 try{
  $graphics=[System.Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
  try{$ok=[StudyReadingWindow]::PrintWindow($handle,$dc,3)}finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
  if(-not $ok){return @{state='capture-unavailable'}}
  $after=Window-Info $handle
  if([StudyReadingWindow]::GetForegroundWindow() -ne $handle -or $after.title -ne $info.title -or $after.processId -ne $info.processId -or $after.started -ne $info.started){return @{state='paused'}}
  $result=Bitmap-Ocr $bitmap
  $after=Window-Info $handle
  if([StudyReadingWindow]::GetForegroundWindow() -ne $handle -or $after.title -ne $info.title -or $after.processId -ne $info.processId -or $after.started -ne $info.started){return @{state='paused'}}
  $result.state='captured';$result.window=$info;return $result
 }finally{$bitmap.Dispose()}
}
if($ImagePath){$image=New-Object System.Drawing.Bitmap([System.IO.Path]::GetFullPath($ImagePath));try{Bitmap-Ocr $image | ConvertTo-Json -Depth 6 -Compress}finally{$image.Dispose()};exit}
while($line=[Console]::ReadLine()){
 try{$request=$line|ConvertFrom-Json;$value=if($request.action -eq 'list'){Reading-Windows}elseif($request.action -eq 'capture'){Capture-Reading $request}elseif($request.action -eq 'check'){Check-Reading $request}else{throw 'Unknown operation'};@{id=$request.id;ok=$true;value=$value}|ConvertTo-Json -Depth 8 -Compress}
 catch{@{id=$request.id;ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Depth 3 -Compress}
}
