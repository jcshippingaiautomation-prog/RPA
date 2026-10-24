-- ============================================================
--  14 — Job queue: รับงาน "พิมพ์ใบขนซ้ำ" (rpa_print) และ "แคปหน้าจอใบขน" (rpa_capture)
--
--  ก่อนรันไฟล์นี้ ฐานข้อมูลปฏิเสธงานพิมพ์ซ้ำทุกครั้ง (ปุ่ม "พิมพ์ใบขนซ้ำ" บนเว็บจึงไม่เคยทำงานจริง)
--  ส่วนงานแคปหน้าจอ ระบบฝากไปกับคิวสร้างใบไว้ก่อน ใช้งานได้แต่ประวัติงานจะแสดงเป็นงานสร้างใบ
--  รันใน Supabase → SQL Editor ครั้งเดียว
-- ============================================================
alter table public.job_queue drop constraint if exists job_queue_type_check;
alter table public.job_queue add constraint job_queue_type_check
  check (type in ('rpa_import', 'get_email', 'rpa_edit', 'rpa_print', 'rpa_capture'));
