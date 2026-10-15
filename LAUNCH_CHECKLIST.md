# Launch checklist: Demo v10

What is left to take the v10 backend and app live. Work top to bottom: each section assumes the ones
above it are done. Database steps are in `DATABASE_MIGRATION_INSTRUCTIONS.md`; this file links to it
rather than repeating it.

**State on 2026-10-06:** the v10 code is deployed (`main` on Railway and Vercel, PR #14 in both repos),
the 24 v10 migrations are applied, and P0 is done apart from merging the signup fix.

---

## P0: today, in this order

### Database

- [x] **Backup** (§1). Done 2026-10-06. `student_aid_profiles` and `student_aid_checklist`, the only
  tables `20261005030002` deletes from, had 0 rows, so the migration deletes nothing. Their (empty)
  exports are kept outside the repo.
- [x] **Where the database is** (§2). `student_red_flags` exists; no v10 table does.
- [x] **Apply the 24 migrations** (§3). Done 2026-10-06 through the Supabase Management API
  (`POST /v1/projects/{ref}/database/query`), one transaction per file, each version recorded in
  `supabase_migrations.schema_migrations`. All 24 applied without errors. The earlier migrations are
  recorded under dashboard timestamps rather than their file names, so `supabase db push` would try
  to re-run them: don't use it against this project until that is reconciled.
- [x] **Verify** (§4). Done 2026-10-06:
  - `node --env-file=.env scripts/verify-v10.mjs` prints `All checks passed.` (Use this rather than
    the "24 rows in `schema_migrations`" query: the SQL editor doesn't record versions, so that query
    returns 0 on Option B.)
  - The RLS query returns `0`.
  - Dashboard > Advisors > Security shows no new warnings. The remaining warnings are expected:
    security-definer RPCs that signed-in users call by design (each scopes to `auth.uid()`),
    service-role-only tables with no policies, and leaked-password protection (P1). A stray
    `public.test` table predates v10. Check what it is and drop it if it's unused.

- [ ] **AI context and research migrations** (`DATABASE_MIGRATION_INSTRUCTIONS.md`, last section). Apply
  `20261016000001_context_documents.sql` (the document kinds, `ai_access` and `ferpa_waived` the context layer
  reads), then `20261016000002_research.sql` (hidden counselor tasks, `research_runs`, `recommendations`,
  `research_blocked_domains`), each before deploying the code that needs it. Never set `RESEARCH_FAKE` on
  Railway: the server refuses to boot with it unless `NODE_ENV` is `development` or `test`.

### Railway variables

- [x] `NODE_ENV=production`
- [x] `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (both crons answer 503 without
  the service-role key)
- [x] `ANTHROPIC_API_KEY` (AxIS and the essay tools answer 503 without it)
- [x] `CORS_ORIGIN` includes `https://app.meridiesai.com`
- [x] `APP_URL=https://app.meridiesai.com`
- [x] `RESEND_API_KEY` and `INVITE_FROM_EMAIL` are set
- [x] `CRON_SECRET` is at least 32 characters (`openssl rand -base64 48`); the API refuses to boot
  with a shorter one
- [x] The stale `DATABASE_URL` and `JWT_SECRET` are removed

### Railway crons

- [x] **Accountability sweep** (done 2026-10-06 as `SWEEP_INTERVAL_MINUTES=15`, no cron service): `POST /internal/accountability/sweep`, every 15 minutes, with
  `Authorization: Bearer $CRON_SECRET`. Or set `SWEEP_INTERVAL_MINUTES` instead; one is enough
  (`AGENTS.md`, Scheduled jobs).
- [x] **Message dispatch** (new in v10; done 2026-10-06 as the `dispatch-cron` service, `curlimages/curl`,
  every 10 minutes, `CRON_SECRET` as a reference to `${{meridies-backend.CRON_SECRET}}`): `POST /communication/internal/dispatch`, every 5 to 15
  minutes, same header. It has no in-process alternative. Without it, scheduled messages and those
  held for quiet hours never send.

### Vercel variables (meridies-app)

- [x] `NEXT_PUBLIC_API_URL=https://meridies-backend-production.up.railway.app` (set with a trailing slash;
  `lib/api.ts` strips it)
- [x] `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

### Email and auth

- [x] **Resend**: the sending domain is verified, and `INVITE_FROM_EMAIL` uses it. Until then, invites
  to anyone but the Resend account owner fail.
- [x] **Supabase Auth SMTP**: Auth > SMTP Settings points at Resend (`smtp.resend.com`, port 465,
  user `resend`, the API key as password) with a sender on the verified domain. Supabase's built-in
  mailer only delivers to the project's team members and is rate limited, so signup confirmations
  to real counselors never arrive without this.
- [x] **Supabase Auth URLs**: the Site URL is `https://app.meridiesai.com`. The redirect allow-list
  includes `https://app.meridiesai.com/**` and `http://localhost:3000/**`, which covers
  `/auth/callback` and `/join/*`.
- [x] **Google sign-in**: Auth > Providers > Google is enabled with a client id and secret. Its
  redirect URI in Google Cloud is `https://kerstlpuvpmstiavxblv.supabase.co/auth/v1/callback`.
  This is a different redirect from the Files integration below, and can be the same Google client.
- [x] **Remove the redirect entry `https://*meridiesai.com`** (done 2026-10-06). With no dot after `*` it also matches
  look-alike domains such as `fakemeridiesai.com`, which could receive login links.
  `https://app.meridiesai.com/**` already covers the app.
- [ ] **Merge the app's signup fix** (meridies-app #16, in review) (`fix/signup-email-confirmation`): confirmation links go through
  `/auth/callback`. Without it, an email signup lands on the Site URL and is never signed in.

---

## P1: features that are built but off until configured

- [ ] **Twilio SMS**: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM_NUMBER`
  or `TWILIO_MESSAGING_SERVICE_SID`. Until then, texts stay `queued`. A US number also needs A2P
  10DLC registration before carriers deliver its texts.
- [ ] **`INTEGRATION_TOKEN_KEY`**: generate it with `openssl rand -base64 32`, set it once, and never
  change it. Rotating it disconnects every integration. Set it before anyone connects Google or
  Microsoft.
- [ ] **Google OAuth (Files, Gmail, Calendar)**:
  - set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
  - register `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/google`
  - add the scopes `src/lib/oauth.ts` asks for to the consent screen, including `drive.file` (new
    in v10). Counselors who already connected must reconnect once.
  - **Submit the app for Google verification and publish the consent screen.**
    `drive.readonly` and `gmail.send` are restricted scopes, and `calendar.events` is sensitive.
    Until Google verifies the app, it stays in Testing mode: only listed test users (100 max) can
    connect, and their tokens expire after 7 days. Restricted scopes can require a third-party
    security assessment, which takes weeks, so start early. Until then, add each counselor as a
    test user.
- [ ] **Microsoft OAuth**:
  - set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`
  - register `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/microsoft`
  - leave `MICROSOFT_TENANT=common`
- [ ] **Leaked-password protection**: Supabase Auth > Attack Protection. Needs the Supabase Pro plan;
  the project is on Free, which also has no daily backups. The upgrade is pending a team decision.

---

## P2: production smoke test

Run against app.meridiesai.com and Railway once P0 and P1 are done.

**Auth and onboarding**
- [ ] Counselor email signup → the confirmation email arrives → onboarding → `GET /auth/me` returns
  a counselor with `onboardingComplete`
- [ ] Google signup → `/auth/callback` → the role is confirmed once, and a second visit doesn't crash
- [ ] Invite → the email arrives from the verified domain → `/join/<token>` → the student appears on
  the roster

**v10 screens and data**
- [ ] These screens load: My Work Queue, a student's four sections (college list, application with
  essays, financial aid, communication), Contact Pipeline and Payment Tracker, Management, Calendar,
  Events Hub
- [ ] Catalog surfaces return rows: colleges, aid ratings, scholarships, and class rank (or its
  `unavailableReason`)

**Messaging and background jobs**
- [ ] A task with email + SMS produces two `sent` rows in `message_deliveries`
- [ ] A scheduled message sends within one dispatch interval (this proves cron 2 runs)
- [ ] The sweep raises a stall alert with no dashboard open (this proves cron 1, or the interval,
  runs)

**Integrations and AI**
- [ ] Google and Microsoft connect store tokens, the Drive pick works, the Meet link is real, and the
  doc tracker sees edits
- [ ] AxIS streams from `/chat` and keeps its traces
- [ ] Coherence returns bullets, not prose (the essay guardrail)

**Health**
- [ ] `curl https://meridies-backend-production.up.railway.app/health` returns 200 with
  `database: true` and no secrets in the body. (The 503 path when the database is unreachable is in
  `src/routes/health.ts`; don't take production down to test it.)
- [ ] The same response has `anthropic: true`. `null` is fine only right after a deploy (the first
  key check hasn't answered yet; ask again in a few seconds). `false` means a key problem: the key is
  unset, or Anthropic refused it (401/403). A timeout or an Anthropic outage never reads `false`.
- [ ] Re-run `scripts/verify-v10.mjs` and the security advisors

---

## P3: housekeeping

- [ ] Merge or close the open PRs, in both repos: #15 (AGENTS commit rule) and #2 (PR template).
- [ ] Delete stale remote branches in both repos: `claude/*`, `feat/llm-assistant`, and merged
  `fix/*`. Also in the backend: `feat/supabase-data-layer-and-api`. Also in the app:
  `feat/google-auth-and-live-data` and `design/match-landing-design-language`. Check each is merged or
  abandoned before deleting.
- [ ] Mark the backend section of `context/TODO.md` (and `context/BEFORE_LIVE.md`) as superseded by
  this file
- [ ] Railway: the `Postgres` service in the backend project is unused since `DATABASE_URL` was
  removed. Ask the workspace owner before deleting it.
- [ ] Optional: seed Events Hub listings and webinar tips, or accept their empty states
