# สรุปปัญหา RPA DCTK — สำหรับหาวิธีแก้ (อัปเดต 2026-06-14)

## ปัญหาเดียวที่เหลือ (บล็อกทุกอย่าง)
**กรอก "สกุลเงินค่าระวาง" ในฟอร์ม DCTK แล้ว Kendo ComboBox ไม่ commit ค่าจริง**

### อาการ
- RPA พิมพ์ "USD" ลงช่องสกุลเงินค่าระวาง → ช่อง input **แสดง "USD"** (ดูเหมือนถูก)
- แต่ DCTK ตอน Save&Close ฟ้อง: **"รหัสสกุลเงินค่าระวาง : ความยาวของข้อมูลต้องเท่ากับ 3 หลัก / ค้นหาข้อมูลไม่พบ (สกุลเงินค่าระวาง)"**
- แปลว่า input แสดง USD แต่ **hidden value ที่ submit ใช้ไม่ถูก set** (Kendo ไม่ได้ "เลือก dataItem" จริง)

### user ยืนยัน (สำคัญ)
- **คลิกแถว USD ในตาราง dropdown ด้วยมือ → dropdown หายทันที + ช่องแสดง USD + บันทึกผ่าน**
- dropdown สกุลเงิน = **grid (ตาราง)** มี header: รหัสสกุลเงิน | ชื่อสกุลเงิน | หน่วยย่อยสกุลเงิน
- ต้อง**พิมพ์ USD ก่อน** list ถึงขึ้น (ajax filter ช้า) → เหลือ 1 แถว: USD | U.S. DOLLAR
- ช่อง "สกุลเงินราคา" commit ได้แล้ว (วิธีเดียวกัน) แต่ "ค่าระวาง" ไม่ได้

### วิธีที่ลองแล้ว "ไม่สำเร็จ" (10 รอบ — อย่าทำซ้ำ)
1. `page.click()` บน selector ของแถว → หา element ไม่เจอ
2. JS `dispatchEvent(mousedown/mouseup/click/dblclick)` บน element ที่ text=USD → ไม่ commit
3. `ArrowDown + Enter` (รอ list นิ่งก่อน) → input=USD แต่ไม่ commit
4. คลิก coordinate ใต้ input หลายระดับ (38-75px) → ไม่ commit / บางทีคลิกผิดช่อง
5. Playwright `getByText("USD")` + click row → ไม่ commit
6. **Kendo widget API** `$(sel).data("kendoComboBox").value("USD")` → **found=false** (DCTK ไม่ expose jQuery widget ให้เข้าถึง / หา widget ไม่เจอ)

### สาเหตุที่ commit verify ผิด (กับดัก)
- เคยเช็ค commit จาก `input.value === "USD"` → **คืน true ตลอด** เพราะ input แสดง USD ตั้งแต่พิมพ์
- ต้องเช็คจาก: **dropdown ปิด** หรือ **hidden field value** ไม่ใช่ input text

## ข้อมูลทางเทคนิค DCTK
- **ASP.NET MVC** — URL: `/DCTK/ExInvoice/Create`, `/DCTK/ExDecDtl/Create`
- **Kendo UI** (jQuery) — combo เป็น Kendo ComboBox/dropdowngrid
- **ไม่มี REST API** — probe `/swagger`, `/api`, `/DCTK/api` → ไม่เจอ (เป็น server-rendered form)
- **Login** = form post (`#btnSubmit`) + cookie session (ไม่ใช่ JWT)
- → **ใช้ API/JWT ส่ง JSON ตรงไม่ได้** ต้องกรอกฟอร์มผ่าน RPA

## selector ที่เกี่ยวข้อง
- ช่องสกุลเงินค่าระวาง: `SEL_FREIGHT_CURRENCY` = `#TabStrip-1 > div.row.col-lg-8 > fieldset > div:nth-child(8) > div.col-xs-1...currencyCode...> span > span > input`
- ช่องสกุลเงินราคา: `SEL_CURRENCY_INPUT` = เหมือนกันแต่ `div:nth-child(6)`
- โค้ดที่กรอก: `comboPickSimple()` ใน `rpa-import-node/src/helpers.ts`

## คำถามที่ user จะไปหาคำตอบมา
**"จะทำให้ RPA (Playwright) คลิกแถว USD ใน Kendo dropdowngrid แล้ว commit ค่าจริง ได้อย่างไร?"**

แนวที่ยังไม่ลอง (อาจลองเมื่อ user ให้ข้อมูล):
- หา `<select>` หรือ `<input type=hidden>` ที่ Kendo ผูกไว้ แล้ว set value + dispatch change ที่ตัวนั้นตรง ๆ
- ใช้ Playwright `force click` ที่ `tr.k-table-row` / `.k-grid td` ใน popup ที่ถูกต้อง (ต้องรู้ class จริงจาก DevTools)
- เปลี่ยน DCTK ให้ default สกุลเงินเป็น USD ไว้ล่วงหน้า (ฝั่ง DCTK ถ้าทำได้)

---

## ✅ ส่วนที่เสร็จแล้ว (ดูรายละเอียดใน RPA_STATUS.md)
login, Page1, customs_unit(TNE), น้ำหนัก, ราคา commit (Tab blur), สกุลเงินราคา, ค่าระวางตัวเลข,
frontend error display, pre-run validation (backend)

## งานค้างอื่น (รอ combo แก้ก่อน)
- ค่าระวาง alloc: รายการแรกใส่เต็ม รายการอื่นใส่ "0" (pages.ts allocFreight) — user ถามว่าทำไมใส่ 0
- ใบ DCTK ค้าง ~15 ใบจากทดสอบ (DCTK000034091-34127) — finalize ไม่จบ
- frontend validation UI (backend เสร็จ รอทำ frontend)
