-- Student banner: any colour, not only the four presets (QA round 10).
--
-- A student may pick their own banner colour as well as one of the presets
-- (pattern, forest, dusk, sand) or an uploaded photo. The colour is a plain
-- "#rrggbb" hex in its own column, so the preset CHECK stays as it is; a set
-- colour wins over the preset and an uploaded photo wins over both.
--
-- Same table, same RLS: student_preferences is written by the student alone
-- and read by whoever can view the student. The table-level insert/update
-- grant already covers a new column.
--
-- Deploy order: either. Before this file the API reads bannerColor as null,
-- and a save that names a colour answers 503 banner_color_unavailable; every
-- other preference keeps saving (the column is named only when a colour is
-- part of the save). Not in REQUIRED_SCHEMA.

alter table public.student_preferences
  add column if not exists banner_color text;

alter table public.student_preferences
  drop constraint if exists student_preferences_banner_color_hex;
alter table public.student_preferences
  add constraint student_preferences_banner_color_hex
  check (banner_color is null or banner_color ~ '^#[0-9a-f]{6}$');
