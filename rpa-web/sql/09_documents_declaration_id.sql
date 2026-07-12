-- ============================================================
--  09: ผูกไฟล์ documents กับใบขนแบบเจาะจง (declaration_id)
--  เดิม documents match ด้วย customer+invoice → ใบที่ invoice ซ้ำกันเห็นไฟล์ปนกัน
--  เพิ่ม declaration_id → worker set ตอน upload → เว็บดึงเฉพาะไฟล์ของใบนั้น
--  (ไฟล์เก่าที่ declaration_id = null → เว็บ fallback ไป customer+invoice เหมือนเดิม)
--  รัน idempotent
-- ============================================================

alter table public.documents add column if not exists declaration_id uuid;
create index if not exists idx_documents_declaration_id on public.documents (declaration_id);
