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
  [string] $HermesRepo = "$env:LOCALAPPDATA\hermes\hermes-agent",
  [string] $GrokAppDir = "$env:LOCALAPPDATA\GrokBuildDesktop\app",
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
  try { & $Command 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit $LASTEXITCODE)" }
}

if (-not (Test-Path $desktop)) { Fail "Hermes repo not found at $HermesRepo" }

Step "Hermes commit"
$sha = (& git -C $HermesRepo rev-parse --short HEAD).Trim()
Write-Host "  $sha"

# The contract is the one number that makes the gateway's claim honest. If it
# moved, STOP - rebuilding would ship a backend lying about what it speaks.
Step "Backend contract drift"
$contract = (Select-String -Path (Join-Path $HermesRepo 'tui_gateway\server.py') `
  -Pattern '^DESKTOP_BACKEND_CONTRACT\s*=\s*(\d+)').Matches[0].Groups[1].Value
Write-Host "  upstream contract: $contract"
if ($contract -ne '6') {
  Fail "contract moved to $contract (gateway claims 6). Update the gateway before rebuilding - see docs\HERMES-UPDATE-PROTOCOL.md"
}

Step "Re-apply local patches"
Get-ChildItem (Join-Path $gateway 'patches\*.patch') | Sort-Object Name | ForEach-Object {
  # --reverse --check succeeding means it is ALREADY applied; skip rather than
  # doubling it up.
  & git -C $HermesRepo apply --check --reverse $_.FullName 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  $($_.Name): already applied"
  } else {
    & git -C $HermesRepo apply --3way $_.FullName
    if ($LASTEXITCODE -ne 0) { Fail "$($_.Name) did not apply - re-do it by hand, then re-export it" }
    Write-Host "  $($_.Name): applied"
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
Stop-Process -Name Hermes, GrokBuild -Force -ErrorAction SilentlyContinue
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
$hits = (Select-String -Path $link.FullName -Pattern 'inApp' -AllMatches |
         ForEach-Object { $_.Matches.Count } | Measure-Object -Sum).Sum
Write-Host "  $($link.Name): inApp x$hits"
if (-not $hits) { Fail 'link patch is NOT in the installed bundle' }

Write-Host "`nRepaired. Launch with GrokBuild.cmd" -ForegroundColor Green
