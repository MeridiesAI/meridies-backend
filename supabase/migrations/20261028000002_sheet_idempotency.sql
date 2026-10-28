-- Application sheets: one row per add, however many times the request arrives.
-- The app sends an Idempotency-Key (a uuid made per click) on
-- POST /application/activities and /application/honors; the API stores it
-- here, and a repeat with the same key returns the row it already made
-- (lib/collection.ts). Before this, a double-click or a retried request added
-- a second blank row and could pass the form's cap.
--
-- Deploy order: either. Without the column the routes insert as before, with
-- no key (lib/collection.ts remembers the column is missing for five minutes).
-- Safe for the serving build: it never names the column. Not in
-- REQUIRED_SCHEMA.

alter table public.activities add column if not exists client_request_id uuid;
alter table public.awards add column if not exists client_request_id uuid;

create unique index if not exists activities_client_request_unique
  on public.activities (student_id, client_request_id)
  where client_request_id is not null;

create unique index if not exists awards_client_request_unique
  on public.awards (student_id, client_request_id)
  where client_request_id is not null;
