# Update worker from GitHub then restart service
# Usage: cd $HOME\Desktop\RPA\rpa-worker
#        powershell -ExecutionPolicy Bypass -File update-worker.ps1
$ErrorActionPreference = "Stop"
$REPO = Join-Path $HOME "Desktop\RPA"

Write-Host "[1/4] git pull..." -ForegroundColor Cyan
Set-Location $REPO
git pull

Write-Host "[2/4] build rpa-import-node..." -ForegroundColor Cyan
Set-Location (Join-Path $REPO "rpa-import-node")
npx tsc

Write-Host "[3/4] build rpa-worker..." -ForegroundColor Cyan
Set-Location (Join-Path $REPO "rpa-worker")
npx tsc

Write-Host "[4/4] restart service RpaWorker..." -ForegroundColor Cyan
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if ($nssm) {
  & $nssm restart RpaWorker
  Start-Sleep -Seconds 3
  & $nssm status RpaWorker
  Write-Host "DONE - worker restarted with new code" -ForegroundColor Green
} else {
  Write-Host "nssm not found - run install-service.ps1 (as admin) first, or run: node dist\worker.js" -ForegroundColor Yellow
}
