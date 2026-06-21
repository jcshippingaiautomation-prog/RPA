-- ============================================================
--  04 — Declarations: เพิ่มคอลัมน์ที่ RPA/หน้าตั้งค่าใช้ แต่ยังไม่มีใน DB
--  (export_tariff, customs_unit_code, Page-1 fields, ฯลฯ)
--  รันใน Supabase SQL Editor (Dashboard → SQL Editor → New query → วาง → Run)
-- ============================================================

-- ประเภทพิกัดขาออก (export tariff code) — ช่องบังคับ Page 3 ที่ทำให้ RPA กรอกไม่จบ
alter table public.declarations add column if not exists export_tariff text;

-- หน่วยปริมาณในใบขน (หลังพิกัด เช่น C62/KGM) — ต้องตรงหน่วยหลังพิกัด
alter table public.declarations add column if not exists customs_unit_code text;

-- วิธีลงค่าระวาง/รายการ (zero | first | each)
alter table public.declarations add column if not exists freight_alloc text;

-- ช่อง Page 1 เพิ่มเติม
alter table public.declarations add column if not exists transport_mode text;     -- วิธีขนส่ง
alter table public.declarations add column if not exists mawb text;               -- MAWB
alter table public.declarations add column if not exists hawb text;               -- HAWB/BL
alter table public.declarations add column if not exists reference_no text;       -- เลขอ้างอิงในการขนส่ง
alter table public.declarations add column if not exists exdec_doc_type text;     -- ชนิดเอกสารใบขนขาออก

-- คำอธิบายสินค้าภาษาไทย (Page 3)
alter table public.declarations add column if not exists product_description_thai text;

-- รายการสินค้า (declaration_items) — พิกัด/หน่วยต่อรายการ (ZECK มีหลายพิกัด)
alter table public.declaration_items add column if not exists export_tariff text;
alter table public.declaration_items add column if not exists customs_unit_code text;
