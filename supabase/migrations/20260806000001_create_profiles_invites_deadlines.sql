-- Backfilled from supabase_migrations.schema_migrations (applied 2026-08-06,
-- version 20260806130218). It was applied through the dashboard before the
-- repo owned the schema, so it never had a file. Kept verbatim so a fresh
-- database built from this folder matches the live project.

-- profiles: one row per auth user, mirrors MeridiesUser
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null check (role in ('student','counselor')),
  onboarding_step int not null default 0,
  onboarding_complete boolean not null default false,
  counselor_id uuid references public.profiles(id) on delete set null,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_counselor_id_idx on public.profiles(counselor_id);

create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  counselor_id uuid not null references public.profiles(id) on delete cascade,
  redeemed_by uuid unique references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz
);
create index invite_codes_counselor_id_idx on public.invite_codes(counselor_id);

create table public.deadlines (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  school text,
  type text not null check (type in ('application','essay','test','financial','meeting','document')),
  date_label text,
  due_date date,
  level text not null default 'upcoming' check (level in ('overdue','critical','warning','upcoming','done')),
  owner text not null default 'student' check (owner in ('counselor','student')),
  reminder_sent boolean not null default false,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index deadlines_student_id_idx on public.deadlines(student_id);

-- updated_at maintenance
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'student')
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;
alter table public.invite_codes enable row level security;
alter table public.deadlines enable row level security;

create policy "profiles_select_self" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_select_counselor_of_student" on public.profiles
  for select using (auth.uid() = counselor_id);
create policy "profiles_update_self" on public.profiles
  for update using (auth.uid() = id);
create policy "profiles_update_counselor_of_student" on public.profiles
  for update using (auth.uid() = counselor_id);
create policy "profiles_insert_self" on public.profiles
  for insert with check (auth.uid() = id);

create policy "invites_select_owner_or_redeemer" on public.invite_codes
  for select using (auth.uid() = counselor_id or auth.uid() = redeemed_by);
create policy "invites_insert_owner" on public.invite_codes
  for insert with check (auth.uid() = counselor_id);
create policy "invites_update_redeem" on public.invite_codes
  for update using (redeemed_by is null) with check (redeemed_by = auth.uid());

create policy "deadlines_select_self" on public.deadlines
  for select using (auth.uid() = student_id);
create policy "deadlines_select_counselor" on public.deadlines
  for select using (auth.uid() = (select counselor_id from public.profiles where id = student_id));
create policy "deadlines_update_self" on public.deadlines
  for update using (auth.uid() = student_id);
create policy "deadlines_all_counselor" on public.deadlines
  for all using (auth.uid() = (select counselor_id from public.profiles where id = student_id));
