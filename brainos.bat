@echo off
rem BrainOS launcher: starts the server and opens the dashboard in the browser.
rem Double-click this file, or run it from a terminal. Close the window (or Ctrl+C) to stop.
setlocal EnableExtensions

rem Re-entrant mode: a background copy of this script that waits for the port, then opens the browser.
if /i "%~1"=="--open-when-ready" goto :openWhenReady

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [BrainOS] node was not found on PATH. Install Node 20+ from https://nodejs.org and retry.
  goto :fail
)

node -e "process.exit(parseInt(process.versions.node,10)>=20?0:1)"
if errorlevel 1 (
  for /f "delims=" %%V in ('node -v') do echo [BrainOS] Node %%V is too old - BrainOS needs Node 20+.
  goto :fail
)

rem Host and port come from config.json (falling back to the server's own defaults).
set "HOST=127.0.0.1"
set "PORT=4321"
for /f "usebackq tokens=1,2" %%A in (`node -e "const c=require('./config.json');console.log((c.host||'127.0.0.1')+' '+(c.port||4321))" 2^>nul`) do (
  set "HOST=%%A"
  set "PORT=%%B"
)

rem 0.0.0.0 is a bind address, not something a browser can visit.
set "BROWSERHOST=%HOST%"
if "%BROWSERHOST%"=="0.0.0.0" set "BROWSERHOST=127.0.0.1"
if "%BROWSERHOST%"=="::" set "BROWSERHOST=127.0.0.1"
set "URL=http://%BROWSERHOST%:%PORT%"

call :isUp
if not errorlevel 1 (
  echo [BrainOS] Already running at %URL% - opening the app.
  start "" "%URL%"
  goto :done
)

rem Background copy of this script opens the browser once the server answers.
start "" /b cmd /c ""%~f0" --open-when-ready %HOST% %PORT%"

echo [BrainOS] Starting server on %URL%  (Ctrl+C or close this window to stop)
node server.js
set "EXITCODE=%errorlevel%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [BrainOS] Server exited with code %EXITCODE%.
  goto :fail
)
goto :done

:openWhenReady
rem args: %2 = host, %3 = port. Poll for up to ~60s, then open the browser.
set "HOST=%~2"
set "PORT=%~3"
set "BROWSERHOST=%HOST%"
if "%BROWSERHOST%"=="0.0.0.0" set "BROWSERHOST=127.0.0.1"
if "%BROWSERHOST%"=="::" set "BROWSERHOST=127.0.0.1"
for /l %%I in (1,1,60) do (
  call :isUp
  if not errorlevel 1 (
    start "" "http://%BROWSERHOST%:%PORT%"
    exit /b 0
  )
  rem ~1s pause that works without a console (timeout /t needs stdin).
  ping -n 2 127.0.0.1 >nul
)
exit /b 1

:isUp
rem Sets errorlevel 0 when something is listening on %HOST%:%PORT%, 1 otherwise.
node -e "const n=require('net');const s=n.connect(+process.argv[1],process.argv[2],()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(1500,()=>{s.destroy();process.exit(1)})" %PORT% %HOST% 2>nul
exit /b %errorlevel%

:fail
echo.
pause
exit /b 1

:done
endlocal
exit /b 0
