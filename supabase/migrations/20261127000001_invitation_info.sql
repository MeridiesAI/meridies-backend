-- invitations.info: what a consultant fills in for a student who has been invited but has not joined yet.
--
-- Why: until they accept, an invitation is the only record of a new student, so the contact, personal and
-- academic details a consultant already knows had nowhere to go. They are kept here as a JSON object keyed
-- by the info card's camelCase keys (infoPatchSchema in src/lib/studentPage.ts, minus gradYear, which is
-- invitations.grad_year, plus highSchoolId and privateNote). The moment the invitation is accepted, a
-- trigger copies them into the student's own tables, filling blanks only: a value the student already has
-- is never overwritten, and a bad value is skipped with a warning, never an error that blocks the accept.
--
-- Additive and idempotent. Deploy order: either order with the code. Safe for the previous build: nothing
-- reads the column and its default is '{}'. NOT in REQUIRED_SCHEMA: without it the draft-info routes
-- answer 503 and the app keeps linking the card to the invitations page.

alter table public.invitations
  add column if not exists info jsonb not null default '{}'::jsonb
    constraint invitations_info_shape check (jsonb_typeof(info) = 'object' and pg_column_size(info) <= 20000);

-- Written only through the API on the counselor's own client; RLS and private.invitations_guard_client
-- apply as for every other client-writable column. Nothing for anon.
grant update (info) on table public.invitations to authenticated;

-- ---------------------------------------------------------------------------
-- One atomic merge, so two quick edits to different keys never lose either.
-- SECURITY INVOKER: the caller's RLS decides which invitation they may touch.
-- ---------------------------------------------------------------------------

create or replace function public.merge_invitation_info(p_id uuid, p_set jsonb, p_remove text[])
returns jsonb
language sql
security invoker
set search_path to 'public'
as $$
  update public.invitations
     set info = (info || coalesce(p_set, '{}'::jsonb)) - coalesce(p_remove, '{}'::text[])
   where id = p_id and status = 'pending'
  returning info;
$$;

revoke all on function public.merge_invitation_info(uuid, jsonb, text[]) from public, anon;
grant execute on function public.merge_invitation_info(uuid, jsonb, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Accepting the invitation fills the student's blank fields from info.
-- Each destination is its own sub-block: a bad value there is a WARNING and
-- that destination is skipped; the acceptance always goes through.
-- The warning names the destination and SQLSTATE only, never SQLERRM: the
-- message can quote the value (a minor's birthday, a parent's email).
-- ---------------------------------------------------------------------------

create or replace function private.invitation_info_on_accepted()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  i         jsonb := new.info;
  v_student uuid  := new.accepted_by;
  v_restore text;
begin
  if not (new.status = 'accepted' and new.accepted_by is not null
          and (old.status is distinct from 'accepted' or old.accepted_by is distinct from new.accepted_by)
          and new.info <> '{}'::jsonb) then
    return new;
  end if;

  -- profiles: phone, high school (its catalog id only when the school name also came from here).
  if i ?| array['phone', 'highSchool', 'highSchoolId'] then
    begin
      update public.profiles p
         set phone          = case when nullif(btrim(p.phone), '') is null
                                   then coalesce(nullif(btrim(i->>'phone'), ''), p.phone) else p.phone end,
             high_school    = case when nullif(btrim(p.high_school), '') is null
                                   then coalesce(nullif(btrim(i->>'highSchool'), ''), p.high_school) else p.high_school end,
             high_school_id = case when p.high_school_id is null and nullif(btrim(p.high_school), '') is null
                                   then (nullif(btrim(i->>'highSchoolId'), ''))::uuid else p.high_school_id end
       where p.id = v_student;
    exception when others then
      raise warning 'invitation info: profiles not filled for invitation % (sqlstate %)', new.id, sqlstate;
    end;
  end if;

  -- student_personal_details.
  if i ?| array['email', 'address', 'gender', 'birthday', 'citizenship', 'firstGen', 'livingWithParent',
                'maritalStatus', 'collegesPlanned', 'intendedMajors'] then
    begin
      insert into public.student_personal_details as t
        (student_id, contact_email, address, gender, birthday, citizenship, first_gen, living_with_parent,
         marital_status, colleges_planned, intended_majors, updated_by)
      values (
        v_student,
        nullif(btrim(i->>'email'), ''),
        nullif(btrim(i->>'address'), ''),
        nullif(btrim(i->>'gender'), ''),
        (nullif(btrim(i->>'birthday'), ''))::date,
        nullif(btrim(i->>'citizenship'), ''),
        (i->>'firstGen')::boolean,
        (i->>'livingWithParent')::boolean,
        nullif(btrim(i->>'maritalStatus'), ''),
        (i->>'collegesPlanned')::smallint,
        case when jsonb_typeof(i->'intendedMajors') = 'array'
             then array(select btrim(x) from jsonb_array_elements_text(i->'intendedMajors') x where btrim(x) <> '')
             else '{}'::text[] end,
        new.counselor_id)
      on conflict (student_id) do update set
        contact_email      = case when nullif(btrim(t.contact_email), '') is null then coalesce(excluded.contact_email, t.contact_email) else t.contact_email end,
        address            = case when nullif(btrim(t.address), '') is null then coalesce(excluded.address, t.address) else t.address end,
        gender             = coalesce(t.gender, excluded.gender),
        birthday           = coalesce(t.birthday, excluded.birthday),
        citizenship        = coalesce(t.citizenship, excluded.citizenship),
        first_gen          = coalesce(t.first_gen, excluded.first_gen),
        living_with_parent = coalesce(t.living_with_parent, excluded.living_with_parent),
        marital_status     = coalesce(t.marital_status, excluded.marital_status),
        colleges_planned   = coalesce(t.colleges_planned, excluded.colleges_planned),
        intended_majors    = case when cardinality(t.intended_majors) = 0 then excluded.intended_majors else t.intended_majors end;
    exception when others then
      raise warning 'invitation info: student_personal_details not filled for invitation % (sqlstate %)', new.id, sqlstate;
    end;
  end if;

  -- student_academics.
  if i ?| array['gpaWeighted', 'gpaUnweighted', 'gpaScale', 'classRank', 'sat', 'act', 'rigor'] then
    begin
      insert into public.student_academics as t
        (student_id, gpa_weighted, gpa_unweighted, gpa_scale, class_rank, sat_superscore, act_composite, rigor_context)
      values (
        v_student,
        (i->>'gpaWeighted')::numeric,
        (i->>'gpaUnweighted')::numeric,
        nullif(btrim(i->>'gpaScale'), ''),
        nullif(btrim(i->>'classRank'), ''),
        (i->>'sat')::integer,
        (i->>'act')::integer,
        nullif(btrim(i->>'rigor'), ''))
      on conflict (student_id) do update set
        gpa_weighted   = coalesce(t.gpa_weighted, excluded.gpa_weighted),
        gpa_unweighted = coalesce(t.gpa_unweighted, excluded.gpa_unweighted),
        gpa_scale      = case when nullif(btrim(t.gpa_scale), '') is null then coalesce(excluded.gpa_scale, t.gpa_scale) else t.gpa_scale end,
        class_rank     = case when nullif(btrim(t.class_rank), '') is null then coalesce(excluded.class_rank, t.class_rank) else t.class_rank end,
        sat_superscore = coalesce(t.sat_superscore, excluded.sat_superscore),
        act_composite  = coalesce(t.act_composite, excluded.act_composite),
        rigor_context  = case when nullif(btrim(t.rigor_context), '') is null then coalesce(excluded.rigor_context, t.rigor_context) else t.rigor_context end;
    exception when others then
      raise warning 'invitation info: student_academics not filled for invitation % (sqlstate %)', new.id, sqlstate;
    end;
  end if;

  -- guardians: the primary parent, only when the student has none and there is a way to reach them.
  if (nullif(btrim(i->>'parentEmail'), '') is not null or nullif(btrim(i->>'parentPhone'), '') is not null)
     and not exists (select 1 from public.guardians g where g.student_id = v_student) then
    begin
      -- auth.uid() is the accepting student here; the insert guard would record the student as the one who
      -- added this parent and switch alerts off. The counselor drafted it, so keep the row as written.
      v_restore := current_setting('meridies.axis_restore', true);
      perform set_config('meridies.axis_restore', 'on', true);
      insert into public.guardians (student_id, full_name, email, phone, is_primary, added_by)
      values (v_student,
              coalesce(nullif(btrim(i->>'parentName'), ''), 'Parent or guardian'),
              nullif(btrim(i->>'parentEmail'), ''),
              nullif(btrim(i->>'parentPhone'), ''),
              true,
              new.counselor_id);
      perform set_config('meridies.axis_restore', coalesce(v_restore, ''), true);
    exception when others then
      raise warning 'invitation info: guardians not filled for invitation % (sqlstate %)', new.id, sqlstate;
    end;
  end if;

  -- student_private_notes: only when there is no note yet.
  if nullif(btrim(i->>'privateNote'), '') is not null then
    begin
      insert into public.student_private_notes as t (student_id, body, updated_by)
      values (v_student, btrim(i->>'privateNote'), new.counselor_id)
      on conflict (student_id) do update set body = excluded.body, updated_by = excluded.updated_by
        where nullif(btrim(t.body), '') is null;
    exception when others then
      raise warning 'invitation info: student_private_notes not filled for invitation % (sqlstate %)', new.id, sqlstate;
    end;
  end if;

  return new;
end;
$$;

revoke all on function private.invitation_info_on_accepted() from public, anon, authenticated;

drop trigger if exists invitation_info_on_accepted on public.invitations;
create trigger invitation_info_on_accepted
  after update on public.invitations
  for each row execute function private.invitation_info_on_accepted();
