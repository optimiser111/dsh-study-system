param([string]$OutputPath)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
if(-not $OutputPath){$OutputPath=Join-Path $taskRoot '.probe\study-system-reading-bridge-0.1.0.vsix'}
$OutputPath=[IO.Path]::GetFullPath($OutputPath)
$null=New-Item -ItemType Directory -Path (Split-Path $OutputPath -Parent) -Force
Add-Type -AssemblyName System.IO.Compression
$files=@('package.json','extension.cjs','visible-content.cjs','README.md')
$manifest=@'
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
 <Metadata><Identity Language="en-US" Id="reading-bridge" Version="0.1.0" Publisher="study-system"/><DisplayName>Study System Reading Bridge</DisplayName><Description xml:space="preserve">Read visible VS Code editor lines during an active study capture.</Description><Tags>education</Tags><Categories>Education</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties><License>extension/README.md</License></Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
 <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets>
</PackageManifest>
'@
$types='<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'
$stream=[IO.File]::Open($OutputPath,[IO.FileMode]::Create)
$archive=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create)
try{
 foreach($name in @('extension.vsixmanifest','[Content_Types].xml')+$files){
  $entryName=if($files -contains $name){'extension/'+$name}else{$name}
  $content=if($name -eq 'extension.vsixmanifest'){$manifest}elseif($name -eq '[Content_Types].xml'){$types}else{[IO.File]::ReadAllText((Join-Path (Join-Path $taskRoot 'vscode-reading') $name))}
  $entry=$archive.CreateEntry($entryName);$writer=New-Object IO.StreamWriter($entry.Open(),(New-Object Text.UTF8Encoding($false)))
  try{$writer.Write($content)}finally{$writer.Dispose()}
 }
}finally{$archive.Dispose();$stream.Dispose()}
Write-Output $OutputPath
