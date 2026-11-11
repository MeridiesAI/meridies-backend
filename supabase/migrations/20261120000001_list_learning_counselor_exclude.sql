-- List-builder learning: leave a counselor out, not only a firm.
--
-- 20261119000001 added firms.exclude_from_learning, but on production every counselor is solo (no firms rows),
-- so it could leave nobody out. profiles.exclude_from_learning does the same for one counselor: lib/listLearning.ts
-- logs nothing for a student whose counselor is flagged (or whose counselor's firm is), nor for anything a flagged
-- counselor does on someone else's student (a shared student). Set by hand, as postgres, for our team, demo and
-- test accounts:
--   update public.profiles set exclude_from_learning = true where id in ('<counselor id>', ...);
-- Clients can't set it: profiles' UPDATE grant is per column (this column gets none) and 20261115000001 took
-- away client INSERT. It is readable wherever the row is; it says nothing about anyone else.
--
-- Deploy order: either. With the code first, the logging reads this column, finds it missing, writes nothing and
-- warns once every five minutes until this file is applied (fail closed: no test account's data slips in). With
-- this file first, the previous build ignores the column. Not in REQUIRED_SCHEMA.

alter table public.profiles add column if not exists exclude_from_learning boolean not null default false;
