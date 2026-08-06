# meridies-backend

API for MeridiesAI. Fastify + TypeScript + Prisma (Postgres). Auth and
invite-code contract mirror the `MeridiesUser` shape already used by
`meridies-app/lib/storage.ts`, so the frontend can swap its localStorage mock
for real requests to this API without changing its data model.

## Stack

- **Fastify 5** + TypeScript (ESM)
- **Prisma** + PostgreSQL
- **@fastify/jwt** for auth, **bcryptjs** for password hashing
- **zod** for request validation

## Develop

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL and JWT_SECRET
npx prisma migrate dev    # creates the local schema
npm run dev               # http://localhost:4000
```

`JWT_SECRET` — generate one with `openssl rand -base64 48`.

`DATABASE_URL` — point at any local Postgres, e.g. via Docker:

```bash
docker run -d --name meridies-db -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16
```

## Routes

| Method | Path             | Auth              | Description                                  |
| ------ | ---------------- | ----------------- | --------------------------------------------- |
| GET    | `/health`         | —                 | Liveness check                                |
| POST   | `/auth/signup`    | —                 | Create an account, returns `{ user, token }`  |
| POST   | `/auth/login`     | —                 | Returns `{ user, token }`                     |
| GET    | `/auth/me`        | Bearer            | Current user                                  |
| PATCH  | `/auth/me`        | Bearer            | Partial update (onboarding step/profile/etc.) |
| POST   | `/invites`        | Bearer, counselor | Generate a new `ABC-123` invite code          |
| GET    | `/invites`        | Bearer, counselor | List codes generated + redemption status      |
| POST   | `/invites/redeem` | Bearer, student   | Redeem a code, connects to that counselor     |

Auth is a `Authorization: Bearer <token>` header, issued by signup/login.

The `user` object returned by every route matches `MeridiesUser`:
`{ id, fullName, email, role, onboardingStep, onboardingComplete, inviteCode?, counselorName?, profile? }`.

## Deploy (Railway)

```bash
railway login
railway init                 # or `railway link` if the project already exists
railway add --database postgres
railway variables --set JWT_SECRET=$(openssl rand -base64 48)
railway variables --set CORS_ORIGIN=https://app.meridiesai.com
railway up
```

`DATABASE_URL` is provided automatically once a Postgres service is attached
(reference variable `${{Postgres.DATABASE_URL}}`). `npm run start` runs
`prisma migrate deploy` before booting the server, so schema migrations apply
on every deploy.
