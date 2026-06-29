# RPA auto-update — pull latest code from GitHub, rebuild + restart worker IF changed.
# Run by scheduled task "RPA-AutoUpdate" every 5 minutes. (English only — avoid Thai garbling on PS 5.x)
$ErrorActionPreference = "Continue"
$repo = Join-Path $env:USERPROFILE "Desktop\RPA"
$log  = Join-Path $repo "auto-update.log"
$beat = Join-Path $repo "auto-update-lastrun.txt"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content $log }

Set-Location $repo
# heartbeat (overwrite) so we can confirm the task is alive without bloating the log
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Set-Content $beat

git fetch origin 2>&1 | Out-Null
$before = (git rev-parse HEAD 2>$null).Trim()
$remote = (git rev-parse origin/main 2>$null).Trim()

if ($before -and $remote -and ($before -ne $remote)) {
  Log "new code $before -> $remote : updating"
  git reset --hard origin/main 2>&1 | Out-Null
  Push-Location (Join-Path $repo "rpa-import-node"); npx tsc 2>&1 | Out-Null; Pop-Location
  Push-Location (Join-Path $repo "rpa-worker");      npx tsc 2>&1 | Out-Null; Pop-Location
  pm2 restart rpa-worker 2>&1 | Out-Null
  Log "updated + restarted -> $remote"
}
