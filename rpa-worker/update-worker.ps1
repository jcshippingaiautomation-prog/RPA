# ============================================================
#  อัปเดต worker จาก GitHub แล้ว restart service (ทำครั้งเดียวจบ)
#
#  วิธีใช้ (บน VM, PowerShell ปกติ — ไม่ต้อง admin ถ้า service ตั้งแล้ว):
#    cd $HOME\Desktop\RPA\rpa-worker
#    powershell -ExecutionPolicy Bypass -File update-worker.ps1
# ============================================================
$ErrorActionPreference = "Stop"
$REPO = Join-Path $HOME "Desktop\RPA"

Write-Host "▶ [1/4] git pull..." -ForegroundColor Cyan
Set-Location $REPO
git pull

Write-Host "▶ [2/4] build rpa-import-node..." -ForegroundColor Cyan
Set-Location (Join-Path $REPO "rpa-import-node")
npx tsc

Write-Host "▶ [3/4] build rpa-worker..." -ForegroundColor Cyan
Set-Location (Join-Path $REPO "rpa-worker")
npx tsc

Write-Host "▶ [4/4] restart service RpaWorker..." -ForegroundColor Cyan
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if ($nssm) {
  & $nssm restart RpaWorker
  Start-Sleep -Seconds 3
  & $nssm status RpaWorker
  Write-Host "✅ อัปเดต + restart เสร็จ — worker รันโค้ดใหม่แล้ว" -ForegroundColor Green
} else {
  Write-Host "⚠ ไม่พบ nssm — ถ้ายังไม่ได้ติดตั้ง service ให้รัน install-service.ps1 (as admin) ก่อน" -ForegroundColor Yellow
  Write-Host "  หรือรัน worker เองด้วย: node dist\worker.js"
}
