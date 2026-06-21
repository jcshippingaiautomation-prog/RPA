#!/bin/bash
# ============================================================
#  เริ่มระบบ DCTK Automation ครบทุกส่วน
#  ใช้: ./START.sh   (รันบนเครื่องที่ต่อ DCTK ได้ + มี ngrok)
# ============================================================
set -e
ROOT="/Users/pok/Desktop/Jobs/ScriptMappingคุณแพรว"

echo "▶ 1/3 เริ่มเว็บ (PORT 8100)…"
cd "$ROOT/rpa-web"
# kill เว็บเก่าถ้ามี (ห้ามแตะ 8000)
lsof -ti :8100 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1
PORT=8100 node dist/server.js > /tmp/rpaweb.log 2>&1 &
echo "   เว็บ: http://localhost:8100 (log: /tmp/rpaweb.log)"
sleep 2

echo "▶ 2/3 เริ่ม ngrok tunnel…"
pkill -f "ngrok http 8100" 2>/dev/null || true
sleep 1
ngrok http 8100 --log=stdout > /tmp/ngrok.log 2>&1 &
sleep 4
URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).tunnels[0].public_url)}catch(e){console.log("(ดู /tmp/ngrok.log)")}})')
echo "   URL สาธารณะ: $URL"

echo "▶ 3/3 เริ่ม RPA worker…"
cd "$ROOT/rpa-worker"
pkill -9 -f "dist/worker.js" 2>/dev/null || true
sleep 1
node dist/worker.js > /tmp/rpaworker.log 2>&1 &
echo "   worker: รัน (log: /tmp/rpaworker.log)"

echo ""
echo "✅ ระบบพร้อมใช้งาน!"
echo "   เว็บสาธารณะ: $URL"
echo "   login: jcshipping@gmail.com"
echo ""
echo "หยุดทั้งหมด: ./STOP.sh"
