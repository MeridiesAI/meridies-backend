# meridies-backend

The MeridiesAI API. Fastify 5 + TypeScript (ESM, strict), deployed on Railway.

## What it does

Serves the production app at `app.meridiesai.com`: profiles, invite codes,
student records, deadlines, intake, financial aid, accountability and parent
alerts, the opportunity concierge, and every Anthropic-backed AI route.

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
apply them deliberately and commit the SQL in the same PR as the code.

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
