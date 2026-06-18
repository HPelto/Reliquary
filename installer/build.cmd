@echo off
title Build Reliquary Installer
pushd "%~dp0"

if not exist node_modules (
  echo Installing build tooling...
  call npm install || (echo npm install failed & popd & pause & exit /b 1)
)

echo Building the Reliquary installer...
call npx tauri build --no-bundle
if errorlevel 1 (
  echo.
  echo Build failed - see errors above.
  popd & pause & exit /b 1
)

if not exist "..\installation_File" mkdir "..\installation_File"
copy /Y "src-tauri\target\release\reliquary-installer.exe" "..\installation_File\ReliquarySetup.exe" >nul

echo.
echo Done. Distributable installer:  installation_File\ReliquarySetup.exe
echo.
popd
pause
