-- ============================================================
--  06 — Job queue: รองรับ job type "rpa_edit" (RPA แก้ไขใบเดิม)
--  รันใน Supabase SQL Editor (Dashboard → SQL Editor → New query → วาง → Run)
-- ============================================================

-- ขยาย check constraint ของ job_queue.type ให้รวม 'rpa_edit'
alter table public.job_queue drop constraint if exists job_queue_type_check;
alter table public.job_queue add constraint job_queue_type_check
  check (type in ('rpa_import', 'get_email', 'rpa_edit'));

-- หมายเหตุ: declarations.status เป็น text free-form (ไม่มี check constraint ใน sql/03)
--   จึงใช้ค่า "edited" (แก้แล้ว) ได้เลย ไม่ต้อง alter เพิ่ม
