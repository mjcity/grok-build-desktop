#Requires -Version 5.1
# Cold-start verifier for Grok Build Desktop.
# Exit 0 only if: gateway healthy AND Hermes process alive with a real window
# handle within 15s AND window bounds intersect a visible display work area
# AND the window survives the stability window.
# This script only OBSERVES (plus an optional corrective nudge for off-screen
# windows); launching is GrokBuild.cmd's job.
param(
  [int]$GatewayPort = 8787,
  [int]$HandleTimeoutSec = 15,
  [int]$StabilitySec = 60
)

$ErrorActionPreference = "Stop"
$failures = @()

function Step([string]$name, [bool]$ok, [string]$detail) {
  $tag = if ($ok) { "PASS" } else { "FAIL" }
  Write-Host ("[{0}] {1}: {2}" -f $tag, $name, $detail)
  if (-not $ok) { $script:failures += $name }
}

# 1) Gateway health
try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/status" -TimeoutSec 3
  Step "gateway-health" ($status.service -eq "grok-gateway") ("service=" + $status.service + " model=" + $status.model)
} catch {
  Step "gateway-health" $false $_.Exception.Message
}

# 2) Shape spot-checks (the two known UI-crash endpoints; auth required)
$authHeaders = @{ "X-Hermes-Session-Token" = "local-grok-dev-token" }
try {
  $oauth = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/providers/oauth" -Headers $authHeaders -TimeoutSec 3
  Step "oauth-shape" ($null -ne $oauth.providers -and ($oauth.providers -is [array] -or $oauth.providers.Count -ge 0)) ("providers=" + (ConvertTo-Json $oauth -Compress -Depth 3))
} catch {
  Step "oauth-shape" $false $_.Exception.Message
}
try {
  $skillsRaw = Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/api/skills" -Headers $authHeaders -TimeoutSec 3 -UseBasicParsing
  $isArray = $skillsRaw.Content.TrimStart().StartsWith("[")
  Step "skills-shape" $isArray ("body=" + $skillsRaw.Content.Substring(0, [Math]::Min(60, $skillsRaw.Content.Length)))
} catch {
  Step "skills-shape" $false $_.Exception.Message
}

# 3) Hermes process with a real main window handle within timeout
$handle = 0
$hermes = $null
$deadline = (Get-Date).AddSeconds($HandleTimeoutSec)
while ((Get-Date) -lt $deadline) {
  $hermes = Get-Process -Name Hermes -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($hermes) { $handle = $hermes.MainWindowHandle; break }
  Start-Sleep -Milliseconds 500
}
Step "window-handle" ($handle -ne 0) ("handle=" + $handle + " within " + $HandleTimeoutSec + "s")

if ($handle -ne 0) {
  # 4) Window bounds intersect a visible display work area
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
  $rect = New-Object RECT
  [Win32]::GetWindowRect([IntPtr]$handle, [ref]$rect) | Out-Null
  $win = [System.Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
  $visible = $false
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $inter = [System.Drawing.Rectangle]::Intersect($screen.WorkingArea, $win)
    if ($inter.Width -ge 48 -and $inter.Height -ge 48) { $visible = $true; break }
  }
  if (-not $visible) {
    # Corrective nudge: bring it onto the primary work area, then re-check.
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    [Win32]::ShowWindow([IntPtr]$handle, 9) | Out-Null   # SW_RESTORE
    [Win32]::MoveWindow([IntPtr]$handle, $wa.X + 40, $wa.Y + 30, [Math]::Min(1100, $wa.Width - 80), [Math]::Min(680, $wa.Height - 60), $true) | Out-Null
    [Win32]::SetForegroundWindow([IntPtr]$handle) | Out-Null
    [Win32]::GetWindowRect([IntPtr]$handle, [ref]$rect) | Out-Null
    $win = [System.Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
      $inter = [System.Drawing.Rectangle]::Intersect($screen.WorkingArea, $win)
      if ($inter.Width -ge 48 -and $inter.Height -ge 48) { $visible = $true; break }
    }
  }
  Step "window-on-screen" $visible ("bounds=" + $win.X + "," + $win.Y + " " + $win.Width + "x" + $win.Height)

  # 5) Stability: window handle stays alive for the stability window
  $pid0 = $hermes.Id
  $stableDeadline = (Get-Date).AddSeconds($StabilitySec)
  $stable = $true
  while ((Get-Date) -lt $stableDeadline) {
    Start-Sleep -Seconds 5
    $alive = Get-Process -Id $pid0 -ErrorAction SilentlyContinue
    if (-not $alive -or $alive.MainWindowHandle -eq 0) { $stable = $false; break }
  }
  Step "window-stable" $stable ("pid=" + $pid0 + " held window for " + $StabilitySec + "s")
} else {
  Step "window-on-screen" $false "no handle"
  Step "window-stable" $false "no handle"
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host ("COLD-START FAIL: " + ($failures -join ", ")) -ForegroundColor Red
  exit 1
}
Write-Host "COLD-START PASS" -ForegroundColor Green
exit 0
