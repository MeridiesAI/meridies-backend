-- School-specific scholarships: a school's own awards (a university's merit scholarships and their deadlines), which
-- consultants track by hand today. Meridies never curates these: a row exists only because a counselor typed it in
-- (later also from the cited-proposals pipeline). A counselor's row is unverified until an editor (service role)
-- stamps source_verified_at, and the counselor's own edit clears that stamp again.
--
-- public.scholarships was the national/state catalog: readable by every signed-in user, written by the service role.
-- It gains:
--   college_id          the school the award belongs to (catalog rows may name one too, for a school's own award an
--                       editor adds). ON DELETE RESTRICT: nothing deletes a college today, and a catalog cleanup that
--                       removed one must not silently take counselors' rows and, through scholarship_matches'
--                       cascade, the awards their students are tracking. Whoever deletes a college decides first.
--   owner_counselor_id  the counselor who typed it. ON DELETE CASCADE: deleting the account deletes what it wrote
--                       (the profile's own data; SET NULL would break the CHECK below and leave an ownerless row).
--                       Students' tracked matches survive: scholarship_matches.scholarship_id is SET NULL below.
--                       profiles is not captured by the AxIS trash, so axis-trash-db's whole-branch check is unchanged.
--   firm_id             the owner's firm when the row was written, pinned by a trigger (never the client's). ON DELETE
--                       SET NULL: a deleted firm leaves the row its owner's alone. firms is not captured either.
--   source              'catalog' (Meridies' catalog, service role) or 'counselor'. The client can't choose it.
--   eligibility_text    who it is for, as the counselor wrote it. Free text, never machine-matched (the jsonb
--                       eligibility gates stay the catalog's; a counselor row's are '{}').
-- A counselor row's notes are `description`. Students read both, so they are not private notes.
--
-- Who sees what (select policy, private.can_see_school_scholarship; active rows only, except an owner's own):
--   * catalog rows (no owner): every signed-in user, as before;
--   * a counselor's row: its owner; members of its firm while the owner is still a member (firm sharing);
--     a student whose counselor is the owner, or whose counselor's workspace firm is the row's firm (the owner still
--     in it). Another practice and its students never see it.
-- The scan (lib/studentAid.ts) narrows that again to the student's own practice (scholarship_practice below) and to
-- colleges on the student's list, so a counselor reading a student they collaborate on sees the student's practice's
-- rows, not their own.
--
-- Writes: only an approved counselor, only rows they own with source 'counselor' and a school; never DELETE (soft
-- delete is is_active = false, so a row a student is tracking keeps its link). Column grants
-- keep source, owner, firm and source_verified_at out of every client UPDATE; the guard trigger pins firm_id and the
-- verification stamp and caps a counselor at 200 active rows (errcode 54000), so PostgREST can't get round the API.
--
-- The table keeps its approval_gate (20261017000001 attached it); no new table here.
--
-- Deploy order: migration first. The code before it: the scan reads `select *` and a missing scholarship_practice
-- RPC as "no counselor rows" (there are none), and the new routes answer 503 school_scholarships_unavailable. The
-- previous build after it: it only reads the table, and no counselor row exists until the new routes ship. Not in
-- REQUIRED_SCHEMA. Re-runnable.

alter table public.scholarships
  add column if not exists college_id uuid references public.colleges(id) on delete restrict,
  add column if not exists owner_counselor_id uuid references public.profiles(id) on delete cascade,
  add column if not exists firm_id uuid references public.firms(id) on delete set null,
  add column if not exists source text not null default 'catalog',
  add column if not exists eligibility_text text;

alter table public.scholarships drop constraint if exists scholarships_source_check;
alter table public.scholarships add constraint scholarships_source_check
  check (source in ('catalog', 'counselor'));

-- A counselor's row always names its school and its owner; a catalog row has no owner.
alter table public.scholarships drop constraint if exists scholarships_counselor_row_check;
alter table public.scholarships add constraint scholarships_counselor_row_check
  check (case when source = 'counselor'
              then college_id is not null and owner_counselor_id is not null
              else owner_counselor_id is null and firm_id is null end);

-- What a counselor may write: bounded text and https links only (the API checks the same, in words).
alter table public.scholarships drop constraint if exists scholarships_counselor_bounds_check;
alter table public.scholarships add constraint scholarships_counselor_bounds_check
  check (source <> 'counselor' or (
    length(btrim(name)) between 1 and 200
    and coalesce(length(sponsor), 0) <= 200
    and coalesce(length(description), 0) <= 2000
    and coalesce(length(eligibility_text), 0) <= 2000
    and coalesce(length(amount_note), 0) <= 200
    and (url is null or (url ~ '^https://[^[:space:]]+$' and length(url) <= 2048))
    and (apply_url is null or (apply_url ~ '^https://[^[:space:]]+$' and length(apply_url) <= 2048))
    and (source_url is null or (source_url ~ '^https://[^[:space:]]+$' and length(source_url) <= 2048))
    and coalesce(cardinality(tags), 0) <= 10
    and eligibility = '{}'::jsonb
  ));

-- A student's tracked award outlives the row it came from. scholarship_matches keeps its own copy of name, url,
-- amount and deadline (a hand-added row already has no scholarship_id), so when a counselor's account (and with it
-- their rows) is deleted, the student's match, a won award included, stays and only loses the link. It was ON DELETE
-- CASCADE (20260828000007). Neither table is captured by the AxIS trash.
alter table public.scholarship_matches drop constraint if exists scholarship_matches_scholarship_id_fkey;
alter table public.scholarship_matches add constraint scholarship_matches_scholarship_id_fkey
  foreign key (scholarship_id) references public.scholarships(id) on delete set null;

create index if not exists scholarships_college_idx on public.scholarships (college_id) where is_active and college_id is not null;
create index if not exists scholarships_owner_idx on public.scholarships (owner_counselor_id) where owner_counselor_id is not null;
create index if not exists scholarships_firm_idx on public.scholarships (firm_id) where firm_id is not null;

comment on column public.scholarships.college_id is
  'The school whose own award this is. Shown to a student only while that school is on their list.';
comment on column public.scholarships.source is
  '''catalog'': Meridies'' catalog (service role). ''counselor'': typed in by owner_counselor_id; never curated by Meridies.';
comment on column public.scholarships.eligibility_text is
  'Who the award is for, in the counselor''s words. Not machine-matched; students read it.';

-- ---- Who may see a counselor's row ----

create or replace function private.can_see_school_scholarship(p_owner uuid, p_firm uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_owner is not null and p_viewer is not null and (
    p_owner = p_viewer
    -- The firm's, while the owner is still in it.
    or (p_firm is not null
        and private.crm_firm_member(p_firm, p_owner)
        and private.crm_firm_member(p_firm, p_viewer)
        and private.is_counselor(p_viewer))
    -- A student of the owner, or of a counselor in the row's firm (the owner still in it).
    or exists (
      select 1 from public.profiles s
      where s.id = p_viewer and s.role = 'student' and s.counselor_id is not null
        and private.is_counselor(s.counselor_id)
        and (s.counselor_id = p_owner
             or (p_firm is not null
                 and private.crm_firm_member(p_firm, p_owner)
                 and p_firm = private.crm_workspace_firm(s.counselor_id))))
  );
$$;
revoke all on function private.can_see_school_scholarship(uuid, uuid, uuid) from public, anon;
-- The select policy runs it as the caller (like the other private.* RLS helpers); it answers only true/false.
grant execute on function private.can_see_school_scholarship(uuid, uuid, uuid) to authenticated;

-- ---- RLS ----

alter table public.scholarships enable row level security;

drop policy if exists scholarships_select on public.scholarships;
create policy scholarships_select on public.scholarships
  for select to authenticated
  using (
    (is_active and (
      owner_counselor_id is null
      or private.can_see_school_scholarship(owner_counselor_id, firm_id, (select auth.uid()))))
    -- The owner still reads their removed rows: Postgres holds an UPDATE's new row to the select policy, so without
    -- this the soft delete (is_active = false) itself would be refused. The API and the scan read active rows only.
    or (owner_counselor_id = (select auth.uid())));

drop policy if exists scholarships_insert_counselor on public.scholarships;
create policy scholarships_insert_counselor on public.scholarships
  for insert to authenticated
  with check (
    source = 'counselor'
    and owner_counselor_id = (select auth.uid())
    and college_id is not null
    and source_verified_at is null
    and (select private.is_counselor((select auth.uid()))));

drop policy if exists scholarships_update_counselor on public.scholarships;
create policy scholarships_update_counselor on public.scholarships
  for update to authenticated
  using (
    source = 'counselor'
    and owner_counselor_id = (select auth.uid())
    and (select private.is_counselor((select auth.uid()))))
  with check (
    source = 'counselor'
    and owner_counselor_id = (select auth.uid())
    and college_id is not null);

-- No delete policy, and no DELETE grant: removal is is_active = false.

revoke all on table public.scholarships from anon;
revoke all on table public.scholarships from authenticated;
grant select on table public.scholarships to authenticated;
grant insert (name, sponsor, description, url, apply_url, amount_cents, amount_note, renewable, opens_at, deadline,
              tags, source_url, essay_required, college_id, owner_counselor_id, source, eligibility_text)
  on table public.scholarships to authenticated;
grant update (name, sponsor, description, url, apply_url, amount_cents, amount_note, renewable, opens_at, deadline,
              tags, source_url, essay_required, college_id, eligibility_text, is_active)
  on table public.scholarships to authenticated;

-- ---- The guard: what a client write can't choose ----

-- SECURITY INVOKER on purpose: current_user is the caller's role only in an invoker function (the
-- meetings_owner_guard pattern). The cap's count runs under the caller's RLS, which shows them their own active rows.
create or replace function private.scholarships_guard_client()
returns trigger
language plpgsql set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_active int;
begin
  if current_user <> 'authenticated' then
    return new; -- the service role (editors, the catalog loaders) and migrations
  end if;
  if tg_op = 'INSERT' then
    new.firm_id := private.crm_workspace_firm(v_uid);
    new.source_verified_at := null;
    new.is_active := true;
    new.eligibility := '{}'::jsonb;
    -- One counselor's inserts queue here, so two at once can't both read 199 and both pass the cap.
    perform pg_advisory_xact_lock(hashtext('school_scholarship_cap:' || v_uid::text));
    select count(*) into v_active from public.scholarships
      where owner_counselor_id = v_uid and is_active;
    if v_active >= 200 then
      raise exception 'You have 200 school scholarships saved. Remove one before adding another.'
        using errcode = '54000';
    end if;
  else
    -- Removal is one way for a client: bringing a row back would step round the cap.
    if not old.is_active and new.is_active then
      raise exception 'A removed scholarship can''t be restored. Add it again instead.' using errcode = '42501';
    end if;
    new.firm_id := old.firm_id;
    new.owner_counselor_id := old.owner_counselor_id;
    new.source := old.source;
    new.eligibility := old.eligibility;
    -- An editor's stamp named what they checked; the counselor's edit is not that.
    new.source_verified_at := null;
  end if;
  return new;
end;
$$;
revoke all on function private.scholarships_guard_client() from public, anon;

drop trigger if exists scholarships_guard_client on public.scholarships;
create trigger scholarships_guard_client before insert or update on public.scholarships
  for each row execute function private.scholarships_guard_client();

-- ---- The student's practice, for the scan ----

-- Whose school rows a student's scan may show: the student's counselor and that counselor's workspace firm. Answers
-- only to someone who can view the student (the student, their counselor, a collaborator); null otherwise.
create or replace function public.scholarship_practice(p_student uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when private.can_view_student(p_student, auth.uid()) then (
    select jsonb_build_object('counselorId', p.counselor_id, 'firmId', private.crm_workspace_firm(p.counselor_id))
    from public.profiles p
    where p.id = p_student and p.counselor_id is not null)
  end;
$$;
revoke all on function public.scholarship_practice(uuid) from public, anon;
grant execute on function public.scholarship_practice(uuid) to authenticated;
