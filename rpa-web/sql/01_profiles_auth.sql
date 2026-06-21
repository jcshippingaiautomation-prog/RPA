-- ============================================================
--  Phase A — ตาราง profiles + role (user/admin) + RLS + trigger
--  รันใน Supabase SQL Editor ครั้งเดียว
-- ============================================================

-- 1) ตาราง profiles: ผูกกับ auth.users 1:1 เก็บ role
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

-- 2) เปิด RLS
alter table public.profiles enable row level security;

-- ผู้ใช้อ่าน row ของตัวเองได้
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- หมายเหตุ: การ "แก้ role" ทำผ่าน service_role เท่านั้น (server-side)
-- service_role bypass RLS อยู่แล้ว จึงไม่ต้องมี policy update สำหรับ user
-- (ตั้งใจไม่ให้ user อัปเดต role ตัวเองได้)

-- 3) trigger: เมื่อมี user ใหม่ใน auth.users → สร้าง profiles role=user อัตโนมัติ
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'user')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
--  วิธีสร้าง admin คนแรก:
--  1. สมัคร user ผ่านหน้า login (หรือ Supabase Dashboard → Authentication → Add user)
--  2. รันคำสั่งนี้แทน email จริง:
--     update public.profiles set role = 'admin'
--       where email = 'thanongsak40ni@gmail.com';
-- ============================================================
