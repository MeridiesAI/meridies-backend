-- Student ↔ counselor sync: what the counselor asks for becomes the student's
-- To-Do, the student hands a file in against it, and AxIS checks it.
--
-- 1. A counselor's intake requests ("Transcript", "Resume") become tasks.
--    The New student page stores them on the invitation (intake_requests).
--    When the student joins, each request becomes a counselor task of kind
--    'document' on the student's To-Do, linked back to its request. The link
--    keeps both views in step: the task completing ticks the request on the
--    counselor's Overview card, and the counselor ticking the request
--    completes the task. Requests added after the student joined become
--    tasks too. Existing joined students are backfilled.
--
-- 2. The student hands a file in. deliverable_documents stayed counselor-only
--    (20261010000003); the student may now add and remove their own
--    'submission' rows on their own tasks, and nothing else. Reference
--    material, rubrics and examples stay the counselor's.
--
-- 3. Tracker verdicts are the counselor's and AxIS's, never the student's.
--    deliverable_tracker_checks carried attach_student_policies, so a student
--    could write an "on-track" verdict on their own task through PostgREST.
--    Writes are now counselor-only; AxIS writes with the service role.
--
-- 4. The latest-verdict view carries the findings and the document checked,
--    so the task card can show what AxIS found without a second read.
--
-- 5. ai_runs.module gains 'submission-review'.
--
-- Depends on private.counselor_can_edit_student (20261010000002) and the
-- deliverables.source / created_by columns (20261010000003).

-- ---------------------------------------------------------------------------
-- 1. Intake requests -> tasks
-- ---------------------------------------------------------------------------

alter table public.deliverables
  add column if not exists intake_invitation_id uuid references public.invitations(id) on delete set null,
  add column if not exists intake_request_id    text check (intake_request_id is null or length(intake_request_id) between 1 and 100);

comment on column public.deliverables.intake_invitation_id is
  'The invitation whose intake request this task is. Set with intake_request_id; the two keep the request''s provided flag and the task''s status in step.';

create unique index if not exists deliverables_intake_request_key
  on public.deliverables (intake_invitation_id, intake_request_id)
  where intake_invitation_id is not null;

-- Create the missing tasks for one accepted invitation, and bring existing
-- ones in line with the request's provided flag. Never deletes a task: a
-- request the counselor removes leaves the student's work where it is.
create or replace function private.sync_intake_tasks(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_inv     public.invitations;
  v_item    jsonb;
  v_req_id  text;
  v_label   text;
  v_done    boolean;
begin
  select * into v_inv from public.invitations where id = p_invitation_id;
  if not found or v_inv.status <> 'accepted' or v_inv.accepted_by is null then
    return;
  end if;
  -- Only while the student is still this counselor's.
  if not exists (select 1 from public.profiles
                  where id = v_inv.accepted_by and counselor_id = v_inv.counselor_id) then
    return;
  end if;

  for v_item in select * from jsonb_array_elements(v_inv.intake_requests) loop
    v_label  := left(btrim(coalesce(v_item->>'label', '')), 300);
    v_req_id := left(coalesce(nullif(btrim(v_item->>'id'), ''), md5(v_label)), 100);
    v_done   := coalesce((v_item->>'provided')::boolean, false);
    continue when v_label = '';

    insert into public.deliverables
      (student_id, kind, title, instructions, status, progress_pct, source,
       created_by, assigned_by, assigned_at, notify_email, notify_sms,
       intake_invitation_id, intake_request_id)
    values
      (v_inv.accepted_by, 'document', v_label,
       'Your counselor asked for this. Upload it here.',
       case when v_done then 'complete' else 'not-started' end,
       case when v_done then 100 else 0 end,
       'counselor', v_inv.counselor_id, v_inv.counselor_id, now(), false, false,
       v_inv.id, v_req_id)
    on conflict (intake_invitation_id, intake_request_id)
      where intake_invitation_id is not null
      do nothing;

    -- The counselor ticked or unticked the request: the task follows.
    update public.deliverables d
       set status       = case when v_done then 'complete' else 'in-progress' end,
           progress_pct = case when v_done then 100 else least(d.progress_pct, 99) end
     where d.intake_invitation_id = v_inv.id
       and d.intake_request_id = v_req_id
       and (d.status = 'complete') is distinct from v_done;
  end loop;
end;
$$;

revoke all on function private.sync_intake_tasks(uuid) from public;

create or replace function private.invitations_sync_intake_tasks()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
begin
  if new.status = 'accepted' and new.accepted_by is not null
     and jsonb_array_length(new.intake_requests) > 0
     and (tg_op = 'INSERT'
          or old.status is distinct from new.status
          or old.accepted_by is distinct from new.accepted_by
          or old.intake_requests is distinct from new.intake_requests) then
    perform private.sync_intake_tasks(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists invitations_sync_intake_tasks on public.invitations;
create trigger invitations_sync_intake_tasks
  after insert or update of status, accepted_by, intake_requests on public.invitations
  for each row execute function private.invitations_sync_intake_tasks();

-- accept_invitation marks the invitation accepted before it links the
-- student to the counselor, so the invitation trigger above finds the link
-- missing and waits. This one runs when the link lands (and when a student is
-- re-linked to a counselor whose accepted invitation carries requests).
create or replace function private.profiles_sync_intake_tasks()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_id uuid;
begin
  if new.counselor_id is null or new.counselor_id is not distinct from old.counselor_id then
    return new;
  end if;
  for v_id in
    select id from public.invitations
     where accepted_by = new.id and counselor_id = new.counselor_id
       and status = 'accepted' and jsonb_array_length(intake_requests) > 0
  loop
    perform private.sync_intake_tasks(v_id);
  end loop;
  return new;
end;
$$;

drop trigger if exists profiles_sync_intake_tasks on public.profiles;
create trigger profiles_sync_intake_tasks
  after update of counselor_id on public.profiles
  for each row execute function private.profiles_sync_intake_tasks();

-- The task's status moved (the student ticked it, AxIS accepted the file, the
-- counselor reopened it): the request's provided flag follows.
create or replace function private.deliverables_sync_intake_request()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_done boolean := new.status = 'complete';
begin
  if new.intake_invitation_id is null or new.intake_request_id is null then
    return new;
  end if;
  if (old.status = 'complete') is not distinct from v_done then
    return new;
  end if;

  update public.invitations i
     set intake_requests = (
           select coalesce(jsonb_agg(
                    case when coalesce(nullif(btrim(e->>'id'), ''), md5(left(btrim(coalesce(e->>'label', '')), 300)))
                              = new.intake_request_id
                         then jsonb_set(e, '{provided}', to_jsonb(v_done))
                         else e end
                    order by ord), '[]'::jsonb)
             from jsonb_array_elements(i.intake_requests) with ordinality as t(e, ord))
   where i.id = new.intake_invitation_id
     and exists (select 1 from jsonb_array_elements(i.intake_requests) e
                  where coalesce(nullif(btrim(e->>'id'), ''), md5(left(btrim(coalesce(e->>'label', '')), 300)))
                        = new.intake_request_id
                    and coalesce((e->>'provided')::boolean, false) is distinct from v_done);
  return new;
end;
$$;

drop trigger if exists deliverables_sync_intake_request on public.deliverables;
create trigger deliverables_sync_intake_request
  after update of status on public.deliverables
  for each row execute function private.deliverables_sync_intake_request();

-- Backfill: students who joined before this migration get their tasks now.
do $$
declare
  v_id uuid;
begin
  for v_id in
    select id from public.invitations
     where status = 'accepted' and accepted_by is not null
       and jsonb_array_length(intake_requests) > 0
  loop
    perform private.sync_intake_tasks(v_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The student hands a file in
-- ---------------------------------------------------------------------------

drop policy if exists deliverable_documents_student_submit on public.deliverable_documents;
create policy deliverable_documents_student_submit on public.deliverable_documents
  for insert to authenticated
  with check (
    role = 'submission'
    and student_id = (select auth.uid())
    and added_by = (select auth.uid())
    and exists (select 1 from public.deliverables d
                 where d.id = deliverable_id and d.student_id = (select auth.uid()))
    and exists (select 1 from public.documents doc
                 where doc.id = document_id and doc.student_id = (select auth.uid()))
  );

drop policy if exists deliverable_documents_student_unsubmit on public.deliverable_documents;
create policy deliverable_documents_student_unsubmit on public.deliverable_documents
  for delete to authenticated
  using (
    role = 'submission'
    and student_id = (select auth.uid())
    and added_by = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3. Tracker verdicts: counselor-only writes
-- ---------------------------------------------------------------------------

drop policy if exists deliverable_tracker_checks_insert on public.deliverable_tracker_checks;
create policy deliverable_tracker_checks_insert on public.deliverable_tracker_checks
  for insert to authenticated
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists deliverable_tracker_checks_update on public.deliverable_tracker_checks;
create policy deliverable_tracker_checks_update on public.deliverable_tracker_checks
  for update to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())))
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists deliverable_tracker_checks_delete on public.deliverable_tracker_checks;
create policy deliverable_tracker_checks_delete on public.deliverable_tracker_checks
  for delete to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- 4. The latest verdict carries its findings and the document checked
-- ---------------------------------------------------------------------------

create or replace view public.deliverable_tracker_latest
with (security_invoker = true) as
select distinct on (c.deliverable_id)
  c.deliverable_id,
  c.student_id,
  c.id as check_id,
  c.verdict,
  c.note,
  c.alignment_score,
  c.days_since_activity,
  c.source,
  c.checked_at,
  c.findings,
  c.document_id
from public.deliverable_tracker_checks c
order by c.deliverable_id, c.checked_at desc;

grant select on public.deliverable_tracker_latest to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The AI module
-- ---------------------------------------------------------------------------

-- Additive, like 20261010000005: read the labels already allowed and append,
-- so a sibling migration's label is never dropped and a re-run is harmless.

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if 'submission-review' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'submission-review'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
