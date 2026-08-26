# Meridies Backend — Agent Guide

> **Repo:** `MeridiesAI/meridies-backend` · **Deploy:** Railway API
>
> Read the monorepo onboarding doc at `MeridiesAI/context` (`CODEBASE_GUIDE.md`) for cross-repo conventions.

## What this repo is

**The API for MeridiesAI.** Fastify 5, Node ≥20, ESM, TypeScript strict.

Handles auth, profiles, invites, student rosters, deadlines, and all Anthropic AI routes for the production app (`meridies-app`).

## Current implementation vs target

> **Important for agents:** the frontend (`meridies-app`) is built for **Supabase Auth** and sends Supabase access tokens. This repo is mid-migration.

### Shipped today (what's in `main`)

```
src/
├── index.ts, app.ts, env.ts
├── plugins/jwt.ts          # @fastify/jwt — own token issuance
├── lib/prisma.ts, guards.ts, serialize.ts, invite-code.ts
└── routes/
    ├── health.ts           # GET /health
    ├── auth.ts             # POST /auth/signup, POST /auth/login
    └── invites.ts          # counselor invite codes
```

- **Database:** Prisma + Postgres (`prisma/schema.prisma`)
- **Auth:** email/password → JWT from this server
- **Env:** `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `PORT`

### Target (what `meridies-app` expects)

- Supabase JWT validation via `plugins/supabaseAuth.ts`
- Routes: `/auth/me`, `/students`, `/deadlines`, `/ai/*`
- Env additions: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`
- RLS via Supabase anon key + user JWT

When you touch auth or add routes, **close this seam** — don't document one stack and ship another.

## Anthropic / AI rules

**All product AI goes through Anthropic.** No other providers unless the team explicitly decides otherwise.

- **Speed first** — counselors use tools live in session; latency beats marginal quality
- **Default model:** `claude-haiku-4-5` in `src/routes/ai.ts`
- **Sonnet** only when Haiku quality is insufficient; **Opus** effectively never on hot paths
- **Hard requirement:** every model must support **image and file attachments** (essays, PDFs, screenshots)
- Never enable `thinking` / `effort` on models that don't support them

When adding AI routes:

1. Authenticate + authorize (`loadAuthorizedStudent`) before calling the model
2. Validate input with Zod
3. Use structured output / `betaZodTool` where shapes matter
4. Log errors server-side; return safe client messages — no stack traces, no key hints
5. Treat model output as untrusted — sanitize before storing

## Safe coding standards

- TypeScript strict — no `any`
- ESM imports with `.js` extensions (`import { env } from "./env.js"`)
- Zod at every boundary (env + request bodies)
- Thin route handlers — logic in `src/lib/`
- Always authenticate **and** authorize protected routes
- Never log secrets (API keys, tokens, full JWTs)
- Never commit `.env` — keep `.env.example` current
- CORS is an allowlist from `CORS_ORIGIN` (comma-separated) — never `*`

## Environment

```bash
cp .env.example .env
npm install
npx prisma migrate dev    # local schema
npm run dev               # http://localhost:4000
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (Railway injects in prod) |
| `JWT_SECRET` | Current auth tokens (`openssl rand -base64 48`) |
| `CORS_ORIGIN` | Allowed frontend origins, comma-separated |
| `SUPABASE_URL` | Target — Supabase project URL |
| `SUPABASE_ANON_KEY` | Target — JWT validation |
| `ANTHROPIC_API_KEY` | Target — all `/ai/*` routes |

Health check: `GET /health` → `{ "status": "ok" }`

## Related repos

| GitHub repo | Role |
|---|---|
| `MeridiesAI/meridies-app` | Production frontend — calls this API |
| `MeridiesAI/meridies-demo` | Mock demo — does not call this API |
| `MeridiesAI/meridies-landing` | Marketing — no backend |

**Cross-repo rule:** ship backend routes before the frontend wires them in `lib/api.ts`.

## Git workflow

```bash
git checkout main && git pull
git checkout -b feat/short-description
npm run typecheck && npm run build
# open PR — include migration file if schema changed
```

Railway runs `prisma migrate deploy` on start — **a deploy is a migration**. Never edit applied migrations; write new ones.
