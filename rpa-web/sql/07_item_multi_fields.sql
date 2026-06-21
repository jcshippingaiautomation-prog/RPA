-- ============================================================
--  07: เพิ่มคอลัมน์ declaration_items รองรับ multi-item เต็มรูปแบบ
--  - description_eng_field: คำอธิบายสินค้าอังกฤษ "อิสระ" ต่อรายการ (text แยกจากรหัสสินค้า/combo master)
--      เคส COCO: รหัสสินค้า (description_eng) = "FROZEN ORGANIC COCONUT WATER" เหมือนกันทุกรายการ
--                แต่คำอธิบายอังกฤษต่างกัน เช่น "ORGANIC RAW COCONUT CREAM SMOOTHIE BRAND ORGANIC SOURCE 250ML"
--  - net_weight_unit_code: หน่วยน้ำหนัก/ปริมาณ ต่อรายการ (เคสหลายรายการหน่วยต่างกัน)
--  - insurance: ค่าประกัน ต่อรายการ
--  - product_description_thai: คำอธิบายไทย ต่อรายการ
--  รัน idempotent (add column if not exists)
-- ============================================================

alter table public.declaration_items add column if not exists description_eng_field text;
alter table public.declaration_items add column if not exists net_weight_unit_code text;
alter table public.declaration_items add column if not exists insurance numeric;
alter table public.declaration_items add column if not exists product_description_thai text;
