-- ============================================================
-- ตาราง declaration_items — รายการสินค้า (หลายแถวต่อ 1 ใบขน)
-- header = declarations (1 แถว/ใบขน), items = ตารางนี้ (หลายแถว)
-- ============================================================
create table if not exists public.declaration_items (
  id uuid primary key default gen_random_uuid(),
  declaration_id uuid not null references public.declarations(id) on delete cascade,
  line_no int,                          -- ลำดับรายการ (1,2,3,...)
  description_eng text,                  -- ชื่อ/รายละเอียดสินค้า (ตัวพิมพ์ใหญ่)
  brand_name text,                       -- ยี่ห้อ (NO BRAND ถ้าไม่มี)
  container_or_volume_qty text,          -- จำนวนกล่อง/หีบห่อ ของรายการนี้
  container_unit_code text,              -- หน่วยหีบห่อ (CT/BX)
  net_weight_kg numeric,                 -- น้ำหนักสุทธิ (kg) ของรายการนี้
  gross_weight_kg numeric,               -- น้ำหนักรวม (kg) ของรายการนี้
  net_weight_ton numeric,                -- น้ำหนักสุทธิ (ton)
  amount numeric,                        -- ยอดเงินของรายการนี้
  is_foc boolean default false,          -- ของแถม (Sample/FOC) → qty=0, ปริมาตร LTR
  created_at timestamptz default now()
);

create index if not exists idx_declaration_items_decl
  on public.declaration_items(declaration_id);
