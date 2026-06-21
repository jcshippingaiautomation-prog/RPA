-- ============================================================
-- นำเข้า customer_settings: KASEMCHAI + COCO (จากเอกสารจริง)
-- รันใน Supabase SQL Editor  (on conflict = รันซ้ำได้)
-- ============================================================

-- ========== KASEMCHAI ==========
insert into public.customer_settings (customer_name, allowed_fields, presets, extraction_rules, request_screenshot)
values (
  $cust$KASEMCHAI$cust$,
  '{customer_name,consignee_name,buyer_country_code,destination_country_code,vessel_name,voyage_number,release_port_code,loading_port_code,shipping_mark,tax_payment_method_code,etd,invoice_number,invoice_date,incoterms,currency,total_goods_amount,freight_charge,insurance_charge,net_weight_kg,gross_weight_kg,description_eng,net_weight_ton,net_weight_unit_code,container_or_volume_qty,container_unit_code}'::text[],
  $json${"customer_name":"KASEMCHAI","incoterms":"CFR","tax_payment_method_code":"A","container_unit_code":"CT"}$json$::jsonb,
  $rules$[Customer Rules: KASEMCHAI / KASEMCHAIFOOD]
สินค้าคือไข่ (Eggs) เอกสารประกอบด้วย Booking Confirmation + Commercial Invoice + Packing List
+ [เนื้อหาอีเมล] ที่แนบมาท้าย prompt — สำคัญมาก KASEMCHAI ใส่ข้อมูลหลายอย่างในอีเมล

[เนื้อหาอีเมล (email body) — ของ KASEMCHAI มีรูปแบบตารางแบบนี้ ให้ยึดเป็นหลักก่อนเอกสาร]
ตัวอย่าง:
  Please draft export declaration from BKK to Hong Kong
  Paperless : 0252
  O/f : USD 1170
  INV/PL : KCF-PNS202606-27, PNS#27
  PO# : PO#91119079
  Loading : 26/05/2026
  ETD : 30/05/2026
  ETA : 03/06/2026
  BOOKING : BKKA00701500
  BL : SEA WAYBILL
การ map จากอีเมล:
- freight_charge: ใช้ค่าหลัง "O/f :" เสมอ (เช่น O/f : USD 1170 → freight_charge = 1170) — ยึดอีเมลก่อนเอกสาร ถ้าอีเมลไม่มีค่อยดูเอกสาร ถ้าไม่มีทั้งคู่ใส่ 0
- release_port_code: ใช้ค่าหลัง "Paperless :" (เช่น 0252)
- invoice_number: ใช้ค่าหลัง "INV/PL :" ตัวแรก (เช่น KCF-PNS202606-27)
- etd: ใช้ค่าหลัง "ETD :" (เช่น 30/05/2026 → 2026-05-30)
- destination/buyer country: ดูประโยค "from BKK to Hong Kong" → HK
หมายเหตุ: ค่าในอีเมลกับเอกสารควรตรงกัน ถ้าต่าง ให้ยึด "อีเมล" เป็นหลัก (พนักงานอัปเดตในอีเมล)

[ค่าคงที่ Default Values]
- customer_name: "KASEMCHAI" เสมอ
- incoterms: "CFR" เสมอ (เอกสารไม่ระบุ ใช้ CFR ตลอด)
- tax_payment_method_code: "A"
- container_unit_code: "CT" (หน่วยหีบห่อเป็น Carton)

[จุดสกัดข้อมูล (เอกสาร — ใช้เสริม/ยืนยันกับอีเมล)]
- customer_name / Shipper: "Kasemchai Food Co.,Ltd." ใน Booking/Invoice
- buyer_country_code / destination_country_code: ดูช่อง "To" ใน Booking ("HONG KONG"→HK) หรือ Invoice "To: HK Main Port" / "Singapore Main Port" — แปลงเป็นรหัส 2 ตัว (HK, SG); ทั้งสองฟิลด์ใส่ค่าเดียวกัน
- vessel_name / voyage_number: Booking ช่อง "FEEDER VESSEL" เช่น "KMTC TAIPEIS V.2605N" → vessel_name="KMTC TAIPEIS", voyage_number="2605N" (ตัด "V." ทิ้ง; ถ้า voyage มี 0 นำหน้าให้ตัดทิ้ง)
- release_port_code: Booking ช่อง "PAPERLESS CODE" (เช่น 0252, 2812)
- loading_port_code: ตาม release_port_code — ถ้าขึ้นต้น "025" ให้ "0250"; ถ้าขึ้นต้น "28" ให้ "2801"
- invoice_number: Invoice "Invoice No" เช่น KCF-PNS202604-19 / KCF-GT202510-87
- invoice_date: Invoice "Issued date" เช่น 9-Apr-26 → 2026-04-09
- consignee_name: Invoice "Messrs" เช่น "PARKnSHOP (HK) Limited." / "AN HONG EGG SUPPLIES" / "GREEN-TECH EGG INDUSTRIES PTE LTD"
- currency: ดูหัวคอลัมน์ราคา "PRICE, C&F HONGKONG" หรือ "C&F SINGAPORE" หรือ "SGD/Egg" — เช่น USD, SGD
- total_goods_amount: ยอด TOTAL Amount มุมขวาล่างของ Invoice (เช่น 40,078.33 / 38,886.20 / 45,466.20) ใช้ค่านี้ตรงๆ
- freight_charge: ยึดค่าหลัง "O/f :" ใน[เนื้อหาอีเมล]เป็นหลัก (เช่น 1170) ถ้าอีเมลไม่มีค่อยดูเอกสาร ถ้าไม่มีทั้งคู่ใส่ 0
- insurance_charge: ถ้าไม่ระบุ ใส่ 0
- net_weight_kg / gross_weight_kg: Packing List แถว TOTAL คอลัมน์ NET WEIGHT / GROSS WEIGHT (เช่น 17,101.00 / 19,085.00)
- net_weight_ton: net_weight_kg / 1000
- net_weight_unit_code: "TO"
- description_eng: Invoice คอลัมน์ DESCRIPTION (รวม BRAND NAME ข้างหน้าถ้ามี เช่น "SELECT THAI FRESH BROWN EGGS (XL)") — ตัวพิมพ์ใหญ่ทั้งหมด
- container_or_volume_qty: Packing/Invoice แถว TOTAL คอลัมน์ QUANTITY (CARTON) เช่น 1,135 / 903
- shipping_mark: Invoice "SHIPPING MARK" เช่น "KCF" / "AN HONG EGG" / "GREEN-TECH" (เอามาเฉพาะคำ)

[Edit cases]
- ถ้าน้ำหนัก/ยอดมีคอมม่า ให้ตัดคอมม่าออก
- description ให้แปลงเป็นตัวพิมพ์ใหญ่ทั้งหมด$rules$,
  true
)
on conflict (customer_name) do update set
  allowed_fields = excluded.allowed_fields,
  presets = excluded.presets,
  extraction_rules = excluded.extraction_rules,
  request_screenshot = excluded.request_screenshot,
  updated_at = now();


-- ========== COCO ==========
insert into public.customer_settings (customer_name, allowed_fields, presets, extraction_rules, request_screenshot)
values (
  $cust$COCO$cust$,
  '{customer_name,consignee_name,buyer_country_code,destination_country_code,vessel_name,voyage_number,release_port_code,loading_port_code,shipping_mark,tax_payment_method_code,etd,invoice_number,invoice_date,incoterms,currency,total_goods_amount,freight_charge,insurance_charge,net_weight_kg,gross_weight_kg,description_eng,net_weight_ton,net_weight_unit_code,container_or_volume_qty,container_unit_code}'::text[],
  $json${"customer_name":"COCO","incoterms":"FOB","tax_payment_method_code":"A","container_unit_code":"BX","currency":"USD"}$json$::jsonb,
  $rules$[Customer Rules: COCO / COCOS ENTERPRISES]
สินค้าคือน้ำมะพร้าวแช่แข็ง (Frozen Coconut Water) เอกสาร: Booking + Invoice + Packing List + SI (มักเป็นไฟล์ Excel หลาย Sheet: SI / Pck L / Inv)

[ค่าคงที่ Default Values]
- customer_name: "COCO" เสมอ
- incoterms: "FOB" เสมอ
- tax_payment_method_code: "A"
- container_unit_code: "BX" (หน่วยหีบห่อเป็น Box)
- currency: "USD" (Invoice ใช้ดอลลาร์)

[จุดสกัดข้อมูล]
- customer_name / Shipper: "Cocos Enterprises (Thailand) Co.,Ltd."
- consignee_name: Invoice/SI ช่อง "Consignee" (เช่น "AL ACCAD DEPARTMENT STORE..." หรือ "FFF Fresh & Frozen Food AG") — ถ้ายาวมากให้ตัดเอาเฉพาะคำหลัก
- buyer_country_code / destination_country_code: ดูจาก "Port Of Discharge" หรือ consignee
    * กรณีปกติ: Port Of Discharge เช่น "FUJAIRAH, UAE" → ทั้งคู่ = AE
    * กรณีพิเศษ (สำคัญ): ถ้า consignee คือ "FFF Fresh & Frozen Food AG" (สวิตเซอร์แลนด์) →
        buyer_country_code = "CH" (Switzerland), destination_country_code = "IT" (อิตาลี เพราะ Port of Discharge = "Genoa / Transit to Switzerland")
- vessel_name / voyage_number: ช่อง "VESSEL" (ไม่ใช่ FEEDER, ไม่ใช่ M.VESSEL/Mother)
    เช่น "CMA CGM VALPARAISO / 0MDGLW1MA" → vessel_name="CMA CGM VALPARAISO", voyage="0MDGLW1MA"
    ถ้า COCOS 2 ใช้ช่อง VESSEL "COSCO SHIPPING SCORPIO 034W" → vessel="COSCO SHIPPING SCORPIO", voyage="034W"
    (voyage ถ้ามี 0 นำหน้าให้ตัดทิ้ง)
- release_port_code: ดู Port Of Loading "Laem Chabang (CODE 2812)" → 2812 หรือ Booking "PAPERLESS CODE"
- loading_port_code: ถ้า release ขึ้นต้น "28" → "2801"; ถ้าขึ้นต้น "025" → "0250"
- invoice_number: Invoice "Invoice no." ขึ้นต้นด้วย CTN เสมอ (เช่น CTN2617, CTN2628)
- invoice_date: Invoice "Date" (เช่น 25/4/2026 → 2026-04-25)
- total_goods_amount: ยอด TOTAL ($) มุมขวาล่างของ Invoice (USD) เช่น 80,271.72 / 94,065.98
- freight_charge / insurance_charge: ถ้าไม่ระบุในเอกสาร ดู[เนื้อหาอีเมล] ถ้าไม่เจอใส่ 0 (FOB ปกติไม่มี freight)
- net_weight_kg / gross_weight_kg: Packing List แถว TOTAL "Net Vol/Wgh" และ "Gross Wght" (เช่น 20,148.5 / 24,433.98)
- net_weight_ton: net_weight_kg / 1000 ; net_weight_unit_code: "TO"
- container_or_volume_qty: Packing List แถว TOTAL จำนวน box (เช่น 5,576) — ใช้จำนวน box
- shipping_mark: ช่อง "Shipping Marks / Marks And Nos." เช่น "FROZEN ORGANIC COCONUT WATER" (ถ้ายาวมากให้ใส่ "ADD INVOICE")
- description_eng: คอลัมน์ "Description Of Goods" บรรทัดของแต่ละรายการ — ตัวพิมพ์ใหญ่ทั้งหมด

[กฎรายการสินค้า (per item) สำหรับ RPA]
- แต่ละรายการ (Organic raw coconut water 250ml/500ml/cream/...) = 1 บรรทัดสินค้า
- รายการที่ขึ้นต้นด้วย "Sample" = ของแถม (FOC): ให้จำนวนหีบห่อ (box) = 0 และหน่วยปริมาตรเป็น "LTR" โดยใช้ค่า net weight แทนปริมาณ

[Edge cases]
- ตัวเลขมีคอมม่า/ทศนิยมยาว ให้ตัดคอมม่า เก็บทศนิยมปกติ
- consignee ยาวเกินไป ตัดเอาเฉพาะคำหลัก
- description ตัวพิมพ์ใหญ่ทั้งหมด$rules$,
  true
)
on conflict (customer_name) do update set
  allowed_fields = excluded.allowed_fields,
  presets = excluded.presets,
  extraction_rules = excluded.extraction_rules,
  request_screenshot = excluded.request_screenshot,
  updated_at = now();
