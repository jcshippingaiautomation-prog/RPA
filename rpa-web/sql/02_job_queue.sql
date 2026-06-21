-- ============================================================
--  Phase C — job_queue + job_logs + claim RPC
--  คิวงานให้ web (cloud) สั่ง แล้ว worker (VM) มาหยิบไปทำ
--  รันใน Supabase SQL Editor ครั้งเดียว
-- ============================================================

-- 1) คิวงาน
create table if not exists public.job_queue (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in ('rpa_import', 'get_email')),
  status         text not null default 'pending'
                   check (status in ('pending', 'processing', 'done', 'error', 'cancel')),
  payload        jsonb not null default '{}',          -- rpa_import:{onlyRows,headless,dryRun} | get_email:{subject}
  dry_run        boolean not null default false,
  triggered_by   uuid references auth.users(id) on delete set null,  -- null = scheduler
  trigger_source text default 'manual',                -- 'manual' | 'schedule'
  result         jsonb,                                -- RunResult ตอนจบ
  error          text,
  claimed_at     timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_job_queue_pending
  on public.job_queue (type, created_at) where status = 'pending';
create index if not exists idx_job_queue_created
  on public.job_queue (created_at desc);

-- 2) log สด ของแต่ละงาน (mirror SSE event เดิม)
create table if not exists public.job_logs (
  id         bigint generated always as identity primary key,
  job_id     uuid not null references public.job_queue(id) on delete cascade,
  kind       text not null,        -- 'log' | 'row' | 'row-status' | 'document' | 'lifecycle'
  payload    jsonb not null,       -- รูปแบบเดียวกับ data ของ broadcast(event,data)
  created_at timestamptz not null default now()
);
create index if not exists idx_job_logs_job on public.job_logs (job_id, id);

-- 3) RPC หยิบงานถัดไปแบบ atomic (กัน worker หลายตัวหยิบงานเดียวกัน)
create or replace function public.claim_next_job(p_type text)
returns public.job_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.job_queue;
begin
  update public.job_queue
     set status = 'processing', claimed_at = now(), started_at = now()
   where id = (
     select id from public.job_queue
      where status = 'pending' and type = p_type
      order by created_at
      limit 1
      for update skip locked
   )
   returning * into job;
  return job;  -- null ถ้าไม่มีงาน
end;
$$;

-- 4) เปิด Realtime บน job_logs + job_queue (ให้ web subscribe log สด/สถานะ)
alter publication supabase_realtime add table public.job_logs;
alter publication supabase_realtime add table public.job_queue;

-- ============================================================
--  หมายเหตุ:
--  - service_role bypass RLS → web (enqueue) และ worker (claim/log) ใช้ service key
--  - ถ้าต้องการให้ frontend subscribe Realtime ตรงด้วย anon key ในอนาคต
--    ค่อยเพิ่ม RLS policy select ทีหลัง (ตอนนี้ใช้ web เป็นตัวกลาง bridge)
--  - prune log เก่า (กันโต): ตั้ง cron/policy ลบ job_logs ที่ created_at < now()-interval '7 days'
-- ============================================================
