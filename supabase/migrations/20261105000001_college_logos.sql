-- College logos (college_logos + the public college-logos bucket).
--
-- Most catalog schools showed their initials on a green square: the app only
-- had the forty or so logos checked into meridies-app. A school's own site
-- declares its icon (<link rel="apple-touch-icon"> or rel="icon" with sizes),
-- usually a 180 px PNG of its seal or mark. The lookup (lib/collegeMedia.ts,
-- POST /colleges/:id/lookup, the automatic lookup behind GET /colleges/media,
-- and scripts/ingest/college-media.ts) reads it through lib/links.ts (the
-- SSRF-safe fetch), only from the school's own host or a subdomain, and copies
-- it into Storage, so a viewer's browser never calls the school's site or a
-- third-party favicon service.
--
-- Rules, in the code and here:
--   - PNG, JPEG or WebP only, never SVG (a script could run in it) or ICO.
--     At least 48 px wide, at most 512 KB.
--   - Stored at <unitid>/logo-<sha1>.<ext>, content-addressed.
--   - One row per college that has been looked up. storage_path null means the
--     site was read and offered no usable icon; checked_at tells the automatic
--     lookup to leave the school alone for a week either way.
--   - Public catalog content: any signed-in user reads the rows; only
--     service_role writes them.
--
-- Deploy order: either. lib/collegeMedia.ts reads this table and serves
-- logoUrl: null while it is missing (remembered five minutes), and the lookup
-- skips the logo (a photo is still looked up). Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. college_logos
-- ---------------------------------------------------------------------------

create table if not exists public.college_logos (
  college_id    uuid primary key references public.colleges(id) on delete cascade,
  storage_path  text check (storage_path is null or storage_path ~ '^[0-9]{6}/logo-[0-9a-f]{40}\.(png|jpg|webp)$'),
  source_url    text check (source_url is null or (source_url ~ '^https?://' and length(source_url) <= 2000)),
  width         integer check (width is null or width between 1 and 4096),
  height        integer check (height is null or height between 1 and 4096),
  checked_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint college_logos_path_has_source check (storage_path is null or source_url is not null)
);

drop trigger if exists college_logos_set_updated_at on public.college_logos;
create trigger college_logos_set_updated_at before update on public.college_logos
  for each row execute function public.set_updated_at();

alter table public.college_logos enable row level security;

drop policy if exists college_logos_select on public.college_logos;
create policy college_logos_select on public.college_logos
  for select to authenticated using (true);

revoke all on public.college_logos from anon, authenticated;
grant select on public.college_logos to authenticated;
grant all on public.college_logos to service_role;

select private.attach_approval_gate('public.college_logos');

-- ---------------------------------------------------------------------------
-- 2. The bucket
-- ---------------------------------------------------------------------------
-- Public, like college-photos: a school's own published icon, shown beside its
-- name. No storage.objects policy: only service_role writes. No SVG.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('college-logos', 'college-logos', true, 524288, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
