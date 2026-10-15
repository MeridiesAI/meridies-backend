-- Caseload transfer, step 2: the preview and the transfer.
-- Spec: docs/superpowers/specs/2026-10-15-caseload-transfer-design.md (§5-§9)
--
-- Both are SECURITY DEFINER with an empty search_path: every name is
-- schema-qualified, and authorization is the first thing each does. They
-- return ids and names only, never an email address; the API reads the
-- addresses it mails after the transfer commits.
--
-- The transfer is one transaction. Everything is set-based over a temporary
-- mapping table (student -> receiver), so 500 students stay well inside the
-- authenticated statement timeout (test/integration/caseload-transfer-load.mjs).
--
-- No import function changes. Held data of a moved student is moved by UPDATE
-- into a carrier import owned by the student's receiver (spec §6.6), so the
-- ordinary per-import access, queue and apply functions serve the receiver.

-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------

-- Who may receive students (or the practice items) in this firm: an approved
-- counselor who is a member of it, with the firm on their profile.
create or replace function private.caseload_can_receive(p_firm uuid, p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_firm is not null and p_profile is not null
     and private.is_counselor(p_profile)
     and private.crm_firm_member(p_firm, p_profile)
     and exists (select 1 from public.profiles p where p.id = p_profile and p.firm_id = p_firm);
$$;
revoke all on function private.caseload_can_receive(uuid, uuid) from public, anon, authenticated;

-- The caller's firm when they may transfer p_from's students, else an error
-- with a counselor-readable message. Shared by the preview and the transfer
-- so the two can never disagree about who may look and who may act.
create or replace function private.caseload_transfer_firm(p_from uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := (select auth.uid());
  v_firm  uuid;
  v_owner uuid;
  v_from  record;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.is_counselor(v_me) then
    raise exception 'Only an approved counselor can transfer students' using errcode = '42501';
  end if;
  v_firm := private.crm_workspace_firm(v_me);
  if v_firm is null then
    raise exception 'Caseload transfer is between consultants in a firm. Start a firm and invite your colleague first.'
      using errcode = 'P0001';
  end if;
  if not private.crm_firm_admin(v_firm, v_me) then
    raise exception 'Only a firm owner or admin can transfer students' using errcode = '42501';
  end if;
  select p.id, p.role, p.firm_id into v_from from public.profiles p where p.id = p_from;
  if v_from.id is null or v_from.role is distinct from 'counselor'
     or v_from.firm_id is distinct from v_firm or not private.crm_firm_member(v_firm, p_from) then
    raise exception 'That consultant isn''t in your firm' using errcode = '42501';
  end if;
  select f.owner_id into v_owner from public.firms f where f.id = v_firm;
  if p_from = v_owner and v_me <> v_owner then
    raise exception 'Only the firm owner can transfer the owner''s students' using errcode = '42501';
  end if;
  return v_firm;
end;
$$;
revoke all on function private.caseload_transfer_firm(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The preview (read-only)
-- ---------------------------------------------------------------------------
create or replace function public.caseload_transfer_preview(p_from uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me     uuid := (select auth.uid());
  v_firm   uuid := private.caseload_transfer_firm(p_from);
  v_owner  uuid;
  v_result jsonb;
  v_policy record;
begin
  select f.owner_id into v_owner from public.firms f where f.id = v_firm;
  select ps.caseload_transfer_mode as mode, ps.caseload_default_receiver as receiver
    into v_policy
    from public.practice_settings ps where ps.firm_id = v_firm;

  with students as (
    select s.id, s.full_name, s.grad_year, s.archived_at
      from public.profiles s
     where s.counselor_id = p_from and s.role = 'student'
  ),
  attendees as (
    select a.meeting_id, a.student_id from public.meeting_attendees a
    union
    select m.id, m.student_id from public.meetings m
  ),
  meetings as (
    select mt.id, mt.starts_at, mt.calendar_event_id,
           bool_and(st.id is not null) as all_students_moving
      from public.meetings mt
      join attendees a on a.meeting_id = mt.id
      left join students st on st.id = a.student_id
     where mt.counselor_id = p_from
       and exists (select 1 from attendees a2 join students s2 on s2.id = a2.student_id where a2.meeting_id = mt.id)
     group by mt.id, mt.starts_at, mt.calendar_event_id
  )
  select jsonb_build_object(
    'from', (select jsonb_build_object(
               'id', p.id, 'name', p.full_name,
               'approved', private.is_counselor(p.id),
               'isOwner', p.id = v_owner, 'isYou', p.id = v_me)
             from public.profiles p where p.id = p_from),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', st.id,
               'name', st.full_name,
               'gradYear', st.grad_year,
               'archived', st.archived_at is not null,
               'alumni', exists (select 1 from public.alumni_records ar where ar.student_id = st.id),
               'onboarding', exists (select 1 from public.invitations i
                                      where i.accepted_by = st.id and i.counselor_id = p_from
                                        and i.status = 'accepted' and i.confirmed_at is null),
               'upcomingMeetings', (select count(*) from public.meetings mt
                                     where mt.student_id = st.id and mt.counselor_id = p_from
                                       and mt.starts_at > now() and mt.status = 'scheduled'))
             order by st.archived_at is not null, st.full_name, st.id)
        from students st), '[]'::jsonb),
    'receivers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.full_name,
               'seatRole', coalesce(fm.seat_role, case when p.id = v_owner then 'owner' else 'counselor' end),
               'studentCount', (select count(*) from public.profiles s
                                 where s.counselor_id = p.id and s.role = 'student' and s.archived_at is null),
               'isYou', p.id = v_me)
             order by p.full_name, p.id)
        from public.profiles p
        left join public.firm_members fm on fm.firm_id = v_firm and fm.profile_id = p.id
       where p.firm_id = v_firm and p.id <> p_from
         and private.caseload_can_receive(v_firm, p.id)), '[]'::jsonb),
    'counts', jsonb_build_object(
      'students', (select count(*) from students),
      'activeStudents', (select count(*) from students where archived_at is null),
      'archivedStudents', (select count(*) from students where archived_at is not null),
      'meetings', (select count(*) from meetings where all_students_moving),
      'upcomingMeetings', (select count(*) from meetings where all_students_moving and starts_at > now()),
      'meetingNotes', (select count(*) from public.meeting_notes n join students st on st.id = n.student_id
                        where n.counselor_id = p_from),
      'documents', (select count(*) from public.documents d join students st on st.id = d.student_id
                     where d.owner_id = p_from),
      'messages', (select count(*) from public.student_messages sm join students st on st.id = sm.student_id
                    where sm.counselor_id = p_from),
      'openTasks', (select count(*) from public.consultant_tasks t join students st on st.id = t.student_id
                     where t.assignee_id = p_from and not t.done and t.parent_id is null),
      'openWorkItems', (select count(*) from public.counselor_work_items w join students st on st.id = w.student_id
                         where w.counselor_id = p_from and not w.done),
      'heldImportItems', (select count(*) from public.import_items it
                            join students st on st.id = it.student_id
                            join public.roster_imports i on i.id = it.import_id
                           where i.counselor_id = p_from and it.match_status = 'awaiting_counselor')
    ),
    'attention', jsonb_build_object(
      'calendarLinkedMeetings', (select count(*) from meetings
                                  where all_students_moving and starts_at > now() and calendar_event_id is not null),
      'groupMeetings', (select count(*) from meetings where not all_students_moving),
      'supplementDocs', (select count(*) from public.supplement_docs sd join students st on st.id = sd.student_id
                          where sd.owner_id = p_from),
      'driveLinkedDocuments', (select count(*) from public.documents d join students st on st.id = d.student_id
                                where d.owner_id = p_from and d.external_provider is not null),
      'scheduledMessages', (select count(*) from public.student_messages sm join students st on st.id = sm.student_id
                             where sm.counselor_id = p_from and sm.status = 'scheduled'),
      'queuedParentAlerts', (select count(*) from public.parent_alerts pa join students st on st.id = pa.student_id
                              where pa.status in ('queued', 'scheduled')
                                and (pa.counselor_id is null or pa.counselor_id = p_from)),
      'importsSaving', (select count(*) from public.roster_imports i
                         where i.counselor_id = p_from and i.status in ('committing', 'undoing')),
      'heldItemsSaving', (select count(*) from public.import_items it
                            join students st on st.id = it.student_id
                            join public.roster_imports i on i.id = it.import_id
                           where i.counselor_id = p_from and it.match_status = 'applying')
    ),
    'practiceItems', jsonb_build_object(
      'movable', p_from <> v_owner,
      'pendingInvitations', (select count(*) from public.invitations i
                              where i.counselor_id = p_from and i.status = 'pending'),
      'imports', (select count(*) from public.roster_imports i where i.counselor_id = p_from),
      'importsInFlight', (select count(*) from public.roster_imports i
                           where i.counselor_id = p_from
                             and i.status in ('committing', 'undoing', 'profiling', 'staging')),
      'templates', (select count(*) from public.import_templates t where t.counselor_id = p_from),
      'pipelineContacts', (select count(*) from public.pipeline_contacts c
                            where c.firm_id = v_firm and (c.counselor_id = p_from or c.owner_id = p_from)),
      'pipelineStages', (select count(*) from public.pipeline_stages s
                          where s.firm_id = v_firm and s.counselor_id = p_from),
      'soloPipelineContacts', (select count(*) from public.pipeline_contacts c
                                where c.firm_id is null and c.counselor_id = p_from),
      'libraryResources', (select count(*) from public.library_resources r
                            where r.firm_id = v_firm and r.counselor_id = p_from)
    ),
    'policy', jsonb_build_object(
      'mode', coalesce(v_policy.mode, 'per_student'),
      'defaultReceiverId', case when v_policy.receiver is not null and v_policy.receiver <> p_from
                                     and private.caseload_can_receive(v_firm, v_policy.receiver)
                                then v_policy.receiver end
    )
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.caseload_transfer_preview(uuid) from public, anon;
grant execute on function public.caseload_transfer_preview(uuid) to authenticated;

comment on function public.caseload_transfer_preview(uuid) is
  'What a caseload transfer of p_from would move (firm owner/admin). Ids, names and counts only; never an email.';

-- ---------------------------------------------------------------------------
-- The transfer
-- ---------------------------------------------------------------------------
create or replace function public.transfer_caseload(
  p_from             uuid,
  p_all_to           uuid    default null,
  p_assignments      jsonb   default null,
  p_practice_to      uuid    default null,
  p_include_practice boolean default false,
  p_remove_after     boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me          uuid := (select auth.uid());
  v_firm        uuid;
  v_owner       uuid;
  v_from_name   text;
  v_me_name     text;
  v_mode        text;
  v_count       integer;
  v_locked      integer;
  v_left        integer;
  v_practice    boolean := coalesce(p_include_practice, false) or coalesce(p_remove_after, false);
  v_practice_to uuid;
  v_transfer    uuid := gen_random_uuid();
  v_bad         record;
  v_n           integer;
  v_moved       jsonb := '{}'::jsonb;
  v_practice_moved jsonb := '{}'::jsonb;
  v_calendar    jsonb := '[]'::jsonb;
  v_group       jsonb := '[]'::jsonb;
  v_supplement  jsonb := '[]'::jsonb;
  v_drive       integer := 0;
  v_cancelled_messages integer := 0;
  v_cancelled_alerts   integer := 0;
  v_carriers    integer := 0;
  v_held        integer := 0;
  v_result      jsonb;
begin
  -- -- Who, and from whom -----------------------------------------------------
  v_firm := private.caseload_transfer_firm(p_from);
  select f.owner_id into v_owner from public.firms f where f.id = v_firm;

  -- The from profile first: a second transfer or a removal of the same
  -- consultant waits here until this one commits.
  select p.full_name into v_from_name from public.profiles p where p.id = p_from for update;
  -- A removal that committed while this call waited for the lock: the consultant is no
  -- longer the firm's to transfer (the released students left with them).
  if not exists (select 1 from public.profiles p where p.id = p_from and p.firm_id = v_firm)
     or not private.crm_firm_member(v_firm, p_from) then
    raise exception 'That consultant isn''t in your firm' using errcode = '42501';
  end if;
  select p.full_name into v_me_name from public.profiles p where p.id = v_me;
  v_from_name := coalesce(nullif(btrim(v_from_name), ''), 'This consultant');

  if (p_all_to is null) = (p_assignments is null) then
    raise exception 'Choose one receiver for everyone, or assign each student' using errcode = '22023';
  end if;
  if v_practice and p_from = v_owner then
    raise exception 'The firm owner''s invitations, imports and pipeline stay with the owner' using errcode = 'P0001';
  end if;

  drop table if exists pg_temp._ct_moves;
  create temp table _ct_moves (
    student_id uuid primary key,
    to_id      uuid not null
  ) on commit drop;

  if p_all_to is not null then
    v_mode := 'one_person';
    perform 1 from public.profiles s
     where s.counselor_id = p_from and s.role = 'student'
     order by s.id
       for update;
    insert into pg_temp._ct_moves (student_id, to_id)
    select s.id, p_all_to from public.profiles s
     where s.counselor_id = p_from and s.role = 'student';
    get diagnostics v_count = row_count;
    if v_count = 0 and not v_practice then
      raise exception '% has no students to transfer', v_from_name using errcode = 'P0001';
    end if;
  else
    v_mode := 'per_student';
    if jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
      raise exception 'Assign at least one student' using errcode = '22023';
    end if;
    if jsonb_array_length(p_assignments) > 500 then
      raise exception 'Transfer at most 500 students at a time' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_assignments) e
                where jsonb_typeof(e) <> 'object'
                   or jsonb_typeof(e -> 'studentId') <> 'string'
                   or jsonb_typeof(e -> 'toId') <> 'string') then
      raise exception 'Each assignment needs a student and a receiver' using errcode = '22023';
    end if;
    insert into pg_temp._ct_moves (student_id, to_id)
    select (e ->> 'studentId')::uuid, (e ->> 'toId')::uuid
      from jsonb_array_elements(p_assignments) e
    on conflict (student_id) do nothing;
    get diagnostics v_count = row_count;
    if v_count <> jsonb_array_length(p_assignments) then
      raise exception 'A student is assigned twice' using errcode = '22023';
    end if;
  end if;

  if v_count > 500 then
    raise exception '% has % students. Transfer at most 500 at a time, assigning each student', v_from_name, v_count
      using errcode = 'P0001';
  end if;

  -- -- Lock the students and check they are still on the from roster ----------
  perform 1 from public.profiles s
   where s.id in (select m.student_id from pg_temp._ct_moves m)
   order by s.id
     for update;
  select count(*) into v_locked
    from public.profiles s join pg_temp._ct_moves m on m.student_id = s.id
   where s.counselor_id = p_from and s.role = 'student';
  if v_locked <> v_count then
    raise exception '% % no longer on %''s caseload. Refresh and try again',
      v_count - v_locked,
      case when v_count - v_locked = 1 then 'student is' else 'students are' end,
      v_from_name
      using errcode = 'P0001';
  end if;

  -- -- Receivers: approved members of this firm (the approval gate) -----------
  perform 1 from public.profiles p
   where p.id in (select distinct m.to_id from pg_temp._ct_moves m)
   order by p.id
     for share;
  if p_all_to = p_from or exists (select 1 from pg_temp._ct_moves m where m.to_id = p_from) then
    raise exception 'Choose someone other than % to receive their students', v_from_name using errcode = '22023';
  end if;
  select m.to_id, coalesce(nullif(btrim(p.full_name), ''), 'That person') as name into v_bad
    from (select distinct to_id from pg_temp._ct_moves
          union select p_all_to where p_all_to is not null) m
    left join public.profiles p on p.id = m.to_id
   where not private.caseload_can_receive(v_firm, m.to_id)
   limit 1;
  if found then
    raise exception '% can''t receive students: only an approved consultant in this firm can', v_bad.name
      using errcode = '42501';
  end if;

  -- -- Practice items: only with the whole caseload ----------------------------
  select count(*) into v_left
    from public.profiles s
   where s.counselor_id = p_from and s.role = 'student'
     and s.id not in (select m.student_id from pg_temp._ct_moves m);
  if v_practice then
    if v_left > 0 then
      raise exception 'Invitations, imports and the pipeline move only with the whole caseload. % student% would stay with %',
        v_left, case when v_left = 1 then '' else 's' end, v_from_name
        using errcode = '22023';
    end if;
    v_practice_to := coalesce(p_practice_to, p_all_to, v_owner);
    perform 1 from public.profiles p where p.id = v_practice_to for share;
    if v_practice_to = p_from then
      raise exception 'Choose someone other than % to take over their invitations and imports', v_from_name
        using errcode = '22023';
    end if;
    if not private.caseload_can_receive(v_firm, v_practice_to) then
      raise exception '% can''t take over invitations and imports: only an approved consultant in this firm can',
        coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.id = v_practice_to), 'That person')
        using errcode = '42501';
    end if;
  elsif p_practice_to is not null then
    raise exception 'A practice receiver is only used when invitations and imports move' using errcode = '22023';
  end if;

  -- -- Imports in flight -------------------------------------------------------
  -- Lock the consultant's imports first (the order request_held_apply and the
  -- job functions use: import, then item), then look at their state.
  perform 1 from public.roster_imports i where i.counselor_id = p_from order by i.id for update;
  if exists (select 1 from public.roster_imports i
              where i.counselor_id = p_from
                and (i.status in ('committing', 'undoing')
                     or (v_practice and i.status in ('profiling', 'staging')))) then
    raise exception 'An import is still saving. Try again in a few minutes.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.import_items it
               join public.roster_imports i on i.id = it.import_id
               join pg_temp._ct_moves m on m.student_id = it.student_id
              where i.counselor_id = p_from and it.match_status = 'applying') then
    raise exception 'Held import data for one of these students is being saved. Try again in a minute.'
      using errcode = 'P0001';
  end if;

  -- =========================================================================
  -- The moves. Order matters where a trigger reads what an earlier step set.
  -- =========================================================================

  -- a) What would have gone out under the old counselor is cancelled, with why.
  update public.student_messages sm
     set status = 'cancelled',
         hold_reason = 'Cancelled: the student moved to another counselor before this went out'
    from pg_temp._ct_moves m
   where sm.student_id = m.student_id and sm.counselor_id = p_from and sm.status = 'scheduled';
  get diagnostics v_cancelled_messages = row_count;

  update public.parent_alerts pa
     set status = 'cancelled', suppressed_reason = 'The student''s counselor changed'
    from pg_temp._ct_moves m
   where pa.student_id = m.student_id and pa.status in ('queued', 'scheduled')
     and (pa.counselor_id is null or pa.counselor_id = p_from);
  get diagnostics v_cancelled_alerts = row_count;

  -- b) The student folder and everything under it (custom subfolders too).
  drop table if exists pg_temp._ct_folders;
  create temp table _ct_folders (
    id      uuid primary key,
    to_id   uuid not null,
    root    uuid not null,
    into_id uuid
  ) on commit drop;
  insert into pg_temp._ct_folders (id, to_id, root)
  with recursive tree as (
    select f.id, m.to_id, f.id as root
      from public.folders f join pg_temp._ct_moves m on m.student_id = f.student_id
     where f.owner_id = p_from and f.kind = 'student'
    union
    select c.id, t.to_id, t.root
      from public.folders c join tree t on c.parent_id = t.id
     where c.owner_id = p_from
  )
  select distinct on (id) id, to_id, root from tree order by id;

  -- The receiver already has a folder for this student: merge into it.
  update pg_temp._ct_folders t
     set into_id = rf.id
    from public.folders bf, public.folders rf
   where t.id = t.root and bf.id = t.root
     and rf.owner_id = t.to_id and rf.kind = 'student' and rf.student_id = bf.student_id;
  update public.folders c set parent_id = t.into_id
    from pg_temp._ct_folders t
   where t.into_id is not null and c.parent_id = t.id;
  update public.documents d set folder_id = t.into_id
    from pg_temp._ct_folders t
   where t.into_id is not null and d.folder_id = t.id;
  update public.document_links l set folder_id = t.into_id
    from pg_temp._ct_folders t
   where t.into_id is not null and l.folder_id = t.id;
  delete from public.folders f using pg_temp._ct_folders t
   where t.into_id is not null and f.id = t.id;
  update public.folders f set owner_id = t.to_id
    from pg_temp._ct_folders t
   where f.id = t.id and t.into_id is null;
  get diagnostics v_n = row_count;
  v_moved := v_moved || jsonb_build_object('folders', v_n);

  -- c) Documents and links about the student, or filed in the moved tree, that
  --    the old counselor owns. A drive pointer reads the old counselor's
  --    drive, which the receiver can't, so it is cleared (the stored copy stays).
  select count(*) into v_drive
    from public.documents d
   where d.owner_id = p_from and d.external_provider is not null
     and (d.student_id in (select m.student_id from pg_temp._ct_moves m)
          or d.folder_id in (select t.id from pg_temp._ct_folders t)
          or d.folder_id in (select t.into_id from pg_temp._ct_folders t where t.into_id is not null));
  update public.documents d
     set owner_id = coalesce(m.to_id, t.to_id),
         external_provider = null, external_file_id = null, external_drive_id = null
    from public.documents d0
    left join pg_temp._ct_moves m on m.student_id = d0.student_id
    left join pg_temp._ct_folders t on t.id = d0.folder_id or t.into_id = d0.folder_id
   where d.id = d0.id and d.owner_id = p_from
     and (m.student_id is not null or t.id is not null);
  get diagnostics v_n = row_count;
  v_moved := v_moved || jsonb_build_object('documents', v_n);

  update public.document_links l
     set owner_id = coalesce(m.to_id, t.to_id)
    from public.document_links l0
    left join pg_temp._ct_moves m on m.student_id = l0.student_id
    left join pg_temp._ct_folders t on t.id = l0.folder_id or t.into_id = l0.folder_id
   where l.id = l0.id and l.owner_id = p_from
     and (m.student_id is not null or t.id is not null);
  get diagnostics v_n = row_count;
  v_moved := v_moved || jsonb_build_object('documentLinks', v_n);

  -- d) The student's accepted invitation(s), before the roster changes: the
  --    intake sync trigger on profiles reads invitations by the new counselor.
  update public.invitations i set counselor_id = m.to_id
    from pg_temp._ct_moves m
   where i.accepted_by = m.student_id and i.counselor_id = p_from;
  get diagnostics v_n = row_count;
  v_moved := v_moved || jsonb_build_object('acceptedInvitations', v_n);

  -- e) The roster itself. Fires profiles_student_folder (a no-op: the folder
  --    moved in b) and profiles_sync_intake_tasks (idempotent).
  update public.profiles s set counselor_id = m.to_id
    from pg_temp._ct_moves m
   where s.id = m.student_id;

  -- f) Meetings: one moves when every attendee goes to the same receiver.
  drop table if exists pg_temp._ct_meetings;
  create temp table _ct_meetings on commit drop as
  with attendees as (
    select a.meeting_id, a.student_id from public.meeting_attendees a
    union
    select mt.id, mt.student_id from public.meetings mt
  )
  select mt.id, mt.title, mt.starts_at, mt.status, mt.calendar_event_id,
         (array_agg(m.to_id) filter (where m.to_id is not null))[1] as to_id,
         bool_and(m.student_id is not null) and count(distinct m.to_id) = 1 as movable
    from public.meetings mt
    join attendees a on a.meeting_id = mt.id
    left join pg_temp._ct_moves m on m.student_id = a.student_id
   where mt.counselor_id = p_from
     and exists (select 1 from attendees a2 join pg_temp._ct_moves m2 on m2.student_id = a2.student_id
                  where a2.meeting_id = mt.id)
   group by mt.id, mt.title, mt.starts_at, mt.status, mt.calendar_event_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'startsAt', c.starts_at, 'toId', c.to_id)
                            order by c.starts_at), '[]'::jsonb)
    into v_calendar
    from pg_temp._ct_meetings c
   where c.movable and c.calendar_event_id is not null and c.starts_at > now() and c.status = 'scheduled';
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'startsAt', c.starts_at)
                            order by c.starts_at), '[]'::jsonb)
    into v_group
    from pg_temp._ct_meetings c
   where not c.movable;

  -- The calendar pointer names an event on the old counselor's calendar; the
  -- receiver's edits must not call it. The join link is kept.
  update public.meetings mt
     set counselor_id = c.to_id, calendar_provider = null, calendar_event_id = null
    from pg_temp._ct_meetings c
   where mt.id = c.id and c.movable;
  get diagnostics v_n = row_count;
  v_moved := v_moved || jsonb_build_object('meetings', v_n);

  -- g) Per-student rows owned by the old counselor, all of them.
  update public.meeting_notes t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('meetingNotes', v_n);

  update public.family_reports t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('familyReports', v_n);

  update public.opportunity_requests t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('opportunityRequests', v_n);

  update public.student_messages t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('messages', v_n);

  update public.research_runs t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('researchRuns', v_n);

  update public.alumni_records t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('alumniRecords', v_n);

  -- Locked (closed-cycle) rows included: the lock guard allows an owner-only change here.
  update public.admission_outcomes t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('admissionOutcomes', v_n);

  update public.library_resource_pins t set counselor_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('resourcePins', v_n);

  -- Supplement Docs: the row moves so it survives the old account; the Doc
  -- itself stays in the old counselor's Drive (listed under attention).
  select coalesce(jsonb_agg(jsonb_build_object('id', sd.id, 'collegeName', sd.college_name,
                                               'title', sd.title, 'studentId', sd.student_id, 'toId', m.to_id)
                            order by sd.college_name), '[]'::jsonb)
    into v_supplement
    from public.supplement_docs sd join pg_temp._ct_moves m on m.student_id = sd.student_id
   where sd.owner_id = p_from;
  update public.supplement_docs t set owner_id = m.to_id
    from pg_temp._ct_moves m where t.student_id = m.student_id and t.owner_id = p_from;

  -- h) Referral asks: the receiver's own open ask wins over a duplicate.
  delete from public.referrals r using pg_temp._ct_moves m
   where r.from_student_id = m.student_id and r.counselor_id = p_from and r.status = 'asked'
     and exists (select 1 from public.referrals x
                  where x.counselor_id = m.to_id and x.from_student_id = m.student_id and x.status = 'asked');
  update public.referrals r set counselor_id = m.to_id
    from pg_temp._ct_moves m where r.from_student_id = m.student_id and r.counselor_id = p_from;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('referrals', v_n);

  -- i) Per-student accountability settings: the receiver's own row wins.
  delete from public.accountability_settings a using pg_temp._ct_moves m
   where a.student_id = m.student_id and a.counselor_id = p_from
     and exists (select 1 from public.accountability_settings x
                  where x.counselor_id = m.to_id and x.student_id = m.student_id);
  update public.accountability_settings a set counselor_id = m.to_id
    from pg_temp._ct_moves m where a.student_id = m.student_id and a.counselor_id = p_from;

  -- j) Calendar entries about the student, today onwards. Event types are per
  --    owner, so the type goes.
  update public.calendar_events e set owner_id = m.to_id, type_id = null
    from pg_temp._ct_moves m
   where e.student_id = m.student_id and e.owner_id = p_from and e.on_date >= current_date;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('calendarEvents', v_n);

  -- k) Open work: My Work Queue items, and Management tasks (a task's subtasks
  --    follow it, so a subtask always belongs to its task's consultant).
  update public.counselor_work_items w set counselor_id = m.to_id
    from pg_temp._ct_moves m
   where w.student_id = m.student_id and w.counselor_id = p_from and not w.done;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('workItems', v_n);

  with parents as (
    update public.consultant_tasks t set assignee_id = m.to_id
      from pg_temp._ct_moves m
     where t.parent_id is null and t.student_id = m.student_id and t.assignee_id = p_from and not t.done
    returning t.id, t.assignee_id
  ), children as (
    update public.consultant_tasks c set assignee_id = parents.assignee_id
      from parents
     where c.parent_id = parents.id and c.assignee_id = p_from
    returning c.id
  )
  select (select count(*) from parents) into v_n;
  v_moved := v_moved || jsonb_build_object('tasks', v_n);

  -- l) Firm pipeline contacts that became these students and that the old
  --    counselor owns. Solo-era rows (firm_id null) are their own workspace.
  update public.pipeline_contacts c set owner_id = m.to_id
    from pg_temp._ct_moves m
   where c.student_id = m.student_id and c.owner_id = p_from and c.firm_id = v_firm;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('pipelineContacts', v_n);

  -- m) The old counselor's pins on these students go; a receiver's collaborator
  --    grant is redundant now that they are the primary.
  delete from public.consultant_student_pins p using pg_temp._ct_moves m
   where p.consultant_id = p_from and p.student_id = m.student_id;
  delete from public.student_collaborators c using pg_temp._ct_moves m
   where c.student_id = m.student_id and c.counselor_id = m.to_id;

  -- n) Held import data follows the student: items waiting in one of the old
  --    counselor's imports move into a carrier import owned by the receiver.
  drop table if exists pg_temp._ct_carriers;
  create temp table _ct_carriers (
    orig    uuid not null,
    to_id   uuid not null,
    carrier uuid not null default gen_random_uuid(),
    primary key (orig, to_id)
  ) on commit drop;
  insert into pg_temp._ct_carriers (orig, to_id)
  select distinct it.import_id, m.to_id
    from public.import_items it
    join pg_temp._ct_moves m on m.student_id = it.student_id
    join public.roster_imports i on i.id = it.import_id
   where i.counselor_id = p_from and it.match_status = 'awaiting_counselor';
  get diagnostics v_carriers = row_count;

  if v_carriers > 0 then
    -- firm_id is stamped by roster_imports_stamp_firm from the receiver.
    insert into public.roster_imports (id, counselor_id, filename, source, status, source_system,
                                       rows_total, committed_at, undo_until, expires_at, completed_at,
                                       permission_confirmed_by, permission_confirmed_at)
    select c.carrier, c.to_id,
           left(i.filename || ' (held data moved from ' || v_from_name || ')', 300),
           i.source, i.status, i.source_system,
           (select count(*) from public.import_items it
              join pg_temp._ct_moves m on m.student_id = it.student_id
             where it.import_id = i.id and it.match_status = 'awaiting_counselor' and m.to_id = c.to_id),
           i.committed_at, i.undo_until, i.expires_at, i.completed_at,
           i.permission_confirmed_by, i.permission_confirmed_at
      from pg_temp._ct_carriers c join public.roster_imports i on i.id = c.orig;

    with moved as (
      update public.import_items it set import_id = c.carrier
        from pg_temp._ct_moves m, pg_temp._ct_carriers c
       where it.student_id = m.student_id and it.match_status = 'awaiting_counselor'
         and c.orig = it.import_id and c.to_id = m.to_id
      returning it.id, it.import_id
    ), changes as (
      update public.import_changes ch set import_id = moved.import_id
        from moved where ch.item_id = moved.id
      returning ch.id
    )
    select (select count(*) from moved) into v_held;
  end if;
  v_moved := v_moved || jsonb_build_object('heldImportItems', v_held, 'carrierImports', v_carriers);

  -- o) Practice items: only with the whole caseload, only when leaving.
  if v_practice then
    update public.invitations i set counselor_id = v_practice_to where i.counselor_id = p_from;
    get diagnostics v_n = row_count; v_practice_moved := v_practice_moved || jsonb_build_object('invitations', v_n);

    -- Templates: on a fingerprint clash the receiver's wins.
    update public.roster_imports i set template_id = rt.id
      from public.import_templates bt
      join public.import_templates rt on rt.counselor_id = v_practice_to and rt.fingerprint = bt.fingerprint
     where bt.counselor_id = p_from and i.template_id = bt.id;
    update public.import_templates rt
       set use_count = rt.use_count + bt.use_count,
           last_used_at = greatest(rt.last_used_at, bt.last_used_at)
      from public.import_templates bt
     where bt.counselor_id = p_from and rt.counselor_id = v_practice_to and rt.fingerprint = bt.fingerprint;
    delete from public.import_templates bt
     where bt.counselor_id = p_from
       and exists (select 1 from public.import_templates rt
                    where rt.counselor_id = v_practice_to and rt.fingerprint = bt.fingerprint);
    update public.import_templates t set counselor_id = v_practice_to where t.counselor_id = p_from;
    get diagnostics v_n = row_count; v_practice_moved := v_practice_moved || jsonb_build_object('templates', v_n);

    -- Imports, solo-era ones included, now belong to this firm.
    update public.roster_imports i set counselor_id = v_practice_to, firm_id = v_firm
     where i.counselor_id = p_from;
    get diagnostics v_n = row_count; v_practice_moved := v_practice_moved || jsonb_build_object('imports', v_n);
    update public.import_files f set counselor_id = v_practice_to where f.counselor_id = p_from;
    update public.roster_import_rows r set counselor_id = v_practice_to where r.counselor_id = p_from;

    update public.pipeline_stages s set counselor_id = v_practice_to
     where s.firm_id = v_firm and s.counselor_id = p_from;
    get diagnostics v_n = row_count; v_practice_moved := v_practice_moved || jsonb_build_object('pipelineStages', v_n);
    update public.pipeline_contacts c
       set counselor_id = case when c.counselor_id = p_from then v_practice_to else c.counselor_id end,
           owner_id = case when c.owner_id = p_from then v_practice_to else c.owner_id end
     where c.firm_id = v_firm and (c.counselor_id = p_from or c.owner_id = p_from);
    get diagnostics v_n = row_count; v_practice_moved := v_practice_moved || jsonb_build_object('pipelineContacts', v_n);

    update public.library_resources r set counselor_id = v_practice_to
     where r.firm_id = v_firm and r.counselor_id = p_from;
    get diagnostics v_n = row_count; v_practice_moved := v_practice_moved || jsonb_build_object('libraryResources', v_n);

    update public.admission_outcomes o set counselor_id = v_practice_to
     where o.counselor_id = p_from and o.firm_id = v_firm;
    get diagnostics v_n = row_count; v_practice_moved := v_practice_moved || jsonb_build_object('admissionOutcomes', v_n);

    update public.practice_settings ps set caseload_default_receiver = null
     where ps.firm_id = v_firm and ps.caseload_default_receiver = p_from;
  end if;

  -- -- The record --------------------------------------------------------------
  insert into public.caseload_transfers (id, firm_id, from_counselor_id, from_name, requested_by,
                                         requested_by_name, mode, practice_to, practice_items_moved,
                                         member_removed, student_count, summary)
  values (v_transfer, v_firm, p_from, left(v_from_name, 200), v_me, left(v_me_name, 200), v_mode,
          v_practice_to, v_practice, coalesce(p_remove_after, false), v_count,
          jsonb_build_object('moved', v_moved, 'practice', v_practice_moved,
                             'cancelledMessages', v_cancelled_messages,
                             'cancelledAlerts', v_cancelled_alerts,
                             'calendarMeetings', jsonb_array_length(v_calendar),
                             'groupMeetings', jsonb_array_length(v_group),
                             'supplementDocs', jsonb_array_length(v_supplement),
                             'driveLinkedDocuments', v_drive));

  insert into public.caseload_transfer_students (transfer_id, student_id, student_name, to_counselor_id, to_name)
  select v_transfer, m.student_id, left(s.full_name, 200), m.to_id, left(r.full_name, 200)
    from pg_temp._ct_moves m
    join public.profiles s on s.id = m.student_id
    join public.profiles r on r.id = m.to_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (v_me, 'caseload.transferred', 'profile', p_from,
          jsonb_build_object('transfer_id', v_transfer, 'firm_id', v_firm, 'mode', v_mode,
                             'students', v_count, 'practice_items_moved', v_practice,
                             'practice_to', v_practice_to, 'member_removed', coalesce(p_remove_after, false),
                             'moved', v_moved, 'practice', v_practice_moved));
  insert into public.audit_log (actor_id, student_id, action, entity_type, entity_id, metadata)
  select v_me, m.student_id, 'caseload.student_transferred', 'profile', m.student_id,
         jsonb_build_object('transfer_id', v_transfer, 'from', p_from, 'to', m.to_id)
    from pg_temp._ct_moves m;

  -- In-app notice to each receiver (the email is the API's, after commit).
  insert into public.notifications (recipient_id, kind, urgency, title, href, created_by)
  select r.to_id, 'system', 'normal',
         left(case when r.n = 1 then format('1 student from %s is now yours', v_from_name)
                   else format('%s students from %s are now yours', r.n, v_from_name) end, 300),
         '/dashboard/counselor', v_me
    from (select m.to_id, count(*) as n from pg_temp._ct_moves m group by m.to_id) r;
  if v_practice and v_practice_to is not null then
    insert into public.notifications (recipient_id, kind, urgency, title, href, created_by)
    values (v_practice_to, 'system', 'normal',
            left(format('%s''s invitations, imports and pipeline are now yours', v_from_name), 300),
            '/dashboard/counselor', v_me);
  end if;

  -- -- Transfer and remove: in this same transaction -------------------------
  if coalesce(p_remove_after, false) then
    perform public.remove_firm_member(p_from);
  end if;

  select jsonb_build_object(
    'transferId', v_transfer,
    'mode', v_mode,
    'studentCount', v_count,
    'from', jsonb_build_object('id', p_from, 'name', v_from_name),
    'firmId', v_firm,
    'practiceTo', v_practice_to,
    'practiceItemsMoved', v_practice,
    'removed', coalesce(p_remove_after, false),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.student_id, 'name', s.full_name, 'toId', m.to_id,
               'archived', s.archived_at is not null,
               'alumni', exists (select 1 from public.alumni_records ar where ar.student_id = m.student_id))
             order by s.full_name, m.student_id)
        from pg_temp._ct_moves m join public.profiles s on s.id = m.student_id), '[]'::jsonb),
    'receivers', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.to_id, 'name', p.full_name, 'count', r.n) order by p.full_name)
        from (select m.to_id, count(*) as n from pg_temp._ct_moves m group by m.to_id) r
        join public.profiles p on p.id = r.to_id), '[]'::jsonb),
    'moved', v_moved,
    'practice', v_practice_moved,
    'attention', jsonb_build_object(
      'calendarMeetings', v_calendar,
      'groupMeetings', v_group,
      'supplementDocs', v_supplement,
      'driveLinkedDocuments', v_drive,
      'cancelledMessages', v_cancelled_messages,
      'cancelledAlerts', v_cancelled_alerts)
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.transfer_caseload(uuid, uuid, jsonb, uuid, boolean, boolean) from public, anon;
grant execute on function public.transfer_caseload(uuid, uuid, jsonb, uuid, boolean, boolean) to authenticated;

comment on function public.transfer_caseload(uuid, uuid, jsonb, uuid, boolean, boolean) is
  'Move a consultant''s students (and their record) to other approved consultants in the firm, all or nothing. '
  'Firm owner/admin only. Returns ids and names, never an email address.';
