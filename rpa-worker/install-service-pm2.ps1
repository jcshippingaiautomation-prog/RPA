# Install rpa-worker as 24/7 service using pm2 + pm2-windows-startup
# Usage (Run PowerShell as Administrator):
#   cd $HOME\Desktop\RPA\rpa-worker
#   powershell -ExecutionPolicy Bypass -File install-service-pm2.ps1
# Manage after install:
#   pm2 status / pm2 logs rpa-worker / pm2 restart rpa-worker / pm2 stop rpa-worker

$ErrorActionPreference = "Stop"
$WORKER_DIR = Join-Path $HOME "Desktop\RPA\rpa-worker"
$ENTRY = Join-Path $WORKER_DIR "dist\worker.js"

Write-Host "=== Install rpa-worker 24/7 with pm2 ===" -ForegroundColor Cyan
if (-not (Test-Path $ENTRY)) { Write-Host "ERROR: $ENTRY not found - run npx tsc in rpa-worker first" -ForegroundColor Red; exit 1 }

# 1) install pm2 globally
Write-Host "[1/5] install pm2 (global)..." -ForegroundColor Green
npm install -g pm2 pm2-windows-startup

# 2) stop old instance if any
Write-Host "[2/5] stop old rpa-worker (if any)..." -ForegroundColor Green
pm2 delete rpa-worker 2>$null

# 3) start worker via pm2
Write-Host "[3/5] start worker..." -ForegroundColor Green
Set-Location $WORKER_DIR
pm2 start $ENTRY --name rpa-worker --time

# 4) save process list + setup auto-start on boot
Write-Host "[4/5] save + enable auto-start on boot..." -ForegroundColor Green
pm2 save
pm2-startup install

# 5) status
Write-Host "[5/5] status:" -ForegroundColor Green
pm2 status

Write-Host ""
Write-Host "DONE! Worker runs 24/7 (auto-start on boot + auto-restart on crash)" -ForegroundColor Green
Write-Host "Common commands:" -ForegroundColor Cyan
Write-Host "  pm2 status            # check"
Write-Host "  pm2 logs rpa-worker   # live logs"
Write-Host "  pm2 restart rpa-worker"
