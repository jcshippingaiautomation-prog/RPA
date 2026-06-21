-- ============================================================
--  05 — Declarations: เลขใบขน DCTK (สำหรับ RPA ค้นใบเดิมเพื่อแก้ไข)
--  รันใน Supabase SQL Editor (Dashboard → SQL Editor → New query → วาง → Run)
-- ============================================================

-- เลขใบขนที่ DCTK ออกให้ตอนสร้าง (เช่น A005-16905-06273)
-- ใช้เป็นกุญแจให้ RPA ค้นใบเดิมใน DCTK เพื่อแก้ไข
alter table public.declarations add column if not exists declaration_no text;

create index if not exists idx_declarations_decl_no on public.declarations (declaration_no);
