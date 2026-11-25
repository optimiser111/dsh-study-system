@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-BilibiliLearning.ps1" %*
exit /b %errorlevel%
