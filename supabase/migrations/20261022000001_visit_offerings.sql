-- What a college's admissions office offers when its exact dates aren't
-- listed: a campus tour, an information session, a virtual visit, as its
-- own site describes them ("most weekdays, 10am and 2pm"), with the page to
-- sign up on. Most colleges load their tour calendar with script, so the
-- events discovery job (lib/eventsDiscovery.ts) finds these where it can't
-- read dated events, and the student's Events tab shows them as cards.
--
-- Public college information, like the catalog: any signed-in user reads it;
-- only service_role (the discovery job) writes it. A run replaces a college's
-- offerings with what it just found and checked.

create table if not exists public.college_visit_offerings (
  id          uuid primary key default gen_random_uuid(),
  college_id  uuid not null references public.colleges(id) on delete cascade,
  kind        text not null check (kind in
                ('campus-tour','info-session','virtual-visit','open-house','webinar','workshop')),
  title       text not null check (length(btrim(title)) between 1 and 200),
  -- As the college's page puts it; null when the page doesn't say.
  schedule    text check (schedule is null or length(schedule) <= 200),
  url         text not null check (url ~ '^https?://' and length(url) <= 2000),
  source_url  text check (source_url is null or (source_url ~ '^https?://' and length(source_url) <= 2000)),
  checked_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create unique index if not exists college_visit_offerings_key
  on public.college_visit_offerings (college_id, kind, lower(btrim(title)));

alter table public.college_visit_offerings enable row level security;

drop policy if exists college_visit_offerings_select on public.college_visit_offerings;
create policy college_visit_offerings_select on public.college_visit_offerings
  for select to authenticated using (true);

revoke all on public.college_visit_offerings from anon, authenticated;
grant select on public.college_visit_offerings to authenticated;
grant all on public.college_visit_offerings to service_role;

-- A pending or revoked counselor reads nothing here, like every public table.
select private.attach_approval_gate('public.college_visit_offerings');
