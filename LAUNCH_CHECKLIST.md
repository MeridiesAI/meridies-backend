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
  to re-run them: don't use it against this project until that is reconciled. (Reconciled 2026-10-12,
  X12: `supabase db push` is safe now, and it is what the Apply migrations workflow runs.)
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

- [ ] **Apply migrations workflow** (`.github/workflows/migrations.yml`; setup in
  `DATABASE_MIGRATION_INSTRUCTIONS.md`, "Setup, once"). Add `SUPABASE_ACCESS_TOKEN` and
  `SUPABASE_DB_PASSWORD`, create the `production-db-plan` and `production-db` environments restricted to
  `main`, set `MIGRATION_APPROVERS` (and `MIGRATIONS_REVIEWERS_CONFIGURED=true` only once
  `production-db` has required reviewers), turn on Railway's "Wait for CI", then do one manual run with
  apply off and read the plan before anything is applied. Until the secrets exist the workflow skips
  with a notice and migrations are applied by hand.
- [ ] **The thirteen migrations after `20261022000001`** (`DATABASE_MIGRATION_INSTRUCTIONS.md`, "Not yet
  applied"): the questionnaire sync, import pipeline step 2, caseload transfer, campus photos, the College
  Scorecard figures and emailed meeting invites. Merged ahead of the database on purpose and not applied yet; apply them in that
  section's order, after a backup, when the team decides. Until then each feature says it isn't switched
  on yet (meetings: "Email calendar invites" answers that invites aren't switched on and nothing is
  emailed; imports and caseload transfer answer 503 with a code; photos and the extended Scorecard
  figures read null) and nothing else
  changes. Applying `20261023030003` changes one existing behaviour: removing a firm member who still
  has students is refused until their caseload is transferred or released.
- [ ] **College Scorecard figures** (`DATABASE_MIGRATION_INSTRUCTIONS.md`, "College Scorecard: more
  figures"). When the thirteen above go in, `20261023080001_college_stats_scorecard_more.sql` among them, run the Scorecard load once
  (`POST /internal/ingest/scorecard`); the new profile figures stay empty until it has run. Afterwards
  `GET /internal/status` should not list `scorecard-ingest` under `failing`.

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

- [ ] **College photos** (new; monthly): after applying `20261023070001_college_photos.sql`, run
  `npx tsx --env-file=.env scripts/ingest/college-photos.ts --dry-run`, look the CSV over (bad
  picks go in `scripts/ingest/data/college-photo-picks.csv` as a better title or `none`), then run
  it without `--dry-run` once by hand: `/internal/status` reads the job overdue until its first clean
  run. Then a cron service, monthly (for example `17 4 3 * *`): `POST /internal/ingest/college-photos`,
  same header. It answers 202 and records itself in `ingest_runs`; a first full load is about
  6,000 downloads from Wikimedia and can take an hour.

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
- [ ] **Keep "Confirm email" on** (Auth > Providers > Email). Several sends trust the sign-in
  address as the student's own (due-tomorrow reminders, hand-in verdicts, intake send-backs), and
  `accept_invitation` doesn't compare the account's email with the invitation's: with confirmation
  off, anyone holding an invitation link could sign up as any address and have Meridies mail it.
  The code keeps student-written text out of reminder emails either way, but the address itself is
  only as good as the signup.
- [ ] **Merge the app's signup fix** (meridies-app #16, in review) (`fix/signup-email-confirmation`): confirmation links go through
  `/auth/callback`. Without it, an email signup lands on the Site URL and is never signed in.

---

## P1: features that are built but off until configured

- [ ] **Time saved (monthly ROI report)** (spec `docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md`):
  - apply `20261027000001`-`05` (either order with the code; nothing is in `REQUIRED_SCHEMA`, the routes say
    `kpi_unavailable` until then).
  - add two Railway crons on `POST /internal/kpi/monthly` with the `CRON_SECRET` bearer: daily
    `?purgeOnly=1` at `0 7 * * *` (clears activity signals older than 24 hours, drops tasks idle 14 days),
    and the full run at `0 14 2-7 * *` (finalizes last month and sends its emails; it runs daily on the 2nd to
    the 7th so a send that failed, e.g. over Resend's daily cap, goes out the next day; each email goes once).
    A missed month can be re-run by hand with `?month=YYYY-MM`.
  - `KPI_TRACKING_ENABLED=true` on Railway **only after** the privacy policy's "Time Saved Reports" section is
    live on meridiesai.com/privacy. Until then heartbeats are accepted and ignored (`tracked: false`), and
    completions still count with the signup figures.
- [ ] **Twilio SMS**: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM_NUMBER`
  or `TWILIO_MESSAGING_SERVICE_SID`. Until then, texts stay `queued`. A US number also needs A2P
  10DLC registration before carriers deliver its texts.
- [ ] **`INTEGRATION_TOKEN_KEY`**: generate it with `openssl rand -base64 32`, set it once, and never
  change it. Rotating it disconnects every integration. Set it before anyone connects Google or
  Microsoft.
- [ ] **Google OAuth (picked files, Calendar on request)**:
  - Google connects only files the counselor picks (`drive.file`, through Google Picker) and, when they turn it
    on, Calendar (`calendar.events`). No Gmail, and no restricted scope, so no CASA security assessment.
  - set the Railway variables `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INTEGRATION_TOKEN_KEY` (above),
    `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER`, and only after the backend and app PRs are both live.
    Until they are set every Google route answers 503 (`picker-config`: `picker_not_configured`) and the app hides
    the Drive button.
  - register `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/google`
  - on the consent screen add `drive.file` and `calendar.events` (the scopes `src/lib/oauth.ts` asks for);
    restrict the Picker API key to the Picker API and the app's origin
  - publish the consent screen. `drive.file` and `calendar.events` are not restricted scopes, so no third-party
    security assessment is needed, but until Google verifies the app it stays in Testing mode (100 test users,
    tokens expire after 7 days): add each counselor as a test user until then.
  - run `scripts/smoke/google-picker.md` once by hand against the deployed setup
- [ ] **Do not set `NODE_OPTIONS=--max-old-space-size` on Railway.** The PDF text worker caps its own heap at
  256 MB with `resourceLimits`, and a process-wide heap flag can override that limit.
- [ ] **Microsoft OAuth** (keep it off in production, no `MICROSOFT_*` vars, until browsing moves to Microsoft's
  picker with the narrowest scope that works; `Files.Read.All` reads the whole drive and is not shippable):
  - register the app in Entra ID as multi-tenant plus personal Microsoft accounts (one prod, one dev)
  - set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`; the secret expires (24 months at most): put the
    renewal date on the calendar
  - register `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/microsoft`
  - leave `MICROSOFT_TENANT=common`
  - **publisher verification** (a Microsoft Partner Network ID tied to the meridiesai.com domain). Without it,
    work and school tenants show the app as unverified and many block user consent outright since Nov 2020.
  - API permissions match the code: `openid`, `email`, `offline_access`, `User.Read`, the files scope, and
    `Calendars.ReadWrite` (asked only when a counselor turns Calendar on). No `Mail.Send`.
- [ ] **Leaked-password protection**: Supabase Auth > Attack Protection. Needs the Supabase Pro plan;
  the project is on Free, which also has no daily backups. The upgrade is pending a team decision.

- [ ] **Import pipeline step 2 (the Import page)**: apply `20261023020001`-`20261023020003`
  (`DATABASE_MIGRATION_INSTRUCTIONS.md`); confirm `IMPORT_DATABASE_URL` (logs in as `import_worker`
  through the session pooler) and the `/internal/imports/sweep` cron (every 5 to 15 minutes, which now
  also runs retention); set `IMPORTS_PILOT` to the pilot practices' ids (`IMPORTS_ROLLOUT` defaults to
  `pilot`; `all` once spec §13's blockers are cleared: five real anonymized exports tested and
  Anthropic zero data retention confirmed in writing). Changing the pilot list needs a redeploy.
  Leave `IMPORT_HOLD_EXPIRY_ENABLED` unset until the app's Ready to apply page is live, then run the
  grace update in the runbook and set it to `true`.

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
- [ ] A meeting booked with "Email calendar invites" (`20261023090001` applied) reaches a test
  student as an invite that adds to the calendar, then a move updates it and a cancel removes it, in
  Gmail, Outlook.com, Outlook desktop and iOS Mail (Outlook desktop may show the attached file rather
  than an inline meeting request: note what each client does). Each send is a `message_deliveries`
  row with the meeting's `meeting_id`; needs the verified Resend domain above
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
