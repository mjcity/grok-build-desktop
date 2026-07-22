# Setup guide

Two ways to connect: **manual** (5 steps) or **let your Grok do it**
(paste-a-prompt, bottom of this page).

## What you're building

The stock Hermes desktop app supports connecting to a "remote backend" via
two environment variables. This project's gateway pretends to be that
backend on `127.0.0.1:8787` and drives your locally installed Grok CLI. No
accounts, no API keys, no cloud — three local processes talking on localhost.

## Prerequisites

| Thing | Check |
|---|---|
| Windows 10/11 | tested platform (mac/linux: see CONTRIBUTING) |
| Node.js 18+ | `node --version` |
| git | `git --version` |
| Grok CLI, logged in | `grok --version`, and you've chatted with it at least once |
| Hermes desktop app | `Hermes.exe` exists (see below) |

**Installing Hermes:** follow the official instructions at
<https://github.com/NousResearch/hermes-agent> (the desktop app lives in
`apps/desktop`). Typical install locations this launcher auto-detects:

- `%LOCALAPPDATA%\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe`
- `%LOCALAPPDATA%\Programs\Hermes\Hermes.exe`

Anywhere else → set `GROK_BUILD_HERMES_DIR` to the folder containing
`Hermes.exe` before launching.

## Manual install

```powershell
# 1. Get the bridge
git clone https://github.com/mjcity/grok-build-desktop
cd grok-build-desktop
npm install --omit=dev

# 2. Sanity-check your Grok CLI headless mode
grok --output-format streaming-json -p "Reply with exactly: WIRED_OK"
# you should see NDJSON lines ending with WIRED_OK content and an "end" line

# 3. Launch
.\GrokBuild.cmd
```

The launcher:
1. reuses the gateway if one is already healthy, else starts it (hidden, on
   `127.0.0.1:8787`)
2. repairs the window-position file only if it's corrupt
3. points the Hermes self-updater at a harmless local stub (so an "Update"
   click can't rebuild your Hermes install mid-session)
4. starts Hermes with the remote-backend env vars, in an **isolated profile**
   (`%LOCALAPPDATA%\GrokBuildDesktop`) — your regular Hermes profile and
   sessions are never touched

**Make a shortcut:** right-click `GrokBuild.cmd` → Send to → Desktop. Set it
to run minimized if you don't want the brief console window.

## Verify it

```powershell
node scripts\chat-e2e.mjs      # streams a token through the full stack, then
                               # proves multi-turn memory via --resume
node scripts\tools-e2e.mjs     # proves live tool chips during a tool-using turn
```

Both must print `PASS` and exit 0.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Hermes.exe not found" | Install Hermes, or set `GROK_BUILD_HERMES_DIR` |
| Gateway fails health check in 40s | `%USERPROFILE%\.grok-hermes-desktop\logs\gateway-out.log` has the reason (usually: port 8787 taken → set `GROK_BUILD_PORT`, or Node missing) |
| Window opens but "boot failed" overlay | The gateway wasn't up within 45s of the app starting — relaunch `GrokBuild.cmd` (it starts the gateway *first*), then click Retry in the app |
| Chat never streams | Run step 2 of Manual install; if the CLI itself doesn't stream, fix your grok install/login first — the bridge can only relay what the CLI produces |
| First ~10–15s of a turn shows only the spinner | Normal: that's Grok's server-side first-token latency; the raw CLI has the identical silence |
| Windows Defender complains about the launcher | The launch chain avoids hidden PowerShell where possible; if flagged, allow the repo folder — the code is all readable in this repo |
| App window vanished to a second monitor that's unplugged | Hermes itself repositions off-screen windows on launch; if a corrupt state file defeats that, delete `%LOCALAPPDATA%\GrokBuildDesktop\window-state.json` |
| Something else | `%USERPROFILE%\.grok-hermes-desktop\logs\` — `gateway.log` (turns, tool feed), `gateway-http.log` (every API call + the shape returned), `launcher.log` |

## Uninstall

Delete the repo folder, `%LOCALAPPDATA%\GrokBuildDesktop`, and
`%USERPROFILE%\.grok-hermes-desktop`. Hermes and the Grok CLI are untouched.

## "This is how I connected mine" — the agent prompt

If your Grok CLI has file and terminal access (it does), you can hand it the
whole job. Paste this:

```
Clone https://github.com/mjcity/grok-build-desktop into a projects folder,
run "npm install --omit=dev" inside it, and read its docs/SETUP.md.
Then: (1) verify the grok CLI works headlessly by running
  grok --output-format streaming-json -p "Reply with exactly: WIRED_OK"
and confirming WIRED_OK streams back; (2) verify Hermes.exe exists (look in
%LOCALAPPDATA%\hermes\hermes-agent\apps\desktop\release\win-unpacked and
%LOCALAPPDATA%\Programs\Hermes — if missing, tell me how to install Hermes
from https://github.com/NousResearch/hermes-agent and stop); (3) run
GrokBuild.cmd from the repo; (4) verify end-to-end by running
  node scripts/chat-e2e.mjs
and node scripts/tools-e2e.mjs from the repo — both must print PASS and exit
0; (5) if anything fails, read %USERPROFILE%\.grok-hermes-desktop\logs and
fix per docs/SETUP.md troubleshooting, then re-verify. Report what passed.
```

The prompt is deliberately verification-first: the agent has to *prove* the
wiring with the repo's exit-code-gated tests, not just claim it.
