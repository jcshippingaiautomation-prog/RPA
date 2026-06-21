-- ============================================================
-- เพิ่มคอลัมน์ extraction_rules + นำเข้าข้อมูล 2 ลูกค้า
-- ============================================================

alter table public.customer_settings add column if not exists extraction_rules text default '';

-- THANAKORN
insert into public.customer_settings (customer_name, allowed_fields, presets, extraction_rules)
values ($rules$THANAKORN$rules$, '{customer_name,consignee_name,buyer_country_code,destination_country_code,vessel_name,voyage_number,release_port_code,loading_port_code,shipping_mark,tax_payment_method_code,etd,invoice_number,invoice_date,incoterms,currency,total_goods_amount,freight_charge,insurance_charge,net_weight_kg,gross_weight_kg,description_eng,net_weight_ton,net_weight_unit_code,container_or_volume_qty,container_unit_code}'::text[], $json${"customer_name":"THANAKORN","tax_payment_method_code":"A","container_unit_code":"1F"}$json$::jsonb, $rules$[Customer Rules: THANAKORN]
เอกสารประกอบด้วย Invoice และ Booking Confirmation ให้สกัดข้อมูลโดยมีจุดสังเกตดังนี้:

[ค่าคงที่ (Default Values) - ให้ใช้ค่านี้เสมอโดยไม่ต้องหาในเอกสาร]
- customer_name: "THANAKORN"
- tax_payment_method_code: "A"
- container_unit_code: "1F" 

[กฎการ Mapping พิเศษ]
- Logic ท่าเรือ: ให้ดู release_port_code หากรหัสนี้นำหน้าด้วย "28" (เช่น 2816, 2835) ข้อมูลในฟิลด์ loading_port_code จะต้องเป็น "2801" เสมอ

[จุดสกัดข้อมูลจากเอกสาร (Location Guide)]
- buyer_country_code / destination_country_code: ดูจาก Invoice ช่อง "Country of Final Destination" (และแปลงชื่อประเทศเป็นรหัส 2 ตัวอักษรตาม Global Config ใน Prompt หลัก)
- release_port_code: ดูที่เอกสาร Booking บรรทัด "CUSTOMS PAPERLESS CODE**" (ดึงเฉพาะตัวเลขรหัสหลังคำว่า PORT)
- vessel_name และ voyage_number: ดูที่ Booking ช่อง "FEEDER VESSEL" หรือ Invoice ช่อง "Vessel" (ต้องแยกชื่อเรือออกจากเที่ยวเรือ เช่น ถ้าเขียน "MAERSK NUSSFJORD V.616N" ชื่อเรือคือ "MAERSK NUSSFJORD" เที่ยวเรือคือ "616N")
- shipping_mark: ดูที่เอกสาร Invoice ด้านซ้ายล่าง ใต้คำว่า "MARK" (ดึงข้อความทั้งหมดในส่วนนั้น)
- invoice_number และ invoice_date: ดูที่มุมขวาบนของ Invoice 
- consignee_name: ดูที่ Invoice ช่อง "Sold to Messrs" หรือ "Notify Party" ตัวอย่างข้อมูล "DK&N VIETNAM LTD"
- incoterms: ดูที่ Invoice คอลัมน์ "Amount USD." บรรทัดของราคาสินค้า จะมีรหัสนำหน้าชื่อเมือง (เช่น CIF, FOB)
- currency: ดูที่ส่วนหัวคอลัมน์ Amount ใน Invoice (เช่น USD)
- total_goods_amount: ดูยอดรวมค่าสินค้าที่คอลัมน์ Amount ของ Invoice
- freight_charge และ insurance_charge: ดูที่คอลัมน์ Amount ของ Invoice บริเวณค่าใช้จ่ายแยก (ถ้าไม่มีในเอกสารให้ใส่ 0.00)
- net_weight_ton และ gross_weight (ตัน): ดูที่ Invoice ด้านล่างสุด "Net Weight (MT.)" และ "Gross Weight (MT.)" (ดึงมาเฉพาะตัวเลข)
- net_weight_kg และ gross_weight_kg: ให้นำค่าน้ำหนักหน่วยตัน (MT.) ที่สกัดได้มาคูณด้วย 1000
- description_eng: ดึงจาก Invoice คอลัมน์ "Description"
- container_or_volume_qty: ดูที่ Booking ช่อง "VOLUME" (ดึงเฉพาะจำนวนตู้ที่เป็นตัวเลขด้านหน้า เช่น 5X20'GP ให้ดึงแค่เลข 5) หรือ Invoice ใต้ Description ตรงคำว่า "Total ... CONTAINERS"$rules$)
on conflict (customer_name) do update set
  allowed_fields = excluded.allowed_fields,
  presets = excluded.presets,
  extraction_rules = excluded.extraction_rules,
  updated_at = now();

-- email rule THANAKORN
insert into public.email_rules (sender, subject, note)
values ($rules$THIP@iconlogistic.com$rules$, $rules$THANAKORN$rules$, $rules$THANAKORN$rules$)
on conflict (sender) do update set subject = excluded.subject, note = excluded.note;

-- ZECK TSE
insert into public.customer_settings (customer_name, allowed_fields, presets, extraction_rules)
values ($rules$ZECK TSE$rules$, '{customer_name,consignee_name,buyer_country_code,destination_country_code,vessel_name,voyage_number,release_port_code,loading_port_code,shipping_mark,tax_payment_method_code,etd,invoice_number,invoice_date,incoterms,currency,total_goods_amount,freight_charge,insurance_charge,net_weight_kg,gross_weight_kg,description_eng,net_weight_ton,net_weight_unit_code,container_or_volume_qty,container_unit_code}'::text[], $json${"customer_name":"ZECK TSE","tax_payment_method_code":"A","container_unit_code":"1F"}$json$::jsonb, $rules$[Customer Rules: ZECK TSE]

เอกสารประกอบด้วย 5 ชิ้น คือ (1) Commercial Invoice, (2) Packing List, (3) Export Booking Confirmation จาก Forwarder/IGL, (4) FOB Calculation Worksheet (Excel) และ (5) Shipping Information (Word/DOCX) ให้สกัดข้อมูลโดยมีจุดสังเกตดังนี้:

[ค่าคงที่ (Default Values) - ให้ใช้ค่านี้เสมอโดยไม่ต้องหาในเอกสาร]
- customer_name: "ZECK TSE"
- shipper_name: "ZECK TSE INTERNATIONAL LTD."
- shipper_address: "52 MU 1, SAMNAK BOK, MUEANG CHON BURI, CHON BURI, 20000 THAILAND"
- shipper_tax_id: "0105553092611"
- tax_payment_method_code: "A"
- container_unit_code: "1F"
- country_of_origin_code: "TH"   // เอกสารทุกฉบับระบุ "Country of Origin: Thailand" และ "MADE IN THAILAND"

[กฎการ Mapping พิเศษ - สำคัญที่สุดสำหรับลูกค้ารายนี้]

1. ลำดับความสำคัญของแหล่งข้อมูล (Source Priority): เนื่องจากลูกค้ารายนี้ส่งมา 5 ไฟล์ที่มีข้อมูลซ้อนทับกัน ให้ยึดลำดับนี้
   - ข้อมูลพิธีการส่งออก (FOB, EXW, HS Code, ภาษีไทย): ยึด FOB Calculation Worksheet (Excel) เป็นหลัก เพราะเป็นไฟล์ที่ทำขึ้นเฉพาะสำหรับศุลกากรไทย
   - ข้อมูลเรือ/ตู้/ท่าเรือ/Booking: ยึด Export Booking Confirmation จาก Forwarder (IGL) เป็นหลัก
   - ข้อมูลยอดเงิน CIF/Insurance/Freight ที่เรียกเก็บจริง: ยึด Commercial Invoice เป็นหลัก
   - ข้อมูล Notify Party และ Shipping Mark ฉบับเต็ม: ยึด Shipping Information (DOCX) เป็นหลัก
   - ข้อมูลน้ำหนัก/จำนวนหีบห่อ: Invoice = Packing List (ตรงกัน) ใช้ตัวใดก็ได้

2. Logic ท่าเรือ: ให้ดู release_port_code จาก Booking Confirmation บรรทัด "CUSTOMS PAPERLESS CODE**" หากรหัสนี้นำหน้าด้วย "28" (เช่น 2816 = Durban) ข้อมูลในฟิลด์ loading_port_code จะต้องเป็น "2801" (Laem Chabang) เสมอ

3. Logic Incoterms (สำคัญมากสำหรับลูกค้ารายนี้): ลูกค้ารายนี้มักขายแบบ CIF (เช่น CIF Durban) แต่กรมศุลกากรไทยต้องการราคา FOB เป็นฐานในการสำแดง ดังนั้น
   - incoterms_field: ดึง CIF จาก Invoice (Delivery Terms) เพื่อแสดงเงื่อนไขการขายจริง
   - total_goods_amount (FOB): ห้าม! ใช้ยอด TOTAL ที่มุมขวาล่างของ Invoice เพราะนั่นคือ CIF Total ให้ใช้ค่า "Total FOB (USD)" บรรทัดกลางหน้า Invoice แทน หรือใช้ค่า "TOTAL FOB" จาก Sheet "FOB cal for TH custom" (cell D13) ของไฟล์ Excel
   - ตรวจสอบความสอดคล้อง: TOTAL CIF (Invoice) = TOTAL FOB + Sea Freight + Insurance Premium เสมอ (เช่น 67,415 = 60,811.20 + 6,403.80 + 200.00)

4. Logic แยก vessel_name และ voyage_number: ใน Booking Confirmation มี 2 ฟิลด์เรือ ให้ใช้ "FEEDER VESSEL" เป็นหลัก (ไม่ใช่ MOTHER VESSEL) เพราะเป็นเรือที่ออกจาก Laem Chabang ตัวอย่าง "MTT SANDAKAN V.72S" → vessel_name: "MTT SANDAKAN", voyage_number: "72S"

[จุดสกัดข้อมูลจากเอกสาร (Location Guide)]

ข้อมูล Header / ผู้ซื้อ / ผู้รับ
- invoice_number: ดูที่ Invoice มุมขวาบน ช่อง "INVOICE NO." (ตัวอย่าง: 2604034)
- invoice_date: ดูที่ Invoice มุมขวาบน ช่อง "DATE" (ตัวอย่าง: 03-Apr-2026)
- customer_order_no: ดูที่ Invoice มุมขวาบน ช่อง "CUSTOMER'S ORDER NO." (ตัวอย่าง: Z0457-101225 Date:10/12/2025)
- consignee_name: ดูที่ Invoice/Packing List ช่อง "MESSRS:" (ตัวอย่าง: "GW LIFTING & ENGINEERING SUPPLIES")
- consignee_address: ดูที่ Invoice/Packing List ใต้ชื่อบริษัทในช่อง MESSRS รวม VAT No., Tel, Fax
- buyer_country_code / destination_country_code: ดูจาก Invoice ช่อง "PORT OF DISCHARGE" หรือ "DELIVERY TERMS" (ตัวอย่าง: Durban → ZA) แปลงชื่อประเทศเป็นรหัส 2 ตัวอักษรตาม Global Config ใน Prompt หลัก
- notify_party: ห้ามดูจาก Invoice หรือ Packing List เพราะเอกสาร 2 ชิ้นนี้เว้นว่างไว้ ให้ดูจากไฟล์ Shipping Information (DOCX) ใต้คำว่า "NOTIFY PARTY:" (ตัวอย่าง: "PRIVE LOGISTICS, EASPORT LOGISTICS PARK, EASTPORT BLVD KEMPTON PARK, 1619 SOUTH AFRICA, MONIQUE@PRIVE.CO.ZA")

ข้อมูลเรือ / ท่าเรือ / Booking
- booking_number: ดูที่ Booking Confirmation ช่อง "BOOKING NO." (ตัวอย่าง: GOSUBKK80447666)
- shipping_line: ดูที่ Booking Confirmation ช่อง "SHIPPING LINES" (ตัวอย่าง: ZIM (THAILAND) CO.,LTD)
- release_port_code: ดูที่ Booking Confirmation บรรทัด "CUSTOMS PAPERLESS CODE**" (ดึงเฉพาะตัวเลข เช่น 2816)
- loading_port_code: ใช้ Logic ท่าเรือ (ข้อ 2) — ถ้า release_port_code นำหน้าด้วย "28" ให้ใส่ "2801" (Laem Chabang) เสมอ
- vessel_name และ voyage_number: ดูที่ Booking ช่อง "FEEDER VESSEL" แล้วแยกตาม Logic ข้อ 4 (ตัวอย่าง: "MTT SANDAKAN V.72S" → vessel_name: "MTT SANDAKAN", voyage_number: "72S")
- mother_vessel_name (ถ้าระบบต้องการ): ดูที่ Booking ช่อง "MOTHER VESSEL" (ตัวอย่าง: "KOTA LEKAS V.108W")
- transhipment_port: ดูที่ Booking ช่อง "TRANSHIPMENT PORT" (ตัวอย่าง: SINGAPORE)
- etd: ดูที่ Booking ช่อง "ETD" (ตัวอย่าง: April 08, 2026)
- eta: ดูที่ Booking ช่อง "ETA" (ตัวอย่าง: April 29, 2026)

ข้อมูล Shipping Mark
- shipping_mark: ให้ใช้จาก Shipping Information (DOCX) ก่อน เพราะเป็นฉบับ formatted สมบูรณ์ ดึงข้อความตั้งแต่บรรทัด "MARK & NOS:" จนถึง "DRUM STAND TB/IT 7 TONS" (รวม CONSIGNEE, ADDRESS, VAT, TEL, FAX, EMAIL, MADE IN THAILAND, PORT OF LOADING, PORT OF DISCHARGE, TOTAL PACKAGE, TOTAL GROSS WEIGHT, DESCRIPTION) ถ้าไม่มี DOCX ให้ใช้จากกรอบ Description ของ Invoice (ส่วนล่างใต้คำว่า "MARK & NOS:") เป็น fallback

ข้อมูลสินค้า (Goods Data)
- description_eng: ดึงจาก FOB Calculation Excel cell D3 (ตัวอย่าง: "DRUM STAND TB IT 7 TONS") หรือจาก Invoice คอลัมน์ "DESCRIPTION OF GOODS" บรรทัดแรก (ตัวอย่าง: "Drum Stand TB/IT 7 tons")
- description_thai: ดึงจาก FOB Calculation Excel cell D6 เท่านั้น (ตัวอย่าง: "ฐานตังหมุนวงล้อสำหรับการขึงลวดสลิง") เอกสาร PDF ไม่มีคำบรรยายภาษาไทย
- hs_code: ดึงจาก FOB Calculation Excel cell D5 เท่านั้น (ตัวอย่าง: 84254920) เอกสาร Invoice/Packing List ไม่มี HS Code
- part_number: ดึงจาก Invoice/Packing List คอลัมน์ "PART NO." อาจมีหลายรหัสในเซลล์เดียว (ตัวอย่าง: "FP08-99-001" และ "DST-01-070") ให้รวมทั้งสองด้วยเครื่องหมาย "; " หรือคั่นตามที่ระบบต้องการ
- quantity: ดึงจาก Invoice/Packing List คอลัมน์ "QUANTITY" (ตัวอย่าง: 16.00)
- unit_of_measure: ดึงจากท้ายตัวเลข Quantity ในคอลัมน์เดียวกัน (ตัวอย่าง: "SET")
- unit_price: ดึงจาก Invoice คอลัมน์ "UNIT PRICE" (ตัวอย่าง: 3,800.700 USD/SET)

ข้อมูลยอดเงิน (Amount Data)
- currency: ดูที่ส่วนหัวคอลัมน์ "AMOUNT" ของ Invoice หรือบรรทัด TOTAL ด้านล่าง (ตัวอย่าง: USD)
- incoterms: ดูที่ Invoice ช่อง "DELIVERY TERMS" (ตัวอย่าง: "CIF Durban, ZA" → ดึงเฉพาะ "CIF")
- total_goods_amount (FOB): ใช้ Logic Incoterms ข้อ 3 — ดึงจาก FOB Calculation Excel cell D13 หรือ Invoice บรรทัด "Total FOB (USD)" (ตัวอย่าง: 60,811.20) ห้าม! ใช้ค่า 67,415 ที่มุมขวาล่างเพราะนั่นคือ CIF
- freight_charge (Sea Freight): ดึงจาก Invoice บรรทัด "Sea freight Volume: 1 x 20'GP" คอลัมน์ AMOUNT (ตัวอย่าง: 6,403.800)
- insurance_charge (Insurance Premium): ดึงจาก Invoice บรรทัด "Insurance Premium" คอลัมน์ AMOUNT (ตัวอย่าง: 200.000)
- total_cif_amount: ดึงจาก Invoice บรรทัด TOTAL มุมขวาล่าง (ตัวอย่าง: 67,415.00) หรือจาก FOB Calculation Excel cell D14
- total_amount_check: ตรวจสอบ TOTAL CIF = total_goods_amount + freight_charge + insurance_charge (60,811.20 + 6,403.80 + 200.00 = 67,415.00 ✓)

ข้อมูลน้ำหนักและตู้คอนเทนเนอร์
- net_weight_kg: ดึงจาก Invoice/Packing List บรรทัด "TOTAL N.W :" (ตัวอย่าง: 5,440.00 KGS) — ใช้ตัวเลข KGS โดยตรง
- gross_weight_kg: ดึงจาก Invoice/Packing List บรรทัด "TOTAL G.W :" (ตัวอย่าง: 5,450.00 KGS) — ใช้ตัวเลข KGS โดยตรง
- net_weight_ton: ใช้ค่า net_weight_kg หาร 1000 (ตัวอย่าง: 5.440)
- gross_weight_ton: ใช้ค่า gross_weight_kg หาร 1000 (ตัวอย่าง: 5.450)
- หมายเหตุ: เอกสาร ZECK TSE ระบุน้ำหนักหน่วย KGS เท่านั้น ไม่มีหน่วย MT./Ton ให้คำนวณกลับด้านจาก THANAKORN
- total_packages: ดึงจาก Invoice/Packing List บรรทัด "TOTAL :" (ตัวอย่าง: SIXTEEN PKG ONLY → 16) หรือ Shipping Info (DOCX) บรรทัด "TOTAL PACKAGE: 01-16 PKG"
- container_or_volume_qty: ดูที่ Booking Confirmation ช่อง "VOLUME" (ตัวอย่าง: "FCL 1X20'GP" → ดึงเลข 1) หรือ Packing List Excel cell J2 ("1X20\"GP") หรือ Invoice บรรทัด "Volume: 1 x 20'GP"
- container_size: ดึงจากสตริงเดียวกัน (ตัวอย่าง: "20'GP")

ข้อมูลภาษี / EXW (เฉพาะจาก FOB Calculation Excel)
- exw_amount: FOB Calculation Excel Sheet "FOB cal for TH custom" cell G3 (ตัวอย่าง: 59,040)
- exw_markup_rate: cell H2 (ตัวอย่าง: 0.03 = 3%)
- exw_markup_amount: cell H3 (ตัวอย่าง: 1,771.20)
- transport_packing_cost: cell D10 (ตัวอย่าง: 8,375)
- fob_unit_price_in_usd: cell J3 (ตัวอย่าง: 3,800.70 USD/SET)
- หมายเหตุ: ฟิลด์เหล่านี้มีอยู่เฉพาะใน Excel ไม่มีในเอกสาร PDF ใดๆ ถ้าไฟล์ Excel ไม่ถูกแนบมา ให้ปล่อย null และแจ้งเตือน

ข้อมูล Freight & Country
- freight_term: ดึงจาก Invoice/Packing List บรรทัด "**FREIGHT**" (ตัวอย่าง: "Prepaid") หรือจาก Booking Confirmation ช่อง "FREIGHT TERM / INCO TERM"
- country_of_origin: ดึงจาก Invoice/Packing List บรรทัด "**COUNTRY OF ORIGIN**" (ตัวอย่าง: "Thailand") แปลงเป็นรหัส "TH"

[ข้อควรระวัง / Edge Cases สำหรับ ZECK TSE]
- เอกสาร Booking Confirmation ของ IGL มีตัวอักษรไทยเพี้ยนหลายจุด (เช่น "กรณาตรวจสอบรายละเอ ร ยดข อ างต ข น...") ให้ AI ละเว้นการพยายามอ่าน/แก้ และใช้เฉพาะข้อมูลที่เป็นภาษาอังกฤษ/ตัวเลขจากตารางเท่านั้น
- ฟิลด์ TEL/FAX/E-mail ในส่วนหัวของ Booking Confirmation (TO: ZECK TSE INTERNATIONAL LTD. / ATTN: K.ALMA) มักเว้นว่าง อย่าตีความเป็น 0 หรือสร้างข้อมูลเอง
- "ATTN: K.ALMA" และผู้ลงนาม "Alma Cartas" ใน Invoice/Packing List คือบุคคลเดียวกัน (พนักงาน ZECK) ใช้เป็น contact_person ของฝั่ง Shipper ได้ ไม่ใช่ของ Consignee
- ผู้รับ "GW LIFTING & ENGINEERING SUPPLIES" และ Notify "PRIVE LOGISTICS" เป็นคนละบริษัท อย่ารวม
- รหัส Customer's Order No. (เช่น Z0457-101225) ขึ้นต้นด้วย "Z" ตามรหัสภายในของ ZECK ไม่ใช่ Booking No. ของ Forwarder
- ค่า Insurance ในเอกสารชุดนี้คือ 200 USD เป็น flat fee ไม่ใช่ % คำนวณจาก CIF อย่าพยายามคำนวณย้อน$rules$)
on conflict (customer_name) do update set
  allowed_fields = excluded.allowed_fields,
  presets = excluded.presets,
  extraction_rules = excluded.extraction_rules,
  updated_at = now();

-- email rule ZECK TSE
insert into public.email_rules (sender, subject, note)
values ($rules$angpao@iconlogistic.com$rules$, $rules$ZECK TSE$rules$, $rules$ZECK TSE$rules$)
on conflict (sender) do update set subject = excluded.subject, note = excluded.note;

