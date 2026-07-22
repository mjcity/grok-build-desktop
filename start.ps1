#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$env:Path = "$env:USERPROFILE\.grok\bin;$env:USERPROFILE\.local\bin;$env:Path"
$env:GROK_DISABLE_AUTOUPDATER = "1"
if (-not (Test-Path "$Root\node_modules\ws")) {
  cmd /c "npm install"
}
cmd /c "node server.mjs"
