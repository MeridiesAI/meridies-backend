# Meridies Backend — Agent Guide

> **Repo:** `MeridiesAI/meridies-backend` · **Deploy:** Railway API
>
> Read the monorepo onboarding doc at `MeridiesAI/context` (`CODEBASE_GUIDE.md`) for cross-repo conventions.

## What this repo is

**The API for MeridiesAI.** Fastify 5, Node ≥20, ESM, TypeScript strict.

Auth, profiles, invites, student records, deadlines, financial aid,
accountability, the opportunity concierge, and all Anthropic AI routes for the
production app (`meridies-app`).

## Architecture — this is now the shipped state, not a target

The auth seam is closed. There is one database: the Supabase project
`kerstlpuvpmstiavxblv`. Prisma and `@fastify/jwt` are gone, along with the
separate Postgres they pointed at.

```
src/
├── index.ts, app.ts, env.ts
├── plugins/
│   ├── supabaseAuth.ts    # verifies Supabase JWTs against the project JWKS
│   └── rateLimit.ts       # @fastify/rate-limit, per-user then per-IP
├── lib/
│   ├── supabase.ts        # userClient (RLS applies) / serviceClient (bypasses)
│   ├── guards.ts          # requireRole, assertCanView/EditStudent, resolveStudentId
│   ├── collection.ts      # generates the student-scoped CRUD routes
│   ├── limits.ts          # DB-backed rate limits + spend quotas
│   ├── accountability.ts  # stall detection, escalation, anti-spam throttle
│   ├── anthropic.ts       # model wrapper, ai_runs audit, essay guardrail
│   ├── serialize.ts       # rows -> the DTOs meridies-app declares
│   └── errors.ts, invite-code.ts
├── routes/
│   ├── health.ts, auth.ts, invites.ts, students.ts, deadlines.ts
│   ├── records.ts, intake.ts, aid.ts, accountability.ts
│   └── opportunities.ts, ai.ts
└── supabase/migrations/   # the schema — this repo owns it
```

### The two Supabase clients — pick deliberately

- **`request.db`** (anon key + the caller's JWT) — nearly everything. Queries run
  as that user, so RLS is the backstop under the handler's own checks.
- **`serviceClient()`** (service role, bypasses RLS) — only for work a user may
  not do as themselves: the rate limiter, spend quotas, `ai_runs` / `audit_log`
  writes, outbound message delivery. **Never** hand it a client-supplied id
  without checking the relationship first.

Authorize in code *and* let RLS enforce it. A route that skips its check leaks
the shape of the answer (404 vs 403 vs empty list) even when RLS blocks the row.

### Schema

`supabase/migrations/*.sql`, applied to the Supabase project. Every migration
ships its own RLS policies so no table is ever created unprotected.
`private.attach_student_policies()` stamps the standard student-scoped shape;
use it rather than hand-writing four policies and getting one wrong.

Two things the database enforces that the API must not be trusted to:

- **`profiles.role` is not writable by `authenticated`.** The table-level UPDATE
  grant was dropped and re-issued per column. Role changes go through
  `confirm_user_role()`, which succeeds exactly once. Same for `counselor_id`,
  which only `redeem_invite_code()` writes.
- **Invite codes can't be enumerated.** There is no SELECT policy for codes you
  don't own; redemption matches an exact code inside a SECURITY DEFINER
  function, so a student has to already know it.

## Rate limiting

Two layers, and they are not redundant:

1. `@fastify/rate-limit` — in-process, per authenticated user (falling back to
   IP). Cheap, soaks up floods, **resets on deploy and doesn't span replicas.**
2. `public.consume_rate_limit` / `public.consume_quota` — Postgres counters via
   `lib/limits.ts`. This is the layer that actually holds, and the one that
   protects AI spend. EXECUTE is granted to `service_role` only.

Without `SUPABASE_SERVICE_ROLE_KEY` the second layer degrades to an in-process
map and logs a warning at boot. Set it before going live.

New expensive route? Add a `limit(...)` preHandler. AI routes get 20/min per
user plus a 300-call daily quota.

## Anthropic / AI rules

**All product AI goes through Anthropic.** No other providers unless the team
explicitly decides otherwise.

- **Speed first** — counselors use these live, in session with a family
- **Default model:** `claude-haiku-4-5` (`FAST_MODEL` in `lib/anthropic.ts`)
- **Sonnet** (`DEEP_MODEL`) only where Haiku's quality genuinely isn't enough —
  currently narrative coherence, college lists, and the concierge
- **Opus** effectively never on a hot path, and never without documenting why
- Every model must support image and file attachments
- Never enable `thinking` / `effort` on models that don't support them

`runStructured()` handles quota, the `ai_runs` audit row, token accounting and
safe error messages. Use it rather than calling the SDK directly.

### The essay restriction is a hard product constraint

The product stays well clear of writing, or closely approximating, essay prose.
`/ai/essay-advice` returns bullets only.

`NO_PROSE_SYSTEM` states the rule, and `enforceNoProse()` drops anything over
two sentences or 240 characters *after* the model responds. Keep both. A system
prompt is a request, not an enforcement mechanism — if you add another
essay-adjacent route, it needs the code-level filter too.

Similarly, `/ai/award-appeal` and `/ai/family-report` produce **drafts**. They
are written with `status: 'draft'` / `'counselor-review'` and nothing in this
API sends them.

## Safe coding standards

- TypeScript strict — no `any`
- ESM imports with `.js` extensions (`import { env } from "./env.js"`)
- Zod at every boundary, `.strict()` on request bodies
- Thin route handlers — logic in `src/lib/`
- Always authenticate **and** authorize
- Never log secrets; never return stack traces or key hints to a client
- Never commit `.env` — keep `.env.example` current
- CORS is an allowlist from `CORS_ORIGIN` — never `*`
- Treat model output as untrusted user content

## Environment

```bash
cp .env.example .env
npm install
npm run dev               # http://localhost:4000
```

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL — also the JWKS issuer |
| `SUPABASE_ANON_KEY` | The key every user-scoped query runs under |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional; rate limits/quotas/audit degrade without it |
| `ANTHROPIC_API_KEY` | Optional; `/ai/*` returns 503 without it |
| `CORS_ORIGIN` | Allowed frontend origins, comma-separated |
| `PORT` | Defaults to 4000 |

`GET /health` reports `{ status, anthropic, serviceRole }` — presence only,
never values.

## Related repos

| GitHub repo | Role |
|---|---|
| `MeridiesAI/meridies-app` | Production frontend — calls this API |
| `MeridiesAI/meridies-demo` | Mock demo — does not call this API |
| `MeridiesAI/meridies-landing` | Marketing — no backend |

**Cross-repo rule:** ship backend routes before the frontend wires them in
`lib/api.ts`.

## Git workflow

```bash
git checkout main && git pull
git checkout -b feat/short-description
npm run typecheck && npm run build
# open PR — include the migration if the schema changed
```

Railway runs `npm run start` (plain `node dist/index.js`). Migrations are **no
longer applied on deploy** — Prisma owned that, and it's gone. Apply schema
changes to Supabase deliberately, and commit the SQL under
`supabase/migrations/` in the same PR.
