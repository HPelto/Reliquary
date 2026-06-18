@echo off
REM Dev launcher that advertises your PUBLIC IP for voice, so friends OUTSIDE
REM your LAN can connect to voice channels. Use the normal start-keep.cmd for
REM local/LAN testing. Port-forward on your router to this machine:
REM   TCP 7777  (chat / everything)   and   UDP 7011  (voice)
title Henry's Keep [PUBLIC VOICE] - Reliquary
set KEEP_SUPERVISED=1

echo Detecting your public IP for voice...
set PUBIP=
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 5).Trim() } catch { '' }"`) do set PUBIP=%%i

if "%PUBIP%"=="" (
  echo   WARNING: couldn't detect a public IP - voice will only work on your LAN.
  set VOICEARG=
) else (
  echo   Public IP: %PUBIP%   ^(advertising this for voice^)
  set VOICEARG=-voice-ip %PUBIP%
)
echo   Reminder: forward TCP 7777 and UDP 7011 to this PC on your router.
echo.

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

"%~dp0keep.exe" -addr :7777 -data "%~dp0dev-keep.db" -name "Henry's Keep" %VOICEARG%

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
