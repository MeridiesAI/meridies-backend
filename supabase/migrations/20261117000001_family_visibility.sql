-- What a student's parents receive: one switch per kind of information Meridies sends a family on its own.
--
--   student_alert_prefs.parents_get_tasks      the weekly family report's "Finished this week" and "Coming up or
--                                              overdue" sections, and the escalation sweep's parent alert
--   student_alert_prefs.parents_get_colleges   the weekly report's "College deadlines in the next two weeks"
--   student_alert_prefs.parents_get_essays     the weekly report's essay word counts (never essay text)
--
-- On the table that already decides who a student's messages go to: counselor-written (student_alert_prefs_write,
-- is_counselor_of) and student-readable (student_alert_prefs_select, can_view_student), behind the approval gate.
-- No new policy: the existing row policies cover the new columns, and the table-level grants to authenticated
-- already include columns added later. A student still can't write any of it.
--
-- Defaults are true, which is exactly what is sent today: nothing new is hidden or sent on deploy, and every
-- existing row keeps receiving everything.
--
-- Deploy order: either. The API (feat/parent-visibility-api) reads the columns explicitly and treats "column not
-- found" as not switched on yet (everything on; PUT /accountability/family-visibility answers 503
-- family_visibility_unavailable); the previous build never names them. Additive only. Not in REQUIRED_SCHEMA.

alter table public.student_alert_prefs
  add column if not exists parents_get_tasks    boolean not null default true,
  add column if not exists parents_get_colleges boolean not null default true,
  add column if not exists parents_get_essays   boolean not null default true;

comment on column public.student_alert_prefs.parents_get_tasks is
  'Whether this student''s parents receive tasks and overdue work in what Meridies sends on its own (the weekly report''s task sections, the escalation sweep''s parent alert). Counselor-written, like the rest of this table.';
comment on column public.student_alert_prefs.parents_get_colleges is
  'Whether this student''s parents receive college deadlines in the weekly family report. Counselor-written.';
comment on column public.student_alert_prefs.parents_get_essays is
  'Whether this student''s parents receive essay progress (word counts only, never text) in the weekly family report. Counselor-written.';
