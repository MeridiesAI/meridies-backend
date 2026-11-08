-- Persisted practice branding: a logo, a banner and an accent colour (Task 15c).
--
-- Until now the app kept branding in the browser (localStorage, data URLs), so it
-- was lost on another device and could not reach emails or the student view.
--
-- Firms already have the columns (logo_url 20260828000002; banner_url,
-- accent_color, accent_color_source 20260902000006) and their client UPDATE
-- grant (20261024000021); nothing changes on `firms`. This file adds:
--
--   1. The public-read `branding` bucket. Images only (PNG, JPEG, WebP; never
--      SVG, which runs script), 4 MB per object (a banner's limit; the API holds
--      a logo to 2 MB and checks the stored size again on save). No
--      storage.objects policy at all, like college-logos: clients can neither
--      write nor list. Uploads go only through signed upload URLs the API mints
--      after its own checks (POST /branding/upload-url), under
--      "<firm id or counselor id>/<logo|banner>-<16 hex>.<png|jpg|webp>".
--   2. `counselor_branding`: a solo counselor's own branding, one row each,
--      owner-only both ways. The URL CHECKs pin each column to its own kind in
--      the counselor's own folder of a branding bucket; the host can't be pinned
--      here (it is the project's URL), so the API checks it is this project's.
--
-- Deploy order: either. Before this file, GET /branding for a solo counselor and
-- every upload answer 503 `branding_unavailable`; firm branding reads and saves
-- as before. Not in REQUIRED_SCHEMA. Re-runnable.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 4194304, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.counselor_branding (
  counselor_id        uuid primary key references public.profiles(id) on delete cascade,
  logo_url            text,
  banner_url          text,
  accent_color        text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color_source text not null default 'default'
                        check (accent_color_source in ('default', 'logo', 'banner', 'manual')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- https, or plain http on a loopback host (the local stack); a public object
  -- in this counselor's own folder, of the column's own kind.
  constraint counselor_branding_logo_url_shape check (
    logo_url is null or (
      length(logo_url) <= 2000
      and logo_url ~ '^(https://[^/?#@\s]+|http://(127\.0\.0\.1|localhost)(:[0-9]+)?)/storage/v1/object/public/branding/[0-9a-f-]{36}/logo-[0-9a-f]{16}\.(png|jpg|webp)$'
      and strpos(logo_url, '/storage/v1/object/public/branding/' || counselor_id::text || '/') > 0)),
  constraint counselor_branding_banner_url_shape check (
    banner_url is null or (
      length(banner_url) <= 2000
      and banner_url ~ '^(https://[^/?#@\s]+|http://(127\.0\.0\.1|localhost)(:[0-9]+)?)/storage/v1/object/public/branding/[0-9a-f-]{36}/banner-[0-9a-f]{16}\.(png|jpg|webp)$'
      and strpos(banner_url, '/storage/v1/object/public/branding/' || counselor_id::text || '/') > 0))
);

comment on table public.counselor_branding is
  'A solo counselor''s own logo, banner and accent colour (a firm member uses the firm''s). Owner-only. Images are in the public branding bucket under the counselor''s id; written through PUT /branding.';

drop trigger if exists counselor_branding_set_updated_at on public.counselor_branding;
create trigger counselor_branding_set_updated_at before update on public.counselor_branding
  for each row execute function public.set_updated_at();

alter table public.counselor_branding enable row level security;
revoke all on public.counselor_branding from public, anon, authenticated;
grant select, delete on public.counselor_branding to authenticated;
grant insert (counselor_id, logo_url, banner_url, accent_color, accent_color_source)
  on public.counselor_branding to authenticated;
-- counselor_id is in the UPDATE grant only because an upsert (PostgREST's
-- on_conflict) names every inserted column in its DO UPDATE; the policies pin it
-- to the caller, so it can never move.
grant update (counselor_id, logo_url, banner_url, accent_color, accent_color_source)
  on public.counselor_branding to authenticated;

drop policy if exists counselor_branding_select_self on public.counselor_branding;
create policy counselor_branding_select_self on public.counselor_branding
  for select to authenticated
  using (counselor_id = (select auth.uid()));

drop policy if exists counselor_branding_insert_self on public.counselor_branding;
create policy counselor_branding_insert_self on public.counselor_branding
  for insert to authenticated
  with check (
    counselor_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'counselor'
  );

drop policy if exists counselor_branding_update_self on public.counselor_branding;
create policy counselor_branding_update_self on public.counselor_branding
  for update to authenticated
  using (counselor_id = (select auth.uid()))
  with check (
    counselor_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'counselor'
  );

drop policy if exists counselor_branding_delete_self on public.counselor_branding;
create policy counselor_branding_delete_self on public.counselor_branding
  for delete to authenticated
  using (counselor_id = (select auth.uid()));

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.counselor_branding');
