# One-time setup (run on the VM via Nutanix console):
#   1) force build + restart worker NOW (deploy current code)
#   2) register scheduled task "RPA-AutoUpdate" to run auto-update.ps1 every 5 min
# English only — avoid Thai garbling on Windows PowerShell 5.x.
$ErrorActionPreference = "Continue"
$repo   = Join-Path $env:USERPROFILE "Desktop\RPA"
$script = Join-Path $repo "rpa-worker\auto-update.ps1"
$task   = "RPA-AutoUpdate"

Write-Host "=== 1/2: build + restart worker with current code ==="
Set-Location $repo
Push-Location (Join-Path $repo "rpa-import-node"); npx tsc; Pop-Location
Push-Location (Join-Path $repo "rpa-worker");      npx tsc; Pop-Location
pm2 restart rpa-worker
pm2 save 2>$null

Write-Host ""
Write-Host "=== 2/2: register auto-update task (every 5 min) ==="
schtasks /Delete /TN $task /F 2>$null | Out-Null
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
# one-time trigger with 5-minute repetition (works on Windows PowerShell 5.x)
$base = New-ScheduledTaskTrigger -Once -At (Get-Date)
$rep  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$base.Repetition = $rep.Repetition
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $task -Action $action -Trigger $base -Principal $principal -Force | Out-Null

Write-Host ""
Write-Host "DONE. Worker is on latest code + auto-updates every 5 min."
Write-Host "Log:       $repo\auto-update.log"
Write-Host "Heartbeat: $repo\auto-update-lastrun.txt (updates every 5 min)"
pm2 status
