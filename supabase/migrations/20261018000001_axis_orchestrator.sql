-- AxIS on Claude Haiku 5.5: conversation memory and dialogue state, the
-- verification result on an answer, proposals the counselor confirms, and the
-- ai_runs labels.
--
-- Safe to apply before the code: nothing existing reads these columns, and
-- the old /chat routes keep working unchanged.

-- 1. Memory: a running summary of turns older than the ones sent verbatim, and
--    the students and schools the conversation is about (for "her", "it").
alter table public.ai_conversations
  add column if not exists summary         text check (summary is null or length(summary) <= 4000),
  add column if not exists summary_through timestamptz,
  add column if not exists state           jsonb check (state is null or (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 4000));

-- 2. What grounding and the adjudicator found, replayed under the answer.
alter table public.ai_messages
  add column if not exists verification jsonb
    check (verification is null or jsonb_typeof(verification) = 'object');

-- 3. Proposals. AxIS writes a pending row; only the counselor's confirm turns
--    it into a work item or opens the composer. Owner-only, like the chats
--    they come from, and a proposal about a student needs that student to be
--    visible to the owner when it is written.
create table if not exists public.axis_actions (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  message_id      uuid references public.ai_messages(id) on delete set null,
  student_id      uuid references public.profiles(id) on delete cascade,
  type            text not null check (type in ('work_item', 'email_draft')),
  payload         jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8000),
  status          text not null default 'pending' check (status in ('pending', 'confirmed', 'dismissed')),
  result          jsonb,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);

create index if not exists axis_actions_owner_pending_idx
  on public.axis_actions (owner_id, created_at desc) where status = 'pending';
create index if not exists axis_actions_conversation_idx
  on public.axis_actions (conversation_id);

alter table public.axis_actions enable row level security;

drop policy if exists axis_actions_select on public.axis_actions;
create policy axis_actions_select on public.axis_actions
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists axis_actions_insert on public.axis_actions;
create policy axis_actions_insert on public.axis_actions
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.owner_id = (select auth.uid()))
    and (student_id is null or private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists axis_actions_update on public.axis_actions;
create policy axis_actions_update on public.axis_actions
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- No delete policy: a proposal is dismissed, not erased. The conversation's delete cascades.

-- The proposal itself can't be rewritten after the fact; edits travel on the confirm call.
revoke update on public.axis_actions from authenticated;
grant update (status, result, decided_at, message_id) on public.axis_actions to authenticated;

select private.attach_approval_gate('public.axis_actions');

-- 4. ai_runs module labels, added the additive way (see 20261016000002).
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

  if array['axis', 'axis-verify', 'axis-memory', 'axis-warm'] <@ v_values then
    return;
  end if;
  v_values := array(select distinct unnest(v_values || array['axis', 'axis-verify', 'axis-memory', 'axis-warm']));

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
