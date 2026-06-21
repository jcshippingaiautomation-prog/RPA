# RPA DCTK Import — สถานะการทำงาน (อ่านก่อนแก้ทุกครั้ง)

> ✅ **สำเร็จแล้ว end-to-end** (THANAKORN/ADM 01(A)/2026 → DCTK000034182/34184 + PDF + อีเมล ครบ 2 ใบ, 2026-06-14)
> ไฟล์นี้บันทึก **อะไรถูกแล้ว (ห้ามแก้)** + **วิธีการ** + **อะไรยังเหลือ**
> โค้ดหลัก: `rpa-import-node/src/` | Reference Python ที่เคยสำเร็จ: `RPA for inport Data 2/rpa_import.py`

## หลักการ (จาก user — สำคัญมาก)
1. **แก้เฉพาะจุดที่ผิด** อย่าแก้ฟังก์ชันรวมที่กระทบของที่ทำงานอยู่
2. **เช็คค่าช่องก่อนกรอกเสมอ ถ้าถูกอยู่แล้วไม่ต้องแตะ** (การ `fill("")` ลบของถูกแล้ว commit ไม่ติด = บั๊ก)
3. **ถ้ารันไม่ผ่าน** ตั้ง `RPA_PAUSE_ON_ERROR=1` ค้างจอ แล้วถาม user
4. ทดสอบ: invoice ทดสอบใช้ TestNNN เพิ่มทีละ 1 เมื่อสำเร็จ (กันซ้ำ)

## ✅ ลำดับ flow ที่ทำงานครบ (THANAKORN/CFR)
1. **login** — `goto(domcontentloaded, 45s)` (runner.ts)
2. **Page 1** — vessel/buyer(ค้น company)/consignee(popup)/voyage/น้ำหนัก/วันที่ → Save (pages.ts `fillPage1`)
3. **Page 2 ใบกำกับ** (`fillPage2Fill`) — invoice no/date/consignee/term →
   ตารางราคากรอกทีละ step แยกขาด (ดูตารางสกุลเงินล่าง) → Save&Close
4. **Page 3 รายละเอียดสินค้า** (`fillPage3`/`fillOneGoodsItem`) — รหัสสินค้า(combo strict)/น้ำหนัก×2/หน่วย×2/ปริมาณ/ราคา/ประกัน → **force สกุลเงินก่อนเซฟ** → ติ๊ก last entry → Save&Close
5. **Finalize** (`finalize.ts`) — กดเสร็จสิ้นใบกำกับ → print PDF (Stimulsoft) → เซฟไฟล์ + อัป Supabase + ส่งอีเมล

## ✅ ส่วนที่ถูกแล้ว — ห้ามแก้ (+ วิธีการ)
| ส่วน | วิธีการที่ใช้ (ห้ามเปลี่ยน) |
|---|---|
| login | `goto(domcontentloaded, 45s)` (เดิมรอ "load" 15s ไม่ทัน) |
| customs_unit_code | preset `TNE` ต่อลูกค้า + `firstNonEmpty` (ค่า DB เป็น "" ไม่ใช่ null) |
| น้ำหนัก/qty item=0 | ใบ item เดียว เติมจากค่าหัวใบ (postprocess) |
| ราคา/น้ำหนัก (Kendo numeric) | พิมพ์ตัวเลข + **Tab blur** (`put` opts.commit=true) — ไม่ blur ค่าจริง=0 |
| **สกุลเงิน ราคา/หน่วย+ราคา/FOB** | `comboPickSimple` = พิมพ์ → **Enter** (DCTK เติม USD ให้เอง → carry ลง Page 3) |
| ค่าระวาง/ค่าประกัน (จำนวนเงิน) | กรอก Page 2 เมื่อ term CIF/CFR/CNF/C&F |
| Finalize/print PDF ทน tab ปิด | `safeClick` + re-acquire page + guard `waitForLoadState` (finalize.ts) — เดิม crash ตอน tab report ปิด |

## 🔑🔑 สกุลเงินค่าระวาง/ค่าประกัน — ROOT CAUSE + วิธีแก้ (ที่สู้กันนานสุด)
**ปัญหา:** ช่องมี 2 ชั้น — model field (`FreightCurrencyCode`) + Kendo widget (`_Freight`/`_Freight_input`).
ตั้ง USD ได้จริง (aria-selected=true) แต่ **DCTK recalc หลังจากนั้นรีเซ็ต widget เป็น "0"** → ตอน submit เอา 0 ไปทับ → finalize ฟ้อง "ความยาวต้อง 3 หลัก/ค้นหาไม่พบ". (ราคาไม่โดน เพราะอะไรไม่ทราบ — แต่ค่าระวางโดน)

**วิธีแก้ที่ได้ผล (pages.ts ใน `fillPage3` ก่อน `SEL_BTN_SAVE_CLOSE`):**
**force-set ตอนสุดท้ายก่อนกด Save พอดี** (หลังนั้นไม่มี recalc มาทับ) ทั้ง 3 ช่อง = currency + dispatch change:
`FreightCurrencyCode`, `_Freight`, `_Freight_input` (และชุด `Insurance*` ถ้ามีค่าประกัน).
ผลที่ยืนยัน: `thisPageClosed=true` (เดิม false = เซฟ Page 3 ไม่ผ่าน) → finalize errors:[] → ได้เลขใบขน.
ดู [[dctk-currency-combo-attempts]]

## ⚠ กับดักที่เคยพลาด (อย่าทำซ้ำ — เสียเวลา 6+ ชม.)
- เอา grid-click ไปใช้ช่อง **ราคา** → จำนวนเงินหลุดลงช่องสกุลเงิน พัง (ราคาต้องใช้ Enter เท่านั้น)
- `comboPickSimple` ไป `fill("")` ลบ USD ที่ DCTK เติมถูกแล้ว → commit ไม่ติด → เด้งเป็น 0 (= ที่ user เห็น "RPA ใส่ 0")
- เชื่อ text="USD" ว่า commit แล้ว → จริงๆ ค่า submit ยัง 0 (ต้อง dump field จริงดู model+widget)
- เช็ค input.value แล้ว skip → input แสดงค่าตั้งแต่พิมพ์ ยังไม่ commit

## ❌ ยังเหลือ
- **ZECK TSE (CIF): ใบกำกับ Page 2 ไม่ถูกบันทึกเข้าใบขน** (declaration grid ว่าง) → ฟอร์มสินค้า Page 3 ไม่เปิด → timeout.
  ไม่ใช่ invoice ซ้ำ (test33 ก็ติด) ไม่ใช่สกุลเงิน (ZECK ได้ USD ครบ). capture error ไม่เจอ error → silent fail. **กำลังหา root cause.**
- Page 3 โหลดช้า — เพิ่ม wait เป็น ~45s แล้ว (ZECK ยังไม่พอ เพราะ invoice ไม่บันทึกตั้งแต่แรก)
- โค้ด diagnostic/action-log (📝, ดัมป์) ยังเหลือใน code รอเก็บกวาด

## วิธีรันทดสอบ
```bash
cd rpa-import-node && npm run build
cd rpa-worker && pkill -9 -f "node dist/worker.js"; RPA_PAUSE_ON_ERROR=1 RPA_PAUSE_SECONDS=180 npm run start > /tmp/rpa-worker.log 2>&1 &
node dist/enqueue-run.js "ADM 01(A)/2026"   # หา+คำนวณ index เอง, headless=false
# reset doc_status=false ก่อนถ้าใบทำไปแล้ว
```
