-- Saved email templates (demo v7, v9), one list per consultant.
--
-- Two sets that never mix: 'families' (Email Blast, and the Contact
-- Pipeline's Follow-up and Contract proposal, which live in the same list so
-- a consultant edits one set wherever they write from) and 'staff'
-- (Management's blast to the practice's consultants, v9).
--
-- `slug` marks the templates the product reaches for by name (the pipeline's
-- 'follow-up' and 'contract-proposal'); a consultant can rename or rewrite
-- them and the buttons still find them.
--
-- The default copy is the product's (the brief's), seeded per consultant the
-- first time a set is opened by `ensure_email_templates`. Templates are a
-- consultant's own: no firm sharing, no student access.

create table if not exists public.email_templates (
  id            uuid primary key default gen_random_uuid(),
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  template_set  text not null check (template_set in ('families', 'staff')),
  slug          text check (slug ~ '^[a-z0-9-]{1,60}$'),
  name          text not null check (length(btrim(name)) between 1 and 200),
  subject       text not null check (length(subject) <= 300),
  body          text not null check (length(body) <= 20000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint email_templates_slug_unique unique (counselor_id, template_set, slug)
);

create index if not exists email_templates_owner_idx on public.email_templates (counselor_id, template_set, created_at);

drop trigger if exists email_templates_set_updated_at on public.email_templates;
create trigger email_templates_set_updated_at before update on public.email_templates
  for each row execute function public.set_updated_at();

alter table public.email_templates enable row level security;

drop policy if exists email_templates_owner on public.email_templates;
create policy email_templates_owner on public.email_templates
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

revoke all on public.email_templates from public, anon, authenticated;
grant select, insert, delete on public.email_templates to authenticated;
grant update (name, subject, body) on public.email_templates to authenticated;

create or replace function public.ensure_email_templates(p_set text)
returns void
language plpgsql
security invoker
set search_path to 'public', 'private'
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.is_counselor(v_uid) then
    raise exception 'Only counselors keep templates' using errcode = '42501';
  end if;
  if p_set not in ('families', 'staff') then
    raise exception 'Unknown template set' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('email-templates:' || v_uid::text || ':' || p_set));
  if exists (select 1 from public.email_templates where counselor_id = v_uid and template_set = p_set) then
    return;
  end if;

  if p_set = 'families' then
    insert into public.email_templates (counselor_id, template_set, slug, name, subject, body) values
      (v_uid, 'families', 'welcoming', 'Welcoming', 'Welcome to the practice',
       E'Hi {first},\n\nWelcome aboard. Over the next two weeks we''ll finish your intake, build a first college list together and set a meeting rhythm that fits your schedule.\n\nYour first step is the intake questionnaire; it takes about twenty minutes and saves us an hour in our first meeting.\n\nLooking forward to working with you,\n{me}'),
      (v_uid, 'families', 'reminders', 'Reminders', 'Two weeks to your next deadline',
       E'Hi everyone,\n\nA quick reminder that your next application deadline is two weeks out. If anything on your list is still in draft, reply to this email and we''ll find time this week.\n\nBest,\n{me}'),
      (v_uid, 'families', 'follow-up', 'Follow-up', 'Following up on our conversation',
       E'Hi {first},\n\nThank you for taking the time to talk with me about your family''s college search. As promised, here is a short summary of how we work and what the first month looks like.\n\nIf you have questions, reply here or book a second call at a time that suits you.\n\nWarmly,\n{me}'),
      (v_uid, 'families', 'contract-proposal', 'Contract proposal', 'Your counseling proposal',
       E'Hi {first},\n\nAttached is the proposal we discussed: the package, the meeting cadence, what is included through application season and the fee schedule.\n\nOnce you''ve had a chance to read it, reply with any questions or sign through the link and we''ll schedule the kickoff meeting.\n\nBest,\n{me}');
  else
    insert into public.email_templates (counselor_id, template_set, slug, name, subject, body) values
      (v_uid, 'staff', 'weekly-sync', 'Weekly sync', 'Weekly sync: agenda for Monday',
       E'Hi team,\n\nAhead of Monday''s sync, please add to the shared agenda by Friday:\n\n- Students who slipped this week, and what you need from the rest of us\n- Upcoming deadlines on your caseload in the next fourteen days\n- Anything a family has escalated\n\nWe''ll keep it to thirty minutes.\n\nThanks,\n{me}'),
      (v_uid, 'staff', 'caseload', 'Caseload check-in', 'Caseload check-in',
       E'Hi {first},\n\nA quick check-in on your caseload. Which students are you most worried about right now, and is there anyone you''d like a second pair of eyes on before the early deadlines?\n\nIf your load feels heavy, say so and we''ll rebalance before November.\n\nThanks,\n{me}'),
      (v_uid, 'staff', 'deadline', 'Deadline reminder', 'Early deadlines in two weeks',
       E'Hi team,\n\nEarly Decision and Early Action deadlines are two weeks out. Before then, please make sure every senior on your caseload has a confirmed final list, recommendations requested and a counselor letter uploaded.\n\nFlag anyone at risk in Management so we can step in early.\n\nThanks,\n{me}');
  end if;
end;
$$;

revoke all on function public.ensure_email_templates(text) from public, anon;
grant execute on function public.ensure_email_templates(text) to authenticated;

-- ---------------------------------------------------------------------------
-- ai_runs: allow the 'email-template' module (AxIS drafting a template).
--
-- Other migrations extend this CHECK too, so rather than restating the whole
-- list (and silently dropping a module another migration added), this reads
-- the current allowed values back and adds ours.
-- ---------------------------------------------------------------------------

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  -- Postgres renders the list either as ARRAY['a'::text, ...] or as
  -- '{a,b}'::text[]; read both.
  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if not ('email-template' = any (v_values)) then
    v_values := array_append(v_values, 'email-template');
  end if;

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  -- Spelled as IN (...) so the definition reads back as one literal per
  -- value, and the next migration can extend it the same way.
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module in (%s))',
    (select string_agg(quote_literal(v), ',' order by v) from unnest(v_values) as v)
  );
end;
$$;
