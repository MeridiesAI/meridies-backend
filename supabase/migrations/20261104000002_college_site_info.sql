-- What a college's own website says about applying (college_site_info), saved by "Look up info & photo".
--
-- A counselor's lookup on a College Search card or a college's page (POST
-- /colleges/:id/lookup, lib/collegeSiteInfo.ts) reads a few pages of the
-- college's own site (home, then up to three of its pages about applying,
-- admissions and academics) and keeps what they state:
--
--   about, test_policy, essays_recs   short text, each backed by a quote the
--                                     pages really contain (checked in code)
--   deadlines   [{ plan, date, evidence }] plan ED / ED2 / EA / REA / RD /
--               Rolling / Transfer / Other, the date as the school writes it
--   programs    names the pages mention
--   pages       the URLs actually read; source_url is the home page
--
-- It is scraped, not curated: it lives apart from colleges.deadlines and
-- college_policies (which the team curates and which a lookup never touches),
-- and the app labels it "from the school's website". One row per college,
-- replaced by a lookup once it is 30 days old (a day, when the model did not
-- read the pages: model is null and only the school's own description was
-- kept), or sooner when a counselor presses Refresh.
--
-- Public catalog content, like college_photos: any signed-in user reads the
-- rows (a pending counselor reads nothing, the approval gate); only
-- service_role (the lookup route, after an approved counselor asked) writes.
--
-- Deploy order: either. Before this file the lookup still reads the site and
-- finds a photo, but nothing can be saved: it answers the facts it just read
-- (or info: null when it could not read any) and the next lookup reads again,
-- and GET /colleges/:id/extras answers siteInfo: null. Not in REQUIRED_SCHEMA.
-- No AI label is added: the model call is logged under the existing
-- 'link-digest' module.

-- ---------------------------------------------------------------------------
-- 1. college_site_info
-- ---------------------------------------------------------------------------

create table if not exists public.college_site_info (
  college_id   uuid primary key references public.colleges(id) on delete cascade,
  -- The home page that was read (after redirects), and every page read.
  source_url   text not null check (source_url ~ '^https?://' and length(source_url) <= 2000),
  pages        jsonb not null
               check (case when jsonb_typeof(pages) = 'array' then jsonb_array_length(pages) between 1 and 6 else false end),
  about        text check (about is null or length(btrim(about)) between 1 and 1200),
  deadlines    jsonb not null default '[]'::jsonb
               check (case when jsonb_typeof(deadlines) = 'array' then jsonb_array_length(deadlines) <= 12 else false end),
  test_policy  text check (test_policy is null or length(btrim(test_policy)) between 1 and 1200),
  essays_recs  text check (essays_recs is null or length(btrim(essays_recs)) between 1 and 1200),
  programs     jsonb not null default '[]'::jsonb
               check (case when jsonb_typeof(programs) = 'array' then jsonb_array_length(programs) <= 20 else false end),
  fetched_at   timestamptz not null default now(),
  -- The model that read the pages; null when none did (only the description was kept).
  model        text check (model is null or length(model) <= 100),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists college_site_info_set_updated_at on public.college_site_info;
create trigger college_site_info_set_updated_at before update on public.college_site_info
  for each row execute function public.set_updated_at();

alter table public.college_site_info enable row level security;

drop policy if exists college_site_info_select on public.college_site_info;
create policy college_site_info_select on public.college_site_info
  for select to authenticated using (true);

revoke all on public.college_site_info from anon, authenticated;
grant select on public.college_site_info to authenticated;
grant all on public.college_site_info to service_role;

-- A pending or revoked counselor reads nothing here, like every public table.
select private.attach_approval_gate('public.college_site_info');
