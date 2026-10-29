-- CSV student import: the columns a counselor's spreadsheet carried beyond the
-- invitation's own (name, grade, class year, time zone) are kept on the
-- invitation, as the label the sheet used and the value it held, so the
-- "Building profile" card can show them while the student does the forms.
--
-- Nothing here writes a student record: the values stay on the invitation, so
-- the student's own answers are never overwritten.
--
-- Deploy order: either. The API writes the column only when a CSV row carries
-- extras, and on a database without it saves the invitation without them
-- (lib/invites.ts). Not in REQUIRED_SCHEMA. Safe for the previous build: it
-- never names the column. The client UPDATE grant (20261024000023) is not
-- widened, so a counselor cannot edit it after the invitation is made.

alter table public.invitations
  add column if not exists import_data jsonb
  check (import_data is null or (jsonb_typeof(import_data) = 'object' and pg_column_size(import_data) <= 20000));

comment on column public.invitations.import_data is
  'Extra columns from a CSV import: {label: value}, strings only. Shown on the Building profile card; never copied into a student record.';
