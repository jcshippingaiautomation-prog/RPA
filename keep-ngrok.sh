#!/bin/bash
# ============================================================
#  keep-ngrok: เฝ้า ngrok ถ้าหลุด → เปิดใหม่อัตโนมัติ (กัน ERR_NGROK_3200)
#  ใช้: ./keep-ngrok.sh   (เปิดค้างไว้ใน terminal แยก)
# ============================================================
PORT=8100
echo "🛡  เฝ้า ngrok (port $PORT) — เช็คทุก 30 วิ, หลุดแล้วเปิดใหม่อัตโนมัติ"
echo "   (Ctrl+C เพื่อหยุดเฝ้า)"
while true; do
  # เช็คว่า tunnel ยังออนไลน์ (ngrok local API ตอบ + มี tunnel)
  ONLINE=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -c "public_url")
  if [ "$ONLINE" = "0" ]; then
    echo "$(date '+%H:%M:%S') ⚠ ngrok หลุด — เปิดใหม่…"
    pkill -f "ngrok http $PORT" 2>/dev/null
    sleep 2
    ngrok http $PORT --log=stdout > /tmp/ngrok.log 2>&1 &
    sleep 5
    URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).tunnels[0].public_url)}catch(e){console.log("?")}})')
    echo "$(date '+%H:%M:%S') ✓ ngrok กลับมาแล้ว: $URL"
  fi
  sleep 30
done
