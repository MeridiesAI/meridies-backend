-- Seasonal stage emails: nine rough drafts of the mass emails a practice sends through the year,
-- each a template with a suggested month and day and the class it is for.
--
-- A stage email is NOT a per-student field. It is an `email_templates` row in the 'families' set (so
-- it is edited, renamed and saved like any template) that also carries when it is suggested for and
-- who it is for; Email Blast's Season view turns the drafts into ordinary scheduled blasts the
-- counselor reviews first. Nothing here sends anything.
--
--   stage          "Planning essays": the stage's name, which the Season view shows
--   send_month     1-12, send_day 1-31 (checked against the month; Feb 29 is allowed): a SUGGESTION,
--                  in the school year that starts on August 1
--   class_offset   0 seniors, 1 juniors, 2 sophomores, 3 freshmen: relative, so the same draft means the
--                  right graduating class every year (the app turns it into a class year for the filter)
--   audience       who a blast of it goes to by default: parents or students
--
-- All five are written by the counselor (the update grant below), together or not at all.
--
-- Seeding. `ensure_email_templates` seeds the four everyday templates only for a counselor with NO
-- family templates, so an account that already has some would never see new defaults. This file
--   1. adds the nine drafts to that seed (new counselors get them on first open),
--   2. backfills them once for every counselor who already has family templates, and
--   3. adds `restore_stage_templates()`, which puts back any draft that is missing and never touches
--      one that is there, edited or not. A draft the counselor deletes stays deleted until they ask.
-- The copy lives in `private.stage_template_defaults()`, generated from meridies-demo's
-- `lib/stageSeeds.ts` by `node --no-warnings scripts/stage-seeds-sql.mjs`: change it there, regenerate,
-- and ship the new text in a later migration (this one never rewrites a draft someone has edited).
--
-- email_blasts.source_template_id remembers which seasonal draft a blast was queued from, so the Season
-- view can mark what is already queued and the API can refuse the same draft for the same classes twice.
--
-- Deploy order: either. The code reads the new columns only after probing for them
-- (`stageColumnsReady`), so the template list, the pickers in Pipeline and Management, and blasts keep
-- working on a database without this file; the stage routes answer 503 `stage_templates_unavailable`.
-- Additive only (new nullable columns, one constraint over them, new functions); no existing row
-- changes except the backfill's inserts. Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. email_templates: the stage fields
-- ---------------------------------------------------------------------------

alter table public.email_templates
  add column if not exists stage        text     check (stage is null or length(btrim(stage)) between 1 and 60),
  add column if not exists send_month   smallint check (send_month is null or send_month between 1 and 12),
  add column if not exists send_day     smallint check (send_day is null or send_day between 1 and 31),
  add column if not exists class_offset smallint check (class_offset is null or class_offset between 0 and 3),
  add column if not exists audience     text     not null default 'parents' check (audience in ('parents', 'students'));

-- A stage is all or nothing, only in the families set, and its day exists in its month.
alter table public.email_templates drop constraint if exists email_templates_stage_complete;
alter table public.email_templates add constraint email_templates_stage_complete check (
  (stage is null and send_month is null and send_day is null and class_offset is null)
  or (
    stage is not null and send_month is not null and send_day is not null and class_offset is not null
    and template_set = 'families'
    and send_day <= case send_month when 2 then 29 when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30 else 31 end
  )
);

-- The counselor edits all five; the id, owner and set stay fixed.
grant update (stage, send_month, send_day, class_offset, audience) on public.email_templates to authenticated;

comment on column public.email_templates.stage is
  'A seasonal draft''s stage ("Planning essays"); null for an everyday template.';
comment on column public.email_templates.class_offset is
  'Which class a seasonal draft is for, relative to the admissions cycle: 0 seniors, 1 juniors, 2 sophomores, 3 freshmen.';

-- ---------------------------------------------------------------------------
-- 2. email_blasts: which draft a queued blast came from
-- ---------------------------------------------------------------------------

alter table public.email_blasts
  add column if not exists source_template_id uuid references public.email_templates(id) on delete set null;

-- The duplicate check asks "is this draft already queued for this counselor?".
create index if not exists email_blasts_source_template_idx
  on public.email_blasts (counselor_id, source_template_id)
  where status = 'scheduled' and source_template_id is not null;

-- ---------------------------------------------------------------------------
-- 3. The drafts
-- ---------------------------------------------------------------------------

create or replace function private.stage_template_defaults()
returns table (
  slug text, name text, stage text, send_month smallint, send_day smallint, class_offset smallint,
  audience text, subject text, body text
)
language sql
immutable
set search_path to 'pg_catalog'
as $$
  select d.slug, d.name, d.stage, d.send_month::smallint, d.send_day::smallint, d.class_offset::smallint,
         d.audience, d.subject, d.body
  from (values
    (E'stage-jr-search-kickoff', E'Starting the college search', E'Ideation', 1, 12, 1, E'parents',
     E'Starting {student}''s college search',
     E'Hi {first},\n\nThis is the start of {student}''s college search, and there is nothing to decide yet. For the next few weeks the goal is simply to learn what matters to your family.\n\nA few things worth talking about at home:\n• What {student} enjoys, and what they might want to study\n• What matters to your family: cost, distance from home, the size of the school\n• Which campuses near you could be visited, even just to walk around\n\nYou do not need to have answers. Reply with any questions at all and we will go through them together.\n\nWarmly,\n{me}'),
    (E'stage-jr-essay-ideas', E'Finding essay ideas', E'Ideation', 4, 6, 1, E'parents',
     E'Finding essay ideas for {student} this spring',
     E'Hi {first},\n\nNext fall {student} will write a main essay of about 650 words. It is a personal story in {student}''s own voice, and the strongest ones are usually about everyday life, not big achievements.\n\nThis spring we are only collecting ideas, not writing:\n• Family stories, responsibilities at home, a job, a language or a tradition can all make a strong essay\n• You can share family stories with {student}; the writing itself stays {student}''s own\n• Ask {student} to jot down a few moments they remember well\n\nNo drafts are due yet. We will talk through the ideas together.\n\nBest,\n{me}'),
    (E'stage-jr-summer-plan', E'A summer plan', E'Summer plan', 6, 1, 1, E'parents',
     E'A summer plan for {student} (it does not need to cost money)',
     E'Hi {first},\n\nColleges like to see how a student spends the summer, but it does not have to be an expensive program.\n\nA job, caring for family, a class, volunteering or learning something new all count. Please help {student} pick one or two things for this summer.\n\nAlso this summer:\n• {student} keeps a short list of essay ideas\n• We set up the Common App account together in August\n• I will check in with {student} in mid-July\n\nQuestions are always welcome.\n\nBest,\n{me}'),
    (E'stage-sr-essay-planning', E'Essay planning', E'Planning essays', 8, 17, 0, E'parents',
     E'Application season: our essay plan for {student}',
     E'Hi {first},\n\nApplication season starts now. Here is what an application has, and what we will do first.\n\nAn application usually has:\n• The application form, with {student}''s grades and activities\n• One main essay of about 650 words\n• Supplemental essays: short extra essays that each college asks for\n• Recommendation letters from teachers and a counselor\n\nOur plan: {student} chooses a main essay topic by September 1, and we start gathering documents this week. If a form ever asks for something from you, I will tell you exactly what it is and why.\n\nBest,\n{me}'),
    (E'stage-sr-first-drafts', E'First drafts', E'First drafts', 9, 14, 0, E'parents',
     E'First essay drafts this month',
     E'Hi {first},\n\nThis month {student} writes first drafts. A first draft does not have to be good; it only has to exist. I give questions and feedback but I never rewrite the essay, so it stays in {student}''s own words.\n\nEarly deadlines, explained:\n• Early Action: apply early, hear back early, and {student} can still decide later\n• Early Decision: apply early, and if {student} is accepted they must attend, so it is binding\n• Please talk to me before choosing Early Decision, especially because of cost\n\nYou can help by giving {student} quiet time to write and by asking how it is going, not by editing the essay.\n\nWarmly,\n{me}'),
    (E'stage-sr-revisions', E'Revisions and final checks', E'Revisions', 10, 12, 0, E'parents',
     E'Revisions and final checks before November 1',
     E'Hi {first},\n\nMany early deadlines are on November 1, so this month is for revising, not starting over.\n\nFinal checklist for {student}:\n• The main essay is finished and I have read it\n• Supplemental essays for the early schools are finished\n• Recommendation letters are requested and confirmed\n• The transcript is sent, and test scores only if we are using them\n\nWhat a deadline means: the application must be submitted by the end of that day, in the college''s time zone. We aim to submit a few days early.\n\nReply with any questions.\n\nBest,\n{me}'),
    (E'stage-sr-regular-deadlines', E'Regular deadlines', E'Final checks', 11, 16, 0, E'parents',
     E'Regular deadlines are coming: final checks',
     E'Hi {first},\n\nMost regular deadlines are in early January. I will send you each school''s exact date.\n\nBetween now and then:\n• We aim to submit every application a week before its deadline\n• Each college has an online portal; please help {student} check it for missing items\n• Thanksgiving week is a good time to finish any supplements that are left\n\nIf a form asks for family information, tell me before you fill it in and we will go through it together.\n\nBest,\n{me}'),
    (E'stage-sr-wrapup-aid', E'Wrap-up and financial aid', E'Wrap-up and aid', 1, 5, 0, E'parents',
     E'Applications are in. Here is what comes next',
     E'Hi {first},\n\nCongratulations: {student}''s applications are in. That was a lot of work.\n\nWhat comes next:\n• Some colleges ask for midyear grades; I will remind {student} when\n• Financial aid forms: the FAFSA and, for some schools, the CSS Profile. They tell colleges how much your family can pay. Please gather your recent tax documents now\n• Net price means what your family would actually pay after grants and scholarships, and it is the number we compare\n• The FAFSA is free. Please do not pay anyone to fill it out, and ask me if a website asks for payment\n\nWarmly,\n{me}'),
    (E'stage-sr-decisions', E'Decisions', E'Decisions', 3, 8, 0, E'parents',
     E'Decisions are arriving: let''s read them together',
     E'Hi {first},\n\nCollege decisions are arriving. Please do not decide anything alone; I would like us to read each result together.\n\nWhat the answers mean:\n• Accepted: {student} got in\n• Waitlisted: the college may offer a place later, and it is not a no\n• Deferred: an early application will be looked at again with the regular group\n\nWhen offers arrive we compare net price, not the price on the website. The reply deadline for most colleges is May 1. Please do not accept or decline before we compare.\n\nBest,\n{me}')
  ) as d(slug, name, stage, send_month, send_day, class_offset, audience, subject, body)
$$;

revoke all on function private.stage_template_defaults() from public, anon;
grant execute on function private.stage_template_defaults() to authenticated;

-- Insert whichever of the nine a counselor doesn't have (by slug). Returns how many it added. Invoker rights:
-- the caller's own RLS and the approval gate apply, so it can only ever write the caller's own templates.
create or replace function private.insert_stage_templates(p_uid uuid)
returns integer
language plpgsql
security invoker
set search_path to 'public', 'private'
as $$
declare
  v_n integer;
begin
  with ins as (
    insert into public.email_templates
      (counselor_id, template_set, slug, name, stage, send_month, send_day, class_offset, audience, subject, body)
    select p_uid, 'families', d.slug, d.name, d.stage, d.send_month, d.send_day, d.class_offset, d.audience, d.subject, d.body
    from private.stage_template_defaults() d
    on conflict (counselor_id, template_set, slug) do nothing
    returning 1
  )
  select count(*) into v_n from ins;
  return v_n;
end;
$$;

revoke all on function private.insert_stage_templates(uuid) from public, anon;
grant execute on function private.insert_stage_templates(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Seeding: new counselors get the drafts with the everyday templates
-- ---------------------------------------------------------------------------

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
    perform private.insert_stage_templates(v_uid);
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
-- 5. Restore: put back what was removed, touch nothing that is there
-- ---------------------------------------------------------------------------

create or replace function public.restore_stage_templates()
returns integer
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
  perform pg_advisory_xact_lock(hashtext('email-templates:' || v_uid::text || ':families'));
  return private.insert_stage_templates(v_uid);
end;
$$;

revoke all on function public.restore_stage_templates() from public, anon;
grant execute on function public.restore_stage_templates() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Backfill: counselors who already have family templates get the drafts once
-- ---------------------------------------------------------------------------

insert into public.email_templates
  (counselor_id, template_set, slug, name, stage, send_month, send_day, class_offset, audience, subject, body)
select t.counselor_id, 'families', d.slug, d.name, d.stage, d.send_month, d.send_day, d.class_offset, d.audience, d.subject, d.body
from (select distinct counselor_id from public.email_templates where template_set = 'families') t
cross join private.stage_template_defaults() d
on conflict (counselor_id, template_set, slug) do nothing;
