# Manual apply bundles

Paste-ready SQL for the Supabase SQL Editor, generated from `supabase/migrations/`.
Each file is one transaction and records its versions in
`supabase_migrations.schema_migrations`, so the live history matches this repo.

Run in order:

1. `2026-09-23_1_schema.sql`: v5 feature parity, parent-alert recipient prefs,
   sweep lease, integration tokens, student red-flag view.
2. `2026-09-23_2_seed_catalog.sql`: the catalog seed.

Both were checked against a local Postgres 16 built from every migration the
live project already had, and both re-run cleanly. The migration files stay the
source of truth; regenerate a bundle rather than editing one.
