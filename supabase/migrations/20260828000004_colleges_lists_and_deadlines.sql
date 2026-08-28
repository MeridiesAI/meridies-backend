-- College catalog, per-student college lists, generated list variants, and the
-- deadline tracker the Deadline Command Center reads.

-- ---------------------------------------------------------------------------
-- Global institution catalog. Read-only to users; only service_role seeds it.
-- ---------------------------------------------------------------------------

create table if not exists public.colleges (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  initials         text,
  brand_color      text,
  city             text,
  state            text,
  country          text not null default 'US',
  control          text check (control in ('public','private','private-for-profit')),
  size             integer,
  acceptance_rate  numeric(5,4) check (acceptance_rate between 0 and 1),
  test_policy      text check (test_policy in ('required','optional','blind','recommended')),
  deadlines        jsonb not null default '{}'::jsonb,
  website          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists colleges_name_idx on public.colleges (lower(name));
drop trigger if exists colleges_set_updated_at on public.colleges;
create trigger colleges_set_updated_at before update on public.colleges
  for each row execute function public.set_updated_at();

alter table public.colleges enable row level security;
drop policy if exists colleges_select_all on public.colleges;
create policy colleges_select_all on public.colleges
  for select to authenticated using (true);
-- No insert/update/delete policies: the catalog is maintained by service_role.

-- ---------------------------------------------------------------------------
-- A student's actual list.
-- ---------------------------------------------------------------------------

create table if not exists public.student_colleges (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  college_id   uuid references public.colleges(id) on delete set null,
  -- Free text so a counselor can add a school the catalog doesn't have yet.
  name         text not null check (length(btrim(name)) between 1 and 300),
  initials     text,
  brand_color  text,
  round        text check (round in ('ED','ED2','EA','REA','RD','rolling','priority')),
  fit          text check (fit in ('reach','target','likely')),
  status       text not null default 'considering' check (status in
                 ('considering','applying','submitted','accepted','denied',
                  'waitlisted','deferred','enrolled','withdrawn')),
  binding      boolean not null default false,
  deadline     date,
  notes        text,
  added_by     uuid references public.profiles(id) on delete set null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists student_colleges_student_idx on public.student_colleges (student_id, sort_order);
create unique index if not exists student_colleges_unique_name
  on public.student_colleges (student_id, lower(name));
drop trigger if exists student_colleges_set_updated_at on public.student_colleges;
create trigger student_colleges_set_updated_at before update on public.student_colleges
  for each row execute function public.set_updated_at();
select private.attach_student_policies('student_colleges');

-- ---------------------------------------------------------------------------
-- College List Builder: several candidate lists per student, one may be active.
-- ---------------------------------------------------------------------------

create table if not exists public.college_list_variants (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 200),
  strategy      text,
  rationale     text,
  is_active     boolean not null default false,
  generated_by  text not null default 'counselor' check (generated_by in ('counselor','ai')),
  ai_run_id     uuid,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists college_list_variants_student_idx
  on public.college_list_variants (student_id, created_at desc);
drop trigger if exists college_list_variants_set_updated_at on public.college_list_variants;
create trigger college_list_variants_set_updated_at before update on public.college_list_variants
  for each row execute function public.set_updated_at();
select private.attach_student_policies('college_list_variants');

create table if not exists public.college_list_items (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references public.college_list_variants(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  college_id  uuid references public.colleges(id) on delete set null,
  name        text not null,
  fit         text check (fit in ('reach','target','likely')),
  round       text,
  note        text,
  sort_order  integer not null default 0
);

create index if not exists college_list_items_variant_idx
  on public.college_list_items (variant_id, sort_order);
select private.attach_student_policies('college_list_items');

-- ---------------------------------------------------------------------------
-- Deadlines: extend the existing table, then normalize its policies onto the
-- shared student shape (the old set had no student INSERT and no DELETE).
-- ---------------------------------------------------------------------------

alter table public.deadlines
  add column if not exists description         text,
  add column if not exists student_college_id  uuid references public.student_colleges(id) on delete set null,
  add column if not exists created_by          uuid references public.profiles(id) on delete set null,
  add column if not exists remind_at           timestamptz,
  add column if not exists reminder_sent_at    timestamptz,
  add column if not exists completed_at        timestamptz,
  add column if not exists updated_at          timestamptz not null default now();

create index if not exists deadlines_student_due_idx on public.deadlines (student_id, due_date);
create index if not exists deadlines_open_idx on public.deadlines (student_id) where not done;

drop trigger if exists deadlines_set_updated_at on public.deadlines;
create trigger deadlines_set_updated_at before update on public.deadlines
  for each row execute function public.set_updated_at();

drop policy if exists deadlines_all_counselor    on public.deadlines;
drop policy if exists deadlines_select_counselor on public.deadlines;
drop policy if exists deadlines_select_self      on public.deadlines;
drop policy if exists deadlines_update_self      on public.deadlines;
select private.attach_student_policies('deadlines');
