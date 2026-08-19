# MANDATORY: Hermes update protocol (Grok Build Desktop)

**Audience: any agent (Claude, Grok, Codex, human) updating the Hermes
install that Grok Build Desktop runs on.** Follow IN ORDER. Every gate is
exit-code checkable. Do not claim success without the §7 evidence. Skipping
the backup or the verification gates is how the working stack gets destroyed.

Machine facts (this install):
- Hermes source + build: `%LOCALAPPDATA%\hermes\hermes-agent` (git clone of
  NousResearch/hermes-agent; `main` is pinned to the last-verified commit)
- Running binary: `...\apps\desktop\release\win-unpacked\Hermes.exe`
- Our gateway repo: `D:\Program\grok\projects\hermes-agent-fork\grok-gateway`
- Gateway logs: `%USERPROFILE%\.grok-hermes-desktop\logs\`

## 0. Preconditions (hard stop if any fails)

1. **No active work.** `GET http://127.0.0.1:8787/api/status` →
   `gateway_busy:false, active_agents:0`. If Michael has a turn/claudeloop
   running, WAIT. Never rebuild under an active task.
2. Disk: ≥ 3 GB free on C: (backup + node_modules + build output).
3. Note the current git HEAD sha — it goes in the backup names.

## 1. Backup (before touching anything)

```powershell
$repo = "$env:LOCALAPPDATA\hermes\hermes-agent"
$sha  = git -C $repo rev-parse --short HEAD
# 1a. binary backup (copying a running exe is fine; deleting/writing is not)
robocopy "$repo\apps\desktop\release\win-unpacked" "$repo\apps\desktop\release\win-unpacked-$sha.bak" /E
# 1b. anchor branch at the working commit
git -C $repo branch "local-patches-$sha" 2>$null
# 1c. preserve ANY dirty files (this repo historically carries local python
#     patches for stock Hermes — they are NOT ours to lose)
git -C $repo stash push -m "local patches pre-update-$(Get-Date -Format yyyyMMdd)"
```

Rollback at ANY later point =
```powershell
Stop-Process -Name Hermes -Force
Remove-Item "$repo\apps\desktop\release\win-unpacked" -Recurse -Force
robocopy "$repo\apps\desktop\release\win-unpacked-<sha>.bak" "$repo\apps\desktop\release\win-unpacked" /E
git -C $repo checkout main   # pinned working commit
git -C $repo stash pop        # if you stashed and want the patches back
# relaunch: D:\Program\grok\projects\hermes-agent-fork\grok-gateway\GrokBuild.cmd
```

## 0b. Stock Hermes updated itself? Run the repair script

This protocol covers a *deliberate* update. The other case is stock Hermes
updating its own working tree behind your back — which breaks Grok Build every
single time, because the two share one checkout. Its updater:

* moves `HEAD` to a new commit,
* **auto-stashes** local changes (our patches leave the working tree), and
* **deletes `apps\desktop\release` entirely.**

That last one is the startup failure. Grok Build has no Electron app of its own;
it launches the binary Hermes's packager produces. With `release\` gone the
launcher dies with:

```
launcher: FATAL Hermes.exe not found - set GROK_BUILD_HERMES_DIR
```

Nothing is corrupted and nothing is lost — it just has to be rebuilt:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Repair-AfterHermesUpdate.ps1
```

It re-applies every `patches\*.patch` (skipping any already applied), stops the
running apps, rebuilds, repackages, refreshes the Grok-branded copy, and then
**greps the patch marker back out of the installed bundle** before declaring
success. It refuses to run if `DESKTOP_BACKEND_CONTRACT` moved off 6 — that needs
a gateway change first, and rebuilding would ship a backend lying about what it
speaks. Then relaunch with `GrokBuild.cmd`.

Observed 2026-08-19: an update pulled 101 commits (`d07be6e1` → `0b879298a`),
contract stayed 6, and both patches re-applied cleanly.

## 1b. Local patch inventory — re-apply every one after the update

Upstream rewrites history, so these never merge cleanly. Treat this list as the
definition of done: after §4 builds, **grep each marker back** before believing
the patch survived.

| File (in the Hermes repo) | What we change | Marker to grep |
|---|---|---|
| `acp_adapter/session.py` | Buzz ACP compatibility | `patches/0002-buzz-acp-compat.patch` |
| `tools/environments/local.py` | Buzz ACP compatibility | `patches/0002-buzz-acp-compat.patch` |
| `tools/tool_search.py` | Buzz ACP compatibility | `_NEVER_DEFER_TOOL_NAMES` |
| `apps/desktop/src/lib/external-link.tsx` | A bare click on a chat link opens the **system** browser; the in-app preview pane moves to ⌘/Ctrl-click and middle-click. Upstream shipped these swapped in `d07be6e1`. | `wantsInAppBrowser` |
| `apps/desktop/src/app/right-sidebar/terminal/links.ts` | Same swap for terminal links: ⌘/Ctrl-click → system browser, ⇧⌘ → in-app pane. | `inApp: event.shiftKey` |

The link patch is checked in as a real patch file, so re-applying it is a
command, not a retype:

```powershell
git -C $repo apply --3way "$gateway\patches\0001-links-open-in-system-browser.patch"
```

It also owns the two test files that assert the routing
(`external-link.test.tsx`, `terminal/links.test.ts`). If upstream's versions come
back, the suites fail loudly rather than silently reverting the behavior — that
is the point. Re-apply, then:

```powershell
cd "$repo\apps\desktop"; npx vitest run src/lib/external-link.test.tsx src/app/right-sidebar/terminal/links.test.ts
```

Why this one is a keeper: an embedded webview has none of the user's logins,
extensions, password manager, or open tabs, so "read this page" quietly became
"read this page signed out." The pane is still there — it is just opt-in now.

## 2. Update source on a branch — never advance `main`

```powershell
git -C $repo fetch origin main
git -C $repo checkout -b "update-$(Get-Date -Format yyyyMMdd)" origin/main
```

`main` stays at the last verified commit as the rollback anchor. Only move
`main` forward AFTER §7 fully passes (`git branch -f main <new-sha>`).

## 3. Contract-drift scan (before building — know what you're walking into)

```powershell
# THE number: if it moved, the gateway MUST be updated to match honestly
Select-String "$repo\tui_gateway\server.py" -Pattern 'DESKTOP_BACKEND_CONTRACT\s*='
# what changed in the protocol surface since the old sha
git -C $repo log <old-sha>..origin/main --oneline -- tui_gateway apps/shared
# what the new session.info carries (compare to sessionInfoPayload in server.mjs)
# find `def _session_info` in tui_gateway/server.py and diff its field list
```

Known contract history: 2 (≤ 2026-07-11) → 4 (2026-07-20; added
`approval_mode`, `project`, `stored_session_id` to session.info). The
desktop's contract check is a WARNING toast, not a hard refusal
(`reportBackendContract` in `apps/desktop/src/store/updates.ts`) — but never
bump the number in the gateway without also adding the fields that level
implies. Wrong-shaped 200s are still the cardinal sin; new fields the
renderer null-guards are safe to send as `null`/`""`.

## 4. Build

```powershell
cd $repo            # npm-workspaces monorepo: install at ROOT
npm install
cd apps\desktop
npm run build       # renderer + electron bundle (does not touch release\)
# --- only now stop the running app: the packager rewrites release\win-unpacked
Stop-Process -Name Hermes -Force -ErrorAction SilentlyContinue
npm run builder -- --dir   # electron-builder → release\win-unpacked
```

Both commands must exit 0. If `builder` fails with file-lock errors,
something still holds `win-unpacked` (Hermes.exe, explorer preview) — close
it and rerun; do NOT delete the folder while anything runs from it.

## 5. Gateway adjustments (if §3 found drift)

Edit `server.mjs` (`sessionInfoPayload` and friends), `node --check
server.mjs`, then restart the gateway (kill the pid in
`~\.grok-hermes-desktop\gateway.pid`; the supervisor restarts it — or start
via `GrokBuild.cmd`). Commit gateway changes to the private repo.

## 6. Relaunch

```powershell
D:\Program\grok\projects\hermes-agent-fork\grok-gateway\GrokBuild.cmd
```

## 7. Verification gates — ALL must pass, evidence required

From `D:\Program\grok\projects\hermes-agent-fork\grok-gateway`:

| Gate | Command | Pass |
|---|---|---|
| Chat + resume | `node scripts\chat-e2e.mjs` | prints PASS, exit 0 |
| Streaming feed | `node scripts\feed-e2e.mjs` | prints PASS, exit 0 |
| Tool chips | `node scripts\tools-e2e.mjs` | prints PASS, exit 0 |
| Cold start + window | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-cold-start.ps1` | COLD-START PASS, exit 0 |
| Shape drift | `gateway-http.log` since relaunch | no NEW 404s from renderer boot, no wrong-shape suspicions |
| Renderer health | desktop log (`%LOCALAPPDATA%\hermes\logs\desktop.log`) | no error-boundary / renderer console errors |
| UI sanity | screenshot of the window | chat chrome, no error overlay, no "backend out of date" toast |

Any red → §1 rollback, then diagnose. Do not leave Michael on a half-updated
stack overnight.

## 8. Finalize

1. `git -C $repo branch -f main <new-sha>` (move the anchor).
2. Reapply/cherry-pick the stashed python patches if stock Hermes needs them;
   resolve or document conflicts.
3. Delete backups older than the previous one (keep exactly one known-good).
4. Update `docs/` + README "tested against Hermes commit X" in the private
   repo; commit + push.
5. Update the agent memory/notes with the new sha and any new contract facts.

## Never-do list

- Never `git pull` over a dirty tree here — stash first (§1c).
- Never rebuild `release\win-unpacked` without a `.bak` copy of the working
  one.
- Never advance `main` before §7 is green.
- Never bump `desktop_contract` in the gateway as a cosmetic fix.
- Never delete `win-unpacked-*.bak` until its successor has passed §7.
- Never run the update while `gateway_busy:true`.
