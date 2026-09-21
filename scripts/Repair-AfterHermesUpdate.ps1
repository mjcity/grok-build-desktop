<#
.SYNOPSIS
  Put Grok Build back together after stock Hermes updates itself.

.DESCRIPTION
  Grok Build does not ship its own Electron app - it launches the binary that
  Hermes's own packager produces under apps\desktop\release\win-unpacked, then
  copies it to a separately-iconed GrokBuild.exe. Stock Hermes's updater
  advances that same working tree, and when it does it:

    * moves HEAD to a new commit,
    * auto-stashes local changes (our patches leave the working tree),
    * DELETES apps\desktop\release entirely.

  The last one is what actually breaks startup: with release\ gone there is no
  Hermes.exe to launch, and GrokBuild.cmd fails with
  "FATAL Hermes.exe not found - set GROK_BUILD_HERMES_DIR".

  This script re-applies our patches from patches\*.patch, rebuilds, repackages,
  refreshes the Grok-branded copy, and proves the patches survived into the
  installed bundle rather than assuming they did.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\Repair-AfterHermesUpdate.ps1
#>
[CmdletBinding()]
param(
  # Grok Build's OWN clone of upstream Hermes (since 2026-09-21). It used to be
  # built out of stock Hermes's install checkout, which meant every stock
  # self-update wiped our patches or deleted the build, and every rebuild here
  # had to kill the user's running Hermes to rewrite release\win-unpacked.
  # Separate tree = stock Hermes is never read, written, or stopped by us.
  [string] $HermesRepo = 'D:\Program\grok\projects\hermes-src-grokbuild',
  [string] $GrokAppDir = "$env:LOCALAPPDATA\GrokBuildDesktop\app",
  # Pull upstream's tip into OUR tree first (shallow; upstream squashes history,
  # so this is a reset, never a merge). Without it the script rebuilds what is
  # already checked out.
  [switch] $Update,
  [switch] $SkipInstall
)

$ErrorActionPreference = 'Stop'
$gateway = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $HermesRepo 'apps\desktop'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 turns a native exe's stderr into ErrorRecords, and with
# $ErrorActionPreference='Stop' a single npm "warn" line kills the script even
# though npm exited 0. So run every native command with the preference relaxed
# and judge it by $LASTEXITCODE, which is the only honest signal here.
function Invoke-Native {
  param([string] $What, [scriptblock] $Command)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = $null
  try { $out = & $Command 2>&1 } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) {
    # Show WHY. This used to discard the output, so a build that failed on a
    # single missing export reported only "exit 1" and had to be re-run by hand
    # to learn anything (2026-09-21).
    $code = $LASTEXITCODE
    Write-Host "  ---- last lines of '$What' ----" -ForegroundColor Yellow
    $ansi = [regex]::Escape([string][char]27) + '\[[0-9;]*m'   # PS 5.1 has no `e escape
    ($out | ForEach-Object { "$_" -replace $ansi, '' } | Where-Object { $_.Trim() } | Select-Object -Last 25) |
      ForEach-Object { Write-Host "  $_" }
    Fail "$What failed (exit $code)"
  }
}

if (-not (Test-Path $desktop)) { Fail "Hermes repo not found at $HermesRepo" }

if ($Update) {
  Step "Pull upstream tip into OUR tree"
  # Upstream squashes main to a single root commit on every push, so there is
  # nothing to merge: fetch the tip shallow and reset to it. The only local
  # modifications this tree ever carries are the files in patches\*.patch,
  # which the next step re-applies - so the hard reset loses nothing. This is
  # safe ONLY because the tree is ours; never point -HermesRepo at stock
  # Hermes's install.
  if ($HermesRepo -like "*\AppData\Local\hermes\*") {
    Fail "-Update refuses to reset stock Hermes's own checkout ($HermesRepo). Use Grok Build's clone."
  }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git -C $HermesRepo fetch --depth 1 origin main 2>&1 | Out-Null
    $fetched = ($LASTEXITCODE -eq 0)
    if ($fetched) { & git -C $HermesRepo reset --hard FETCH_HEAD 2>&1 | Out-Null }
    $reset = ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $prev }
  if (-not $fetched) { Fail 'git fetch from upstream failed (network?)' }
  if (-not $reset) { Fail 'git reset to the fetched tip failed' }
}

Step "Hermes commit"
$sha = (& git -C $HermesRepo rev-parse --short HEAD).Trim()
Write-Host "  $sha"

# The contract is the one number that makes the gateway's claim honest. If it
# moved, STOP - rebuilding would ship a backend lying about what it speaks.
Step "Backend contract drift"
$contract = (Select-String -Path (Join-Path $HermesRepo 'tui_gateway\server.py') `
  -Pattern '^DESKTOP_BACKEND_CONTRACT\s*=\s*(\d+)').Matches[0].Groups[1].Value
Write-Host "  upstream contract: $contract"
# Compare against what the gateway ACTUALLY claims, read from its source. A
# hardcoded number here is a second copy that goes stale the moment the gateway
# is (correctly) bumped - the gate would then block a legitimate build, or
# worse, get "fixed" by editing the gate instead of the gateway.
$claimed = (Select-String -Path (Join-Path $gateway 'server.mjs') `
  -Pattern '^\s*desktop_contract:\s*(\d+),').Matches[0].Groups[1].Value
Write-Host "  gateway claims:    $claimed"
if ($contract -ne $claimed) {
  Fail "contract is $contract upstream but the gateway claims $claimed. Work out what v$contract requires and update the gateway honestly before rebuilding - see docs\HERMES-UPDATE-PROTOCOL.md"
}

Step "Re-apply local patches"
Get-ChildItem (Join-Path $gateway 'patches\*.patch') | Sort-Object Name | ForEach-Object {
  # --reverse --check succeeding means it is ALREADY applied; skip rather than
  # doubling it up.
  # git writes to stderr on a failed --check, and PowerShell 5.1 turns native
  # stderr into ErrorRecords that terminate under $ErrorActionPreference='Stop'
  # - so a NORMAL "not yet applied" probe killed this script. Relax the
  # preference around every git call and judge by $LASTEXITCODE, same as
  # Invoke-Native does for npm.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git -C $HermesRepo apply --check --reverse $_.FullName 2>&1 | Out-Null
    $alreadyApplied = ($LASTEXITCODE -eq 0)
    if (-not $alreadyApplied) {
      & git -C $HermesRepo apply --3way $_.FullName 2>&1 | Out-Null
      $applied = ($LASTEXITCODE -eq 0)
    }
  } finally { $ErrorActionPreference = $prev }

  if ($alreadyApplied) {
    Write-Host "  $($_.Name): already applied"
  } elseif ($applied) {
    Write-Host "  $($_.Name): applied"
  } else {
    Fail "$($_.Name) did not apply - re-do it by hand, then re-export it"
  }
}

if (-not $SkipInstall) {
  Step "npm install"
  Push-Location $HermesRepo
  try { Invoke-Native 'npm install' { npm install } } finally { Pop-Location }
}

Step "Build renderer + electron bundle"
Push-Location $desktop
try { Invoke-Native 'npm run build' { npm run build } } finally { Pop-Location }

Step "Package (release\win-unpacked)"
# GrokBuild ONLY. Stock Hermes runs from its own install and is none of our
# business any more - this line used to kill it too, because both apps shared
# one release folder.
Stop-Process -Name GrokBuild -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Push-Location $desktop
try { Invoke-Native 'npm run builder' { npm run builder -- --dir } } finally { Pop-Location }
$hermesExe = Join-Path $desktop 'release\win-unpacked\Hermes.exe'
if (-not (Test-Path $hermesExe)) { Fail 'packaging produced no Hermes.exe' }
Write-Host "  $hermesExe"

Step "Refresh the Grok-branded copy"
$mjs = Join-Path $gateway 'scripts\build-grok-app.mjs'
$src = Join-Path $desktop 'release\win-unpacked'
$ico = Join-Path $gateway 'docs\assets\grok-build-icon.ico'
$png = Join-Path $gateway 'docs\assets\grok-build-icon-1024.png'
Invoke-Native 'build-grok-app.mjs' { node $mjs $src $GrokAppDir $ico $png }

# Proof, not optimism: grep the marker back out of the bundle that will actually
# run. A build that "succeeded" while silently dropping a patch is the exact
# failure this script exists to prevent.
Step "Verify patches reached the INSTALLED bundle"
$assets = Join-Path $GrokAppDir 'resources\app.asar.unpacked\dist\assets'
$link = Get-ChildItem "$assets\external-link*.js" -ErrorAction SilentlyContinue
if (-not $link) { Fail "no external-link chunk under $assets" }
# Marker = the data-link-routing="system-first" attribute the patch puts on link
# anchors. It is a string literal, so it survives minification; the patch's
# actual logic (an inverted helper) leaves nothing greppable behind.
$hits = (Select-String -Path $link.FullName -Pattern 'system-first' -AllMatches |
         ForEach-Object { $_.Matches.Count } | Measure-Object -Sum).Sum
Write-Host "  $($link.Name): system-first x$hits"
if (-not $hits) { Fail 'link patch is NOT in the installed bundle' }

# Taskbar identity - verify the INSTALLED main bundle, independently of
# build-grok-app.mjs's own exit-4 gate. On 2026-08-24 the identity patch missed
# (bundler renamed `app` -> `app3`), the copy shipped declaring Hermes's own
# AppUserModelID, and Windows merged Grok Build onto stock Hermes's taskbar
# button. Two layers of verification because one silent miss already happened.
$mainMjs = Join-Path $GrokAppDir 'resources\app.asar.unpacked\dist\electron-main.mjs'
if (-not (Test-Path $mainMjs)) { Fail "no electron-main.mjs under $GrokAppDir" }
$mainSrc = [System.IO.File]::ReadAllText($mainMjs)
$stockId = $mainSrc.Contains('setAppUserModelId("com.nousresearch.hermes")')
$grokId  = $mainSrc.Contains('setAppUserModelId("com.mjcity.grokbuild")')
Write-Host "  identity: grok AUMID=$grokId stock AUMID=$stockId"
if ($stockId -or -not $grokId) {
  Fail 'installed copy still declares stock Hermes identity - taskbar buttons would merge'
}

# Live window icon. On Windows the first icon candidate is resources\icon.ico,
# so the swap of that one file is what the running window actually shows -
# verify by hash against our asset, not by trusting the patcher's log line.
# (2026-09-08: the APP_ICON_PATHS array patch silently missed after upstream
# turned it into appIconCandidates(); the icon was still right ONLY because
# this file had been replaced. Check the thing the OS reads.)
$ico = Join-Path $GrokAppDir 'resources\icon.ico'
$ours = Join-Path $gateway 'docs\assets\grok-build-icon.ico'
if (-not (Test-Path $ico)) { Fail "no resources\icon.ico under $GrokAppDir" }
$icoHash = (Get-FileHash $ico -Algorithm SHA256).Hash
$ourHash = (Get-FileHash $ours -Algorithm SHA256).Hash
Write-Host "  window icon: $(if ($icoHash -eq $ourHash) { 'Grok Build' } else { 'NOT ours' })"
if ($icoHash -ne $ourHash) { Fail 'installed resources\icon.ico is not the Grok Build icon - live window would show stock Hermes' }

Write-Host "`nRepaired. Launch with GrokBuild.cmd" -ForegroundColor Green
