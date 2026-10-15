-- Caseload transfer, step 3: removing a firm member who still has students is
-- refused until they are transferred, or an owner/admin releases them.
-- Spec: docs/superpowers/specs/2026-10-15-caseload-transfer-design.md §10
--
-- Behaviour change on its own: once applied, DELETE /firms/mine/members/:id
-- (and AxIS's firm.remove_member, which never releases) answers 409
-- caseload_not_transferred for a member with students. The API falls back to
-- the old 1-argument call only while this file is not applied.

-- ---------------------------------------------------------------------------
-- 1. remove_firm_member gains p_release_students. The 1-argument version is
--    dropped so PostgREST never sees two candidates; { p_profile } alone
--    resolves to this one with release off.
-- ---------------------------------------------------------------------------
drop function if exists public.remove_firm_member(uuid);

create or replace function public.remove_firm_member(p_profile uuid, p_release_students boolean default false)
returns void
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  v_me       uuid := (select auth.uid());
  v_firm     uuid := (select firm_id from public.profiles where id = v_me);
  v_admin    boolean;
  v_students integer;
  v_grants   integer := 0;
  v_n        integer;
begin
  if v_firm is null then
    raise exception 'You''re not part of a firm' using errcode = 'P0002';
  end if;
  v_admin := private.is_counselor(v_me) and private.crm_firm_admin(v_firm, v_me);
  if p_profile <> v_me and not v_admin then
    raise exception 'Only a firm owner or admin can remove someone' using errcode = '42501';
  end if;
  if exists (select 1 from public.firms where id = v_firm and owner_id = p_profile) then
    raise exception 'The owner can''t leave their own firm' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.firm_members where firm_id = v_firm and profile_id = p_profile) then
    raise exception 'That person isn''t in your firm' using errcode = 'P0002';
  end if;

  -- Same lock as transfer_caseload takes first, so a transfer and a removal of
  -- the same person run one after the other.
  perform 1 from public.profiles where id = p_profile for update;

  select count(*) into v_students
    from public.profiles s
   where s.counselor_id = p_profile and s.role = 'student';

  if v_students > 0 then
    if p_profile = v_me then
      raise exception 'Ask a firm owner or admin to transfer your students or release them to you'
        using errcode = 'P0001', hint = 'caseload_not_transferred';
    end if;
    if not coalesce(p_release_students, false) then
      raise exception 'Transfer their % student% first, or release them', v_students,
        case when v_students = 1 then '' else 's' end
        using errcode = 'P0001', hint = 'caseload_not_transferred';
    end if;
    -- Released: the students leave with the counselor, so the firm's
    -- colleagues lose the access they were granted on them.
    delete from public.student_collaborators c
     using public.profiles s
     where s.id = c.student_id and s.counselor_id = p_profile
       and c.counselor_id <> p_profile and private.crm_firm_member(v_firm, c.counselor_id);
    get diagnostics v_n = row_count;
    v_grants := v_grants + v_n;
  end if;

  -- Their access to the firm's students ends with their membership.
  delete from public.student_collaborators c
   using public.profiles s
   where c.counselor_id = p_profile and s.id = c.student_id
     and s.counselor_id is not null and s.counselor_id <> p_profile
     and private.crm_firm_member(v_firm, s.counselor_id);
  get diagnostics v_n = row_count;
  v_grants := v_grants + v_n;

  update public.practice_settings set caseload_default_receiver = null
   where firm_id = v_firm and caseload_default_receiver = p_profile;

  delete from public.firm_members where firm_id = v_firm and profile_id = p_profile;
  update public.profiles set firm_id = null where id = p_profile and firm_id = v_firm;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (v_me, 'firm.member_removed', 'profile', p_profile,
          jsonb_build_object('firm_id', v_firm, 'students_released', v_students,
                             'collaborator_grants_removed', v_grants, 'left', p_profile = v_me));
end;
$$;
revoke all on function public.remove_firm_member(uuid, boolean) from public, anon;
grant execute on function public.remove_firm_member(uuid, boolean) to authenticated;

comment on function public.remove_firm_member(uuid, boolean) is
  'Remove a firm member (owner/admin) or leave. Refused (hint caseload_not_transferred) while the member has students, '
  'unless an owner/admin other than the member passes p_release_students.';

-- ---------------------------------------------------------------------------
-- 2. firm_consultants() also counts archived students, so a consultant whose
--    caseload is only archived students still shows a transfer to make (the
--    removal above counts them). Return type changes, so drop and recreate;
--    body otherwise unchanged from 20261005050003.
-- ---------------------------------------------------------------------------
drop function if exists public.firm_consultants();

create or replace function public.firm_consultants()
returns table (
  profile_id        uuid,
  full_name         text,
  email             text,
  avatar_url        text,
  seat_role         text,
  student_count     integer,
  alerts_visible    boolean,
  overdue_count     integer,
  no_activity_count integer,
  progress_pct      integer,
  archived_count    integer
)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_firm  uuid;
  v_admin boolean;
begin
  if v_uid is null or not private.is_counselor(v_uid) then
    raise exception 'Only counselors can open Management' using errcode = '42501';
  end if;
  v_firm := private.crm_workspace_firm(v_uid);
  v_admin := v_firm is not null and private.crm_firm_admin(v_firm, v_uid);

  return query
  with members as (
    select v_uid as id, case when v_firm is null then 'owner' else null end as seat
    where v_firm is null
    union
    select m.profile_id, m.seat_role from public.firm_members m where m.firm_id = v_firm
    union
    select f.owner_id, 'owner' from public.firms f
    where f.id = v_firm
      and not exists (select 1 from public.firm_members m where m.firm_id = v_firm and m.profile_id = f.owner_id)
  ),
  students as (
    select s.id, s.counselor_id
    from public.profiles s
    join members mb on mb.id = s.counselor_id
    where s.role = 'student' and s.archived_at is null
  ),
  archived as (
    select s.counselor_id, count(*)::integer as n
    from public.profiles s
    join members mb on mb.id = s.counselor_id
    where s.role = 'student' and s.archived_at is not null
    group by s.counselor_id
  ),
  work as (
    select st.counselor_id,
           count(*) filter (where d.status <> 'complete' and d.due_date < current_date) as overdue,
           round(avg(d.progress_pct))::integer as progress
    from students st
    join public.deliverables d on d.student_id = st.id
    group by st.counselor_id
  ),
  idle as (
    select st.counselor_id, count(*) as n
    from students st
    where exists (select 1 from public.deliverables d where d.student_id = st.id and d.status <> 'complete')
      and not exists (
        select 1 from public.deliverables d
        where d.student_id = st.id and d.last_activity_at > now() - interval '14 days'
      )
    group by st.counselor_id
  )
  select p.id,
         p.full_name,
         p.email,
         p.avatar_url,
         coalesce(mb.seat, 'counselor'),
         (select count(*)::integer from students st where st.counselor_id = p.id),
         (v_admin or p.id = v_uid),
         case when v_admin or p.id = v_uid then coalesce(w.overdue, 0)::integer end,
         case when v_admin or p.id = v_uid then coalesce(i.n, 0)::integer end,
         case when v_admin or p.id = v_uid then w.progress end,
         coalesce(a.n, 0)
  from members mb
  join public.profiles p on p.id = mb.id
  left join work w on w.counselor_id = p.id
  left join idle i on i.counselor_id = p.id
  left join archived a on a.counselor_id = p.id
  where p.role = 'counselor'
  order by (p.id = v_uid) desc, p.full_name;
end;
$$;
revoke all on function public.firm_consultants() from public, anon;
grant execute on function public.firm_consultants() to authenticated;
