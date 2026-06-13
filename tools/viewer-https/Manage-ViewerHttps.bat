@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"

fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting Windows administrator permission...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  if errorlevel 1 (
    echo Administrator permission was not granted. Run this file again and choose Yes in UAC.
    pause
  )
  exit /b
)

title UE-Mat Viewer HTTPS Manager
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%Manage-ViewerHttps.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo Operation finished.
) else (
  echo Operation failed. Exit code: %EXIT_CODE%
)
echo Review the result above, then close this window.
pause
exit /b %EXIT_CODE%
