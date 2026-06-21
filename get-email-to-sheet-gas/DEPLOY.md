# คู่มือ Deploy Get Email (Google Apps Script) — ละเอียด

ระบบ Get Email ใช้ **Supabase เป็นแหล่งข้อมูลเดียว** (ไม่ใช้ Google Sheet แล้ว)
flow: รับอีเมล → Gemini สกัดข้อมูล → เขียนลงตาราง `declarations` ใน Supabase

ไฟล์ที่ต้อง deploy: `00_Config.gs` … `13_Supabase.gs` (14 ไฟล์) + `appsscript.json`

---

## ภาพรวมขั้นตอน

1. สร้าง/เปิดโปรเจกต์ GAS
2. วางโค้ดทั้งหมด (วิธี A วางมือ / วิธี B clasp)
3. ตั้ง Script Properties 4 ตัว
4. เปิด Advanced Drive Service
5. รัน `selfTest` + ให้สิทธิ์ (authorize)
6. ตั้ง Trigger `processInbox` ทุก 1 นาที
7. Deploy เป็น Web App → เอา URL ใส่ rpa-web/.env

---

## ขั้นที่ 1 — สร้างโปรเจกต์ GAS

1. ไปที่ <https://script.google.com> → **New project**
2. ตั้งชื่อโปรเจกต์ (มุมซ้ายบน) เช่น `Get Email to Supabase`

> สำคัญ: ต้องล็อกอินด้วย **บัญชี Google ที่เป็นเจ้าของกล่องอีเมล** ที่จะรับเอกสาร
> เพราะ GAS จะอ่าน Gmail ของบัญชีที่รันสคริปต์

---

## ขั้นที่ 2 — วางโค้ด

### วิธี A: วางด้วยมือ (ง่ายสุด ไม่ต้องลงอะไร)

**2A.1 เปิดให้แก้ appsscript.json ได้**
- กดไอคอน ⚙️ **Project Settings** (เมนูซ้าย)
- ☑️ ติ๊ก **"Show appsscript.json manifest file in editor"**

**2A.2 สร้างไฟล์ทีละไฟล์**
- กลับไป **Editor** (`<>`)
- ไฟล์ `.gs` ทั้ง 14 ไฟล์: กดปุ่ม **+** ข้าง "Files" → **Script** → ตั้งชื่อให้ตรง (เช่น `00_Config`) → วางเนื้อหา
  - ตั้งชื่อไม่ต้องใส่ `.gs` (GAS เติมให้เอง)
  - ลำดับชื่อ (00, 01, …) แค่ช่วยให้อ่านง่าย — GAS รวมทุกไฟล์เป็น scope เดียว ลำดับไม่มีผล
- ไฟล์ `appsscript.json`: คลิกไฟล์ `appsscript.json` ที่โผล่มา (จากข้อ 2A.1) → วางทับทั้งหมด
- ลบไฟล์เริ่มต้น `Code.gs` (ถ้ามีและว่าง) ออกได้

**2A.3 Save** ทุกไฟล์ (Ctrl/Cmd + S)

### วิธี B: clasp (push ทีเดียว เร็วกว่า)

```bash
npm install -g @google/clasp
clasp login                      # เปิดเบราว์เซอร์ให้ยืนยันบัญชี

cd "get-email-to-sheet-gas"
clasp create --title "Get Email to Supabase" --type standalone
# มันจะสร้าง .clasp.json + appsscript.json (ถ้าซ้ำให้ตอบ overwrite ระวังทับของเรา)

clasp push                       # อัปโหลด *.gs + appsscript.json ทั้งหมด
clasp open                       # เปิดโปรเจกต์ในเบราว์เซอร์
```

> ถ้า clasp push เตือนเรื่อง appsscript.json ให้ใช้ไฟล์ของเรา (มี oauthScopes + Drive service ครบแล้ว)

---

## ขั้นที่ 3 — ตั้ง Script Properties (4 ตัว)

⚙️ **Project Settings** → เลื่อนลงหา **Script Properties** → **Add script property** ทีละตัว:

| Property | Value |
| -------- | ----- |
| `GEMINI_API_KEY` | คีย์ Gemini ของคุณ |
| `SUPABASE_URL` | `https://<your-project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `<service_role key จาก Supabase → Settings → API>` |
| `WEBAPP_TOKEN` | ตั้งค่าลับสักอัน (เช่น `rpa-2026-xyz`) — ใช้กันคนอื่นยิง Web App |

กด **Save script properties**

> `LAST_RUN_SUMMARY` ไม่ต้องตั้ง — โค้ดเขียนเองหลังรัน

---

## ขั้นที่ 4 — เปิด Advanced Drive Service

ใช้แปลงไฟล์แนบ DOCX/XLSX → PDF (ถ้าไฟล์เป็น PDF/รูปอย่างเดียวจะข้ามได้ แต่แนะนำเปิดไว้)

- ใน Editor เมนูซ้าย หา **Services** → กด **+ (Add a service)**
- เลือก **Drive API** → **Add**

> ถ้าใช้ appsscript.json ของเรา (มี `enabledAdvancedServices` แล้ว) ข้อนี้จะถูกเปิดอัตโนมัติ
> แต่บางครั้งต้องกด Add ในเมนู Services อีกครั้งให้ขึ้นสถานะ enabled

---

## ขั้นที่ 5 — รัน selfTest + ให้สิทธิ์

1. ในช่องเลือกฟังก์ชันด้านบน เลือก **`selfTest`** → กด **Run**
2. ครั้งแรกจะเด้ง **Authorization required**:
   - **Review permissions** → เลือกบัญชี → ถ้าขึ้น "Google hasn't verified" ให้กด **Advanced → Go to … (unsafe)** → **Allow**
   - (เป็นแอปของเราเอง ปลอดภัย)
3. ดูผลใน **Execution log** ด้านล่าง ควรเห็น:
   ```
   ✓ GEMINI_API_KEY พบแล้ว
   ✓ Supabase config พบแล้ว
   ✓ เชื่อม Supabase ได้ — customer_settings 2 ราย: THANAKORN, ZECK TSE
   ✓ email_rules 2 ราย
   ✓ WEBAPP_TOKEN ตั้งแล้ว
   ✓ Gmail search ใช้ได้
   ✓ Drive advanced service พร้อม
   === selfTest ผ่าน — พร้อมใช้งาน ===
   ```
4. ถ้ามี ✗ หรือ error → แก้ตามข้อความ (มักเป็น property พิมพ์ผิด หรือยังไม่เปิด Drive)

---

## ขั้นที่ 6 — ตั้ง Trigger (รันอัตโนมัติทุก 1 นาที)

1. เมนูซ้าย ⏰ **Triggers** → **+ Add Trigger** (มุมขวาล่าง)
2. ตั้งค่า:
   - Function: **`processInbox`**
   - Deployment: **Head**
   - Event source: **Time-driven**
   - Type: **Minutes timer** → **Every minute**
3. **Save** (จะขอ authorize อีกครั้งถ้ายังไม่เคย)

> ทุก 1 นาที GAS จะเช็คอีเมลใหม่ที่ตรง `email_rules` แล้วประมวลผลให้อัตโนมัติ

---

## ขั้นที่ 7 — Deploy เป็น Web App (ให้สั่งรันจากหน้าเว็บ rpa-web)

1. มุมขวาบน **Deploy → New deployment**
2. กดไอคอน ⚙️ ข้าง "Select type" → เลือก **Web app**
3. ตั้งค่า:
   - Description: เช่น `v1`
   - Execute as: **Me** (บัญชีคุณ)
   - Who has access: **Anyone**  ← ป้องกันด้วย `WEBAPP_TOKEN` แทน
4. **Deploy** → authorize ถ้าถาม
5. คัดลอก **Web app URL** (ลงท้าย `/exec`)

**เอา URL + token ไปใส่ใน `rpa-web/.env`:**
```
GAS_WEBAPP_URL=https://script.google.com/macros/s/XXXXXXXX/exec
GAS_SHARED_TOKEN=<ค่าเดียวกับ WEBAPP_TOKEN>
```
แล้ว restart rpa-web (`node dist/server.js`)

> ทดสอบเร็วๆ: เปิด URL `/exec` ในเบราว์เซอร์ → ควรเห็น
> `{"ok":true,"service":"get-email-to-sheet",...}` (นั่นคือ doGet health check)

---

## เสร็จแล้ว — ตรวจการทำงาน

- **อัตโนมัติ:** ส่งอีเมลทดสอบจาก sender ที่อยู่ใน `email_rules` (subject ตรงเงื่อนไข) + แนบ Invoice → รอ ~1 นาที → เปิด Supabase ตาราง `declarations` ดูแถวใหม่
- **จากหน้าเว็บ:** ไปหน้า **Get Email** ใน rpa-web → กด **สั่งรันตอนนี้** → ดู log + แถวล่าสุด

---

## แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
| ----- | --------------- |
| selfTest error "ยังไม่ได้ตั้งค่า Supabase" | Script Properties `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` ยังไม่ตั้ง/พิมพ์ผิด |
| "เชื่อม Supabase ไม่สำเร็จ HTTP 401" | key ผิด — ใช้ `service_role`/`sb_secret_` ไม่ใช่ publishable |
| DOCX/XLSX ไม่ถูกประมวลผล | ยังไม่เปิด Drive Advanced Service (ขั้นที่ 4) |
| อีเมลไม่ถูกหยิบ | sender ไม่ตรง `email_rules` หรือ subject ไม่ match (เช็คหน้า Get Email) |
| สั่งจากเว็บไม่ได้ "unauthorized" | `GAS_SHARED_TOKEN` (rpa-web) ≠ `WEBAPP_TOKEN` (GAS) |
| แก้โค้ดแล้ว Web App ยังเป็นของเก่า | ต้อง **Deploy → Manage deployments → Edit → Version: New version** |
