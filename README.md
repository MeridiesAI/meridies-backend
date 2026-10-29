# meridies-backend

The Meridies API. Fastify 5 + TypeScript (ESM, strict), deployed on Railway.

## What it does

Serves the production app at `app.meridiesai.com`: profiles, email
invitations, student records, deadlines, intake, financial aid, accountability
and parent alerts, the opportunity concierge, and every Anthropic-backed AI
route. Since the Demo v10 sync it also backs My Work Queue, the student page's
four sections, the family message composer, Colleges and Build College Lists,
Events Hub, Contact Pipeline and its Payment Tracker, Management and the
Calendar.

## Auth

There is no signup or login endpoint here. **Supabase Auth owns identity** and
the frontend talks to it directly; this service validates the resulting access
token.

`plugins/supabaseAuth.ts` verifies the JWT locally against the project's JWKS
(this project signs ES256), then attaches:

- `request.auth` — `{ userId, email, token }`
- `request.db` — a Supabase client bound to that user's token, so every query
  runs as them and Row Level Security applies
- `request.profile` — their `profiles` row, read from the database rather than
  the token, so a token minted before a role change doesn't keep old permissions

Authorization is enforced twice on purpose: in the handler (`lib/guards.ts`) and
in the database (RLS). See `AGENTS.md` for why.

## Setup

```bash
npm install
cp .env.example .env    # fill in SUPABASE_URL and SUPABASE_ANON_KEY
npm run dev             # http://localhost:4000
```

```bash
curl localhost:4000/health
```

Run alongside `meridies-app` on `:3000` with `NEXT_PUBLIC_API_URL=http://localhost:4000`,
and make sure `CORS_ORIGIN` includes `http://localhost:3000` — a missing origin
shows up in the browser as an opaque CORS failure, and it's the first thing to
check when "nothing loads".

## Schema

Lives in `supabase/migrations/` and is applied to the Supabase project. Each
migration carries its own RLS policies. Nothing runs migrations automatically —
apply them deliberately and commit the SQL in the same PR as the code. The v10
sync's 24 migrations, and the two settings outside the database that go with
them, are in [`DATABASE_MIGRATION_INSTRUCTIONS.md`](DATABASE_MIGRATION_INSTRUCTIONS.md).

## Scheduled jobs

Two Railway crons call this API with `Authorization: Bearer $CRON_SECRET`:
`POST /internal/accountability/sweep` (escalations) and
`POST /communication/internal/dispatch` (scheduled family messages). Both need
`SUPABASE_SERVICE_ROLE_KEY`. See `AGENTS.md`.

## Card payments (Stripe Connect)

The Payment Tracker can take card payments: each practice connects its own
Stripe account and families pay invoices on Stripe Checkout, so the money goes
straight to the practice. It is off unless all of these are set:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | The Meridies platform account's secret key (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the Connect webhook endpoint `<PUBLIC_API_URL>/webhooks/stripe` |
| `PUBLIC_API_URL` | This API's public origin; pay links are `<PUBLIC_API_URL>/pay/<token>` |
| `SUPABASE_SERVICE_ROLE_KEY` | The webhook and the pay page run with nobody signed in |

plus migration `20261030000001`. Without them `GET /pipeline/stripe` answers
`configured: false` and the app shows nothing about cards. See `AGENTS.md`
("Card payments are Stripe Connect") and `DATABASE_MIGRATION_INSTRUCTIONS.md`.

## Rate limiting

In-process per-user limiting via `@fastify/rate-limit`, plus Postgres-backed
counters (`lib/limits.ts`) that survive deploys and span replicas. The second
layer needs `SUPABASE_SERVICE_ROLE_KEY`; without it the server logs a warning at
boot and falls back to per-process limits only.

## AI

All AI is Anthropic, defaulting to `claude-haiku-4-5` for latency. Every call
goes through `runStructured()`, which enforces the caller's quota, writes an
`ai_runs` audit row, and returns safe errors.

The essay tool returns bulleted advice and will not write prose — enforced in
code, not just in the prompt. Family reports and award appeals are drafts; this
API never sends them.
