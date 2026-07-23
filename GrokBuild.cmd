@echo off
setlocal EnableExtensions
rem ============================================================
rem  Grok Build Desktop - one-command launcher (portable)
rem  Hermes Desktop UI  ->  grok-gateway server.mjs (:8787)  ->  Grok CLI
rem
rem  Paths auto-detect; override with env vars before launching:
rem    GROK_BUILD_HERMES_DIR  folder containing Hermes.exe
rem    GROK_BUILD_PORT        gateway port (default 8787)
rem    GROK_BUILD_TOKEN       gateway token (default local-grok-dev-token)
rem    GROK_BUILD_NOPAUSE     set to 1 to never block on errors (automation)
rem    GROK_BUILD_ICON        custom .ico path (default docs\assets\grok-build-icon.ico)
rem    GROK_BUILD_APP_ICON_PNG  1024x1024 PNG for the LIVE window/taskbar icon
rem                          (default docs\assets\grok-build-icon-1024.png)
rem    GROK_BUILD_NO_REBRAND  set to 1 to skip the re-iconed exe copy entirely
rem                          and launch stock Hermes.exe directly
rem    GROK_BUILD_NO_PLAYWRIGHT  set to 1 to skip auto-starting the Playwright
rem                          MCP server Grok's config expects on 127.0.0.1:8931
rem    GROK_BUILD_PLAYWRIGHT_PS1  override the Playwright MCP starter script
rem    GROK_BUILD_PLAYWRIGHT_DIR  Playwright profile/log dir (default: tmp\playwright next to this repo)
rem    GROK_BUILD_NO_CUA_DRIVER  set to 1 to skip auto-starting the cua-driver
rem                          daemon (real desktop control: screenshot/click/
rem                          type/scroll/UIA). Install once from README.
rem    GROK_BUILD_CUA_DRIVER_EXE  override the cua-driver.exe path
rem ============================================================

if not defined GROK_BUILD_PORT set "GROK_BUILD_PORT=8787"
if not defined GROK_BUILD_TOKEN set "GROK_BUILD_TOKEN=local-grok-dev-token"
set "GW_URL=http://127.0.0.1:%GROK_BUILD_PORT%"

rem The gateway lives next to this script - no install path to configure.
set "GATEWAY_DIR=%~dp0"

rem Hermes desktop install: env override, then common locations.
set "HERMES_DIR=%GROK_BUILD_HERMES_DIR%"
if not defined HERMES_DIR if exist "%LOCALAPPDATA%\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe" set "HERMES_DIR=%LOCALAPPDATA%\hermes\hermes-agent\apps\desktop\release\win-unpacked"
if not defined HERMES_DIR if exist "%LOCALAPPDATA%\Programs\Hermes\Hermes.exe" set "HERMES_DIR=%LOCALAPPDATA%\Programs\Hermes"
set "HERMES_EXE=%HERMES_DIR%\Hermes.exe"

set "PROFILE_DIR=%LOCALAPPDATA%\GrokBuildDesktop"
set "LOG_DIR=%USERPROFILE%\.grok-hermes-desktop\logs"
set "BOOT_LOG=%LOG_DIR%\launcher.log"
set "GW_OUT=%LOG_DIR%\gateway-out.log"
set "GW_ERR=%LOG_DIR%\gateway-err.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not exist "%HERMES_EXE%" (
  echo %date% %time% launcher: FATAL Hermes.exe not found - set GROK_BUILD_HERMES_DIR >> "%BOOT_LOG%"
  echo Hermes.exe not found. Install Hermes Desktop, or set GROK_BUILD_HERMES_DIR
  echo to the folder containing Hermes.exe. See docs\SETUP.md.
  if not defined GROK_BUILD_NOPAUSE pause
  exit /b 1
)

rem Gateway deps (first run after clone).
if not exist "%GATEWAY_DIR%node_modules\ws" (
  echo %date% %time% launcher: installing gateway deps >> "%BOOT_LOG%"
  pushd "%GATEWAY_DIR%"
  cmd /c "npm install --omit=dev"
  popd
)

echo %date% %time% launcher: start >> "%BOOT_LOG%"

rem --- 1) gateway: reuse if healthy, else start supervisor.mjs (keeps server.mjs alive) ---
rem Bare server.mjs dies on hung turns / crashes and leaves Hermes with:
rem   "connect ECONNREFUSED 127.0.0.1:8787"  (backendStartFailure latch).
rem supervisor.mjs restarts the child and kills hung processes after 3 health fails.
rem EXPLICIT System32 paths for curl/findstr: a caller whose PATH puts Git's
rem mingw64/usr bin dirs first (e.g. a Git Bash-spawned launch) would resolve
rem bare `curl`/`find` to the Unix versions and this check would always fail
rem ("FATAL gateway did not become healthy") even with a healthy gateway —
rem that exact false-FATAL happened 4x on 2026-07-21 before this was pinned.
set "SYSCURL=%SystemRoot%\System32\curl.exe"
set "SYSFINDSTR=%SystemRoot%\System32\findstr.exe"
"%SYSCURL%" -s -m 2 "%GW_URL%/api/status" | "%SYSFINDSTR%" /C:"grok-gateway" >nul 2>nul
if not errorlevel 1 goto gateway_ok

echo %date% %time% launcher: starting gateway supervisor.mjs (no window) >> "%BOOT_LOG%"
rem NOTE: stdout and stderr MUST be different files - PowerShell 5.1
rem Start-Process rejects identical RedirectStandardOutput/-Error paths.
rem Supervisor owns gateway-out.log; console stream goes to supervisor-console.log.
set "SUP_OUT=%LOG_DIR%\supervisor-console.log"
set "SUP_ERR=%LOG_DIR%\supervisor-console.err.log"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:GROK_GATEWAY_PORT='%GROK_BUILD_PORT%'; $env:GROK_GATEWAY_TOKEN='%GROK_BUILD_TOKEN%'; Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'supervisor.mjs' -WorkingDirectory '%GATEWAY_DIR%.' -WindowStyle Hidden -RedirectStandardOutput '%SUP_OUT%' -RedirectStandardError '%SUP_ERR%'"

set /a tries=0
:wait_gateway
set /a tries+=1
if %tries% gtr 40 goto gateway_fail
rem ping-sleep: works even without an interactive console (timeout /t does not)
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
"%SYSCURL%" -s -m 2 "%GW_URL%/api/status" | "%SYSFINDSTR%" /C:"grok-gateway" >nul 2>nul
if errorlevel 1 goto wait_gateway

:gateway_ok
echo %date% %time% launcher: gateway healthy on %GROK_BUILD_PORT% >> "%BOOT_LOG%"

rem --- 1b) Playwright MCP: ensure the long-lived server Grok's config expects ---
rem ~/.grok/config.toml points [mcp_servers.playwright] at http://127.0.0.1:8931/mcp
rem in URL mode - Grok is a CLIENT ONLY and never spawns the server itself, so
rem without this step every session reports MCP connect failure ("auth
rem required" is the CLI's misleading label for "nothing listening"). The
rem starter script is idempotent (exits 0 fast if 8931 already listens) and
rem the MCP server is lightweight - Chrome only opens when a browser tool is
rem actually invoked mid-session. Best-effort: a failure here never blocks
rem the app; Grok just runs without browser tools until the next launch.
rem   GROK_BUILD_NO_PLAYWRIGHT=1   skip entirely
rem   GROK_BUILD_PLAYWRIGHT_PS1    override starter script path
if "%GROK_BUILD_NO_PLAYWRIGHT%"=="1" goto playwright_done
set "PLAYWRIGHT_PS1=%GROK_BUILD_PLAYWRIGHT_PS1%"
if not defined PLAYWRIGHT_PS1 set "PLAYWRIGHT_PS1=%GATEWAY_DIR%scripts\Start-PlaywrightMcp.ps1"
if not exist "%PLAYWRIGHT_PS1%" (
  echo %date% %time% launcher: no Playwright starter at %PLAYWRIGHT_PS1% - skipping >> "%BOOT_LOG%"
  goto playwright_done
)
"%SystemRoot%\System32\netstat.exe" -ano | "%SYSFINDSTR%" /C:":8931" | "%SYSFINDSTR%" /C:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo %date% %time% launcher: Playwright MCP already listening on 8931 >> "%BOOT_LOG%"
  goto playwright_done
)
echo %date% %time% launcher: starting Playwright MCP on 8931 >> "%BOOT_LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PLAYWRIGHT_PS1%" >> "%BOOT_LOG%" 2>&1
if errorlevel 1 (
  echo %date% %time% launcher: WARN Playwright MCP failed to start - continuing without browser tools >> "%BOOT_LOG%"
) else (
  echo %date% %time% launcher: Playwright MCP ready >> "%BOOT_LOG%"
)
:playwright_done

rem --- 1c) cua-driver - real desktop control: screenshot/click/type/scroll/UIA ---
rem Grok's config.toml points mcp_servers.cua_driver at a STDIO command, so
rem grok.exe spawns the MCP proxy itself per-session - we only need to ensure
rem the long-lived cua-driver SERVE DAEMON is running first. Without it,
rem every cua_driver tool call fails. Same idempotent ensure-running pattern
rem as Playwright. cua-driver is a separate, real open-source project -
rem github.com/trycua/cua, MIT, 20k+ stars - not bundled here; install once
rem with the official installer, see README.
rem This superseded our own custom computer-use-mcp - the nut-js-based one -
rem on 2026-07-23: cua-driver doesn't steal the real cursor or keyboard,
rem using a visible agent-cursor overlay instead; it works on background and
rem minimized windows; it offers accessibility-tree and browser-CDP tools
rem our build never had; and it is a maintained upstream instead of code we
rem would have to keep fixing ourselves.
rem   GROK_BUILD_NO_CUA_DRIVER=1     skip entirely
rem   GROK_BUILD_CUA_DRIVER_EXE      override the cua-driver.exe path
if "%GROK_BUILD_NO_CUA_DRIVER%"=="1" goto cua_driver_done
set "CUA_EXE=%GROK_BUILD_CUA_DRIVER_EXE%"
if not defined CUA_EXE set "CUA_EXE=%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe"
if not exist "%CUA_EXE%" (
  echo %date% %time% launcher: cua-driver not installed at %CUA_EXE% - real desktop control unavailable this session, see README for the one-time installer >> "%BOOT_LOG%"
  goto cua_driver_done
)
"%CUA_EXE%" status >nul 2>nul
if not errorlevel 1 (
  echo %date% %time% launcher: cua-driver daemon already running >> "%BOOT_LOG%"
  goto cua_driver_done
)
echo %date% %time% launcher: starting cua-driver daemon >> "%BOOT_LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%CUA_EXE%' -ArgumentList 'serve' -WindowStyle Hidden"
set /a cua_tries=0
:wait_cua_driver
set /a cua_tries+=1
if %cua_tries% gtr 20 (
  echo %date% %time% launcher: WARN cua-driver daemon did not come up in time - continuing without it >> "%BOOT_LOG%"
  goto cua_driver_done
)
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
"%CUA_EXE%" status >nul 2>nul
if errorlevel 1 goto wait_cua_driver
echo %date% %time% launcher: cua-driver daemon ready >> "%BOOT_LOG%"
:cua_driver_done

rem --- 2) repair window-state.json only if missing/corrupt ---
"%NODE_EXE%" "%GATEWAY_DIR%repair-window-state.mjs" "%PROFILE_DIR%\window-state.json" >> "%BOOT_LOG%" 2>nul

rem --- 2b) neutralize the Hermes self-update banner (stub git root) ---
rem Clicking "Update" against a real install would rebuild Hermes and quit
rem the app mid-session; a self-referential stub always reports behind=0.
set "UPDATE_STUB=%PROFILE_DIR%\update-root-stub"
if not exist "%UPDATE_STUB%\.git" (
  git init -q -b main "%UPDATE_STUB%" 2>nul
  if exist "%UPDATE_STUB%\.git" (
    pushd "%UPDATE_STUB%"
    git -c user.email=grokbuild@local -c user.name=GrokBuild commit -q --allow-empty -m stub
    git remote add origin "%UPDATE_STUB%" 2>nul
    popd
  )
)
if exist "%UPDATE_STUB%\.git" set "HERMES_DESKTOP_HERMES_ROOT=%UPDATE_STUB%"

rem --- 2c) re-iconed exe: distinct taskbar icon from stock Hermes ---
rem Grok Build and stock Hermes launch the SAME Hermes.exe path, so Windows
rem shows the same running-window taskbar icon for both. TWO layers must be
rem fixed (see build-grok-app.mjs header): the exe's own PE icon resource
rem (Explorer / pre-launch look) AND the LIVE window's icon, which Hermes
rem reads from an unpacked apple-touch-icon.png - NOT the exe resource. The
rem first alone looked fixed by file inspection but was NOT fixed live
rem (confirmed via an actual taskbar screenshot) - both are needed. Zero
rem Hermes code changes either way - a resource stamp + an asset swap.
rem Best-effort: any failure here falls back to launching stock Hermes.exe
rem directly - never blocks the app from starting.
set "LAUNCH_DIR=%HERMES_DIR%"
set "LAUNCH_EXE=%HERMES_EXE%"
if "%GROK_BUILD_NO_REBRAND%"=="1" goto skip_rebrand

set "GROK_APP_DIR=%LOCALAPPDATA%\GrokBuildDesktop\app"
set "GROK_APP_EXE=%GROK_APP_DIR%\GrokBuild.exe"
set "ICON_PATH=%GROK_BUILD_ICON%"
if not defined ICON_PATH set "ICON_PATH=%GATEWAY_DIR%docs\assets\grok-build-icon.ico"
set "APP_ICON_PNG=%GROK_BUILD_APP_ICON_PNG%"
if not defined APP_ICON_PNG set "APP_ICON_PNG=%GATEWAY_DIR%docs\assets\grok-build-icon-1024.png"

if exist "%ICON_PATH%" (
  "%NODE_EXE%" "%GATEWAY_DIR%scripts\build-grok-app.mjs" "%HERMES_DIR%" "%GROK_APP_DIR%" "%ICON_PATH%" "%APP_ICON_PNG%" >> "%BOOT_LOG%" 2>&1
  if exist "%GROK_APP_EXE%" (
    set "LAUNCH_DIR=%GROK_APP_DIR%"
    set "LAUNCH_EXE=%GROK_APP_EXE%"
  ) else (
    echo %date% %time% launcher: re-icon build failed - falling back to stock Hermes.exe >> "%BOOT_LOG%"
  )
) else (
  echo %date% %time% launcher: no icon at %ICON_PATH% - launching stock Hermes.exe >> "%BOOT_LOG%"
)
:skip_rebrand

rem --- 3) launch Hermes wired to the gateway ---
set "HERMES_DESKTOP_REMOTE_URL=%GW_URL%"
set "HERMES_DESKTOP_REMOTE_TOKEN=%GROK_BUILD_TOKEN%"
set "HERMES_DESKTOP_USER_DATA_DIR=%PROFILE_DIR%"
set "HERMES_DESKTOP_APP_NAME=Grok Build"
set "GROK_DISABLE_AUTOUPDATER=1"
set "PATH=%USERPROFILE%\.grok\bin;%USERPROFILE%\.local\bin;%PATH%"

echo %date% %time% launcher: starting UI (%LAUNCH_EXE%) >> "%BOOT_LOG%"
start "" /d "%LAUNCH_DIR%" "%LAUNCH_EXE%"
echo %date% %time% launcher: done >> "%BOOT_LOG%"
endlocal
exit /b 0

:gateway_fail
echo %date% %time% launcher: FATAL gateway did not become healthy in 40s >> "%BOOT_LOG%"
echo Grok gateway failed to start within 40s.
echo Check logs: %GW_OUT% and %GW_ERR%
if not defined GROK_BUILD_NOPAUSE pause
endlocal
exit /b 1
