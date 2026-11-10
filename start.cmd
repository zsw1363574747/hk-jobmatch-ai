@echo off
setlocal
cd /d "%~dp0"
title jobmatch

set "JOBMATCH_DATA_DIR=%~dp0data"
if not defined JOBMATCH_PORT set "JOBMATCH_PORT=7790"

rem Keep this file CRLF and comments ASCII-only: cmd.exe mis-parses UTF-8 comments.
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)
if not "%NODE%"=="node" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo [jobmatch] Node.js 22+ was not found.
  echo            Install it from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)

:run
rem --use-system-ca lets Node trust the Windows cert store behind a proxy/AV.
rem Older Node builds do not support the flag, so fall back to a plain start.
"%NODE%" --use-system-ca "%~dp0web\server.mjs"
if errorlevel 1 "%NODE%" "%~dp0web\server.mjs"

echo.
echo [jobmatch] server exited. Press any key to close.
pause >nul