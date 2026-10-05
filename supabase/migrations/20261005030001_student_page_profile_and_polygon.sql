-- v10 sync, student-aid-comms (1 of 3): the student page itself.
--
-- 1. Personal details. The v7 info card edits every value in place: gender,
--    birthday, citizenship, first-gen, living with parent, marital status,
--    address, a contact email and the intended majors. They had nowhere to live
--    but `profiles.profile` jsonb, which nothing validates. A typed one-row
--    table instead, student-scoped (these are the student's own facts, so the
--    standard shape where the student may write is right).
--
-- 2. The stat polygon, as the demo draws it since v8:
--    - the defaults are the demo's five: Grades, Testing, Rigor,
--      Extracurriculars, Essays. Seeded only for a student who has no axes at
--      all, so a student who already has the v5 six keeps them;
--    - any axis can be taken off the polygon. A default one is *hidden* rather
--      than deleted, so its history (append-only) still has a parent and
--      bringing it back restores the formula;
--    - at most ten visible axes. Past that the labels stop being legible at any
--      size the product renders. The route checks first so it can say so; the
--      trigger is the backstop for a route written later.

-- ---------------------------------------------------------------------------
-- 1. Personal details
-- ---------------------------------------------------------------------------

create table if not exists public.student_personal_details (
  student_id          uuid primary key references public.profiles(id) on delete cascade,
  -- Where the counselor writes to the student, when it is not the login email.
  contact_email       text check (contact_email is null or (length(contact_email) <= 320
                                   and contact_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  address             text check (address is null or length(address) <= 400),
  gender              text check (gender is null or gender in ('female','male','non-binary','undisclosed')),
  birthday            date check (birthday is null or birthday between date '1980-01-01' and date '2030-12-31'),
  citizenship         text check (citizenship is null or citizenship in ('us-citizen','permanent-resident','international')),
  first_gen           boolean,
  living_with_parent  boolean,
  marital_status      text check (marital_status is null or marital_status in ('single','married')),
  intended_majors     text[] not null default '{}'
                        check (cardinality(intended_majors) <= 10),
  updated_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists student_personal_details_set_updated_at on public.student_personal_details;
create trigger student_personal_details_set_updated_at before update on public.student_personal_details
  for each row execute function public.set_updated_at();

comment on table public.student_personal_details is
  'The info card''s personal details (v7), every one editable in place. Student-scoped: the student''s own facts.';

revoke all on table public.student_personal_details from anon;
grant select, insert, update, delete on table public.student_personal_details to authenticated;
select private.attach_student_policies('student_personal_details');

-- ---------------------------------------------------------------------------
-- 2. The stat polygon
-- ---------------------------------------------------------------------------

alter table public.student_polygon_axes
  add column if not exists hidden boolean not null default false;

comment on column public.student_polygon_axes.hidden is
  'A default axis the counselor took off the polygon. Hidden rather than deleted so its history keeps its parent and bringing it back restores the derived score.';

-- The demo's five, for a student with no axes yet. A student who already has
-- axes (the v5 six, or their counselor's own) is left exactly as they are:
-- seeding on top would push them past the ten-axis cap.
create or replace function public.ensure_default_polygon_axes(p_student uuid)
returns void
language plpgsql
security invoker
set search_path to 'public'
as $function$
begin
  if exists (select 1 from public.student_polygon_axes where student_id = p_student) then
    return;
  end if;

  insert into public.student_polygon_axes (student_id, key, label, description, sort_order, source)
  values
    (p_student, 'grades',           'Grades',           'Weighted GPA on a 4.5 scale',                     0, 'default'),
    (p_student, 'testing',          'Testing',          'SAT superscore, or the ACT equivalent',          1, 'default'),
    (p_student, 'rigor',            'Rigor',            'AP, IB and college courses taken or planned',    2, 'default'),
    (p_student, 'extracurriculars', 'Extracurriculars', 'Activities and awards, read together',           3, 'default'),
    (p_student, 'essays',           'Essays',           'How far the essays on file have come',           4, 'default')
  on conflict (student_id, key) do nothing;
end;
$function$;

revoke all on function public.ensure_default_polygon_axes(uuid) from public, anon;
grant execute on function public.ensure_default_polygon_axes(uuid) to authenticated;

-- Ten visible axes, no more.
create or replace function private.polygon_axes_enforce_cap()
returns trigger
language plpgsql
security invoker
set search_path to 'private','public','pg_temp'
as $function$
begin
  if new.hidden then
    return new;
  end if;
  if tg_op = 'UPDATE' and not old.hidden then
    return new;
  end if;

  if (
    select count(*)
    from public.student_polygon_axes a
    where a.student_id = new.student_id
      and not a.hidden
      and a.id <> new.id
  ) >= 10 then
    raise exception 'A polygon holds at most ten axes' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function private.polygon_axes_enforce_cap() from public, anon, authenticated;

drop trigger if exists student_polygon_axes_enforce_cap on public.student_polygon_axes;
create trigger student_polygon_axes_enforce_cap
  before insert or update of hidden on public.student_polygon_axes
  for each row execute function private.polygon_axes_enforce_cap();
