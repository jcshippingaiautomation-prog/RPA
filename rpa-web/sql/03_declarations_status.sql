-- ============================================================
--  03 — Declarations: เพิ่ม workflow status + ที่มา + ข้อความสถานะ
--  รันใน Supabase SQL Editor (Dashboard → SQL Editor → New query → วาง → Run)
-- ============================================================

-- สถานะการทำงานของใบขน (workflow ของ RPA):
--   new       = เพิ่งเข้า ยังไม่ตรวจ
--   ready     = ตรวจแล้ว พร้อมรัน RPA
--   queued    = ส่งเข้าคิว RPA แล้ว รอ worker
--   running   = worker กำลังกรอกฟอร์ม
--   done      = กรอก+พิมพ์ PDF เสร็จ
--   error     = ล้มเหลว (ดู status_message)
alter table public.declarations
  add column if not exists status text not null default 'new';

-- ข้อความสถานะสั้น ๆ (เช่น "ขาดช่อง export_tariff" / "พิมพ์ PDF แล้ว")
alter table public.declarations
  add column if not exists status_message text;

-- ที่มาของรายการ: get-email | upload | manual  (มี default get-email อยู่แล้ว)
alter table public.declarations
  alter column source set default 'get-email';

-- job ล่าสุดที่รันใบนี้ (โยงไป job_queue เพื่อดูประวัติ/log ได้)
alter table public.declarations
  add column if not exists last_job_id uuid;

-- เวลาแก้ไขล่าสุด
alter table public.declarations
  add column if not exists updated_at timestamptz;

-- index ช่วย filter ตามสถานะ
create index if not exists idx_declarations_status on public.declarations (status);
create index if not exists idx_declarations_created on public.declarations (created_at desc);

-- ตั้งสถานะเริ่มต้นให้แถวเก่า (ที่ status ยังเป็น 'new' ตาม default):
--   ใบที่ข้อมูลครบ (มี invoice + consignee) → ready, ที่เหลือ → new
update public.declarations
   set status = 'ready'
 where status = 'new'
   and coalesce(invoice_number,'') <> ''
   and coalesce(consignee_name,'') <> '';
