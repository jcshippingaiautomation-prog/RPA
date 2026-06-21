# RPA Web — แผงควบคุมสั่งรัน RPA Import

หน้าเว็บ (HTML + JS ล้วน) + Express backend สำหรับสั่งรัน [rpa-import-node](../rpa-import-node) (ตัวกรอกเว็บ DCTK) โดยไม่ต้องพิมพ์คำสั่ง terminal

## ฟีเจอร์

ทำงานแบบ **2 ขั้นตอน**:

1. **ขั้นที่ 1 — ดึงข้อมูล** (📥 ปุ่ม "ดึงข้อมูลจาก Sheet") — โหลดรายการจาก Google Sheet มาแสดงในตาราง **โดยยังไม่เปิด browser**
2. **ขั้นที่ 2 — รัน** — ติ๊กเลือกแถวที่ต้องการ → เลือกโหมด → กดรัน (ปุ่มรันจะเปิดให้กดก็ต่อเมื่อดึงข้อมูลแล้ว)

ฟีเจอร์อื่น:
- ▶ **รันทั้งหมด** / ▶ **รันเฉพาะแถวที่เลือก** / ⏹ **หยุด** (หยุดหลังแถวปัจจุบันเสร็จ)
- 🧪 **โหมด Dry run / 🔴 รันจริง** — dry run กรอกข้อมูลจริงทุกหน้าแต่ไม่ Save/Print/ส่งอีเมล
- 🖥 **เลือก headless หรือเปิดหน้า browser** (toggle บนหน้าเว็บ)
- 📡 **Log สดแบบ real-time** ผ่าน SSE
- 📊 **ตารางสถานะแต่ละแถว** (รอ / กำลังทำ / เสร็จ / ผิดพลาด / ข้าม)
- ⚙️ **แก้ config จากหน้าเว็บ** (URL, user/pass, slow_mo, timeout, อีเมล, headless)

## สถาปัตยกรรม

```
Browser (public/index.html + app.js)
   │  fetch + SSE
   ▼
Express (src/server.ts)
   │  import { runImport } จาก rpa-import-node
   ▼
rpa-import-node (Playwright → DCTK)
```

- Browser เปิด Playwright ตรงๆ ไม่ได้ → backend เป็นตัวรัน
- รันได้ครั้งละ 1 งาน (กดรันซ้ำตอนกำลังรันจะถูกปฏิเสธ)
- backend แก้ไฟล์ `rpa-import-node/config.json` ตัวจริง

## ติดตั้ง

ต้อง build `rpa-import-node` ก่อน เพราะ web ใช้ `dist` ของมัน:

```bash
# 1) build ตัว RPA ก่อน
cd ../rpa-import-node
npm install            # ครั้งแรก (จะโหลด chromium)
npm run build

# 2) ติดตั้ง + build web
cd ../rpa-web
npm install
npm run build
```

## รัน

```bash
npm start              # เปิดที่ http://localhost:5173
# หรือ
npm run dev            # โหมด dev (auto-reload)
# กำหนดพอร์ตเอง:
PORT=8080 npm start
```

เปิดเบราว์เซอร์ไปที่ <http://localhost:5173>

> **หมายเหตุ headless:** ถ้าติ๊ก "เปิดหน้าเว็บ" (headless ปิด) browser ของ Playwright
> จะเด้งขึ้นบน**เครื่องที่รัน backend** — เหมาะตอนรันบนเครื่องตัวเอง.
> ถ้า deploy บน server ที่ไม่มีจอ ให้ใช้ headless เสมอ

## เมื่อแก้โค้ด rpa-import-node

`file:` dependency จะ copy `dist` เข้า `node_modules` ตอน install — หลังแก้ rpa-import-node ต้อง:

```bash
cd ../rpa-import-node && npm run build
cd ../rpa-web && npm install      # refresh copy
```

## 2 เมนู (sidebar)

- **📦 Import Data** — สั่งรัน RPA กรอกเว็บ DCTK (2 ขั้นตอน) + ตารางเอกสารที่สร้าง (จาก Supabase)
- **✉️ Get Email** — สั่งรัน Google Apps Script (ดึงอีเมล→สกัด→เขียน Sheet) + ดูสถานะ/แถวล่าสุด

---

## ตั้งค่า Supabase (เก็บ/แสดงเอกสาร PDF)

ถ้าไม่ตั้งค่า ระบบยังรันได้ปกติ แค่ไม่เก็บ/แสดงเอกสาร

1. สร้าง/เปิด Supabase project
2. **Storage → New bucket** ชื่อ `rpa-documents` (ตั้ง public ได้ถ้าต้องการลิงก์ตรง)
3. **SQL Editor** รันเพื่อสร้างตาราง:
   ```sql
   create table if not exists documents (
     id uuid primary key default gen_random_uuid(),
     customer text,
     invoice text,
     kind text not null,
     filename text not null,
     storage_path text not null,
     public_url text,
     created_at timestamptz default now()
   );
   ```
4. **Project Settings → API** คัดลอก `Project URL` + `service_role` key
5. ใส่ใน `rpa-web/.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJ...   (service_role — ฝั่ง server เท่านั้น)
   SUPABASE_BUCKET=rpa-documents
   ```

> หลังรันจริง (ไม่ใช่ dry run) RPA จะอัป PDF ใบขนขึ้น Supabase อัตโนมัติ
> แล้วโผล่ในตาราง "📄 เอกสารที่สร้าง" หน้า Import Data

---

## ตั้งค่า Google Apps Script (Get Email)

1. เปิดโปรเจกต์ GAS [get-email-to-sheet-gas](../get-email-to-sheet-gas) (มีไฟล์ `12_WebApp.gs` แล้ว)
2. **Project Settings → Script Properties** เพิ่ม `WEBAPP_TOKEN` = ค่าลับสักอัน
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (ป้องกันด้วย token)
4. คัดลอก URL ที่ลงท้าย `/exec`
5. ใส่ใน `rpa-web/.env`:
   ```
   GAS_WEBAPP_URL=https://script.google.com/macros/s/XXXX/exec
   GAS_SHARED_TOKEN=<ค่าเดียวกับ WEBAPP_TOKEN>
   ```

> หน้า "Get Email" จะมีปุ่ม "สั่งรันตอนนี้" (เรียก `processInbox` ผ่าน Web App)
> และ "ดูสถานะ/ผลลัพธ์" (ผลรันล่าสุด + แถวล่าสุดใน sheet รายการ)

---

## API (อ้างอิง)

| Method | Path | หน้าที่ |
| ------ | ---- | ------- |
| GET | `/api/events` | SSE: log, row-status, run lifecycle |
| GET | `/api/status` | snapshot สถานะปัจจุบัน |
| GET | `/api/config` | อ่าน config (ปิดบัง password) |
| POST | `/api/config` | บันทึก config |
| POST | `/api/preview` | ขั้นที่ 1: ดึงแถวจาก Sheet (ไม่เปิด browser) |
| POST | `/api/run` | ขั้นที่ 2: เริ่มรัน `{ headless?, dryRun?, onlyRows? }` |
| POST | `/api/stop` | ขอหยุด |
| GET | `/api/documents` | list เอกสารจาก Supabase |
| GET | `/api/documents/download` | redirect ไป signed/public URL |
| GET | `/api/gas/config` | GAS ตั้งค่าไว้หรือยัง |
| POST | `/api/gas/run` | สั่งรัน processInbox ผ่าน GAS Web App |
| GET | `/api/gas/status` | ผลรันล่าสุด + แถวล่าสุดใน Sheet |
