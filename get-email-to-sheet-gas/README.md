# Get Email to Sheet — Google Apps Script

แทนที่ n8n workflow **"Get Email to System"** ด้วย Google Apps Script — **ไม่ต้องมี server, รันฟรีบน Google, ตั้ง trigger ทุก 1 นาทีได้ในตัว**

ดึงอีเมลที่มีเอกสารแนบ (Invoice / Booking Confirmation) จากลูกค้าที่ลงทะเบียน → ใช้ **Gemini 2.5 Pro** สกัดข้อมูลใบขนสินค้า 25 ฟิลด์ → เขียนลง Google Sheet `รายการ`

จากนั้น `rpa_import.py` (โปรเจกต์เดิม) อ่าน sheet นี้ไปกรอกเว็บ DCTK ต่อ — **2 ส่วนคุยกันผ่าน Google Sheet เหมือนเดิม**

---

## โครงสร้างไฟล์ (.gs แต่ละไฟล์ = 1 ไฟล์ใน editor)

| ไฟล์ | หน้าที่ |
| ---- | ------- |
| `00_Config.gs` | CONFIG + ลำดับคอลัมน์ output + อ่าน API key |
| `01_Main.gs` | **`processInbox`** (entry point) + orchestration + dedup ด้วย label |
| `02_Mail.gs` | แตก sender email / subject / shipper |
| `03_Sheets.gs` | อ่าน/lookup/append Google Sheet |
| `04_Customer.gs` | จับคู่ subject ลูกค้า |
| `05_Files.gs` | เตรียมไฟล์ให้ AI (PDF/รูปส่งตรง, Office→PDF ผ่าน Drive) |
| `06_Prompts.gs` | system prompts (จาก n8n) |
| `07_Gemini.gs` | เรียก Gemini REST ผ่าน UrlFetchApp |
| `08_Agents.gs` | Classifier + Extractor (+ tool Get_Customer_Rules) |
| `09_PostProcess.gs` | แปลงน้ำหนัก / map port / force country |
| `10_Utils.gs` | JSON extraction + type coercion |
| `11_Test.gs` | `selfTest` + `testPostProcess` (รันด้วยมือ) |
| `appsscript.json` | manifest (เปิด Drive service + ตั้ง scopes) |

---

## ต่างจาก n8n เดิม

| เดิม (n8n) | ใหม่ (GAS) |
| ---------- | ---------- |
| แปลงไฟล์ทุกชนิดเป็น JPG ผ่าน **ConvertAPI** | **ส่ง PDF/รูปเข้า Gemini ตรงๆ**; DOCX/XLSX แปลงเป็น PDF ผ่าน Google Drive |
| post-process อ้าง nested keys (บั๊ก) | ปรับให้ตรง **flat schema** จริง |
| โฮสต์บน n8n | รันบน Google ฟรี + time trigger |
| dedup ไม่ชัด | **ติด Gmail label** `processed-by-rpa` กันซ้ำ |

---

## วิธีติดตั้ง (ครั้งเดียว)

### 1. สร้างโปรเจกต์
1. เปิด <https://script.google.com> → **New project** → ตั้งชื่อ `Get Email to Sheet`
2. สร้างไฟล์ตามรายการข้างบน (ปุ่ม + ข้าง "Files") แล้ววางโค้ดแต่ละไฟล์
   - ไฟล์ `.gs` → ชนิด **Script**
   - `appsscript.json` → กดไอคอนเฟือง **Project Settings → ☑ Show "appsscript.json"** แล้วแก้ไฟล์นั้น

> หรือใช้ [`clasp`](https://github.com/google/clasp) push ทั้งโฟลเดอร์นี้ขึ้นไปทีเดียวก็ได้

### 2. ใส่ Gemini API key (ห้าม hard-code)
**Project Settings → Script Properties → Add script property**
- Property: `GEMINI_API_KEY`
- Value: `<คีย์จริง>`

### 3. เปิด Drive Advanced Service (สำหรับ DOCX/XLSX)
ถ้าใช้ `appsscript.json` ที่ให้มา จะเปิดให้อัตโนมัติแล้ว
ถ้าทำมือ: **Editor → Services (+) → Drive API → Add** (ถ้าไฟล์แนบเป็น PDF/รูปอย่างเดียว ข้ามได้)

### 4. ตรวจค่าใน `00_Config.gs`
`SHEET_ID`, ชื่อ tab (`รายการ` / `Customer_Rule` / `Identify_Customer`) — ตั้งค่า default ไว้ตรงกับ workflow เดิมแล้ว

### 5. รัน selfTest + ให้สิทธิ์
**Run → `selfTest`** → กด Authorize (ขอสิทธิ์ Gmail / Sheets / Drive / external request)
ดู Logs ว่าผ่านทุกข้อ ✓

### 6. ตั้ง trigger
**Triggers (รูปนาฬิกา) → Add Trigger**
- Function: **`processInbox`**
- Event source: **Time-driven** → **Minutes timer** → **Every minute**

---

## การทำงาน (ตรงกับ Spec §7)

1. ค้นอีเมลตาม `SEARCH_QUERY` (มีไฟล์แนบ + ยังไม่ติด label)
2. แตก sender email / subject
3. ลูกค้าต้องอยู่ใน `Customer_Rule` (lookup ด้วย email) **และ** subject ตรง pattern
4. เตรียมไฟล์แนบ (PDF/รูปส่งตรง, Office→PDF, อื่นข้าม)
5. **AI Agent 1** สกัด keyword ชื่อลูกค้า
6. lookup กฎเฉพาะลูกค้าใน `Identify_Customer` ด้วย keyword
7. **AI Agent 2** สกัด 25 ฟิลด์ (มี tool `Get_Customer_Rules` ให้เรียกซ้ำได้)
8. post-process (kg↔ton, map loading port, force buyer=destination)
9. append ลง `รายการ` แล้วติด label thread ว่าทำแล้ว

---

## หมายเหตุ

- **Dedup**: ติด label `processed-by-rpa` + query มี `-label:processed-by-rpa` → ทนทาน restart ได้ดี
- ถ้า classifier/extractor parse พัง จะ**ไม่**ติด label → ลองใหม่รอบ trigger ถัดไป (return `RETRY`)
- record ที่ฟิลด์หลักขาด (consignee/invoice/description) จะถูกตั้ง `_needs_review` ใน log (ฟิลด์ขึ้นต้น `_` ไม่ถูกเขียนลง sheet)
- **ขีดจำกัด GAS**: รัน 1 ครั้งห้ามเกิน 6 นาที → `MAX_THREADS=25` ต่อรอบกัน timeout; ถ้าอีเมลเยอะมากให้ลดเลขลงหรือเพิ่มความถี่ trigger
- **UrlFetchApp quota**: บัญชีฟรี ~20,000 calls/วัน — เหลือเฟือสำหรับงานนี้
- `appendRow` เขียนตามลำดับ `OUTPUT_COLUMNS` (ตรง Spec §5.3) — ให้ header แถวแรกของ tab `รายการ` เรียงตรงกัน
