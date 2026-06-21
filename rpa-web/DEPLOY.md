# คู่มือ Deploy — เว็บเดียว + RPA Worker แยก

สถาปัตยกรรม: **Web App (cloud)** สั่งงาน → **Supabase (queue)** → **RPA Worker (VM)** ทำงาน

```
ผู้ใช้ → Web (Render) ─enqueue→ Supabase job_queue ─claim→ Worker (VM, Playwright)
              ↑                                                      │
              └────────── job_logs (Realtime) ←──────────────────────┘
```

---

## ขั้นเตรียม Supabase (ทำครั้งเดียว)

รัน SQL ใน Supabase SQL Editor ตามลำดับ:
1. `sql/01_profiles_auth.sql` — ตาราง profiles + RLS + trigger (Phase A)
2. `sql/02_job_queue.sql` — job_queue + job_logs + claim RPC + Realtime (Phase C)

สร้าง admin คนแรก: Authentication → Add user → แล้วรัน
`update public.profiles set role='admin' where email='<your-email>';`

---

## 1) Web App — Render Web Service (always-on)

> ⚠ ใช้ **Render** ไม่ใช่ Vercel — เพราะ SSE + Realtime subscription ต้องมี process อยู่ตลอด (serverless ตัด SSE)

- **Root directory:** `rpa-web`
- **Build:** `npm install && npm run build`
- **Start:** `npm start` (= `node dist/server.js`)
- **Health check path:** `/login.html`

### Environment variables (Web)
```
PORT=                       (Render กำหนดเอง — ไม่ต้องตั้ง)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...        # service_role — server-only, ห้าม bundle ลง public/
SUPABASE_ANON_KEY=eyJ...           # anon public — ส่งให้ frontend ผ่าน /api/public-config
SUPABASE_BUCKET=Jc shipping

# Get Email (Node pipeline)
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash      # หรือเปลี่ยนผ่านหน้าตั้งค่า
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...            # scope: gmail.readonly + gmail.modify
GMAIL_PROCESSED_LABEL=processed-by-rpa
GMAIL_MAX_THREADS=2
FILE_CONVERT_API_URL=...           # บริการแปลง Office→PDF (xlsx/docx) — optional
FILE_CONVERT_API_KEY=...
```
> Web **ไม่ต้องมี Playwright** (ไม่เปิดเบราว์เซอร์) — deploy เบา

---

## 2) RPA Worker — VM เล็ก (ต้องมีเบราว์เซอร์จริง)

ทำไมต้อง VM: Playwright เปิด Chromium ควบคุม DCTK หลายนาที — serverless รันไม่ได้

ตัวเลือก: Render **Background Worker** / Fly.io machine / VPS เล็ก (1-2GB RAM)

- **Root directory:** `rpa-worker`
- **Build:** `npm install && npm run build && npx playwright install --with-deps chromium`
- **Start:** `npm start` (= `node dist/worker.js`)
- รันเป็น restart-on-crash (Render worker ทำให้เอง / systemd / PM2)

### Environment variables (Worker)
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...        # worker ต้อง service role เพื่อ claim job + เขียน log
SUPABASE_BUCKET=Jc shipping
WORKER_POLL_MS=3000
WORKER_TYPES=rpa_import,rpa_edit   # หรือเพิ่ม get_email ถ้าจะให้ worker รัน Get Email ด้วย
RPA_PAUSE_ON_ERROR=0               # production = 0 (ไม่ค้างเบราว์เซอร์)
RPA_HEADLESS=1                     # production = 1 (รันเบราว์เซอร์เงียบ ไม่เด้งหน้าจอ) — override config.json
```
> config DCTK (url/username/password) อยู่ใน `rpa-import-node/config.json`
> headless ใช้ env `RPA_HEADLESS=1` ตอน production (ไม่ต้องแก้ config.json — config ใช้ test แบบเห็น browser บนเครื่อง dev)

### ⚠ ข้อควรตรวจก่อน production
- VM ต้องเข้าถึงเว็บ DCTK ได้ (เผื่อ portal จำกัด IP → ตั้ง VPN/IP allowlist)
- credentials DCTK เก็บใน config.json ของ worker (ไม่ commit จริง)

---

## 3) ตรวจหลัง deploy (end-to-end)
1. เปิด URL เว็บ → เด้ง `/login.html` → login admin
2. หน้า Import → กด Run → job เข้า queue (status pending)
3. Worker หยิบ (processing) → log ไหลเข้าเว็บแบบสด (SSE)
4. จบ → PDF ขึ้น Supabase Storage + โผล่ในรายการเอกสาร
5. หน้า Get Email → กด Run → declarations เข้า (ถ้าตั้ง Gmail OAuth ครบ)

## Security checklist
- [ ] `SUPABASE_SERVICE_KEY` อยู่ใน env ฝั่ง server เท่านั้น (web + worker) — **ไม่อยู่ใน public/**
- [ ] `/api/public-config` คืนแค่ anon key (ตรวจแล้วในโค้ด)
- [ ] GMAIL_REFRESH_TOKEN เก็บ server-only
- [ ] ทุก `/api/*` ผ่าน requireUser; route ตั้งค่าผ่าน requireAdmin
