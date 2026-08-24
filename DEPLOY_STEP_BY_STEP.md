# 🚀 คู่มือ Deploy ทีละขั้น — RPA Import DCTK

ระบบมี 3 ส่วนที่ต้อง deploy:
```
[1] Supabase (DB + คิว)  →  [2] เว็บ rpa-web (Render)  →  [3] worker (VM ของคุณ)
```
- **เว็บ** = คนเข้าใช้ผ่าน browser (login, upload, สั่งรัน, ดูผล) — รันบน Render
- **worker** = ตัวเปิด Chromium คุม DCTK จริง — รันบน VM (เพราะต้องต่อ DCTK + มี Playwright)
- ทั้งคู่คุยกันผ่าน Supabase (ไม่ต่อกันตรงๆ)

repo: https://github.com/jcshippingaiautomation-prog/RPA

---

## ✅ ก่อนเริ่ม — เตรียมค่าที่ต้องใช้

เปิดไฟล์ `rpa-web/.env` และ `rpa-worker/.env` ในเครื่อง คัดลอกค่าเหล่านี้ไว้ (จะเอาไปวางใน Render/VM):

| ค่า | เอาจาก |
|-----|--------|
| `SUPABASE_URL` | rpa-web/.env |
| `SUPABASE_SERVICE_KEY` | rpa-web/.env (⚠ ลับ — server เท่านั้น) |
| `SUPABASE_ANON_KEY` | rpa-web/.env |
| `SUPABASE_BUCKET` | rpa-web/.env (= `Jc shipping`) |
| `GEMINI_API_KEY` | rpa-web/.env |
| `GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` | rpa-web/.env (สำหรับ Get Email) |
| `GAS_WEBAPP_URL`, `GAS_SHARED_TOKEN` | rpa-web/.env |

> 🔒 ค่าเหล่านี้ห้าม commit ขึ้น git — ใส่ผ่าน dashboard ของ Render/VM เท่านั้น

---

## 📍 ส่วนที่ 1 — Supabase (ทำครั้งเดียว ~10 นาที)

### 1.1 รัน SQL สร้างตาราง
1. เข้า https://supabase.com → เลือก project ของคุณ
2. เมนูซ้าย → **SQL Editor** → **New query**
3. เปิดไฟล์ในเครื่องทีละไฟล์ (โฟลเดอร์ `rpa-web/sql/`) → copy เนื้อหา → วาง → กด **Run**
   รัน **เรียงลำดับ** (สำคัญ):
   ```
   01_profiles_auth.sql        ← ตาราง profiles + login
   02_job_queue.sql            ← คิวงาน + log
   03_declarations_status.sql
   04_declarations_extra_fields.sql
   05_declaration_no.sql
   06_job_edit_and_status.sql
   07_item_multi_fields.sql
   ```
   (ถ้าไฟล์ไหนรันแล้ว error "already exists" = เคยรันแล้ว ข้ามได้)

### 1.2 สร้าง admin user คนแรก
1. เมนูซ้าย → **Authentication** → **Users** → **Add user** → **Create new user**
   - ใส่ email + password (อันนี้ใช้ login เข้าเว็บ)
   - ติ๊ก **Auto Confirm User** (ไม่ต้องยืนยันอีเมล)
2. กลับไป **SQL Editor** → New query → รัน (เปลี่ยน email เป็นของคุณ):
   ```sql
   update public.profiles set role='admin' where email='your-email@example.com';
   ```

### 1.3 เช็ค Storage bucket
- เมนูซ้าย → **Storage** → ต้องมี bucket ชื่อ **`Jc shipping`** (ตรงกับ SUPABASE_BUCKET)
- ถ้าไม่มี → สร้าง bucket ใหม่ชื่อนี้ (ตั้งเป็น **Public** เพื่อให้เปิด PDF ได้ หรือ private ก็ได้ถ้าใช้ signed url)

---

## 📍 ส่วนที่ 2 — เว็บ (Render Web Service ~10 นาที)

### 2.1 สร้าง service
1. เข้า https://render.com → login (เชื่อม GitHub account ที่มีสิทธิ์ org)
2. **New +** → **Web Service**
3. เลือก repo **jcshippingaiautomation-prog/RPA** → Connect
4. ตั้งค่า:
   | ช่อง | ค่า |
   |------|-----|
   | Name | `rpa-web` |
   | Root Directory | `rpa-web` |
   | Runtime | Node |
   | Build Command | `npm install && npm run build` |
   | Start Command | `npm start` |
   | Plan | **Free** (sleep 15 นาทีถ้าไม่มีคน) หรือ **Starter $7** (always-on) |

### 2.2 ใส่ Environment Variables
เลื่อนลงหา **Environment** → **Add Environment Variable** ทีละตัว:
```
NODE_ENV              = production
SUPABASE_URL          = <ค่าจาก .env>
SUPABASE_SERVICE_KEY  = <ค่าจาก .env>
SUPABASE_ANON_KEY     = <ค่าจาก .env>
SUPABASE_BUCKET       = Jc shipping
GEMINI_API_KEY        = <ค่าจาก .env>
GEMINI_MODEL          = gemini-2.5-flash
GMAIL_CLIENT_ID       = <ค่าจาก .env>
GMAIL_CLIENT_SECRET   = <ค่าจาก .env>
GMAIL_REFRESH_TOKEN   = <ค่าจาก .env>
GAS_WEBAPP_URL        = <ค่าจาก .env>
GAS_SHARED_TOKEN      = <ค่าจาก .env>
```
> ⚠ **NODE_ENV=production สำคัญ** — เปิด auth guard (บังคับ login กันคนนอก)
> 💡 PORT ไม่ต้องตั้ง — Render กำหนดเอง (โค้ดอ่าน env PORT อัตโนมัติ)

### 2.3 Deploy
- กด **Create Web Service** → รอ build (~3-5 นาที)
- ได้ URL เช่น `https://rpa-web-xxxx.onrender.com`
- เปิด URL → ต้องเด้งไป `/login.html` → login ด้วย admin ที่สร้างใน 1.2

✅ ถ้า login เข้าได้ + เห็นหน้ารายการ = เว็บ deploy สำเร็จ

---

## 📍 ส่วนที่ 3 — Worker (VM ของคุณ ~15 นาที)

worker ต้องรันบน VM ที่ **(ก)** ต่อ DCTK ได้ `203.154.140.105` **(ข)** ลง Node 20+ ได้

### 3.1 เตรียม VM
- เช่า VM (เช่น DigitalOcean/AWS/Vultr) Ubuntu 22.04, RAM ≥ 2GB
- หรือใช้เครื่องที่มี (Mac/Linux) ที่เปิดทิ้งไว้ได้

### 3.2 ลงของบน VM
```bash
# 1) ลง Node 20 (ถ้ายังไม่มี)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2) clone repo
git clone https://github.com/jcshippingaiautomation-prog/RPA.git
cd RPA

# 3) build rpa-import-node ก่อน (worker พึ่งพา)
cd rpa-import-node && npm install && npm run build && cd ..

# 4) build worker + ลง Chromium
cd rpa-worker
npm install
npm run build
npx playwright install --with-deps chromium
cd ..
```

### 3.3 สร้างไฟล์ config + env บน VM
**(ก) `rpa-import-node/config.json`** — credentials DCTK (ไฟล์นี้ไม่อยู่ใน git ต้องสร้างเอง):
```json
{
  "url": "http://203.154.140.105/DCTK/Account/Login",
  "username": "TALAY",
  "password": "TALAY",
  "headless": true,
  "slow_mo_ms": 0,
  "default_timeout_ms": 15000,
  "download_dir": "file download"
}
```

**(ข) `rpa-worker/.env`**:
```
SUPABASE_URL=<ค่าเดียวกับเว็บ>
SUPABASE_SERVICE_KEY=<ค่าเดียวกับเว็บ>
SUPABASE_BUCKET=Jc shipping
WORKER_POLL_MS=3000
WORKER_TYPES=rpa_import,rpa_edit
RPA_PAUSE_ON_ERROR=0
RPA_HEADLESS=1
```
> `RPA_HEADLESS=1` + `RPA_PAUSE_ON_ERROR=0` = production (รันเงียบ ไม่ค้างหน้าจอ)

### 3.4 รัน worker (ให้รันค้าง + restart อัตโนมัติ)
ใช้ **pm2** (แนะนำ — restart ตอน crash + รันตอน reboot):
```bash
sudo npm install -g pm2
cd rpa-worker
pm2 start dist/worker.js --name rpa-worker
pm2 save
pm2 startup            # ทำตามคำสั่งที่มันบอก (ให้รันตอน VM reboot)
```
ดู log: `pm2 logs rpa-worker`
หยุด: `pm2 stop rpa-worker` / รีรัน: `pm2 restart rpa-worker`

✅ ถ้า log ขึ้น `[worker] เริ่มทำงาน — types=...` = worker พร้อม

---

## 📍 ทดสอบ end-to-end (หลัง deploy ครบ)

1. เปิดเว็บ Render → login admin
2. **upload** ไฟล์เอกสารลูกค้า 1 ใบ → กดประมวลผล → รายการขึ้น (AI สกัด)
3. กด **รัน** ที่รายการ → status: queued → running
4. **worker บน VM หยิบงาน** → เปิด Chromium (เงียบ) คุม DCTK → log ไหลเข้าเว็บสด
5. จบ → status "เสร็จ" + กด **ดูไฟล์** เห็น PDF ใบขน

> ⏱ ถ้าใช้ Render Free: เว็บ sleep หลังไม่มีคน 15 นาที → เข้าครั้งแรกรอ ~30 วิ (ปกติ)

---

## 🔒 Security checklist (เช็คก่อนใช้จริง)
- [ ] `NODE_ENV=production` ใน Render (auth guard เปิด)
- [ ] `.env` + `config.json` **ไม่อยู่ใน git** (อยู่แค่ env ของ platform/VM)
- [ ] admin user สร้างแล้ว + password แข็งแรง
- [ ] revoke GitHub PAT ที่ใช้ push (ถ้าไม่ใช้แล้ว)
- [ ] worker VM ปิด port ที่ไม่จำเป็น (worker ไม่ต้องเปิด port — แค่ต่อออกไป Supabase/DCTK)

---

## ❓ Troubleshooting
| อาการ | สาเหตุ/แก้ |
|------|-----------|
| เว็บ login ไม่ได้ | เช็ค SUPABASE_ANON_KEY + admin user role=admin |
| กดรันแล้วไม่มีอะไรเกิด | worker ไม่ได้รัน / .env worker ผิด → ดู `pm2 logs` |
| worker เปิด browser ไม่ได้ | ยังไม่ `npx playwright install` / RAM ไม่พอ |
| worker ต่อ DCTK ไม่ได้ | VM ออกเน็ตไป 203.154.140.105 ไม่ได้ (firewall) |
| PDF เปิดไม่ได้ | bucket ไม่ public / storage_path ผิด |
| multi-item ลูกค้าบางรายติด | ดู memory: ZECK(buyer address), KASEMCHAI(C62), COCO(master) — ยังเป็นงานค้าง |
