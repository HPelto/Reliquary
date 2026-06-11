@echo off
title Henry's Keep - Reliquary
set KEEP_SUPERVISED=1

:loop
pushd "%~dp0"
echo Building keep.exe...
go build -o keep.exe ./cmd/keep
if errorlevel 1 (
  echo Build failed - see errors above.
  popd
  pause
  exit /b 1
)
popd

"%~dp0keep.exe" -addr :7777 -data "%~dp0dev-keep.db" -name "Henry's Keep"

if %errorlevel%==43 (
  echo.
  echo === Update requested - pulling latest source then rebuilding ===
  echo.
  pushd "%~dp0"
  git pull
  popd
  goto loop
)
if %errorlevel%==42 (
  echo.
  echo === Restart requested from the host console - rebuilding ===
  echo.
  goto loop
)

echo.
echo The Keep has stopped.
pause
