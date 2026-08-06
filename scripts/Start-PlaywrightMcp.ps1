# Start the long-lived Playwright MCP server that Grok's config expects.
#
# ~/.grok/config.toml points [mcp_servers.playwright] at
# http://localhost:8931/mcp in URL mode - Grok is a CLIENT ONLY and never
# spawns this server, so something must keep it running. GrokBuild.cmd calls
# this at every launch (step 1b); it is safe to run any time - idempotent,
# exits 0 immediately if the port is already listening.
#
# The config URL MUST say "localhost", not "127.0.0.1": current @playwright/
# mcp enforces a Host-header check and 403s anything not addressed as
# localhost:8931 ("Access is only allowed at localhost:8931") - that 403 is
# what Grok mislabels as "auth required". Found+fixed 2026-07-21.
#
# The server itself is lightweight: Chrome only opens when a browser tool is
# actually invoked mid-session, and --shared-browser-context keeps that
# Chrome alive across Grok's per-turn MCP reconnects (see
# notes/PLAYWRIGHT-STAY-OPEN.md - that is why URL mode exists at all).
#
# HARDENED 2026-07-21: the original version built a quoted `cmd.exe /c
# "npx ..." > log 2> log` string and Start-Process'd cmd.exe with it. That
# quoting chain silently did nothing when invoked from the GrokBuild.cmd
# launcher (log files untouched, no process, no error) while appearing to
# work when pasted interactively. Replaced with direct Start-Process
# redirection - no cmd.exe, no nested quoting. Also: bind wait raised
# 10s -> 60s because a cold `npx @playwright/mcp@latest` downloads the
# package from the registry first, and early-exit detection reports the
# actual npx failure instead of a generic bind timeout.
#
# TWO MODES (2026-08-01). Default (no args) is unchanged: an ISOLATED Chrome
# with its own profile - clean, logged into nothing, safe for scraping and
# throwaway automation.
#
#   -Extension  attaches to your REAL, already-running Chrome/Edge instead,
#               reusing your live logins and open tabs, via Microsoft's
#               official "Playwright Extension" (Chrome Web Store:
#               chromewebstore.google.com/detail/playwright-extension/
#               mmlmfjhmonkocbjadbfplnigmagldckm). No --user-data-dir and no
#               --shared-browser-context in this mode: the browser is YOURS,
#               not one we launch, so profile/context flags don't apply.
#
# Both can run at once on different ports (8931 isolated / 8932 extension) -
# they're independent server processes, so Grok gets both toolsets and picks
# per task. Extension mode is exactly the scenario upstream bug #1646 broke;
# the PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0 fix below is what makes it usable.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File Start-PlaywrightMcp.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File Start-PlaywrightMcp.ps1 -Extension -Port 8932
param(
  [int]$Port = 0,
  [switch]$Extension
)

$ErrorActionPreference = "Stop"
if ($Port -le 0) { $Port = if ($Extension) { 8932 } else { 8931 } }
$port = $Port
$hostBind = "127.0.0.1"
$modeTag = if ($Extension) { "extension" } else { "isolated" }
# Portable default: env override, else next to this script (works on any
# clone/machine, not just the original dev box). Per-mode subdir so the two
# instances never share output/log files.
$baseDir = $env:GROK_BUILD_PLAYWRIGHT_DIR
if (-not $baseDir) {
  $baseDir = Join-Path (Split-Path -Parent $PSScriptRoot) "tmp\playwright"
}
if ($Extension) { $baseDir = Join-Path $baseDir "extension" }
$profileDir = Join-Path $baseDir "playwright-user-data"
$outDir = Join-Path $baseDir "playwright-output"
$logOut = Join-Path $baseDir "playwright-mcp-stdout.log"
$logErr = Join-Path $baseDir "playwright-mcp-stderr.log"
$npxCandidate = "$env:ProgramFiles\nodejs\npx.cmd"
$npxOnPath = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (Test-Path $npxCandidate) {
  $npx = $npxCandidate
} elseif ($npxOnPath) {
  $npx = $npxOnPath.Source
} else {
  Write-Error "npx not found (checked $npxCandidate and PATH) - install Node.js"
  exit 1
}

New-Item -ItemType Directory -Path $profileDir, $outDir -Force | Out-Null

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if ($existing) {
  Write-Host "Playwright MCP [$modeTag] already listening on port $port (PID(s): $($existing -join ', '))"
  exit 0
}

if ($Extension) {
  # Attaches to the user's own running browser via the Playwright Extension.
  # Deliberately NO --user-data-dir / --shared-browser-context / --viewport-size:
  # we don't own this browser, so launching-profile flags are meaningless here
  # (and --user-data-dir is rejected outright alongside --extension).
  $argList = @(
    "-y", "@playwright/mcp@latest",
    "--port", "$port",
    "--host", $hostBind,
    "--extension",
    "--output-dir", $outDir
  )
} else {
  $argList = @(
    "-y", "@playwright/mcp@latest",
    "--port", "$port",
    "--host", $hostBind,
    "--browser", "chrome",
    "--user-data-dir", $profileDir,
    "--output-dir", $outDir,
    "--shared-browser-context",
    "--viewport-size", "1280x800"
  )
}

# CRITICAL for cross-turn persistence: disable @playwright/mcp's session
# heartbeat by setting its ping timeout to 0.
#
# @playwright/mcp starts a heartbeat that pings the client every ~3s and
# expects a pong within 5s, then calls server.close() (tearing down the
# browser + all tab state) if none arrives. That design assumes a persistent
# bidirectional channel (SSE/stdio/WebSocket). But Grok connects over
# Streamable HTTP - request/response - so once a tool call's HTTP response is
# sent, the server has NO channel to deliver the ping; it always times out,
# and the session self-destructs ~5-8s after each tool call. Net effect: any
# page Grok opens reverts to about:blank a few seconds later, so multi-step
# web tasks and "leave the tab open" both fail.
#
# This is upstream bug microsoft/playwright-mcp#1646 (heartbeat unconditionally
# on for Streamable HTTP); still unfixed as of 0.0.78 + the 2026-07-23 alpha
# (both reproduced here). PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0 makes pingTimeout()
# return 0, and startHeartbeat() early-returns on `timeout <= 0` - no heartbeat,
# no teardown. Verified: page survived a full 120s idle gap across separate
# HTTP connections (it died at ~5-8s without this). Override with
# GROK_BUILD_PLAYWRIGHT_PING_TIMEOUT_MS if a future fix needs the heartbeat back.
$pingTimeout = $env:GROK_BUILD_PLAYWRIGHT_PING_TIMEOUT_MS
if (-not $pingTimeout) { $pingTimeout = "0" }
$env:PLAYWRIGHT_MCP_PING_TIMEOUT_MS = $pingTimeout

# Headed is the default (do not pass --headless) - the whole point is a
# visible Chrome that survives across turns.
$proc = Start-Process -FilePath $npx -ArgumentList $argList `
  -WorkingDirectory $baseDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logOut -RedirectStandardError $logErr

# Cold npx runs download the package first - allow up to 60s to bind.
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) {
    Write-Error "npx exited (code $($proc.ExitCode)) before binding port $port. Last stderr:"
    if (Test-Path $logErr) { Get-Content $logErr -Tail 30 | Write-Host }
    exit 1
  }
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  Write-Error "Playwright MCP did not bind port $port within 60s. See $logErr"
  if (Test-Path $logErr) { Get-Content $logErr -Tail 30 | Write-Host }
  exit 1
}

Write-Host "Playwright MCP [$modeTag] listening on http://localhost:${port}/mcp (npx PID $($proc.Id)) - clients MUST use the localhost hostname"
if ($Extension) {
  Write-Host "Mode: attaches to your OWN running Chrome/Edge - requires the 'Playwright Extension' from the Chrome Web Store"
} else {
  Write-Host "Profile: $profileDir (isolated - logged into nothing)"
}
Write-Host "Logs: $logErr"
