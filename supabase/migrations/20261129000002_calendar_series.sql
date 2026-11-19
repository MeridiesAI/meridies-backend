-- Repeating events: a meeting or a practice event can belong to a series.
--
--   meetings.series_id, calendar_events.series_id   nullable uuid; the rows of one repeating series share it. Null is a
--                                    one-off, which is every existing row. It names no table: it is just an id the API
--                                    mints when it creates a series, so the "following" and "all upcoming" scopes can
--                                    find the sibling rows.
--
-- Additive and idempotent. Deploy order: either. Safe for the previous build (explicit select lists ignore the
-- column). Not in REQUIRED_SCHEMA: until it is applied the series routes answer 503 series_unavailable and the
-- calendar feed does not select the column (`seriesReady`). No table is created, so no RLS or approval gate to
-- attach; the new column sits under each table's existing policies and grants.

alter table public.meetings add column if not exists series_id uuid;
alter table public.calendar_events add column if not exists series_id uuid;

-- The scope reads ask for the rest of a series; most rows have none, so index only the ones that do.
create index if not exists meetings_series_idx on public.meetings (series_id) where series_id is not null;
create index if not exists calendar_events_series_idx on public.calendar_events (series_id) where series_id is not null;
