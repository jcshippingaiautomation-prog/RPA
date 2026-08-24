-- ============================================================
--  12: Master ข้อมูล 3 ระดับ (ตามที่ตกลงในที่ประชุม 4 ส.ค. 2569)
--
--  ที่ประชุมสรุปว่า AI อ่าน 100% ไม่ได้ ต้องมีต้นแบบ (Preset) 3 ระดับ:
--     ระดับ 1  ลูกค้า      → customer_name (มีอยู่แล้วใน sql/11)
--     ระดับ 2  Consignee   → consignee_names (ใหม่) — 1 Master ผูกได้หลาย consignee
--                            เพราะคุณแพวบอก "3 consignee ที่ใช้ชื่อสินค้าเดียวกัน
--                            ให้อ่านตัวต้นแบบตัวเดียวกัน จะได้ไม่ต้องเซตหลายอัน"
--     ระดับ 3  รหัสสินค้า  → product_codes (ใหม่) — consignee เดียวกันแต่คนละสินค้า
--                            ใช้คนละ Master ได้
--
--  การเลือก Master: จับคู่ละเอียดที่สุดก่อน (สินค้า > consignee > ค่าเริ่มต้นของลูกค้า)
--
--  ⚠ ต้องรัน sql/11 ก่อน
--  รัน idempotent (รันซ้ำได้)
-- ============================================================

-- ระดับ 2: Consignee ที่ Master นี้ใช้ได้ (ว่าง = ใช้กับทุก consignee ของลูกค้ารายนี้)
alter table public.declaration_templates
  add column if not exists consignee_names text[] not null default '{}';

-- ระดับ 3: รหัสสินค้าที่ Master นี้ใช้ได้ (ว่าง = ใช้กับทุกสินค้า)
alter table public.declaration_templates
  add column if not exists product_codes text[] not null default '{}';

-- ลำดับความสำคัญเมื่อจับคู่ได้เท่ากัน (มากกว่า = ถูกเลือกก่อน) — ปรับเองได้จากหน้าเว็บ
alter table public.declaration_templates
  add column if not exists priority integer not null default 0;

-- ที่มาของ Master (ดึงจาก DCTK ด้วยเลขอะไร) — ไว้ตรวจย้อนกลับ
alter table public.declaration_templates
  add column if not exists source jsonb not null default '{}'::jsonb;

-- ค้นหาเร็วด้วย array (GIN)
create index if not exists idx_decl_templates_consignees
  on public.declaration_templates using gin (consignee_names);
create index if not exists idx_decl_templates_products
  on public.declaration_templates using gin (product_codes);

-- ============================================================
--  หมายเหตุการจับคู่ (ระบบทำให้ในโค้ด ไม่ต้องตั้งอะไรเพิ่ม)
--    คะแนน = (ตรงรหัสสินค้า ×4) + (ตรง consignee ×2) + (เป็นค่าเริ่มต้น ×1) + priority
--    เลือกอันคะแนนสูงสุด · เท่ากันเลือกอันที่แก้ล่าสุด
--
--  ตัวอย่างของธนากร (ตามที่คุยในที่ประชุม):
--    Master A: consignee_names = {DK&N VIETNAM LTD, ABC CO, XYZ LTD}  ← 3 เจ้าใช้ต้นแบบเดียวกัน
--              product_codes   = {REFINED BLEACHED}
--    Master B: consignee_names = {DK&N VIETNAM LTD}
--              product_codes   = {RBD PALM OLEIN}                      ← เจ้าเดียวกันแต่คนละสินค้า
--    → เอกสารเข้ามาเป็น DK&N + RBD PALM OLEIN  → ได้ Master B (ตรงทั้ง 2 ระดับ)
--    → เอกสารเข้ามาเป็น ABC CO + REFINED BLEACHED → ได้ Master A
-- ============================================================
