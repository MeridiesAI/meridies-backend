-- The student view opens in the light theme unless the student picks another
-- one in Settings. "Device" (system) stays a choice, never the default.
--
-- Until now the column defaulted to 'system', and every preferences save
-- (a banner ground, a reminder switch) wrote that default back, so a row
-- reading 'system' can't be told apart from one the student never touched.
-- Those rows move to 'light'; a student who wants the device's theme picks
-- "Device" again.

alter table public.student_preferences alter column theme set default 'light';

update public.student_preferences set theme = 'light' where theme = 'system';
