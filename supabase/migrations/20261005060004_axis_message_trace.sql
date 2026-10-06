-- AxIS (Demo v6–v8): a chat replays as it ran.
--
-- The demo keeps each turn's reasoning trace (the steps AxIS showed while it
-- worked) and the sources the answer drew on, so reopening a chat from the
-- history column shows the same thread. The live stream already sends both;
-- until now neither was kept, so a reopened chat lost them.
--
-- `trace` is display data the backend wrote (short planning steps), never a
-- prompt. `sources` are the names of the record sections the answer was
-- grounded in ("Student profile", "Calendar"), not URLs.

alter table public.ai_messages
  add column if not exists trace   jsonb  not null default '[]'::jsonb
    check (jsonb_typeof(trace) = 'array'),
  add column if not exists sources text[] not null default '{}'
    check (cardinality(sources) <= 20);

comment on column public.ai_messages.trace is
  'The reasoning steps shown while the answer was written, as {"label": text} objects. Written by the API, replayed by the AxIS history.';
