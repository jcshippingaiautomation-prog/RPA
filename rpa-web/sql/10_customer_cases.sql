-- ============================================================
--  10: หลายกรณีย่อยต่อลูกค้า (multi-case) ใน customer_settings
--  - split_field: ช่องที่ใช้แยกกรณี (เช่น consignee_name, destination_country_code) — ว่าง = ไม่แยก
--  - cases: [{name, match_value, allowed_fields, presets, extraction_rules, request_screenshot}]
--      เลือกกรณีจากค่าของ split_field ใน record; ไม่เข้ากรณีไหน = ใช้ค่า default (คอลัมน์เดิม)
--  รัน idempotent
-- ============================================================

alter table public.customer_settings add column if not exists split_field text default '';
alter table public.customer_settings add column if not exists cases jsonb not null default '[]'::jsonb;
