-- Firm branding: banner + workspace accent colour.
--
-- `firms.logo_url` already existed. The brief adds a banner and says the
-- workspace colour adjusts to the company logo/banner — which means the colour
-- is derived from an image most of the time and typed by hand occasionally, so
-- the row records WHICH, rather than leaving the app guessing whether an
-- accent it finds was chosen deliberately.
--
-- The format check exists because a colour that reaches CSS unvalidated is a
-- style-injection primitive, not just a bad shade.

alter table public.firms
  add column if not exists banner_url         text check (length(banner_url) <= 2000),
  -- #RRGGBB only. Not a CSS colour: no named colours, no rgb(), no var().
  add column if not exists accent_color       text check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  add column if not exists accent_color_source text not null default 'default'
                                              check (accent_color_source in ('default','logo','banner','manual')),
  add column if not exists logo_updated_at    timestamptz;

comment on column public.firms.accent_color is
  'Workspace accent, #RRGGBB. Constrained rather than free text because it is interpolated into styles; a named colour or a css function must never reach the client.';
comment on column public.firms.accent_color_source is
  'Where the accent came from: sampled from the logo or banner, typed by an admin, or never set. Lets the app re-derive on a logo change without overwriting a deliberate choice.';
