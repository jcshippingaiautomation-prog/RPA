#!/bin/bash
# หยุดระบบ DCTK Automation ทุกส่วน (ไม่แตะพอร์ต 8000)
echo "หยุดเว็บ (8100)…"; lsof -ti :8100 2>/dev/null | xargs kill -9 2>/dev/null || true
echo "หยุด ngrok…"; pkill -f "ngrok http 8100" 2>/dev/null || true
echo "หยุด worker…"; pkill -9 -f "dist/worker.js" 2>/dev/null || true
echo "หยุด chromium ค้าง…"; pkill -9 -f "chromium" 2>/dev/null || true
echo "✅ หยุดระบบทั้งหมดแล้ว"
