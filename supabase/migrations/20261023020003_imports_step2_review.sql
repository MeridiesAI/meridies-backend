-- Import pipeline, step 2: what the browser may ask for (start, review
-- decisions, commit with the invitation count, invitation sends), the review
-- reads, and the always-on retention the sweep runs (§5.10, §7.6).
-- Client functions check auth.uid() and private.can_manage_import (which asks
-- the approval gate) and lock the import FOR UPDATE.

-- ---------------------------------------------------------------------------
-- Start (§5.1): the family-permission checkbox is part of the request.
-- ---------------------------------------------------------------------------

create or replace function public.start_import(p_permission boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.is_counselor(v_me) then
    raise exception 'Only an approved counselor can import' using errcode = '42501';
  end if;
  if p_permission is not true then
    raise exception 'Confirm you have the family''s permission to upload this information' using errcode = '22023';
  end if;
  if (select count(*) from public.roster_imports
       where counselor_id = v_me and permission_confirmed_at is not null
         and status in ('draft','mapping','staging','review')) >= 20 then
    raise exception 'You have 20 imports in progress. Finish or discard one first.' using errcode = 'P0001';
  end if;
  insert into public.roster_imports (counselor_id, filename, source, status, permission_confirmed_by,
                                     permission_confirmed_at, expires_at)
  values (v_me, 'Import', 'csv', 'draft', v_me, now(), now() + interval '7 days')
  returning * into v;
  return jsonb_build_object('id', v.id, 'status', v.status, 'expiresAt', v.expires_at);
end;
$$;

-- "Continue without <file>". Before matching only; the plan forgets the file.
create or replace function public.import_exclude_file(p_import uuid, p_file uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  v_types text[];
begin
  v := private.import_v2_lock(p_import, (select auth.uid()), array['draft','mapping']);
  update public.import_files set status = 'excluded'
   where id = p_file and import_id = p_import and status <> 'excluded';
  if not found then
    raise exception 'That file isn''t in this import' using errcode = 'P0002';
  end if;
  select array_agg(distinct detected_type) into v_types
  from public.import_files where import_id = p_import and status = 'profiled';
  update public.roster_imports
     set source = case when v_types is null then source
                       when cardinality(v_types) > 1 then 'mixed'
                       when v_types[1] = 'xlsx' then 'xlsx' else 'csv' end,
         plan = case when plan is null then null
                     else jsonb_set(plan, '{sheets}', coalesce((
                       select jsonb_agg(s) from jsonb_array_elements(plan -> 'sheets') s
                       where s ->> 'fileId' is distinct from p_file::text), '[]'::jsonb)) end
   where id = p_import;
end;
$$;

-- ---------------------------------------------------------------------------
-- Review decisions (§5.6), one transaction:
-- { fixes: { changeId: value }, items: { itemId: { action, studentId? } },
--   changes: { changeId: accept|keep_old|reject }, patterns: { key: accept|keep_old } }
-- Returns the refreshed counts.
-- ---------------------------------------------------------------------------

create or replace function public.import_review_update(p_import uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
  k text;
  a jsonb;
  ch public.import_changes;
  it public.import_items;
  v_student uuid;
  v_email text;
  v_present integer := 0;
  v_n integer;
  v_dec text;
  v_stats jsonb;
begin
  v := private.import_v2_lock(p_import, v_me, array['review']);
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'Nothing to change' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_body -> 'fixes'), 'object') <> 'object'
     or coalesce(jsonb_typeof(p_body -> 'items'), 'object') <> 'object'
     or coalesce(jsonb_typeof(p_body -> 'changes'), 'object') <> 'object'
     or coalesce(jsonb_typeof(p_body -> 'patterns'), 'object') <> 'object' then
    raise exception 'That request isn''t valid' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(coalesce(p_body -> 'fixes', '{}'))) > 200
     or (select count(*) from jsonb_object_keys(coalesce(p_body -> 'items', '{}'))) > 500
     or (select count(*) from jsonb_object_keys(coalesce(p_body -> 'changes', '{}'))) > 500
     or (select count(*) from jsonb_object_keys(coalesce(p_body -> 'patterns', '{}'))) > 100 then
    raise exception 'Too many decisions at once' using errcode = '22023';
  end if;

  -- 1. Manual fixes for cells that failed validation or conflict in the file.
  --    The validation trigger checks the value (23514 when it doesn't fit).
  for k, a in select * from jsonb_each(coalesce(p_body -> 'fixes', '{}')) loop
    select c.* into ch from public.import_changes c
     where c.id = k::uuid and c.import_id = p_import
     for update;
    if not found then
      raise exception 'That value isn''t in this import' using errcode = 'P0002';
    end if;
    select i.* into it from public.import_items i where i.id = ch.item_id;
    if it.match_status in ('skipped','expired') and not ('shared_email' = any (it.flags)) then
      raise exception 'That row was skipped' using errcode = '55000';
    end if;
    if ch.state <> 'skipped_invalid' and not (ch.state = 'staged' and 'conflict_in_file' = any (ch.flags)) then
      raise exception 'Only a value that needs a fix can be changed here' using errcode = '55000';
    end if;
    update public.import_changes
       set new_value = a, state = 'staged', error = null, decision = 'accept',
           flags = array_remove(flags, 'conflict_in_file'),
           old_value = case when op = 'set_field' and it.match_status in ('matched_email','confirmed')
                            then private.import_current_value(target_table, field, it.student_id) end
     where id = ch.id;
    update public.import_changes c
       set old_source = case when c.op = 'insert_row' then null
                             when private.import_absent(c.old_value) then 'empty' else 'student' end,
           risk = private.import_risk(f.sensitivity,
                    case when private.import_absent(c.old_value) then 'empty' else 'student' end,
                    f.value_type, c.old_value, c.new_value, it.match_confidence)
      from public.import_fields f
     where c.id = ch.id and f.target_table = c.target_table and f.field = c.field;
  end loop;

  -- 2. Suggested matches: confirm one candidate, skip, or invite instead.
  for k, a in select * from jsonb_each(coalesce(p_body -> 'items', '{}')) loop
    select i.* into it from public.import_items i
     where i.id = k::uuid and i.import_id = p_import
     for update;
    if not found then
      raise exception 'That row isn''t in this import' using errcode = 'P0002';
    end if;
    if a ->> 'action' = 'confirm' then
      begin
        v_student := (a ->> 'studentId')::uuid;
      exception when others then
        raise exception 'Pick a student to confirm' using errcode = '22023';
      end;
      if it.match_status <> 'suggested' then
        raise exception 'Only a suggested match can be confirmed' using errcode = '55000';
      end if;
      if not exists (select 1 from jsonb_array_elements(it.candidates) c where c ->> 'id' = v_student::text)
         or not private.import_student_allowed(p_import, v_student, v.counselor_id, v_me) then
        raise exception 'That student isn''t one of the suggestions' using errcode = '42501';
      end if;
      if exists (select 1 from public.import_items o
                  where o.import_id = p_import and o.id <> it.id and o.student_id = v_student
                    and o.match_status in ('matched_email','confirmed')) then
        raise exception 'Another row in this import is already matched to that student' using errcode = '55000';
      end if;
      update public.import_items
         set match_status = 'confirmed', student_id = v_student, skip_reason = null
       where id = it.id;
      v_present := v_present + private.import_assess(p_import, it.id);
    elsif a ->> 'action' = 'skip' then
      if it.match_status not in ('matched_email','confirmed','suggested','new_invite') then
        raise exception 'That row can''t be skipped now' using errcode = '55000';
      end if;
      update public.import_items
         set match_status = 'skipped', student_id = null, skip_reason = 'Skipped by you'
       where id = it.id;
    elsif a ->> 'action' = 'invite' then
      v_email := lower(btrim(it.match_key ->> 'email'));
      if it.match_status not in ('suggested','skipped') or coalesce(v_email, '') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        raise exception 'Only a row with an email address can be invited' using errcode = '55000';
      end if;
      if it.match_status = 'skipped' and it.skip_reason is distinct from 'Skipped by you'
         and not ('shared_email' = any (it.flags)) then
        raise exception 'That row can''t be invited' using errcode = '55000';
      end if;
      if exists (select 1 from public.import_items o
                  where o.import_id = p_import and o.id <> it.id and o.match_status = 'new_invite'
                    and lower(o.match_key ->> 'email') = v_email) then
        raise exception 'Another row in this import is already being invited at that address' using errcode = '55000';
      end if;
      if exists (select 1 from public.profiles s
                  where lower(s.email) = v_email and s.role = 'student'
                    and private.can_edit_student(s.id, v.counselor_id)) then
        raise exception 'That email belongs to a student on your roster' using errcode = '55000';
      end if;
      update public.import_items
         set match_status = 'new_invite', student_id = null, skip_reason = null, invite_state = 'unsent'
       where id = it.id;
      update public.import_changes
         set old_value = null, old_source = null, decision = 'accept'
       where item_id = it.id and state = 'staged';
    else
      raise exception 'Unknown action' using errcode = '22023';
    end if;
  end loop;

  -- 3. One change at a time. Accepting a conflicting value picks it.
  for k, a in select * from jsonb_each(coalesce(p_body -> 'changes', '{}')) loop
    v_dec := a #>> '{}';
    if v_dec not in ('accept','keep_old','reject') then
      raise exception 'Unknown decision' using errcode = '22023';
    end if;
    update public.import_changes c
       set decision = v_dec,
           flags = case when v_dec = 'accept' then array_remove(c.flags, 'conflict_in_file') else c.flags end
      from public.import_items i
     where c.id = k::uuid and c.import_id = p_import and c.state = 'staged'
       and i.id = c.item_id and i.match_status not in ('skipped','expired');
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'That value isn''t waiting for a decision' using errcode = 'P0002';
    end if;
  end loop;

  -- 4. A whole column at once ("GPA differs for 31 students"), on matched
  --    rows only. Fills stay fills; conflicts and possible duplicates are
  --    decided one by one.
  for k, a in select * from jsonb_each(coalesce(p_body -> 'patterns', '{}')) loop
    v_dec := a #>> '{}';
    if v_dec not in ('accept','keep_old') then
      raise exception 'Unknown decision' using errcode = '22023';
    end if;
    update public.import_changes c
       set decision = v_dec
      from public.import_items i
     where c.import_id = p_import and c.pattern_key = k and c.state = 'staged'
       and c.decision <> 'auto'
       and not ('conflict_in_file' = any (c.flags)) and not ('possible_duplicate' = any (c.flags))
       and i.id = c.item_id and i.match_status in ('matched_email','confirmed');
  end loop;

  v_stats := coalesce(v.stats, '{}'::jsonb) || private.import_stats(p_import)
             || jsonb_build_object('alreadyPresent', coalesce((v.stats ->> 'alreadyPresent')::integer, 0) + v_present);
  update public.roster_imports set stats = v_stats where id = p_import;
  return v_stats;
end;
$$;

-- Throw away a draft or an import in review: its staged values go now, its
-- files with the next sweep.
create or replace function public.discard_import(p_import uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.import_v2_lock(p_import, (select auth.uid()), array['draft','mapping','review']);
  delete from public.import_items where import_id = p_import;
  update public.import_files set profile = null where import_id = p_import;
  update public.roster_imports
     set status = 'expired', expires_at = now(), stats = null, plan = null, job_error = null
   where id = p_import;
end;
$$;

create or replace function public.delete_import_template(p_template uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not private.is_counselor(v_me) then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from public.import_templates where id = p_template and counselor_id = v_me;
  if not found then
    raise exception 'That layout isn''t yours' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commit (§5.7), now with the invitation count. The body is unchanged for an
-- import that invites nobody, so step 1's callers keep working; for one that
-- invites, the count the counselor confirmed must equal what is staged, read
-- under the same lock. A counselor's first import over 50 invitations saves
-- its data but holds the invitations for a Meridies check (§5.1).
-- ---------------------------------------------------------------------------

drop function if exists public.request_import_commit(uuid);
create or replace function public.request_import_commit(p_import uuid, p_invitations integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
  v_invites integer := 0;
  v_hold boolean := false;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import for update;
  if v.status in ('committing','undoing') then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v.status <> 'review' then
    raise exception 'Only an import in review can be saved' using errcode = '55000';
  end if;
  select count(*) into v_invites
  from public.import_items where import_id = p_import and match_status = 'new_invite';
  if (v_invites > 0 or p_invitations is not null) and p_invitations is distinct from v_invites then
    raise exception 'Confirm the % invitations this import will send', v_invites using errcode = 'MI001';
  end if;
  if v.permission_confirmed_at is not null and v_invites > 50 and v.invites_approved_at is null
     and not exists (select 1 from public.roster_imports o
                      where o.counselor_id = v.counselor_id and o.id <> p_import
                        and o.permission_confirmed_at is not null and o.committed_at is not null) then
    v_hold := true;
  end if;
  update public.roster_imports
     set status = 'committing', job_actor = v_me, job_requested_at = now(), job_error = null,
         invites_held_reason = case when v_hold then 'first-import-review' else invites_held_reason end
   where id = p_import;
end;
$$;
revoke all on function public.request_import_commit(uuid, integer) from public, anon;
grant execute on function public.request_import_commit(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Invitations after commit (§5.7): claimed, linked before the email goes out,
-- then recorded. Only the uploader sends: accepting makes the inviter the
-- student's counselor, so a firm admin's click must not send in their name.
-- ---------------------------------------------------------------------------

create or replace function public.import_claim_invites(p_import uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
  v_items jsonb;
  v_left integer;
begin
  if v_me is null or not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import for update;
  if v.permission_confirmed_at is null then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  if v.counselor_id <> v_me then
    raise exception 'Invitations go out in the name of the counselor who uploaded this import' using errcode = 'MI002';
  end if;
  if v.status <> 'committed' then
    raise exception 'Invitations go out after the import is saved' using errcode = '55000';
  end if;
  if v.invites_held_reason is not null and v.invites_approved_at is null then
    return jsonb_build_object('held', true, 'items', '[]'::jsonb, 'remaining',
      (select count(*) from public.import_items
        where import_id = p_import and match_status = 'new_invite' and invite_state in ('unsent','failed')));
  end if;

  with c as (
    select it.id
    from public.import_items it
    where it.import_id = p_import and it.match_status = 'new_invite'
      and (it.invite_state in ('unsent','failed')
           or (it.invite_state = 'sending' and it.invite_claimed_at < now() - interval '10 minutes'))
    order by it.created_at, it.id
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  ), u as (
    update public.import_items it
       set invite_state = 'sending', invite_claimed_at = now()
      from c
     where c.id = it.id
    returning it.id, it.match_key, it.imported_name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', u.id,
           'email', lower(btrim(u.match_key ->> 'email')),
           'name', u.imported_name,
           'gradYear', case when u.match_key ->> 'gradYear' ~ '^\d{4}$' then (u.match_key ->> 'gradYear')::integer end)), '[]'::jsonb)
    into v_items
    from u;

  select count(*) into v_left from public.import_items
   where import_id = p_import and match_status = 'new_invite' and invite_state in ('unsent','failed');
  return jsonb_build_object('held', false, 'items', v_items, 'remaining', v_left);
end;
$$;

-- The invitation row exists; tie the item to it before any email is sent, so
-- a quick acceptance always finds the held data.
create or replace function public.import_link_invitation(p_item uuid, p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  it public.import_items;
  v public.roster_imports;
begin
  select * into it from public.import_items where id = p_item for update;
  if not found then
    raise exception 'That invitation isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = it.import_id;
  if v_me is null or v.counselor_id <> v_me or v.permission_confirmed_at is null
     or not private.can_manage_import(v.id, v_me) then
    raise exception 'That invitation isn''t yours' using errcode = '42501';
  end if;
  if it.match_status <> 'new_invite' or it.invite_state <> 'sending' or v.status <> 'committed' then
    raise exception 'This invitation is no longer waiting to be sent' using errcode = '55000';
  end if;
  if not exists (select 1 from public.invitations i
                  where i.id = p_invitation and i.counselor_id = v_me and i.status = 'pending'
                    and lower(i.email) = lower(btrim(it.match_key ->> 'email'))) then
    raise exception 'That invitation isn''t yours' using errcode = '42501';
  end if;
  update public.import_items set invitation_id = p_invitation where id = p_item;
end;
$$;

create or replace function public.import_finish_invite(p_item uuid, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  update public.import_items it
     set invite_state = case when p_ok and it.invitation_id is not null then 'sent' else 'failed' end,
         invite_claimed_at = null
    from public.roster_imports i
   where it.id = p_item and i.id = it.import_id and i.counselor_id = v_me
     and i.permission_confirmed_at is not null and it.invite_state = 'sending';
end;
$$;

-- ---------------------------------------------------------------------------
-- Review reads. Definer functions that return student data, so each asks
-- can_view_import (and through it the approval gate) first.
-- ---------------------------------------------------------------------------

create or replace function public.import_review_groups(p_import uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_view_import(p_import, (select auth.uid())) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(q.g order by q.mr desc, q.n desc), '[]'::jsonb)
    from (
      select max(ch.risk) as mr, count(*) as n,
             jsonb_build_object(
               'patternKey', ch.pattern_key,
               'table', min(ch.target_table),
               'field', min(ch.field),
               'column', min(ch.source_column),
               'count', count(*),
               'decisions', jsonb_build_object(
                  'auto', count(*) filter (where ch.decision = 'auto'),
                  'accept', count(*) filter (where ch.decision = 'accept'),
                  'keep_old', count(*) filter (where ch.decision = 'keep_old'),
                  'reject', count(*) filter (where ch.decision = 'reject')),
               'maxRisk', max(ch.risk)) as g
      from public.import_changes ch
      join public.import_items it on it.id = ch.item_id
      where ch.import_id = p_import and ch.state = 'staged' and ch.pattern_key is not null
        and it.match_status in ('matched_email','confirmed')
      group by ch.pattern_key
      order by max(ch.risk) desc, count(*) desc
      limit 500
    ) q
  );
end;
$$;

-- One page of rows for a review tab, riskiest first.
create or replace function public.import_review_page(p_import uuid, p_section text, p_offset integer, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_items jsonb;
begin
  if not private.can_view_import(p_import, (select auth.uid())) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  if p_section not in ('changes','suggested','invites','skipped','problems') then
    raise exception 'Unknown section' using errcode = '22023';
  end if;

  with pick as (
    select it.*,
           coalesce((select max(c.risk) from public.import_changes c
                      where c.item_id = it.id and c.state in ('staged','skipped_invalid')
                        and c.decision <> 'auto'), 0) as max_risk
    from public.import_items it
    where it.import_id = p_import
      and case p_section
        when 'changes' then it.match_status in ('matched_email','confirmed')
                            and exists (select 1 from public.import_changes c where c.item_id = it.id and c.state = 'staged')
        when 'suggested' then it.match_status = 'suggested'
        when 'invites' then it.match_status = 'new_invite'
        when 'skipped' then it.match_status = 'skipped'
        when 'problems' then it.match_status not in ('skipped','expired')
                             and exists (select 1 from public.import_changes c
                                          where c.item_id = it.id
                                            and (c.state = 'skipped_invalid'
                                                 or (c.state = 'staged' and 'conflict_in_file' = any (c.flags))))
      end
  ), counted as (
    select count(*) as n from pick
  ), page as (
    select * from pick
    order by max_risk desc, imported_name nulls last, id
    offset v_offset limit v_limit
  )
  select (select n from counted),
         coalesce(jsonb_agg(jsonb_build_object(
           'itemId', page.id,
           'importedName', page.imported_name,
           'email', page.match_key ->> 'email',
           'matchStatus', page.match_status,
           'confidence', page.match_confidence,
           'reasons', to_jsonb(page.match_reasons),
           'flags', to_jsonb(page.flags),
           'skipReason', page.skip_reason,
           'inviteState', page.invite_state,
           'sourceRef', page.locator ->> 'sourceRef',
           'student', case when page.student_id is null then null
                           else jsonb_build_object('id', page.student_id,
                                  'name', (select p.full_name from public.profiles p where p.id = page.student_id)) end,
           'candidates', coalesce((select jsonb_agg(jsonb_build_object(
                                     'id', c ->> 'id',
                                     'name', (select p.full_name from public.profiles p where p.id::text = c ->> 'id'),
                                     'why', c ->> 'why'))
                                   from jsonb_array_elements(page.candidates) c), '[]'::jsonb),
           'maxRisk', page.max_risk,
           'changes', coalesce((select jsonb_agg(jsonb_build_object(
                                   'id', c.id, 'table', c.target_table, 'field', c.field, 'op', c.op,
                                   'oldValue', c.old_value, 'newValue', c.new_value, 'oldSource', c.old_source,
                                   'decision', c.decision, 'risk', c.risk, 'state', c.state,
                                   'sourceRef', c.source_ref, 'sourceColumn', c.source_column,
                                   'patternKey', c.pattern_key, 'flags', to_jsonb(c.flags),
                                   'alternatives', c.alternatives, 'error', c.error)
                                 order by c.risk desc, c.target_table, c.field)
                               from (select * from public.import_changes c
                                      where c.item_id = page.id and c.state in ('staged','skipped_invalid')
                                      order by c.risk desc limit 100) c), '[]'::jsonb)
         ) order by page.max_risk desc, page.imported_name nulls last, page.id), '[]'::jsonb)
    into v_total, v_items
    from page;

  return jsonb_build_object('items', v_items, 'total', coalesce(v_total, 0),
    'nextOffset', case when v_offset + v_limit < coalesce(v_total, 0) then v_offset + v_limit end);
end;
$$;

-- Invitation counts per import, for history ("3 invitations not sent").
create or replace function public.import_invite_counts(p_imports uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(q.import_id, q.counts), '{}'::jsonb)
  from (
    select it.import_id, jsonb_build_object(
             'toSend', count(*) filter (where it.invite_state in ('unsent','failed') and it.match_status = 'new_invite'),
             'sending', count(*) filter (where it.invite_state = 'sending' and it.match_status = 'new_invite'),
             'sent', count(*) filter (where it.invite_state = 'sent'),
             'failed', count(*) filter (where it.invite_state = 'failed' and it.match_status = 'new_invite'),
             'joined', count(*) filter (where it.match_status in ('awaiting_counselor','applying','applied'))) as counts
    from public.import_items it
    where it.import_id = any (p_imports[1:100])
      and private.can_view_import(it.import_id, (select auth.uid()))
      and (it.invitation_id is not null or it.match_status = 'new_invite')
    group by it.import_id
  ) q;
$$;

-- ---------------------------------------------------------------------------
-- Retention (§5.10, §7.6), run by the sweep on every pass. Not behind
-- IMPORT_HOLD_EXPIRY_ENABLED: that flag holds back only the 30-day expiry of
-- accepted, waiting data and its warning emails.
-- ---------------------------------------------------------------------------

create or replace function public.import_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drafts integer := 0;
  v_stuck integer := 0;
  v_unsent integer := 0;
  v_unaccepted integer := 0;
  v_profiles integer := 0;
begin
  -- Drafts and reviews never saved: expired after 7 days, staged values gone.
  with gone as (
    update public.roster_imports
       set status = 'expired', stats = null, plan = null,
           job_error = jsonb_build_object('message', 'This import expired before it was saved')
     where permission_confirmed_at is not null
       and status in ('draft','mapping','review') and expires_at < now()
    returning id
  ), del as (
    delete from public.import_items it using gone where it.import_id = gone.id returning 1
  )
  select count(*) into v_drafts from gone;

  update public.roster_imports
     set status = 'mapping', job_error = jsonb_build_object('message', 'Matching didn''t finish. Try again.')
   where permission_confirmed_at is not null and status = 'staging'
     and coalesce(job_requested_at, 'epoch'::timestamptz) < now() - interval '10 minutes';
  get diagnostics v_stuck = row_count;

  -- Invitations never sent: held data goes 14 days after the save.
  with gone as (
    update public.import_items it
       set match_status = 'expired', skip_reason = 'The invitation was never sent', invite_claimed_at = null
      from public.roster_imports i
     where i.id = it.import_id and i.permission_confirmed_at is not null
       and it.match_status = 'new_invite' and it.invitation_id is null
       and i.committed_at < now() - interval '14 days'
    returning it.id
  ), del as (
    delete from public.import_changes ch using gone where ch.item_id = gone.id and ch.state = 'staged' returning 1
  )
  select count(*) into v_unsent from gone;

  -- Sent but never accepted: the data goes when the invitation does (§5.8),
  -- unless a newer invitation to the same address is still open.
  with gone as (
    update public.import_items it
       set match_status = 'expired', skip_reason = 'The invitation expired before it was accepted'
      from public.invitations i, public.roster_imports ri
     where it.invitation_id = i.id and ri.id = it.import_id and ri.permission_confirmed_at is not null
       and it.match_status = 'new_invite'
       and (i.status = 'revoked' or (i.status = 'pending' and i.expires_at < now()))
       and not exists (
         select 1 from public.invitations o
          where o.counselor_id = i.counselor_id and lower(o.email) = lower(i.email)
            and o.status = 'pending' and o.expires_at >= now())
    returning it.id
  ), del as (
    delete from public.import_changes ch using gone where ch.item_id = gone.id and ch.state = 'staged' returning 1
  )
  select count(*) into v_unaccepted from gone;

  -- Masked samples live until commit.
  update public.import_files f
     set profile = null
    from public.roster_imports i
   where i.id = f.import_id and f.profile is not null and i.permission_confirmed_at is not null
     and i.status in ('committed','undoing','undone','expired');
  get diagnostics v_profiles = row_count;

  return jsonb_build_object('expiredDrafts', v_drafts, 'stuckStaging', v_stuck, 'unsentExpired', v_unsent,
                            'unacceptedExpired', v_unaccepted, 'profilesWiped', v_profiles);
end;
$$;

-- Raw files go once an import is saved, undone or expired (≤ 7 days, §7.6).
create or replace function public.import_files_to_delete(p_limit integer)
returns table (file_id uuid, storage_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.storage_path
  from public.import_files f
  join public.roster_imports i on i.id = f.import_id
  where f.deleted_at is null and i.status in ('committed','undoing','undone','expired')
  order by f.created_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

create or replace function public.import_mark_files_deleted(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.import_files set deleted_at = now(), profile = null
   where id = any (p_ids) and deleted_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Objects in the bucket with no live file row after 24 hours: an upload that
-- was never registered, or a removal that failed (§5.10). The backend
-- removes them through the Storage API, never by deleting rows here.
create or replace function public.import_orphan_objects(p_limit integer)
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'imports'
    and o.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.import_files f where f.storage_path = o.name and f.deleted_at is null)
  order by o.created_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.start_import(boolean) from public, anon;
revoke all on function public.import_exclude_file(uuid, uuid) from public, anon;
revoke all on function public.import_review_update(uuid, jsonb) from public, anon;
revoke all on function public.discard_import(uuid) from public, anon;
revoke all on function public.delete_import_template(uuid) from public, anon;
revoke all on function public.import_claim_invites(uuid, integer) from public, anon;
revoke all on function public.import_link_invitation(uuid, uuid) from public, anon;
revoke all on function public.import_finish_invite(uuid, boolean) from public, anon;
revoke all on function public.import_review_groups(uuid) from public, anon;
revoke all on function public.import_review_page(uuid, text, integer, integer) from public, anon;
revoke all on function public.import_invite_counts(uuid[]) from public, anon;
grant execute on function public.start_import(boolean) to authenticated;
grant execute on function public.import_exclude_file(uuid, uuid) to authenticated;
grant execute on function public.import_review_update(uuid, jsonb) to authenticated;
grant execute on function public.discard_import(uuid) to authenticated;
grant execute on function public.delete_import_template(uuid) to authenticated;
grant execute on function public.import_claim_invites(uuid, integer) to authenticated;
grant execute on function public.import_link_invitation(uuid, uuid) to authenticated;
grant execute on function public.import_finish_invite(uuid, boolean) to authenticated;
grant execute on function public.import_review_groups(uuid) to authenticated;
grant execute on function public.import_review_page(uuid, text, integer, integer) to authenticated;
grant execute on function public.import_invite_counts(uuid[]) to authenticated;

revoke all on function public.import_retention() from public, anon, authenticated;
revoke all on function public.import_files_to_delete(integer) from public, anon, authenticated;
revoke all on function public.import_mark_files_deleted(uuid[]) from public, anon, authenticated;
revoke all on function public.import_orphan_objects(integer) from public, anon, authenticated;
grant execute on function public.import_retention() to import_worker, service_role;
grant execute on function public.import_files_to_delete(integer) to import_worker, service_role;
grant execute on function public.import_mark_files_deleted(uuid[]) to import_worker, service_role;
grant execute on function public.import_orphan_objects(integer) to import_worker, service_role;

-- ---------------------------------------------------------------------------
-- Last object in the step-2 migrations: the API's readiness probe
-- (lib/imports/availability.ts) asks for this, so a database with only the
-- first file or two applied answers "not ready" instead of failing per call.
-- ---------------------------------------------------------------------------

create or replace function public.imports_step2_ready()
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;
revoke all on function public.imports_step2_ready() from public, anon;
grant execute on function public.imports_step2_ready() to authenticated, import_worker, service_role;
