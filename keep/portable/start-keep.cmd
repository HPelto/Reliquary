@echo off
title Reliquary Keep
cd /d "%~dp0"

REM Portable Keep launcher — just runs the prebuilt keep.exe (no Go, no source).
REM KEEP_SUPERVISED enables the Host Console "Restart" button (exit 42 loops here).
set KEEP_SUPERVISED=1
set KEEP_PORTABLE=1

echo Starting your Reliquary Keep...  (first run prints an admin key - save it!)
echo.

:loop
keep.exe %*
if "%errorlevel%"=="42" goto loop

echo.
echo The Keep has stopped (exit %errorlevel%). You can close this window.
pause >nul
