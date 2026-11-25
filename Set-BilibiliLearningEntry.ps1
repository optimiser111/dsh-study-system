param([switch]$Restore)
$ErrorActionPreference = 'Stop'
$clientName = [string][char]0x54d4 + [char]0x54e9 + [char]0x54d4 + [char]0x54e9
$shortcutPath = Join-Path $env:ProgramData ('Microsoft\Windows\Start Menu\Programs\' + $clientName + '.lnk')
if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'The original Bilibili Start menu shortcut was not found.' }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ([IO.Path]::GetFileName($shortcut.TargetPath) -ne ($clientName + '.exe') -or -not (Test-Path -LiteralPath $shortcut.TargetPath -PathType Leaf)) {
    throw 'The shortcut does not point to the official Bilibili executable.'
}
$backupDirectory = Join-Path $PSScriptRoot '.probe\bilibili-default-entry'
$backupPath = Join-Path $backupDirectory 'original.lnk'
$metadataPath = Join-Path $backupDirectory 'original.json'
if ($Restore) {
    if (-not (Test-Path -LiteralPath $metadataPath) -or -not (Test-Path -LiteralPath $backupPath)) { throw 'The original shortcut backup was not found.' }
    $original = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
    if ($original.shortcut -ne $shortcutPath -or $original.target -ne $shortcut.TargetPath) { throw 'The shortcut target has changed; inspect before restoring.' }
    if ($original.userShortcut) {
        $expectedUserPath = Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\' + $clientName + '.lnk')
        if ($original.userShortcut -ne $expectedUserPath) { throw 'Unexpected user shortcut path.' }
        if (Test-Path -LiteralPath $expectedUserPath) {
            $userShortcut = $shell.CreateShortcut($expectedUserPath)
            if ($userShortcut.TargetPath -ne $original.target -or $userShortcut.Arguments -notmatch '--remote-debugging-port=7790(?:\s|$)') { throw 'The user shortcut has changed; inspect before restoring.' }
            Remove-Item -LiteralPath $expectedUserPath
        }
        if ($original.desktopShortcut) {
            $expectedDesktopPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ($clientName + '.lnk')
            if ($original.desktopShortcut -ne $expectedDesktopPath) { throw 'Unexpected desktop shortcut path.' }
            if (Test-Path -LiteralPath $expectedDesktopPath) {
                $desktopLink = $shell.CreateShortcut($expectedDesktopPath)
                if ($desktopLink.TargetPath -ne $original.target -or $desktopLink.Arguments -notmatch '--remote-debugging-port=7790(?:\s|$)') { throw 'The desktop shortcut has changed; inspect before restoring.' }
                Remove-Item -LiteralPath $expectedDesktopPath
            }
        }
        Write-Output 'The per-user learning entry was removed; the original shared icon remains available.'
        return
    }
    Copy-Item -LiteralPath $backupPath -Destination $shortcutPath -Force
    Write-Output 'Original Bilibili shortcut restored.'
    return
}
if ($shortcut.Arguments -match '--remote-debugging-port(?:=|\s+)\d+' -and $shortcut.Arguments -notmatch '--remote-debugging-port=7790(?:\s|$)') {
    throw 'The shortcut already has a different debugging port; inspect before changing it.'
}
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $metadataPath)) {
    Copy-Item -LiteralPath $shortcutPath -Destination $backupPath -Force
    @{ shortcut = $shortcutPath; target = $shortcut.TargetPath; arguments = $shortcut.Arguments } |
        ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}
$arguments = $shortcut.Arguments
# Keep existing launch options and normalize only the three learning options.
$arguments = $arguments -replace '(?:^|\s+)--force-renderer-accessibility(?=\s|$)', ''
$arguments = $arguments -replace '(?:^|\s+)--remote-debugging-address(?:=|\s+)(?:"[^"]*"|\S+)', ''
$arguments = $arguments -replace '(?:^|\s+)--remote-debugging-port=7790(?=\s|$)', ''
$shortcut.Arguments = ($arguments.Trim() + ' --force-renderer-accessibility --remote-debugging-address=127.0.0.1 --remote-debugging-port=7790').Trim()
try { $shortcut.Save() }
catch [System.UnauthorizedAccessException] {
    # Shared Start menu entries can be administrator-owned. Use the matching
    # per-user Start menu entry so the ordinary icon keeps its name and target.
    $userDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $userPath = Join-Path $userDirectory ($clientName + '.lnk')
    New-Item -ItemType Directory -Path $userDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $userPath) {
        $existing = $shell.CreateShortcut($userPath)
        if ($existing.TargetPath -ne $shortcut.TargetPath -or $existing.Arguments -ne $shortcut.Arguments) { throw 'A different user Bilibili shortcut already exists.' }
    } else {
        Copy-Item -LiteralPath $shortcutPath -Destination $userPath
        $userShortcut = $shell.CreateShortcut($userPath)
        $userShortcut.Arguments = $shortcut.Arguments
        $userShortcut.Save()
    }
    $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
    $metadata | Add-Member -NotePropertyName userShortcut -NotePropertyValue $userPath -Force
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
    $shortcutPath = $userPath
}
$verified = $shell.CreateShortcut($shortcutPath)
if ($verified.Arguments -ne $shortcut.Arguments) { throw 'The shortcut update could not be verified.' }
$desktopPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ($clientName + '.lnk')
if (-not (Test-Path -LiteralPath $desktopPath)) {
    Copy-Item -LiteralPath $shortcutPath -Destination $desktopPath
    $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
    $metadata | Add-Member -NotePropertyName desktopShortcut -NotePropertyValue $desktopPath -Force
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}
$desktopVerified = $shell.CreateShortcut($desktopPath)
if ($desktopVerified.TargetPath -ne $verified.TargetPath -or $desktopVerified.Arguments -ne $verified.Arguments) { throw 'The existing desktop icon uses another entry; inspect before replacing it.' }
Write-Output 'Bilibili desktop and Start menu entries are ready. Fully exit Bilibili once, then open the desktop icon.'
