# RPA auto-update — pull latest code from GitHub, rebuild + restart worker IF changed.
# Run by scheduled task "RPA-AutoUpdate" every 5 minutes. (English only — avoid Thai garbling on PS 5.x)
# SAFETY: never restart while a job is processing (would kill the running RPA job) -> defer to next cycle.
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
  # SAFETY GUARD: if a job is currently processing, defer the update (don't kill a running RPA job)
  $busy = $false
  $envFile = Join-Path $repo "rpa-worker\.env"
  if (Test-Path $envFile) {
    $su = $null; $sk = $null
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^\s*SUPABASE_URL\s*=\s*(.+)$')         { $su = $matches[1].Trim() }
      if ($_ -match '^\s*SUPABASE_SERVICE_KEY\s*=\s*(.+)$') { $sk = $matches[1].Trim() }
    }
    if ($su -and $sk) {
      try {
        $r = Invoke-RestMethod -Uri "$su/rest/v1/job_queue?status=eq.processing&select=id&limit=1" `
               -Headers @{ apikey = $sk; Authorization = "Bearer $sk" } -TimeoutSec 15
        if ($r -and @($r).Count -gt 0) { $busy = $true }
      } catch { }
    }
  }
  if ($busy) {
    Log "new code $before -> $remote but a job is PROCESSING -> defer to next cycle"
  } else {
    Log "new code $before -> $remote : updating"
    git reset --hard origin/main 2>&1 | Out-Null
    Push-Location (Join-Path $repo "rpa-import-node"); npx tsc 2>&1 | Out-Null; Pop-Location
    Push-Location (Join-Path $repo "rpa-worker");      npx tsc 2>&1 | Out-Null; Pop-Location
    pm2 restart rpa-worker 2>&1 | Out-Null
    Log "updated + restarted -> $remote"
  }
}
