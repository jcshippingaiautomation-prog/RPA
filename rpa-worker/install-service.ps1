# ============================================================
#  ติดตั้ง rpa-worker เป็น Windows Service (รัน 24/7)
#  ใช้ NSSM (Non-Sucking Service Manager) — auto-start + auto-restart
#
#  วิธีใช้ (บน VM):
#    1. เปิด PowerShell แบบ "Run as Administrator"
#    2. cd $HOME\Desktop\RPA\rpa-worker
#    3. powershell -ExecutionPolicy Bypass -File install-service.ps1
#
#  คำสั่งจัดการ service หลังติดตั้ง:
#    nssm status  RpaWorker      → ดูสถานะ
#    nssm restart RpaWorker      → restart
#    nssm stop    RpaWorker      → หยุด
#    nssm start   RpaWorker      → เริ่ม
#    nssm remove  RpaWorker confirm → ลบ service
#    Get-Content $HOME\Desktop\RPA\rpa-worker\logs\worker.out.log -Tail 30 -Wait  → ดู log สด
# ============================================================

$ErrorActionPreference = "Stop"
$SERVICE = "RpaWorker"
$WORKER_DIR = Join-Path $HOME "Desktop\RPA\rpa-worker"
$NODE = (Get-Command node).Source
$ENTRY = Join-Path $WORKER_DIR "dist\worker.js"
$LOG_DIR = Join-Path $WORKER_DIR "logs"

Write-Host "=== ติดตั้ง rpa-worker เป็น Windows Service ===" -ForegroundColor Cyan
Write-Host "  node : $NODE"
Write-Host "  entry: $ENTRY"

# --- ตรวจ admin ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "❌ ต้องรัน PowerShell แบบ Run as Administrator" -ForegroundColor Red; exit 1 }

# --- ตรวจไฟล์ worker ---
if (-not (Test-Path $ENTRY)) { Write-Host "❌ ไม่พบ $ENTRY — รัน 'npx tsc' ใน rpa-worker ก่อน" -ForegroundColor Red; exit 1 }

# --- หา/ติดตั้ง nssm ---
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  Write-Host "▶ ไม่พบ nssm — ดาวน์โหลด..." -ForegroundColor Yellow
  $nssmZip = Join-Path $env:TEMP "nssm.zip"
  $nssmDir = Join-Path $env:TEMP "nssm-2.24"
  Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip
  Expand-Archive -Path $nssmZip -DestinationPath $env:TEMP -Force
  $nssm = Join-Path $nssmDir "win64\nssm.exe"
  if (-not (Test-Path $nssm)) { $nssm = Join-Path $nssmDir "win32\nssm.exe" }
  Write-Host "  nssm: $nssm"
}

# --- ลบ service เดิมถ้ามี ---
$existing = & $nssm status $SERVICE 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "▶ มี service เดิม — ลบก่อน..." -ForegroundColor Yellow
  & $nssm stop $SERVICE 2>$null
  & $nssm remove $SERVICE confirm
  Start-Sleep -Seconds 2
}

# --- สร้าง log dir ---
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

# --- ติดตั้ง service ---
Write-Host "▶ สร้าง service '$SERVICE'..." -ForegroundColor Green
& $nssm install $SERVICE $NODE $ENTRY
& $nssm set $SERVICE AppDirectory $WORKER_DIR
& $nssm set $SERVICE AppStdout (Join-Path $LOG_DIR "worker.out.log")
& $nssm set $SERVICE AppStderr (Join-Path $LOG_DIR "worker.err.log")
& $nssm set $SERVICE AppRotateFiles 1
& $nssm set $SERVICE AppRotateBytes 10485760   # หมุน log ทุก 10MB
& $nssm set $SERVICE Start SERVICE_AUTO_START   # auto-start ตอน boot
& $nssm set $SERVICE AppExit Default Restart    # auto-restart ถ้า crash
& $nssm set $SERVICE AppRestartDelay 5000       # รอ 5 วิ ก่อน restart
& $nssm set $SERVICE DisplayName "RPA Import DCTK Worker"
& $nssm set $SERVICE Description "Worker หยิบงานจาก Supabase → กรอก DCTK สร้างใบขน (Playwright)"

# --- เริ่ม service ---
Write-Host "▶ เริ่ม service..." -ForegroundColor Green
& $nssm start $SERVICE
Start-Sleep -Seconds 3
& $nssm status $SERVICE

Write-Host ""
Write-Host "✅ ติดตั้งเสร็จ! worker จะรัน 24/7 (auto-start ตอน boot + auto-restart ถ้า crash)" -ForegroundColor Green
Write-Host ""
Write-Host "คำสั่งที่ใช้บ่อย:" -ForegroundColor Cyan
Write-Host "  nssm restart $SERVICE       # restart (เช่นหลัง git pull + npx tsc)"
Write-Host "  nssm status  $SERVICE       # ดูสถานะ"
Write-Host "  Get-Content '$LOG_DIR\worker.out.log' -Tail 30 -Wait   # ดู log สด"
