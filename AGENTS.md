# Meridies Backend — Agent Guide

## What this repo is

**This is the real backend that powers MeridiesAI.**

`meridies-backend` is a Fastify (Node.js ≥20, ESM, TypeScript) API that handles:

- **Auth** — Supabase JWT validation on every protected route
- **Profiles & onboarding** — counselor/student user records
- **Student rosters** — counselor ↔ student relationships
- **Invites** — counselor-generated codes students redeem
- **Deadlines** — application deadline tracking
- **AI features** — all LLM work via the Anthropic API

The frontend (`meridies-app-real`) talks to this server exclusively through `lib/api.ts`. The demo app (`meridies-app`) does **not** call this backend — it uses mock data.

## Architecture

```
src/
├── index.ts          # Server entry, listens on PORT (default 4000)
├── app.ts            # Fastify app, CORS, route registration, error handler
├── env.ts            # Zod-validated env — server exits on invalid config
├── plugins/
│   └── supabaseAuth.ts   # Bearer token → Supabase user + client on request
├── lib/
│   ├── supabase.ts       # Supabase client factory (anon key + user JWT)
│   ├── authz.ts          # Authorization helpers (counselor/student access)
│   └── serialize.ts      # DB row → API response shapes
└── routes/
    ├── health.ts         # GET /health
    ├── auth.ts           # GET/PATCH /auth/me
    ├── students.ts       # GET /students, GET /students/:id
    ├── invites.ts        # POST/GET /invites, POST /invites/redeem
    ├── deadlines.ts      # GET /deadlines
    └── ai.ts             # POST /ai/* — all Anthropic calls
```

### Auth model

Every protected route uses `{ preHandler: app.authenticate }`. The plugin reads `Authorization: Bearer <supabase_access_token>`, validates it with Supabase, and attaches `request.supabaseUser` + `request.supabase` (a client scoped to that user's JWT, so **RLS applies**).

Authorization beyond auth (e.g., "can this counselor see this student?") goes through `lib/authz.ts` — never skip these checks.

### Data layer

Supabase Postgres with Row Level Security. The backend uses the **anon key** with the user's JWT — it does not bypass RLS with a service role key unless explicitly required and reviewed.

## Anthropic / AI rules

**All AI in this product goes through Anthropic.** No OpenAI, no other providers, unless explicitly directed by the team.

### Speed first

This is a **speed-first AI system**. Counselors use these tools in live sessions — latency matters more than marginal quality gains.

- Default to the fastest model that can handle the task
- Current baseline in `src/routes/ai.ts`: **`claude-haiku-4-5`**
- Do not reach for Opus/Sonnet unless the task genuinely requires it and you document why
- Never enable `thinking` / `effort` on models that don't support them (Haiku 4.5 does not)

### Model selection

You may choose models per task, but follow this hierarchy:

1. **Haiku 4.5** — default for structured summaries, short reports, tool runs, anything interactive
2. **Sonnet** — only when Haiku quality is insufficient (longer reasoning, nuanced writing)
3. **Opus** — avoid unless explicitly requested; never for user-facing hot paths

**Hard requirement: every model you use must support attaching images and files.** If a model cannot accept document/image inputs, do not use it. Many counselor workflows will send transcripts, essays, screenshots, and PDFs.

When adding a new AI route:

- Put it in `src/routes/ai.ts` (or split into `src/routes/ai/` if the file grows)
- Authenticate + authorize via `loadAuthorizedStudent` before calling the model
- Validate input with Zod
- Use structured output (`output_config`) or `betaZodTool` where appropriate — already established in this file
- Log errors server-side; return safe error messages to clients (no stack traces, no API key hints)

## Safe coding standards

### Security

- **Never log secrets** — no API keys, tokens, or full JWTs in logs
- **Never commit `.env`** — use `.env.example` as the template
- **Validate all input** with Zod at route boundaries (`env.ts` pattern)
- **Always authenticate** protected routes — no "temporary" unauthenticated endpoints
- **Always authorize** — check counselor/student relationship in `authz.ts`, don't trust client-supplied IDs alone
- **Respect RLS** — prefer the user's Supabase client over service-role bypass
- **Sanitize AI output** before storing — treat model responses as untrusted user content
- **CORS** — only origins listed in `CORS_ORIGIN` (comma-separated in env)

### Error handling

- Use the centralized error handler in `app.ts`
- Return `{ error: string }` for client errors; include `details` only for validation failures (400)
- 500s get logged; clients get generic messages

### Code style

- TypeScript strict — no `any`
- ESM imports with `.js` extensions (see existing files)
- Zod schemas for request bodies and env vars
- Prefer `loadAuthorizedStudent` / `loadCounselorName` over duplicating query logic
- Keep route handlers thin — business logic in `lib/`

## Environment variables

Required (validated in `src/env.ts`):

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` / `production` / `test` |
| `PORT` | Server port (default `4000`) |
| `CORS_ORIGIN` | Allowed frontend origin(s), comma-separated |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key (JWT validation) |
| `ANTHROPIC_API_KEY` | Anthropic API key for all `/ai/*` routes |

Copy `.env.example` → `.env` for local dev.

## Running locally

```bash
npm install
npm run dev      # tsx watch, http://localhost:4000
npm run build    # tsc → dist/
npm run start    # node dist/index.js
npm run typecheck
```

Health check: `GET /health` → `{ "status": "ok" }`

## Related repos

| Repo | Role |
|---|---|
| `meridies-app-real` | Production-intent frontend (calls this API) |
| `meridies-app` | Static demo — does not call this backend |
| `merides-landing` | Marketing site — no backend integration |

When the frontend needs a new capability, add the route here first, then wire `lib/api.ts` in `meridies-app-real`.
