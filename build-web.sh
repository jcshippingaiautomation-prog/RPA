#!/usr/bin/env bash
# Build script สำหรับ Render Web Service (rpa-web)
# ต้องรันจาก repo root (ไม่ตั้ง Root Directory ใน Render)
#   เพราะ rpa-web พึ่ง rpa-import-node แบบ file:../rpa-import-node → ต้องเห็นทั้ง 2 โฟลเดอร์
set -e

echo "▶ [1/2] build rpa-import-node (rpa-web พึ่งพา — ต้อง build ก่อนให้มี dist/)"
cd rpa-import-node
npm install --include=dev
npm run build
cd ..

echo "▶ [2/2] build rpa-web"
cd rpa-web
npm install --include=dev
npm run build
cd ..

echo "✅ build เว็บเสร็จ (rpa-import-node + rpa-web)"
