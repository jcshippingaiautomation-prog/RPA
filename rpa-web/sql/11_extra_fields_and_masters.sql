-- ============================================================
--  11: ช่องกรอกครบทุกช่องของ DCTK + คลัง Master ข้อมูล
--
--  (ก) extra_fields jsonb — เก็บ "ทุกช่องที่ยังไม่มีคอลัมน์จริง" ของ DCTK
--      ที่มา: field-registry.json (133 ช่อง) — ช่องที่ column = null จะลงที่นี่
--      ข้อดี: เพิ่มช่องใหม่ในอนาคต = แก้ registry อย่างเดียว ไม่ต้อง migrate DB อีก
--
--  (ข) declaration_templates — คลัง Master ข้อมูล (แยกจากใบขนจริง ไม่ปนในลิสต์)
--      สร้างสำเนา → แก้เล็กน้อย → นำเข้าได้เลย
--      field_modes = โหมดรายช่อง: 'master' (ใช้ค่า Master ทับ AI) | 'ai' (ปล่อย AI สกัด) | 'off' (ไม่กรอก)
--
--  รัน idempotent (รันซ้ำได้)
-- ============================================================

-- ── (ก) ช่องเพิ่มเติมแบบ jsonb ────────────────────────────────
alter table public.declarations      add column if not exists extra_fields jsonb not null default '{}'::jsonb;
alter table public.declaration_items add column if not exists extra_fields jsonb not null default '{}'::jsonb;

-- โหมดรายช่องของ "ใบนี้" (คัดลอกมาจาก Master ตอนสร้าง) — worker ใช้ตัดสินว่าจะกรอกช่องไหน
--   'master' ใช้ค่าที่กรอกไว้ · 'ai' ใช้ค่าที่ AI สกัดมา · 'off' ไม่กรอกช่องนี้ลง DCTK
alter table public.declarations add column if not exists field_modes jsonb not null default '{}'::jsonb;

-- ── (ข) คลัง Master ข้อมูล ────────────────────────────────────
create table if not exists public.declaration_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,                              -- ชื่อ Master เช่น "THANAKORN — ตู้ 40 ฟุต ไปเวียดนาม"
  customer_name text not null default '',                   -- ลูกค้าที่ Master นี้ใช้กับ ('' = ใช้ได้ทุกลูกค้า)
  description   text,                                       -- คำอธิบายสั้น ๆ
  header        jsonb not null default '{}'::jsonb,         -- ค่าช่องหัวใบ (คอลัมน์จริง + ช่อง extra ปนกันได้)
  items         jsonb not null default '[]'::jsonb,         -- รายการสินค้า (array ของ object)
  field_modes   jsonb not null default '{}'::jsonb,         -- {field_key: 'master'|'ai'|'off'}
  is_default    boolean not null default false,             -- ใช้เติมใบที่มาจากอีเมลอัตโนมัติ
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_decl_templates_customer on public.declaration_templates (customer_name);
create index if not exists idx_decl_templates_updated  on public.declaration_templates (updated_at desc);

-- 1 ลูกค้า มี Master ที่เป็น default ได้ไม่เกิน 1 อัน
create unique index if not exists uq_decl_templates_default
  on public.declaration_templates (customer_name) where is_default;

-- อัปเดต updated_at อัตโนมัติ
create or replace function public.touch_declaration_template()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_declaration_template on public.declaration_templates;
create trigger trg_touch_declaration_template
  before update on public.declaration_templates
  for each row execute function public.touch_declaration_template();

-- หมายเหตุ: เว็บ/worker เข้าถึงด้วย service_role (bypass RLS) เหมือนตารางอื่นในระบบนี้
--   จึงยังไม่เปิด RLS policy สำหรับ anon key
