# Update worker from GitHub then restart (pm2)
# Usage: cd $HOME\Desktop\RPA\rpa-worker
#        powershell -ExecutionPolicy Bypass -File update-worker.ps1
$ErrorActionPreference = "Stop"
$REPO = Join-Path $HOME "Desktop\RPA"

Write-Host "[1/4] git pull..." -ForegroundColor Cyan
Set-Location $REPO
git pull
Write-Host "[2/4] build rpa-import-node..." -ForegroundColor Cyan
Set-Location (Join-Path $REPO "rpa-import-node"); npx tsc
Write-Host "[3/4] build rpa-worker..." -ForegroundColor Cyan
Set-Location (Join-Path $REPO "rpa-worker"); npx tsc
Write-Host "[4/4] restart worker (pm2)..." -ForegroundColor Cyan
pm2 restart rpa-worker
Start-Sleep -Seconds 2
pm2 status
Write-Host "DONE - worker restarted with new code" -ForegroundColor Green
