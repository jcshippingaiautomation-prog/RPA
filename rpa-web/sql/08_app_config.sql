-- ============================================================
--  08: ตารางตั้งค่าระบบแบบ global (key/value JSON) — แก้ได้จากหน้าตั้งค่า
--  ใช้เก็บ "กฎสถานที่รับบรรทุก" (loading_port_rules): prefix ของสถานที่ตรวจปล่อย → รหัสสถานที่รับบรรทุก
--    เช่น {"28":"2801"} = release ขึ้นต้น 28 → loading=2801; prefix ที่ไม่ match = loading เท่ากับ release
--  รัน idempotent
-- ============================================================

create table if not exists public.app_config (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ค่าเริ่มต้นของกฎ loading (ถ้ายังไม่มี)
insert into public.app_config (key, value)
values ('loading_port_rules', '{"28":"2801"}'::jsonb)
on conflict (key) do nothing;
