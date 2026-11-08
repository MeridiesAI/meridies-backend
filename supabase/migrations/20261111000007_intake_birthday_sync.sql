-- The onboarding questionnaire's optional date of birth fills the info card's birthday.
--
-- Re-issues private.sync_intake_answers (20261023010002, unchanged otherwise)
-- with one more step after first-generation: intakeAnswers.birthday, an ISO
-- date (YYYY-MM-DD), is copied into student_personal_details.birthday under
-- the same rules as every other field: fill only what is empty; a re-saved
-- questionnaire changes it only while it is still exactly what the
-- questionnaire wrote (its hash in intake_fills); a value the counselor
-- entered, edited or cleared is never touched again; the step runs in its own
-- subtransaction (intake_put_alone), so the save never fails because of it.
--
-- Validation (private.intake_birthday): a real calendar date (Feb 29 only in
-- a leap year), not in the future, and the student aged 10 to 25 on the day
-- of the sync; anything else is skipped as 'invalid' and changes nothing.
--
-- Privacy: this is a minor's date of birth. It is optional in the app, and
-- it is the only date of birth the questionnaire copies; citizenship, aid
-- need and the other sensitive answers stay uncopied, in
-- profiles.profile.intakeAnswers only. The value is never logged and never
-- written to a report: the progress_events row and the run's report name the
-- field and a reason, never the date. student_personal_details.birthday is
-- not on the AI allowlist (src/lib/context/ai-allowlist.ts;
-- test/unit/context-allowlist.test.ts), so no AI feature reads it.
--
-- Deploy order: either. Before this migration a saved birthday answer stays
-- in intakeAnswers and copies nothing; the info card's mark needs only
-- INFO_KEY_OF in the code. Not in REQUIRED_SCHEMA. No backfill: answers
-- saved before it are copied the next time the questionnaire is saved, or by
-- a manual private.backfill_intake_answers() run.

create or replace function private.intake_birthday(p text, p_today date)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  d date;
  n integer;
begin
  if p is null or p_today is null or p !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  begin
    d := p::date;
  exception when others then
    return null;
  end;
  -- Postgres reads '2009-02-29' as an error, never as March 1; check anyway.
  if to_char(d, 'YYYY-MM-DD') <> p or d > p_today then
    return null;
  end if;
  n := extract(year from age(p_today, d))::integer;
  if n < 10 or n > 25 then
    return null;
  end if;
  return d;
end;
$$;

create or replace function private.sync_intake_answers(p_student uuid, p_answers jsonb, p_actor uuid, p_run text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a jsonb := p_answers;
  v_out jsonb := private.intake_report();
  g jsonb;
  -- shared
  v_uc boolean;
  v_award_count integer;
  v_rigor boolean;
  v_ts text;
  -- GPA
  v_type text; v_scale text; v_max numeric; v_exact_s text; v_exact numeric; v_band_s text; v_band text;
  v_col text; v_other text;
  d_u jsonb; d_w jsonb; d_s jsonb;
  c_s jsonb; c_u jsonb; c_w jsonb; st_s text; st_u text; st_w text; st_col text;
  -- SAT / rank
  v_raw text; d_e jsonb; d_m jsonb; d_t jsonb; d_rank jsonb; d_val jsonb;
  st_a text; st_b text; st_c text; v_leave text[];
  -- rows
  v_rows jsonb; e jsonb; v_name text; v_org text; v_pos text; v_cat text; v_exam text; v_kind text;
  v_score text; v_level text; v_year text; v_hours text;
  -- school
  v_old_school text;
  v_changed integer;
begin
  if p_run is null or p_run not in ('save','backfill') then
    raise exception 'Unknown questionnaire run %', p_run using errcode = '22023';
  end if;
  if jsonb_typeof(a) is distinct from 'object' then
    return v_out;
  end if;
  -- Students only, not archived. The row lock serializes a save and the backfill.
  perform 1 from public.profiles p
   where p.id = p_student and p.role = 'student' and p.archived_at is null
   for update;
  if not found then
    return v_out;
  end if;

  v_award_count := private.intake_int(private.intake_str(a, 'awardCount'), 0, 1000);
  -- applyingUC is asked only once there is an award (the app's showIf).
  v_uc := coalesce(v_award_count >= 1, false) and private.intake_str(a, 'applyingUC') = 'yes';
  v_rigor := private.intake_str(a, 'rigorCount') is not null and private.intake_str(a, 'rigorCount') <> '0';
  v_ts := private.intake_str(a, 'testStatus');

  -- 1. High school (and its catalog link), hometown, class year ---------------
  begin
    g := private.intake_report();
    v_old_school := private.import_current_value('profiles', 'high_school', p_student) #>> '{}';
    g := private.intake_put(p_student, 'profiles', 'high_school',
                            to_jsonb(private.intake_text(a, 'highSchool', 200)), p_run, g);
    if jsonb_array_length(g -> 'done') > 0 then
      perform private.intake_link_high_school(p_student, v_old_school,
        private.import_current_value('profiles', 'high_school', p_student) #>> '{}');
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'profiles.high_school', 'error:' || sqlstate);
  end;
  v_out := private.intake_put_alone(p_student, 'profiles', 'hometown',
                                    to_jsonb(private.intake_text(a, 'location', 200)), p_run, v_out);
  v_out := private.intake_put_alone(p_student, 'profiles', 'grad_year',
                                    to_jsonb(private.intake_str(a, 'gradYear')), p_run, v_out);

  -- 2. GPA: kept on its own scale, never converted, never invented ------------
  begin
    g := private.intake_report();
    v_type := private.intake_str(a, 'gpaType');
    if v_type not in ('unweighted','weighted') then v_type := null; end if;
    v_scale := case v_type
                 when 'unweighted' then '4.0'
                 when 'weighted' then case private.intake_str(a, 'gpaScale')
                                        when '5' then '5.0' when '6' then '6.0' when '100' then '100' end
               end;
    v_max := case v_scale when '4.0' then 4 when '5.0' then 5 when '6.0' then 6 when '100' then 110 end;
    v_col := case v_type when 'unweighted' then 'gpa_unweighted' when 'weighted' then 'gpa_weighted' end;
    v_exact_s := private.intake_str(a, 'gpaExact');
    v_band_s := private.intake_str(a, case v_type when 'unweighted' then 'gpaBandUnweighted'
                                                   when 'weighted' then 'gpaBandWeighted' end);
    v_exact := null;
    v_leave := '{}';
    if v_type is not null and v_scale is null and (v_exact_s is not null or v_band_s is not null) then
      -- 'Something else': a GPA without a scale can't be read safely.
      g := private.intake_skip(g, 'student_academics.gpa_scale', 'scale_unknown');
      v_leave := array['gpa'];
    elsif v_type is not null and v_exact_s is not null then
      if v_exact_s !~ '^\d{1,3}(\.\d{1,3})?$' then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'invalid');
        v_leave := array['gpa'];
      elsif v_exact_s::numeric <= 0 or v_exact_s::numeric > v_max then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'out_of_range');
        v_leave := array['gpa'];
      else
        v_exact := v_exact_s::numeric;
      end if;
    end if;
    d_u := case when v_type = 'unweighted' then to_jsonb(v_exact) end;
    d_w := case when v_type = 'weighted' then to_jsonb(v_exact) end;
    d_s := case when v_exact is not null then to_jsonb(v_scale) end;

    c_s := private.import_current_value('student_academics', 'gpa_scale', p_student);
    c_u := private.import_current_value('student_academics', 'gpa_unweighted', p_student);
    c_w := private.import_current_value('student_academics', 'gpa_weighted', p_student);
    st_s := private.intake_field_state(p_student, 'student_academics', 'gpa_scale', c_s);
    st_u := private.intake_field_state(p_student, 'student_academics', 'gpa_unweighted', c_u);
    st_w := private.intake_field_state(p_student, 'student_academics', 'gpa_weighted', c_w);

    if 'gpa' = any (v_leave) then
      null;  -- an unreadable answer leaves the GPA as it is
    elsif st_s in ('empty','ours') and st_u in ('empty','ours') and st_w in ('empty','ours') then
      -- The whole GPA is empty or the questionnaire's: make it say what the
      -- answers say. Stale columns go first; then the scale and the GPA in the
      -- order student_academics_gpa_range accepts (a 100 scale before a GPA
      -- above 10; a GPA before a move off the 100 scale).
      if d_u is null then g := private.intake_put(p_student, 'student_academics', 'gpa_unweighted', null, p_run, g); end if;
      if d_w is null then g := private.intake_put(p_student, 'student_academics', 'gpa_weighted', null, p_run, g); end if;
      if v_exact is null then
        g := private.intake_put(p_student, 'student_academics', 'gpa_scale', null, p_run, g);
      elsif v_scale = '100' then
        g := private.intake_put(p_student, 'student_academics', 'gpa_scale', d_s, p_run, g);
        g := private.intake_put(p_student, 'student_academics', v_col, to_jsonb(v_exact), p_run, g);
      else
        g := private.intake_put(p_student, 'student_academics', v_col, to_jsonb(v_exact), p_run, g);
        g := private.intake_put(p_student, 'student_academics', 'gpa_scale', d_s, p_run, g);
      end if;
    elsif v_exact is not null then
      -- Someone else wrote part of the GPA. Fill an empty (or still our own)
      -- column only on the same scale; never touch their scale or their GPA.
      st_col := case v_col when 'gpa_unweighted' then st_u else st_w end;
      v_other := case v_col when 'gpa_unweighted' then 'gpa_weighted' else 'gpa_unweighted' end;
      if st_col not in ('empty','ours') then
        g := private.intake_skip(g, 'student_academics.' || v_col, private.intake_skip_reason(st_col));
      elsif c_s is null then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'scale_conflict');
      elsif substring(c_s #>> '{}' from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric
            is distinct from substring(v_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'scale_conflict');
      else
        g := private.intake_put(p_student, 'student_academics', v_col, to_jsonb(v_exact), p_run, g);
      end if;
    end if;

    -- The range is its own field: text that names its type and scale.
    v_band := private.intake_gpa_band(v_type, v_band_s, v_scale);
    if v_band_s is not null and v_band is null and v_scale is not null and v_scale <> '100' then
      g := private.intake_skip(g, 'student_academics.gpa_band', 'invalid');
    elsif v_band is not null or v_band_s is null or v_scale is not null then
      g := private.intake_put(p_student, 'student_academics', 'gpa_band', to_jsonb(v_band), p_run, g);
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'student_academics.gpa', 'error:' || sqlstate);
  end;

  -- 3. Class rank and its value move together ---------------------------------
  begin
    g := private.intake_report();
    d_rank := null; d_val := null;
    case private.intake_str(a, 'classRank')
      when 'exact' then
        d_rank := to_jsonb(private.intake_text(a, 'classRankValue', 40));
        d_val := d_rank;
      when 'top-1' then d_rank := to_jsonb('Top 1%'::text);
      when 'top-5' then d_rank := to_jsonb('Top 5%'::text);
      when 'top-10' then d_rank := to_jsonb('Top 10%'::text);
      when 'top-25' then d_rank := to_jsonb('Top 25%'::text);
      when 'top-50' then d_rank := to_jsonb('Top 50%'::text);
      when 'none' then d_rank := to_jsonb('Not ranked'::text);
      else null;
    end case;
    st_a := private.intake_field_state(p_student, 'student_academics', 'class_rank',
              private.import_current_value('student_academics', 'class_rank', p_student));
    st_b := private.intake_field_state(p_student, 'student_academics', 'class_rank_value',
              private.import_current_value('student_academics', 'class_rank_value', p_student));
    if st_a in ('empty','ours') and st_b in ('empty','ours') then
      g := private.intake_put(p_student, 'student_academics', 'class_rank', d_rank, p_run, g);
      g := private.intake_put(p_student, 'student_academics', 'class_rank_value', d_val, p_run, g);
    elsif d_rank is not null then
      g := private.intake_skip(g, 'student_academics.class_rank',
                               private.intake_skip_reason(case when st_a in ('empty','ours') then st_b else st_a end));
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'student_academics.class_rank', 'error:' || sqlstate);
  end;

  -- 4. Testing status ---------------------------------------------------------
  v_out := private.intake_put_alone(p_student, 'student_academics', 'test_status',
    to_jsonb(case
      when v_ts in ('sat','act','both') then 'taken'
      when v_ts = 'optional' then 'test-optional'
      when v_ts = 'notyet' then case when private.intake_str(a, 'testPrepStatus') in ('self','course','diagnostic')
                                     then 'prepping' else 'not-started' end
    end), p_run, v_out);

  -- 5. SAT: the two sections and the total move together ----------------------
  begin
    g := private.intake_report();
    d_e := null; d_m := null; d_t := null; v_leave := '{}';
    if v_ts in ('sat','both') then
      v_raw := private.intake_str(a, 'satEbrw');
      d_e := to_jsonb(private.intake_int(v_raw, 200, 800));
      if v_raw is not null and d_e is null then v_leave := v_leave || 'sat_ebrw'::text;
        g := private.intake_skip(g, 'student_academics.sat_ebrw', 'invalid'); end if;
      v_raw := private.intake_str(a, 'satMath');
      d_m := to_jsonb(private.intake_int(v_raw, 200, 800));
      if v_raw is not null and d_m is null then v_leave := v_leave || 'sat_math'::text;
        g := private.intake_skip(g, 'student_academics.sat_math', 'invalid'); end if;
      v_raw := private.intake_str(a, 'satSuperscore');
      d_t := to_jsonb(private.intake_int(v_raw, 400, 1600));
      if v_raw is not null and d_t is null then v_leave := v_leave || 'sat_superscore'::text;
        g := private.intake_skip(g, 'student_academics.sat_superscore', 'invalid'); end if;
      -- Two sections and no total: that sitting's total is their sum.
      if d_t is null and v_raw is null and d_e is not null and d_m is not null then
        d_t := to_jsonb((d_e #>> '{}')::integer + (d_m #>> '{}')::integer);
      end if;
    end if;
    st_a := private.intake_field_state(p_student, 'student_academics', 'sat_ebrw',
              private.import_current_value('student_academics', 'sat_ebrw', p_student));
    st_b := private.intake_field_state(p_student, 'student_academics', 'sat_math',
              private.import_current_value('student_academics', 'sat_math', p_student));
    st_c := private.intake_field_state(p_student, 'student_academics', 'sat_superscore',
              private.import_current_value('student_academics', 'sat_superscore', p_student));
    if st_a in ('empty','ours') and st_b in ('empty','ours') and st_c in ('empty','ours') then
      if not ('sat_ebrw' = any (v_leave)) then
        g := private.intake_put(p_student, 'student_academics', 'sat_ebrw', d_e, p_run, g); end if;
      if not ('sat_math' = any (v_leave)) then
        g := private.intake_put(p_student, 'student_academics', 'sat_math', d_m, p_run, g); end if;
      if not ('sat_superscore' = any (v_leave)) then
        g := private.intake_put(p_student, 'student_academics', 'sat_superscore', d_t, p_run, g); end if;
    elsif d_e is not null or d_m is not null or d_t is not null then
      g := private.intake_skip(g, 'student_academics.sat', 'already_set');
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'student_academics.sat', 'error:' || sqlstate);
  end;

  -- 6. ACT composite ------------------------------------------------------------
  v_raw := case when v_ts in ('act','both') then private.intake_str(a, 'actComposite') end;
  if v_raw is not null and private.intake_int(v_raw, 1, 36) is null then
    v_out := private.intake_skip(v_out, 'student_academics.act_composite', 'invalid');
  else
    v_out := private.intake_put_alone(p_student, 'student_academics', 'act_composite',
                                      to_jsonb(private.intake_int(v_raw, 1, 36)), p_run, v_out);
  end if;

  -- 7. First-generation -----------------------------------------------------------
  v_out := private.intake_put_alone(p_student, 'student_personal_details', 'first_gen',
    case private.intake_str(a, 'firstGen') when 'yes' then 'true'::jsonb when 'no' then 'false'::jsonb end,
    p_run, v_out);

  -- 7b. Date of birth (optional; a minor's, so validated and never echoed) ---
  -- An answer that isn't a real date, is in the future, or makes the student
  -- younger than 10 or older than 25 today is skipped by name and leaves the
  -- field as it is. No answer takes back only the questionnaire's own value.
  v_raw := private.intake_str(a, 'birthday');
  if v_raw is not null and private.intake_birthday(v_raw, current_date) is null then
    v_out := private.intake_skip(v_out, 'student_personal_details.birthday', 'invalid');
  else
    v_out := private.intake_put_alone(p_student, 'student_personal_details', 'birthday',
                                      to_jsonb(private.intake_birthday(v_raw, current_date)), p_run, v_out);
  end if;

  -- 8. Intended majors (asked when the student is certain or has narrowed it) --
  v_rows := null;
  if private.intake_str(a, 'majorCertainty') in ('certain','narrowed') and jsonb_typeof(a -> 'intendedMajors') = 'array' then
    select jsonb_agg(m order by first_ord) into v_rows from (
      select min(ord) as first_ord, (array_agg(t order by ord))[1] as m
      from (select nullif(rtrim(left(btrim(regexp_replace(x #>> '{}', '\s+', ' ', 'g')), 200)), '') as t, ord
              from jsonb_array_elements(a -> 'intendedMajors') with ordinality as y(x, ord)
             where jsonb_typeof(x) = 'string' and ord <= 50) z
      where t is not null
      group by lower(t)
      order by min(ord)
      limit 10) q;
  end if;
  v_out := private.intake_put_alone(p_student, 'student_personal_details', 'intended_majors', v_rows, p_run, v_out);

  -- 9. AP / IB scores (asked when the student reports advanced courses) -------
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if v_rigor and jsonb_typeof(a -> 'apScores') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'apScores') with ordinality as y(x, ord) where ord <= 15 order by ord loop
        v_exam := private.intake_text(e, 'exam', 200);
        continue when v_exam is null;
        v_kind := case when v_exam ~* '^\s*IB\M' then 'ib' else 'ap' end;
        -- The option is the AP score; its label reads "5 / 7", the IB score beside it.
        v_score := case private.intake_str(e, 'score')
                     when '5' then case v_kind when 'ib' then '7' else '5' end
                     when '4' then case v_kind when 'ib' then '6' else '4' end
                     when '3' then case v_kind when 'ib' then '5' else '3' end
                     when '2' then case v_kind when 'ib' then '4' else '2' end
                     when '1' then case v_kind when 'ib' then '3' else '1' end
                   end;
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', v_kind || '|' || v_exam,
          'row', jsonb_strip_nulls(jsonb_build_object('exam', v_exam, 'kind', v_kind, 'score', v_score))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'test_scores', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'test_scores', 'error:' || sqlstate);
  end;

  -- 10. Advanced courses. The questionnaire's "grade" is the grade level the
  -- course was taken in; courses.grade is the mark, so it is not copied.
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if v_rigor and jsonb_typeof(a -> 'advancedCourses') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'advancedCourses') with ordinality as y(x, ord) where ord <= 20 order by ord loop
        v_name := private.intake_text(e, 'name', 300);
        continue when v_name is null;
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', v_name,
          'row', jsonb_strip_nulls(jsonb_build_object(
            'name', v_name,
            'type', case private.intake_str(e, 'type')
                      when 'ap' then 'ap' when 'ib' then 'ib' when 'honors' then 'honors'
                      when 'de' then 'dual-enrollment' when 'other' then 'other' end,
            'status', case private.intake_str(e, 'status')
                        when 'completed' then 'completed' when 'inprogress' then 'in-progress'
                        when 'planned' then 'planned' end))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'courses', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'courses', 'error:' || sqlstate);
  end;

  -- 11. Honors (asked when the student counts at least one) -------------------
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if coalesce(v_award_count >= 1, false) and jsonb_typeof(a -> 'awards') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'awards') with ordinality as y(x, ord) where ord <= 25 order by ord loop
        v_name := private.intake_text(e, 'name', 100);
        continue when v_name is null;
        v_level := private.intake_str(e, 'level');
        v_year := private.intake_text(e, 'year', 20);
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', v_name || '|' || coalesce(v_year, ''),
          'row', jsonb_strip_nulls(jsonb_build_object(
            'name', v_name,
            'year', v_year,
            'level', case v_level when 'international' then 'International' when 'national' then 'National'
                                  when 'state' then 'State / Regional' when 'school' then 'School / Local' end,
            'recognition_levels', case v_level when 'international' then '["international"]'::jsonb
                                               when 'national' then '["national"]'::jsonb
                                               when 'state' then '["state-regional"]'::jsonb
                                               when 'school' then '["school"]'::jsonb end,
            'uc_level', case v_level when 'international' then 'international' when 'national' then 'national'
                                     when 'state' then 'state' when 'school' then 'school' end,
            'uc_criteria', case when v_uc then private.intake_text(e, 'ucCriteria', 250) end,
            'uc_earned', case when v_uc then private.intake_text(e, 'ucEarned', 350) end))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'awards', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'awards', 'error:' || sqlstate);
  end;

  -- 12. Activities. Blank rows the form opened in advance are skipped. The
  -- organization is the sheet's name for a row; without one the position or
  -- the type stands in.
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if jsonb_typeof(a -> 'activities') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'activities') with ordinality as y(x, ord) where ord <= 20 order by ord loop
        v_org := private.intake_text(e, 'organization', 100);
        v_pos := private.intake_text(e, 'position', 50);
        v_cat := private.intake_activity_type(private.intake_str(e, 'category'));
        continue when v_org is null and v_pos is null and v_cat is null;
        v_hours := private.intake_str(e, 'hoursPerWeek');
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', coalesce(v_org, '') || '|' || coalesce(v_pos, '') || '|' || coalesce(v_cat, ''),
          'row', jsonb_strip_nulls(jsonb_build_object(
            'name', coalesce(v_org, v_pos, v_cat),
            'organization', v_org,
            'position', v_pos,
            'category', v_cat,
            'grade_levels', (select jsonb_agg(gl order by case gl when 'PG' then 13 else gl::integer end) from (
                               select distinct case when x #>> '{}' = 'pg' then 'PG' else x #>> '{}' end as gl
                               from jsonb_array_elements(case when jsonb_typeof(e -> 'gradeLevels') = 'array'
                                                              then e -> 'gradeLevels' else '[]'::jsonb end) x
                               where jsonb_typeof(x) = 'string' and x #>> '{}' in ('9','10','11','12','pg')) q),
            'timing', case when private.intake_str(e, 'timing') in ('school','break','year')
                           then jsonb_build_array(private.intake_str(e, 'timing')) end,
            'hours_per_week', case when v_hours ~ '^\d{1,3}(\.\d{1,2})?$' and v_hours::numeric <= 168
                                   then to_jsonb(v_hours::numeric) end,
            'weeks_per_year', to_jsonb(private.intake_int(private.intake_str(e, 'weeksPerYear'), 0, 52)),
            'continuing', case private.intake_str(e, 'continuing') when 'yes' then 'true'::jsonb
                                                                  when 'no' then 'false'::jsonb end,
            'description', private.intake_text(e, 'description', 150),
            'uc_description', case when v_uc then private.intake_text(e, 'ucDescription', 350) end))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'activities', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'activities', 'error:' || sqlstate);
  end;

  -- Background answers with no real field (the background note, country,
  -- English test, citizenship, aid need and types, FAFSA status) are not
  -- copied anywhere: they stay in profiles.profile.intakeAnswers only. The
  -- birthday (7b) is the only date of birth copied.

  -- The counselor's activity trail: which fields changed and why others were
  -- left alone. Names and reasons only.
  v_changed := jsonb_array_length(v_out -> 'done');
  if v_changed > 0 then
    insert into public.progress_events (student_id, entity_type, event, actor_id, metadata)
    values (p_student, 'intake', 'edited', p_actor, jsonb_build_object('questionnaire', jsonb_build_object(
      'run', p_run,
      'changed', v_changed,
      'fields', (select jsonb_agg(distinct d ->> 'field') from jsonb_array_elements(v_out -> 'done') d),
      'skipped', (select coalesce(jsonb_agg(s), '[]'::jsonb) from (
                    select s from jsonb_array_elements(v_out -> 'skipped') s limit 60) q))));
  end if;
  return v_out;
end;
$$;

revoke all on function private.intake_birthday(text, date) from public, anon, authenticated;
revoke all on function private.sync_intake_answers(uuid, jsonb, uuid, text) from public, anon, authenticated;
