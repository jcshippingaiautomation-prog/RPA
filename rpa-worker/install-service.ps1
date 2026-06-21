# Install rpa-worker as a Windows Service (24/7) using NSSM
# Usage (Run PowerShell as Administrator):
#   cd $HOME\Desktop\RPA\rpa-worker
#   powershell -ExecutionPolicy Bypass -File install-service.ps1
# Manage after install:
#   nssm status RpaWorker / nssm restart RpaWorker / nssm stop RpaWorker
#   Get-Content $HOME\Desktop\RPA\rpa-worker\logs\worker.out.log -Tail 30 -Wait

$ErrorActionPreference = "Stop"
$SERVICE = "RpaWorker"
$WORKER_DIR = Join-Path $HOME "Desktop\RPA\rpa-worker"
$NODE = (Get-Command node).Source
$ENTRY = Join-Path $WORKER_DIR "dist\worker.js"
$LOG_DIR = Join-Path $WORKER_DIR "logs"

Write-Host "=== Install rpa-worker as Windows Service ===" -ForegroundColor Cyan
Write-Host "  node : $NODE"
Write-Host "  entry: $ENTRY"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "ERROR: Run PowerShell as Administrator" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ENTRY)) { Write-Host "ERROR: $ENTRY not found - run npx tsc in rpa-worker first" -ForegroundColor Red; exit 1 }

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  Write-Host "Downloading nssm..." -ForegroundColor Yellow
  $nssmZip = Join-Path $env:TEMP "nssm.zip"
  $nssmDir = Join-Path $env:TEMP "nssm-2.24"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip
  Expand-Archive -Path $nssmZip -DestinationPath $env:TEMP -Force
  $nssm = Join-Path $nssmDir "win64\nssm.exe"
  if (-not (Test-Path $nssm)) { $nssm = Join-Path $nssmDir "win32\nssm.exe" }
  Write-Host "  nssm: $nssm"
}

$existing = & $nssm status $SERVICE 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Removing existing service..." -ForegroundColor Yellow
  & $nssm stop $SERVICE 2>$null
  & $nssm remove $SERVICE confirm
  Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

Write-Host "Creating service $SERVICE..." -ForegroundColor Green
& $nssm install $SERVICE $NODE $ENTRY
& $nssm set $SERVICE AppDirectory $WORKER_DIR
& $nssm set $SERVICE AppStdout (Join-Path $LOG_DIR "worker.out.log")
& $nssm set $SERVICE AppStderr (Join-Path $LOG_DIR "worker.err.log")
& $nssm set $SERVICE AppRotateFiles 1
& $nssm set $SERVICE AppRotateBytes 10485760
& $nssm set $SERVICE Start SERVICE_AUTO_START
& $nssm set $SERVICE AppExit Default Restart
& $nssm set $SERVICE AppRestartDelay 5000
& $nssm set $SERVICE DisplayName "RPA Import DCTK Worker"
& $nssm set $SERVICE Description "Worker: poll Supabase jobs, fill DCTK via Playwright"

Write-Host "Starting service..." -ForegroundColor Green
& $nssm start $SERVICE
Start-Sleep -Seconds 3
& $nssm status $SERVICE

Write-Host ""
Write-Host "DONE! Worker now runs 24/7 (auto-start on boot + auto-restart on crash)" -ForegroundColor Green
Write-Host "Common commands:" -ForegroundColor Cyan
Write-Host "  nssm restart $SERVICE"
Write-Host "  nssm status  $SERVICE"
Write-Host "  Get-Content '$LOG_DIR\worker.out.log' -Tail 30 -Wait"
