# RPA Import — Node.js (DCTK)

Port 1:1 ของ [`rpa_import.py`](../RPA for inport Data/rpa_import.py) มาเป็น **Node.js + TypeScript + Playwright**

อ่านข้อมูลจาก Google Sheet `รายการ` → กรอกใบขนสินค้าขาเข้าเข้าระบบ DCTK ให้อัตโนมัติทุกหน้า (Page 1–4) → พิมพ์ PDF → ส่งอีเมล

> ตัว Python เดิม ([RPA for inport Data/](../RPA for inport Data/)) **ยังเก็บไว้** ใช้เปรียบเทียบ/fallback ได้

---

## โครงสร้างไฟล์

```
rpa-import-node/
├── src/
│   ├── main.ts        # entry point + run loop + attachRules
│   ├── config.json    # (อยู่ที่ root) URL, user/pass, email, google_sheet
│   ├── selectors.ts   # CSS selectors ทั้งหมด (1:1)
│   ├── helpers.ts     # combo/dropdown/date pickers, clickThenType, log
│   ├── data.ts        # โหลด Google Sheet (gviz CSV) / Excel / field+customer rules
│   ├── pages.ts       # login, portfolio, fillPage1/2/3
│   ├── finalize.ts    # Page 4: done → print → save PDF (Stimulsoft viewer)
│   ├── email.ts       # ส่งอีเมล + รวม screenshots เป็น Capture_<customer>.pdf
│   └── types.ts
├── config.json
├── package.json
└── tsconfig.json
```

## ความต่างจาก Python (ไลบรารีที่ใช้แทน)

| Python | Node.js |
| ------ | ------- |
| `playwright` (sync) | `playwright` (async/await) |
| `requests` | `fetch` (built-in Node 20+) |
| `openpyxl` | `exceljs` |
| `Pillow` (รวมรูป→PDF) | `pdf-lib` |
| `smtplib` | `nodemailer` |

Logic, selectors, ลำดับขั้นตอน, การ skip ตาม field rules, เงื่อนไข CIF, การหา tab ใหม่, fallback ต่างๆ — **เหมือนเดิมทุกอย่าง**

---

## ติดตั้ง

```bash
cd rpa-import-node
npm install            # postinstall จะรัน "playwright install chromium" ให้
```

ถ้า postinstall ไม่ได้รัน (เช่นติดตั้งแบบ --ignore-scripts):

```bash
npx playwright install chromium
```

## ตั้งค่า

แก้ [config.json](config.json) — โครงสร้างเดียวกับ Python เป๊ะ:

| key | คำอธิบาย |
|-----|----------|
| `url`, `username`, `password` | login DCTK |
| `headless` | `true` = ไม่เปิดหน้าจอ |
| `slow_mo_ms` | หน่วงทุก action (ms) |
| `default_timeout_ms` | timeout default ของ Playwright |
| `google_sheet.enabled` | `true` = ดึงจาก Google Sheet, `false` = ใช้ Excel |
| `google_sheet.sheet_id` / `sheet_name` | sheet หลัก `รายการ` |
| `google_sheet.field_rules_sheet` | ชีท `การกรอกข้อมูล` (field ที่อนุญาตต่อลูกค้า) |
| `google_sheet.customer_rule_sheet` | ชีท `Customer_Rule` (มีคอลัมน์ `ร้องขอภาพหน้าจอ`) |
| `data_file` | ไฟล์ Excel input (เมื่อ google_sheet ปิด) |
| `download_dir` | โฟลเดอร์เก็บ PDF (default: `file download`) |
| `email.*` | Gmail SMTP + App Password (ดูใน config) |
| `pause_on_error` | `true` = หยุดรอ Enter เมื่อ error (เฉพาะตอน headless=false) |

## รัน

```bash
npm run build && npm start    # build แล้วรัน
# หรือ
npm run dev                   # รันตรงด้วย tsx ไม่ต้อง build
```

---

## หมายเหตุการใช้งานจริง (เหมือน Python เดิม)

1. **เริ่มต้น set `headless: false` + `slow_mo_ms: 300`** เพื่อดู flow ทำงาน
2. ถ้า error จะมี `error_record_<n>.png` (full-page screenshot) ที่ root โปรเจกต์
3. ปฏิทิน Kendo: สคริปต์กด ‹ / › ไปหาเดือนเป้าหมายเอง
4. Combo Kendo: เลือก item แรกที่โผล่ — ถ้าผลลัพธ์ > 1 ต้องเพิ่ม logic
5. การ download PDF ผ่าน Stimulsoft viewer: ดักผ่าน `waitForEvent('download')`; ถ้าไม่สำเร็จมี fallback `page.pdf()` (**ทำงานเฉพาะ headless Chromium**)
6. แถวที่ `สถานะการสร้างเอกสาร = TRUE` จะถูกข้าม
7. ลูกค้าที่ตั้ง `ร้องขอภาพหน้าจอ = TRUE` ใน `Customer_Rule` จะถูก capture หน้าจอแต่ละหน้า แล้วรวมเป็น `Capture_<customer>.pdf` แนบไปกับอีเมล
