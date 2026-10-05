-- Overview (demo v7): the admission outcomes database, Close cycle, alumni.
--
-- admission_outcomes
--   Every admission result the practice has seen, one row per student, school
--   and round. Mostly invisible: it is what next cycle's list building reads
--   ("what happened when students from this high school applied here") and
--   what AxIS retrieves, so an answer about admissibility is the practice's own
--   history rather than a national average. Practice data: visible to the
--   counselor who recorded it and to their firm, never to students. A row keeps
--   the high school and college *names* as recorded, because the history must
--   survive a student account being deleted (student_id is set null, not
--   cascaded) and profiles.high_school is free text.
--
-- Close cycle
--   close_admission_cycle() turns each senior into an alum and locks their
--   rows. It records what is on the students' college lists with a decision
--   (it never invents a result), snapshots GPA and scores at that moment, and
--   is SECURITY INVOKER: every insert and update runs under the caller's RLS.
--   A locked row is history and cannot be edited or deleted.
--
-- alumni_records
--   Where each alum enrolled and in what program. Null institution = undecided
--   (the counselor never marked an enrolment).

create table if not exists public.admission_outcomes (
  id                 uuid primary key default gen_random_uuid(),
  counselor_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  firm_id            uuid references public.firms(id) on delete set null,
  student_id         uuid references public.profiles(id) on delete set null,
  student_name       text check (student_name is null or length(student_name) <= 200),
  high_school_id     uuid references public.high_schools(id) on delete set null,
  high_school_name   text not null check (length(btrim(high_school_name)) between 1 and 200),
  cycle              text not null check (cycle ~ '^\d{4}-\d{4}$'),
  college_id         uuid references public.colleges(id) on delete set null,
  college_name       text not null check (length(btrim(college_name)) between 1 and 300),
  round              text not null default 'RD'
                       check (round in ('ED','ED2','EA','REA','SCEA','RD','rolling','priority')),
  result             text not null check (result in ('admitted','denied','waitlisted','deferred','withdrawn')),
  enrolled           boolean not null default false,
  gpa_unweighted     numeric(4,3) check (gpa_unweighted between 0 and 10),
  gpa_weighted       numeric(4,3) check (gpa_weighted between 0 and 10),
  sat                integer check (sat between 400 and 1600),
  act                integer check (act between 1 and 36),
  hooks              text[] not null default '{}'
                       check (hooks <@ array['first_gen','full_pay','recruited_athlete','legacy','ed']::text[]),
  intended_major     text check (intended_major is null or length(intended_major) <= 200),
  -- The college-list row a closed cycle recorded this from, so closing twice
  -- cannot record it twice.
  student_college_id uuid references public.student_colleges(id) on delete set null,
  locked             boolean not null default false,
  locked_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint admission_outcomes_enrolled_admitted check (not enrolled or result = 'admitted')
);

create index if not exists admission_outcomes_counselor_idx on public.admission_outcomes (counselor_id, cycle);
create index if not exists admission_outcomes_firm_idx on public.admission_outcomes (firm_id) where firm_id is not null;
create index if not exists admission_outcomes_student_idx on public.admission_outcomes (student_id) where student_id is not null;
create index if not exists admission_outcomes_school_idx
  on public.admission_outcomes (lower(high_school_name), college_id);
create unique index if not exists admission_outcomes_from_list_once
  on public.admission_outcomes (student_college_id, cycle) where student_college_id is not null;

drop trigger if exists admission_outcomes_set_updated_at on public.admission_outcomes;
create trigger admission_outcomes_set_updated_at before update on public.admission_outcomes
  for each row execute function public.set_updated_at();

-- History is history: a locked row is neither edited nor deleted. Locking
-- itself (false -> true) is the one update allowed past this.
create or replace function private.admission_outcomes_lock_guard()
returns trigger
language plpgsql set search_path to 'private','public'
as $$
begin
  if tg_op = 'DELETE' then
    if old.locked then
      raise exception 'That outcome is part of a closed cycle and cannot be removed' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.locked then
    raise exception 'That outcome is part of a closed cycle and cannot be edited' using errcode = '42501';
  end if;
  if new.locked and not old.locked then
    new.locked_at := now();
  end if;
  return new;
end;
$$;
revoke all on function private.admission_outcomes_lock_guard() from public, anon, authenticated;

drop trigger if exists admission_outcomes_lock_guard on public.admission_outcomes;
create trigger admission_outcomes_lock_guard before update or delete on public.admission_outcomes
  for each row execute function private.admission_outcomes_lock_guard();

comment on table public.admission_outcomes is
  'Admission results the practice has seen. Counselor and firm only; locked rows are closed-cycle history.';

alter table public.admission_outcomes enable row level security;
revoke all on table public.admission_outcomes from anon;
grant select, insert, update, delete on table public.admission_outcomes to authenticated;

drop policy if exists admission_outcomes_select on public.admission_outcomes;
create policy admission_outcomes_select on public.admission_outcomes
  for select to authenticated
  using (
    counselor_id = (select auth.uid())
    or (firm_id is not null and private.is_firm_member(firm_id, (select auth.uid())))
  );

drop policy if exists admission_outcomes_insert on public.admission_outcomes;
create policy admission_outcomes_insert on public.admission_outcomes
  for insert to authenticated
  with check (
    counselor_id = (select auth.uid())
    and private.is_counselor((select auth.uid()))
    and (firm_id is null or private.is_firm_member(firm_id, (select auth.uid())))
    and (student_id is null or private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists admission_outcomes_update on public.admission_outcomes;
create policy admission_outcomes_update on public.admission_outcomes
  for update to authenticated
  using (counselor_id = (select auth.uid()))
  with check (
    counselor_id = (select auth.uid())
    and (firm_id is null or private.is_firm_member(firm_id, (select auth.uid())))
    and (student_id is null or private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists admission_outcomes_delete on public.admission_outcomes;
create policy admission_outcomes_delete on public.admission_outcomes
  for delete to authenticated
  using (counselor_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Alumni
-- ---------------------------------------------------------------------------

create table if not exists public.alumni_records (
  student_id       uuid primary key references public.profiles(id) on delete cascade,
  counselor_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  cycle            text not null check (cycle ~ '^\d{4}-\d{4}$'),
  college_id       uuid references public.colleges(id) on delete set null,
  -- Null = undecided.
  institution_name text check (institution_name is null or length(btrim(institution_name)) between 1 and 300),
  program          text check (program is null or length(program) <= 200),
  outcome_id       uuid references public.admission_outcomes(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists alumni_records_counselor_idx on public.alumni_records (counselor_id, cycle);

drop trigger if exists alumni_records_set_updated_at on public.alumni_records;
create trigger alumni_records_set_updated_at before update on public.alumni_records
  for each row execute function public.set_updated_at();

comment on table public.alumni_records is
  'Where an alum enrolled. Counselor-written; the alum may read their own.';

alter table public.alumni_records enable row level security;
revoke all on table public.alumni_records from anon;
grant select, insert, update, delete on table public.alumni_records to authenticated;

drop policy if exists alumni_records_select on public.alumni_records;
create policy alumni_records_select on public.alumni_records
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists alumni_records_write on public.alumni_records;
create policy alumni_records_write on public.alumni_records
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (
    counselor_id = (select auth.uid())
    and private.is_counselor_of(student_id, (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Closed cycles
-- ---------------------------------------------------------------------------

create table if not exists public.admission_cycles (
  counselor_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  cycle         text not null check (cycle ~ '^\d{4}-\d{4}$'),
  closed_at     timestamptz not null default now(),
  alumni_count  integer not null default 0 check (alumni_count >= 0),
  rows_recorded integer not null default 0 check (rows_recorded >= 0),
  rows_locked   integer not null default 0 check (rows_locked >= 0),
  primary key (counselor_id, cycle)
);

alter table public.admission_cycles enable row level security;
revoke all on table public.admission_cycles from anon;
grant select, insert on table public.admission_cycles to authenticated;

drop policy if exists admission_cycles_owner on public.admission_cycles;
create policy admission_cycles_owner on public.admission_cycles
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

-- Close a cycle for the calling counselor. SECURITY INVOKER: RLS applies to
-- every statement, so this can only touch the caller's own roster and rows.
-- Runs as one transaction: either every senior becomes an alum or none does.
create or replace function public.close_admission_cycle(p_cycle text)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_user       uuid := auth.uid();
  v_class      text;
  v_firm       uuid;
  v_seniors    uuid[];
  v_recorded   integer := 0;
  v_locked     integer := 0;
  v_alumni     integer := 0;
  v_student    uuid;
  v_enrolled   public.admission_outcomes;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if (select role from public.profiles where id = v_user) is distinct from 'counselor' then
    raise exception 'Only counselors can close a cycle' using errcode = '42501';
  end if;
  if p_cycle !~ '^\d{4}-\d{4}$' or right(p_cycle, 4)::int <> left(p_cycle, 4)::int + 1 then
    raise exception 'A cycle reads like 2026-2027' using errcode = '22023';
  end if;
  if exists (select 1 from public.admission_cycles where counselor_id = v_user and cycle = p_cycle) then
    raise exception 'That cycle is already closed' using errcode = '23505';
  end if;

  -- The fall 2026 cycle's seniors are the class of 2027.
  v_class := right(p_cycle, 4);
  select firm_id into v_firm from public.profiles where id = v_user;

  select coalesce(array_agg(p.id), '{}') into v_seniors
  from public.profiles p
  where p.counselor_id = v_user
    and p.role = 'student'
    and p.archived_at is null
    and btrim(coalesce(p.grad_year, '')) = v_class
    and not exists (select 1 from public.alumni_records a where a.student_id = p.id);

  -- Record every decision on the seniors' college lists not already recorded.
  with ins as (
    insert into public.admission_outcomes (
      counselor_id, firm_id, student_id, student_name, high_school_name, cycle,
      college_id, college_name, round, result, enrolled,
      gpa_unweighted, gpa_weighted, sat, act, hooks, intended_major, student_college_id
    )
    select
      v_user, v_firm, p.id, p.full_name,
      coalesce(nullif(btrim(p.high_school), ''), 'Unknown high school'),
      p_cycle, sc.college_id, sc.name,
      coalesce(sc.round, 'RD'),
      case sc.status when 'accepted' then 'admitted' when 'enrolled' then 'admitted' else sc.status end,
      sc.status = 'enrolled',
      sa.gpa_unweighted, sa.gpa_weighted, sa.sat_superscore, sa.act_composite,
      case when sc.round in ('ED','ED2') or sc.binding then array['ed']::text[] else '{}'::text[] end,
      nullif(btrim(coalesce(p.profile->>'intendedMajor', '')), ''),
      sc.id
    from public.student_colleges sc
    join public.profiles p on p.id = sc.student_id
    left join public.student_academics sa on sa.student_id = p.id
    where sc.student_id = any(v_seniors)
      and sc.status in ('accepted','enrolled','denied','waitlisted','deferred','withdrawn')
      and not exists (
        select 1 from public.admission_outcomes o
        where o.student_college_id = sc.id and o.cycle = p_cycle
      )
    returning 1
  )
  select count(*) into v_recorded from ins;

  with upd as (
    update public.admission_outcomes
       set locked = true
     where counselor_id = v_user and cycle = p_cycle and not locked
       and (student_id is null or student_id = any(v_seniors))
    returning 1
  )
  select count(*) into v_locked from upd;

  foreach v_student in array v_seniors loop
    select * into v_enrolled
    from public.admission_outcomes
    where student_id = v_student and cycle = p_cycle and enrolled
    order by updated_at desc
    limit 1;

    insert into public.alumni_records (student_id, counselor_id, cycle, college_id, institution_name, program, outcome_id)
    values (
      v_student, v_user, p_cycle,
      v_enrolled.college_id, v_enrolled.college_name, v_enrolled.intended_major, v_enrolled.id
    )
    on conflict (student_id) do nothing;
    v_alumni := v_alumni + 1;
    v_enrolled := null;
  end loop;

  insert into public.admission_cycles (counselor_id, cycle, alumni_count, rows_recorded, rows_locked)
  values (v_user, p_cycle, v_alumni, v_recorded, v_locked);

  return jsonb_build_object(
    'cycle', p_cycle,
    'alumniCount', v_alumni,
    'rowsRecorded', v_recorded,
    'rowsLocked', v_locked
  );
end;
$function$;

revoke all on function public.close_admission_cycle(text) from public, anon;
grant execute on function public.close_admission_cycle(text) to authenticated;
