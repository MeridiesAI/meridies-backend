-- Application page (QA): Stanford's supplement prompts as Stanford asks them,
-- and the ai_runs labels for the two new AI reads.
--
-- 1. Stanford. The v10 seed (20261005020001) filled four prompts from the
--    demo's fixtures: two were paraphrased and the other five questions were
--    missing. These are the eight Stanford asks on the Common App (five short
--    questions of up to 50 words, three short essays of 100 to 250 words), as
--    published for the 2025-2026 cycle. They are still unverified for the
--    current cycle: source_verified_at stays null, so the app shows "Check the
--    prompt on Stanford's site" beside them until someone checks the page and
--    sets it. Rows someone already verified by hand are left alone. Essays
--    written against the old rows keep their own copy of title and prompt.
--
-- 2. ai_runs labels 'essay-body' (where the essay sits in an uploaded file)
--    and 'resume-adjust' (the Resume adjuster). Additive, read back from the
--    current CHECK like 20261028000007.
--
-- Deploy order: either. Without (1) the old prompts show; without (2) only the
-- audit rows for the two AI calls are skipped (an unknown label fails the
-- audit insert, not the request). No table is created. Not in REQUIRED_SCHEMA.

insert into public.college_supplements (college_id, admission_cycle, title, prompt, word_limit, sort_order, source_url)
select c.id, '2026-2027', v.title, v.prompt, v.word_limit, v.sort_order, c.website
  from (values
    (0, 'Short question · Society''s challenge', 'What is the most significant challenge that society faces today?', 50),
    (1, 'Short question · Last two summers', 'How did you spend your last two summers?', 50),
    (2, 'Short question · A historical moment', 'What historical moment or event do you wish you could have witnessed?', 50),
    (3, 'Short question · An activity, job or responsibility', 'Briefly elaborate on one of your extracurricular activities, a job you hold, or responsibilities you have for your family.', 50),
    (4, 'Short question · Five things', 'List five things that are important to you.', 50),
    (5, 'Short essay · Intellectual vitality', 'The Stanford community is deeply curious and driven to learn in and out of the classroom. Reflect on an idea or experience that makes you genuinely excited about learning.', 250),
    (6, 'Short essay · Note to your roommate', 'Virtually all of Stanford''s undergraduates live on campus. Write a note to your future roommate that reveals something about you or that will help your roommate, and us, get to know you better.', 250),
    (7, 'Short essay · Your contribution', 'Please describe what aspect of your life experiences, interests and character would help you make a meaningful contribution to the Stanford community.', 250)
  ) as v(sort_order, title, prompt, word_limit)
  join public.colleges c on c.slug = 'stanford'
 where c.website is null or c.website ~ '^https://'
on conflict (college_id, admission_cycle, sort_order) do update
   set title = excluded.title,
       prompt = excluded.prompt,
       word_limit = excluded.word_limit,
       source_url = coalesce(public.college_supplements.source_url, excluded.source_url)
 where public.college_supplements.source_verified_at is null;

do $$
declare
  v_def    text;
  v_values text[];
  v_label  text;
  v_added  boolean := false;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  foreach v_label in array array['essay-body', 'resume-adjust'] loop
    if not (v_label = any(v_values)) then
      v_values := array_append(v_values, v_label);
      v_added := true;
    end if;
  end loop;
  if not v_added then
    return;
  end if;

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
