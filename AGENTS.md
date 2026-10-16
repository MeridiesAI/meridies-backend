# Meridies Backend — Agent Guide

> **Repo:** `MeridiesAI/meridies-backend` · **Deploy:** Railway API
>
> Read the monorepo onboarding doc at `MeridiesAI/context` (`README.md`) for cross-repo conventions.

## What this repo is

**The API for Meridies.** Fastify 5, Node ≥20, ESM, TypeScript strict.

Auth, profiles, invites, student records, deadlines, financial aid,
accountability, the opportunity concierge, and all Anthropic AI routes for the
production app (`meridies-app`). Since the v10 sync it also serves what the
Demo v10 product shows: My Work Queue, pins, admission outcomes and alumni,
referrals, Mass invite, the student page's four sections (College list,
Application, Financial aid, Communication), Colleges search and Build College
Lists, Events Hub, Contact Pipeline with its Payment Tracker, Management, email
templates and the Calendar feed. SV Demo v2 adds the signed-in student's own
view: overview and preferences, a read-only strength profile, their To-Do,
My documents and Profile Update (see "The student view" below). `meridies-demo` is the source of truth for
what these look like and do; this repo makes them real.

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
│   ├── access.ts          # counselor approval: the one definition (request gate + jobs)
│   ├── accessReview.ts    # the emailed one-time review link, its page and email
│   ├── guards.ts          # requireRole, assertCanView/EditStudent, resolveStudentId
│   ├── collection.ts      # generates the student-scoped CRUD routes
│   ├── classRank.ts       # weighted GPA -> percentile, or null. See below
│   ├── polygonHistory.ts  # buckets the recorded axis history; never invents one
│   ├── preferences.ts     # the card-sort read-out
│   ├── invites.ts         # invite tokens (shared by /invites and /roster), intake fields
│   ├── limits.ts          # DB-backed rate limits + spend quotas
│   ├── accountability.ts  # stall detection, escalation sweep, anti-spam throttle
│   ├── sweepSchedule.ts   # scheduled sweep: every counselor, under a Postgres lease
│   ├── anthropic.ts       # model wrapper, ai_runs audit, essay guardrails
│   ├── proseGuard.ts      # the essay gate on streamed answers (AxIS, /chat): first-person cap
│   ├── anthropicKeyCheck.ts # /health's key check: only a 401/403 marks the key bad, cached
│   ├── email.ts           # Resend email + Twilio SMS, message_deliveries audit
│   ├── links.ts           # the ONLY user-supplied-URL fetch — see below
│   ├── oauth.ts           # Google/Microsoft OAuth (code + PKCE), token refresh/revoke
│   ├── tokenCrypto.ts     # AES-256-GCM for tokens at rest (INTEGRATION_TOKEN_KEY)
│   ├── suiteApi.ts        # Drive/OneDrive files, Calendar events with Meet/Teams
│   ├── liveDocuments.ts   # live edit times of linked files, for the task tracker
│   ├── serialize.ts       # rows -> the DTOs meridies-app declares
│   ├── parentAlertDelivery.ts # carries a queued parent alert; records what happened
│   ├── massInvite.ts      # Mass invite: deterministic parse first, AxIS sorts second
│   ├── outcomes.ts        # admission outcomes read per high school; CDS flags only with data
│   ├── studentPage.ts     # info card, derived polygon scores, recorded-growth scrubber
│   ├── studentApplication.ts # College list board + Application DTOs and rules
│   ├── supplementDocs.ts  # supplement Google Docs under drive.file
│   ├── documentText.ts    # .txt/.md/.docx text on the server, for word counts (10 MB cap, linear scans)
│   ├── linearText.ts      # tag/block stripping and line trims in linear time, for text a user supplied
│   ├── studentAid.ts      # Financial aid page: FAFSA status + due date only, matching
│   ├── inviteDelivery.ts  # an invitation's (or a composer attempt's) delivery status, as the webhooks left it
│   ├── deliveryInsert.ts  # the delivery row insert, degrading while invitation_id or meeting_id is missing
│   ├── ics.ts             # RFC 5545 meeting invite files: stable UID, SEQUENCE, escaping, 75-octet folding
│   ├── meetingInvites.ts  # emailed meeting invites: who gets what, fail-closed recipients, sent after the response
│   ├── meetingCalendar.ts # a meeting's calendar event: only its owner's, only with the caller's own token
│   ├── studentMessages.ts # Communication composer: frozen recipients, gated delivery
│   ├── collegesV10.ts     # Colleges search query/cards, official stats + freshness, decision rounds, list builder
│   ├── scorecardCodes.ts  # labels for the coded Scorecard fields (Carnegie, predominant degree, completion windows)
│   ├── ingest/            # scorecard.ts (catalog), ipeds.ts (admission factors), curated.ts (team CSVs), events.ts (Events Hub CSV), collegePhotos.ts + wikimedia.ts (campus photos), linkCheck.ts, run.ts
│   ├── collegePhotos.ts   # a college's campus photo as every college surface serves it; null without the migration
│   ├── eventsHub.ts       # Events Hub feed, recommendations, calendar saves
│   ├── eventsDiscovery.ts # colleges' own upcoming events and visit pages, found and checked weekly
│   ├── rosterColleges.ts  # which colleges a roster's lists point at, most-listed first
│   ├── crm.ts             # the practice workspace (firm or solo) for pipeline/management
│   ├── caseloadTransfer.ts # caseload transfer: bodies, DTOs without addresses, emails, removal fallback
│   ├── payments.ts        # Payment Tracker arithmetic; nothing stored
│   ├── practiceFolders.ts # the two practice system folders, created lazily
│   ├── calendarFeed.ts    # the Calendar's one feed of everything dated
│   ├── practiceSettings.ts # Data & privacy switches, enforced (AI summaries, document reading, report sharing)
│   ├── heartbeat.ts       # job_heartbeats: each cron's last clean run, for /internal/status
│   ├── collegeIntel.ts    # NL search filters, proposal rules, the per-student summary (no model)
│   ├── studentView.ts     # the student's own preferences (banner, theme, reminder channels)
│   ├── profileUpdates.ts  # Profile Update: draft validation, completeness, filing into the sheets
│   ├── intakeFills.ts     # what the onboarding questionnaire filled, for the info card and sheet marks
│   ├── gpa.ts             # GPA scale: fourPointGpa, null for non-4/5-point scales
│   ├── imports/           # import pipeline: worker pool + role check, job runner, name rule, textShapes (linear cell checks);
│   │                      #   step 2: parse (capped child process), profile + masking, plan + presets + AI mapping,
│   │                      #   rows + matching, staging, review, invitations, retention, rollout flag
│   ├── context/           # the AI context layer: allowlist, section loaders, packing, document rule
│   ├── research/          # research: brief + identity filter, prompts, citation keeper, run, accept, test double
│   ├── submissionReview.ts # AxIS checks a handed-in file against its task, moves the task, notifies
│   ├── studentReminders.ts # due-tomorrow reminders on the student's own text/email channels
│   ├── axis/              # AxIS v2 on Haiku 5.5: understanding in code, direct answers, planner, loop, grounding, memory, fail-safes
│   │   └── ops/           # what AxIS can change: the operation catalog, run through this API as the counselor
│   └── errors.ts, chat.ts
├── routes/
│   ├── imports.ts         # import requests, held-data queue, status, sweep (thin)
│   ├── aiContext.ts       # /students/:id/ai-context   what AxIS sees for a student (counselor)
│   ├── research.ts        # /students/:id/research/:feature, /recommendations   research and its results (counselor)
│   ├── health.ts, auth.ts, invites.ts, students.ts, deadlines.ts
│   ├── records.ts, intake.ts, aid.ts, accountability.ts
│   ├── tasks.ts, files.ts, blasts.ts, firms.ts, colleges.ts
│   ├── preferences.ts, meetings.ts, notifications.ts
│   ├── integrations.ts, reports.ts, roster.ts
│   ├── opportunities.ts, ai.ts, chat.ts
│   ├── axis.ts            # /axis         AxIS v2 turn (SSE), cache pre-warm, proposals (counselor)
│   ├── workItems.ts       # /work-items   My Work Queue
│   ├── pins.ts            # /pins         pinned students, per consultant
│   ├── outcomes.ts        # /outcomes, /alumni   outcomes, Close cycle, alumni
│   ├── referrals.ts       # /referrals    post-application referrals
│   ├── overviewSummaries.ts # /overview   Overview card summaries, one request
│   ├── application.ts     # /application  College list + Application sections
│   ├── applicationAi.ts   # /application  their AxIS calls (lists, coherence, activities)
│   ├── studentPage.ts     # /student-page info card, polygon, private note
│   ├── studentAid.ts      # /student-aid  Financial aid page, scholarship matching
│   ├── communication.ts   # /communication composer; /communication/internal/dispatch (cron)
│   ├── collegesV10.ts     # /colleges     search (search_colleges RPC), filters, profile extras, list builder
│   ├── collegeAi.ts       # /ai           college research, Build College Lists bar
│   ├── events.ts          # /events       Events Hub
│   ├── myEvents.ts        # /me/events    the student's Events tab
│   ├── pipeline.ts        # /pipeline     Contact Pipeline + Payment Tracker
│   ├── management.ts      # /management   consultants, consultant tasks, staff blast, caseload transfer
│   ├── emailTemplates.ts  # /email-templates per-consultant templates, AxIS drafts
│   ├── search.ts          # /search       top-bar search: students, invited students, colleges, work items
│   ├── resources.ts       # /resources    resource library, pins, resource -> deadline, cited Q&A
│   ├── collegeIntel.ts    # /colleges     AI search, cited research, catalog proposals, student summary
│   ├── settings.ts        # /settings     Data & privacy (practice_settings)
│   ├── account.ts         # /account      data export (self, a student), account deletion
│   ├── accessReview.ts    # /access-review/:token   Meridies approves a pending counselor
│   ├── webhooks.ts        # /webhooks     Resend + Twilio delivery status (signed)
│   ├── calendar.ts        # /calendar     feed, event types, practice events
│   ├── me.ts              # /me           the student view: overview, preferences, settings, polygon (read-only)
│   ├── profileUpdates.ts  # /profile-updates  Profile Update (AxIS); /students/:id/profile-updates
│   └── internal.ts        # CRON_SECRET machine routes (sweep, catalog, link check, events, photos, imports)
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

**Don't lean on RLS to find a counselor's rows.** A list over all of a
counselor's students with no student filter makes Postgres read every
practice's rows and run the RLS helpers on each one, so the page slows down as
other practices grow (the speed test below caught the calendar feed and
`GET /tasks` doing this). Name the students: `caseloadStudentIds(request)`
(`lib/guards.ts`) returns exactly what `private.can_view_student` allows (the
roster, archived included, the students shared with them, and the caller), or
null past 250 ids, when the query runs unscoped as before. RLS still applies on top.

### Schema

`supabase/migrations/*.sql`, applied to the Supabase project. Every migration
ships its own RLS policies so no table is ever created unprotected.

**How migrations reach production.** `.github/workflows/migrations.yml`
("Apply migrations"): on a merge to `main` that touches `supabase/migrations/**`,
or a manual run, the plan job (no approval) dry-runs `supabase db push` and
writes the pending files, their header lines and any destructive statements
(`scripts/migrations/plan.mjs`) to the run summary. The apply job waits for the
`production-db` environment; a push applies only when
`vars.MIGRATIONS_REVIEWERS_CONFIGURED` says reviewers exist, otherwise an
approver in `vars.MIGRATION_APPROVERS` runs it by hand with apply on and confirm
set to the newest version. It re-checks the list (refusing if it changed),
pushes, and fails on any table it left without RLS or the approval gate
(`scripts/migrations/problems.sql`, run only when its sha256 matches
`PROBLEMS_SQL_SHA256` in the workflow: change both together). The plan holds
the same write-capable credentials as the apply with no approval, so in the
plan every secret-holding step runs before any of our code; the runbook says
what is left and how to close it (a read-only credential for
`production-db-plan`, CODEOWNERS). Without `SUPABASE_ACCESS_TOKEN` /
`SUPABASE_DB_PASSWORD` it skips green with a notice. The code and its migration
land minutes apart in no guaranteed order (with Railway's "Wait for CI" the
migration's own commit deploys after it, a later merge that touches no
migration does not wait), so every migration still states its deploy order: what
happens if the code runs first, and whether it belongs in `REQUIRED_SCHEMA`.
The other direction too: a migration applies while the previous build still
serves, so it must be safe for that build; drops and renames go in a later PR,
after the code that reads the old shape has shipped. Never `--include-all` on
production: a file older than production's newest version gets a new
timestamp. The CLI version is pinned in both workflows (a unit test checks they
match). Runbook, setup and recovery: `DATABASE_MIGRATION_INSTRUCTIONS.md`.

**Merged but not yet applied to production.** Everything after
`20261022000001`: the questionnaire sync (`20261023010001`-`04`), import
pipeline step 2 (`20261023020001`-`03`), caseload transfer
(`20261023030001`-`03`), campus photos (`20261023070001`), the extended
College Scorecard columns (`20261023080001`), emailed meeting invites
(`20261023090001`), the meeting owner guard (`20261024000011`-`12`, a security
fix that depends only on applied files and can go in ahead of the rest),
the RLS and ownership fixes (`20261024000021`-`25`, below), the
submission-review and reminder security fixes (`20261024000041`-`43`),
the security review's chat lock (`20261024000051`, restrictive inserts only;
the API already refuses students on `/chat`), the per-counselor import
invitation review and the same-student rule for held data (`20261024000061`-`62`), the campus photo review queue
(`20261024000071`), the profile size trigger (`20261024000081`) and the
caseload transfer's file rule (`20261024000082`, which replaces
`transfer_caseload` from `20261023030002`). They go in later, in filename order
(`DATABASE_MIGRATION_INSTRUCTIONS.md`, "Not yet applied"). None of them is in
`REQUIRED_SCHEMA`, and the code runs without them: every existing screen and
route works as before (origin/main's persona suites pass against a database
that has none of them), and each new feature says it isn't switched on yet
rather than failing: `503 imports_unavailable` (and `GET /imports` reads
`available: false`), `503 caseload_transfer_unavailable` (removing a firm
member falls back to the old function), `invites: { status: "unavailable" }`
on meetings, `photo: null` on colleges, the extended Scorecard figures null
on extras and Compare (the monthly load writes the older ones and stays
clean), `fromQuestionnaire: []` and
`transferredFrom: null` on the info card, and a questionnaire save that copies
nothing. Keep it that way until they are applied: a feature that needs one of
these files degrades, it never 500s.

**The v10 sync added 24 migrations (`20261005*`)**, applied by hand on
2026-10-06 before the workflow existed. `DATABASE_MIGRATION_INSTRUCTIONS.md`
keeps that runbook as history (backup first: `20261005030002` deletes FAFSA data
on purpose; the order; what each file changes in place; the two settings
outside the database, Google's `drive.file` scope and the dispatch cron).
`node --env-file=.env scripts/verify-v10.mjs` checks, read-only, that every
table the 24 files create exists. `LAUNCH_CHECKLIST.md` is everything else
left before going live (Railway, crons, Supabase Auth, Resend, OAuth, smoke test).
`private.attach_student_policies()` stamps the standard student-scoped shape;
use it rather than hand-writing four policies and getting one wrong.

**The catalog seed** is `20260923000001_seed_catalog.sql`, generated by
`scripts/seed/generate-catalog.ts` from the meridies-demo fixtures (edit the
script, then `MERIDIES_DEMO_DIR=../meridies-demo npx tsx
scripts/seed/generate-catalog.ts > supabase/migrations/20260923000001_seed_catalog.sql`).
Apply it like any migration (the Apply migrations workflow; by hand,
`supabase db push`). It is idempotent (ON CONFLICT / WHERE NOT EXISTS)
and never updates a row that already exists, so re-running it will not overwrite
hand corrections. It fills only what a fixture states: no scattergram points (the
demo's are PRNG output), no admission stats (no cohort year), and
`source_verified_at` is null everywhere until someone verifies the rows.
`20261005040004_seed_college_v10.sql` comes from the same script with
`--v10` (profile facts, curated admitted polygons, CDS editions, programs and
the Build College Lists catalog), under the same rules.

Two things the database enforces that the API must not be trusted to:

- **`profiles.role` is not writable by `authenticated`.** The table-level UPDATE
  grant was dropped and re-issued per column. Role changes go through
  `confirm_user_role()`, which succeeds exactly once. Same for `counselor_id`,
  which only `accept_invitation()` writes.
- **Only `accept_invitation()` marks an invitation accepted**
  (`20261024000023`). The client UPDATE grant on `invitations` covers what
  the app edits (status, the New student card's fields, intake requests,
  `dismissed_at`, `confirmed_at`, `submitted_at`), and
  `private.invitations_guard_client` lets a client move status only
  pending -> revoked, set `confirmed_at` only once accepted and
  `submitted_at` only back to null, and insert only a pending row. The API
  doesn't trust an accepted state either: `PATCH /invites/:id` acts on an
  acceptance (receive, send back, confirm) only when the accepted profile is
  a student on the caller's roster (`acceptedStudentOnRoster`), so it holds
  on a database without the migration. A task's
  `intake_invitation_id` / `intake_request_id` are written only by
  `sync_intake_tasks`, and the sync back touches only an invitation the
  task's own student accepted.
- **Invitation tokens can't be enumerated.** Counselors invite students by email
  (`routes/invites.ts` → Resend via `lib/email.ts`); the emailed link carries an
  unguessable token. There is no SELECT policy that exposes a pending invite to
  the invitee — `invitation_preview()` and `accept_invitation()` are SECURITY
  DEFINER, so an invite has to be *received*, not discovered.
- **A counselor is pending until Meridies approves them** (`20261017000001`,
  spec `docs/superpowers/specs/2026-10-10-counselor-approval-gate-design.md`).
  `profiles.counselor_approved_at` is not writable by `authenticated`.
  `private.is_counselor` means "an approved counselor", so policies and
  functions that ask it refuse a pending or revoked one, and
  `accept_invitation` refuses a student joining one. Approval is permanent:
  nothing expires it, and only a revoke removes it. The API gate is in
  `app.authenticate` (the row it loads per request, never a token claim): a
  pending counselor gets `403 { code: "account_pending" }` on every route that
  does not set `config: { allowPending: true }`. New routes are closed by
  default; open one only for the caller's own account. Jobs on the service
  client or the import pool skip RLS, so they call `isCounselorApproved` /
  `approvedCounselorIds` (`lib/access.ts`) when they run, failing closed;
  `test/unit/service-callsites.test.ts` fails when a new elevated call site
  has not been reviewed. Approve: the emailed link (`/access-review/:token`,
  single-use, 7 days; opening it changes nothing, the button approves), or by
  hand `update profiles set counselor_approved_at = now(),
  counselor_approved_via = 'team' where id = '<profile id>'`. Revoke, as
  `postgres`: `select private.revoke_counselor_access('<profile id>');` (also
  revokes their pending student and firm invitations; members they approved
  through a firm stay approved, and a revoked account is never auto-approved
  by a firm invitation). A counselor who accepts a firm invitation is approved
  only when the inviter is, at that moment, an approved owner or admin.
  The roster helpers (`is_counselor_of`, `can_edit_student`, and through them
  `can_view_student`) ask about approval too, and every public table plus
  `storage.objects` carries a restrictive `approval_gate` policy: an
  unapproved counselor's database is their own `profiles` row and nothing
  else. **A migration that creates a table must call
  `private.attach_approval_gate('public.<table>')`**; `approval-db.test.mjs`
  fails when a table is missing it. What the gate does not cover: a SECURITY
  DEFINER function that returns data without going through those helpers.
  The review link's token is stored only as a hash: the delivery record keeps
  the email without its link (`sendEmail`'s `recordText`), and request logs
  drop the token (`lib/requestLog.ts`).

### Three rules the schema encodes, and why they are not the obvious shape

- **`student_alert_prefs` and `student_status_overrides` are not
  `attach_student_policies` tables.** The standard student-scoped shape lets the
  student write, and here that is exactly wrong: it would let a student switch
  off the accountability alerts their counselor sends about them. Alert prefs
  are counselor-written and student-readable; a status override ("at risk") is a
  private professional assessment and is counselor-only in both directions, the
  same reasoning that keeps `parent_alerts` away from the student they concern.
- **`polygon_axis_history` is append-only and trigger-written.** Select and
  insert policies only, filled by `private.polygon_axes_record_history()` on the
  axes themselves, so no route can forget to record a change and no counselor
  can tidy the past. The demo models growth backwards from today's scores;
  `lib/polygonHistory.ts` deliberately does not — a student with two weeks of
  history gets two weeks of chart.
- **Class rank returns null rather than a guess.** Roughly one high school in
  six publishes no profile, so `lib/classRank.ts` interpolates only *between*
  two published bands and never past the strongest one. `GET
  /high-schools/:id/rank` carries an `unavailableReason` instead of a number. A
  national assumption wearing a specific school's name is worse than no answer,
  because a counselor would repeat it to a family.

### What the v10 sync's schema enforces, and why

Each of these is decided in the database, so a route written later can't
forget it.

- **FAFSA: status and due date, nothing else (v5, narrowed by v8).**
  `fafsa_status` is `not-started | in-progress | submitted`, beside
  `fafsa_due_date`; `fafsa_submitted_at` and `efc_estimate` are dropped, the
  per-school `fafsa` checklist item is deleted and refused by the CHECK, and
  there is no SSN anywhere. Where a student needs an aid form outstanding,
  that form is the CSS Profile. A school's published aid *policy* ("FAFSA
  only") is catalog data and stays. Don't add a FAFSA field back because v4
  asked for one.
- **The Communication composer is counselor-only, and what it wrote stays
  written.** `student_messages` is readable and writable only by the
  student's counselor (`is_counselor_of`), never by the student. The client
  UPDATE grant covers status and delivery columns only, so the body and the
  recipients can't change after the fact, and there is no delete. Recipients
  are frozen on the row when it is written, so a scheduled message reaches
  the people the counselor saw in the To line — but whether they *may* still
  receive it is re-decided at dispatch (`sendBlockedReason` in
  `lib/studentMessages.ts`): the student still on this counselor's roster and
  not archived, parents still switched on, each guardian still on file with
  alerts on and the same address, an email to the student still addressed to
  their sign-in email, an alert still clear of the throttle. The student is
  written to at their sign-in email (`profiles.email`), never the
  student-writable `student_personal_details.contact_email` (the info card's
  email is a recorded detail, not a destination), the same rule as meeting
  invites and the due-tomorrow reminders.
  Anything unreadable holds the send; a refusal cancels it with the reason.
  A row is not proof the route wrote it, so dispatch keeps only recipients
  the composer would have resolved itself (`allowedRecipients`): the student
  by id at their sign-in email or phone on file, or a guardian of this
  student still receiving messages at the same address; it sends to the
  addresses on file, never the row's. A text to the student goes to their
  phone on file at send time. An email goes to their sign-in email, and one
  frozen with another address (scheduled when the contact email was
  followed, or before a sign-in email change) is cancelled; changing the
  contact email neither redirects nor cancels a message. A guardian must
  still have the address the row froze. The cron also
  sends at most `DISPATCH_DAILY_CAP` (100) messages a day per counselor,
  whoever wrote the rows: over it a row waits an hour and is tried again
  (`hold_reason` says so), nothing is dropped. In the database
  (`20261024000024`) a client insert must name exactly such recipients and
  start `queued` or `scheduled`, and a counselor's client inserts are
  capped at 200 a day (`consume_rate_limit`, errcode 54000, which the route
  answers as 429); the check answers only for the caller's own student, so
  a foreign insert always fails at RLS the same way and the guard can't be
  used to test guesses at someone's address. A client update moves status
  only scheduled -> cancelled or queued -> sent | failed | cancelled, and
  `scheduled_for` is the dispatch cron's alone. Addresses on file are
  counselor-writable (guardians, contact email, phone), so what bounds a
  counselor's sending is the volume: the route's 30 an hour and 100 a day,
  and the two caps above for rows written any other way. Follow-up, in a
  later PR once this build is live: insert on the service client and
  revoke INSERT from `authenticated` (doing it now would break the serving
  build's composer the moment the migration applies).
  A composer alert counts toward the parent-alert throttle, so the sweep can't
  send a second alert right behind a hand-written one.
- **`student_private_notes` is counselor-only both ways**, the same reasoning
  as status overrides: the "Add notes" box is a professional's private read.
- **The Contact Pipeline is the practice's workspace, never the student's.**
  A counselor in a firm shares the firm's pipeline; a solo counselor has their
  own (`crm_my_workspace()`, `private.crm_can_access`; `lib/crm.ts` reads the
  answer). Insert policies pin new rows to the caller's workspace, a guard
  trigger keeps a contact's stage and owner inside it, and the linkage columns
  (`student_id`, filled by a trigger when the invitation is accepted, and
  `stage_entered_at`, reset by a trigger on every stage change) are withheld
  from the client UPDATE grant so days-in-stage can't be backdated. A
  stage's lifecycle group (Prospect, Lead, Client, Current) lives on the stage,
  never on the contact. No student reads any of it.
- **Payment Tracker balances are derived, never stored.** `pipeline_packages`,
  `pipeline_invoices` and `pipeline_payments` hold integer cents and nothing
  else; there is deliberately no balance or status column. `lib/payments.ts`
  settles payments against the oldest invoice first and calls an invoice
  overdue from its due date, every read. Invoices are voided, not deleted, and
  invoices and payments RESTRICT their package, so a contact with billing
  history can't be deleted. Billing rights: a solo counselor, or in a firm its
  owners/admins and the contact's owner (`private.crm_can_bill`). The tables
  are `pipeline_*` because `public.invoices` is subscription billing.
- **`consultant_tasks` (Management) are visible to the assignee, the assigner
  and the firm's owners/admins, and nobody else.** Anyone may assign
  themselves a task; only an owner or admin assigns to another firm member,
  and a task about a student requires that student on the *assignee's*
  caseload. The assignee ticks it off; only the assigner or an admin deletes
  it. Firm owners count as admins without a `firm_members` row.
  `firm_consultants()` is SECURITY DEFINER and returns counts only; the alert
  figures (overdue, no activity, progress) are null unless the caller is an
  admin or the row is their own. The staff blast is owner/admin only.
- **`meeting_attendees`.** `meetings.student_id` stays the primary attendee so
  every per-student read keeps working; a trigger writes the primary here too.
  Only the meeting's counselor adds or removes attendees, and only students
  they can edit; an invited student may read the meeting (`meetings_select_attendee`)
  but not move it. The helpers are SECURITY DEFINER to avoid policy recursion
  between the two tables.
- **A meeting's calendar event is its owner's** (`20261024000011`,
  `lib/meetingCalendar.ts`). `calendar_provider` / `calendar_event_id` name an
  event on the calendar of `meetings.counselor_id`, and the API moves or
  deletes it with stored OAuth tokens, so a forged owner would hand one
  counselor another's calendar. In code: a provider is called only when the
  caller owns the meeting, always with `request.auth.userId` (never the stored
  `counselor_id` read on its own); a write collaborator's change to someone
  else's meeting is saved in Meridies only, the sync skipped with a logged
  reason and the pointer kept for its owner, and `createConference` on it is
  403. In the database: `meetings_owner_guard` (keyed off `current_user`, like
  `admission_outcomes_lock_guard`, so `transfer_caseload` and the service role
  pass) makes a user session book only as itself, never change
  `counselor_id`, and set, change or clear the pointer only on its own
  meeting; insert, update and delete need `private.counselor_can_edit_student`
  (read-only collaborators read meetings, never write them); `20261024000012`
  clears the pointer on rows forged before the guard (owner neither the
  student's counselor nor a collaborator). A forged owner also can't be made
  to pay: an invite round is resolved before `meeting-invites:<owner>` is
  charged, and a meeting whose own student isn't on its owner's caseload
  sends nothing and charges nothing. A new route that calls a provider about
  a stored row, or charges a limit keyed by a stored owner, checks ownership
  the same way.
- **The practice system folders can't be deleted.** "Practice templates" and
  "Policy & research" are `is_system` folders keyed by `folders.system_key`,
  unique per owner. They can be renamed but not deleted or moved, because the
  Colleges tab files research into "Policy & research" by key. Counselors who
  existed at migration time were backfilled; newer ones get them on their
  first Files read (`lib/practiceFolders.ts`).
- **A polygon holds at most ten visible axes.** A trigger refuses the
  eleventh (errcode 23514); a default axis the counselor removes is `hidden`,
  not deleted, so its history keeps its parent. `ensure_default_polygon_axes`
  seeds the demo's five only for a student with no axes at all.
- **`ai_runs_module_check` is extended additively.** The migrations that add
  a module label (`mass-invite`, `college-research`, `email-template`,
  `profile-update`, `submission-review`, `import-mapping`, `import-cleanup`) read
  the current CHECK back and add theirs, so they never drop another area's
  label and re-running one is harmless. Keep the `AiModule` union in
  `lib/anthropic.ts` in step; an unknown label fails the audit insert, not the
  request, so it would go unnoticed.
- **Essay word counts are the database's** (`essays_set_word_count`, also on
  `essay_versions`); routes don't accept a client's count.

### The student view (SV Demo v2)

A signed-in student sees their own record, and "me" is always the JWT: the
`/me` routes take no student id, and everywhere else `resolveStudentId`
refuses another student's. The rules, each enforced in route code *and* in
the database (`20261010*`):

- **The strength profile is read-only for the student.** They read their
  polygon and its recorded history (`GET /me/polygon`, `/me/polygon/years`,
  or `/student-page/:id/polygon*` with their own id); every axis write is
  counselor-only (`requireRole("counselor")`, and RLS through
  `private.counselor_can_edit_student`). A student's read derives today's
  scores in memory (`loadPolygon(..., { persist: false })`) and writes
  nothing, so it never touches the history.
- **Counselor tasks are not the student's to edit.** On a task with
  `source = 'counselor'` the student records progress only (status, words,
  percent, ticking a step done); renaming, re-dating, re-scoping or deleting
  it is refused by the route and by `deliverables_guard_student_edits`. Stage
  inserts/deletes and task document links are counselor-only.
- **Self-added tasks are visible to the counselor.** `POST /tasks` from a
  student writes `source = 'student'`, `created_by` = the student; those rows
  are theirs to edit and delete, show on the counselor's `GET /tasks?studentId`
  (filter with `source`), and never count as stalled work in the
  accountability sweep.
- **Profile updates are filed into the sheets.** Profile Update (AxIS, Haiku,
  `ai_runs` module `profile-update`) asks one question at a time; the server,
  not the model, decides when a record is complete, re-validates every field
  (the description is capped at 150 characters) and files it as a row of
  `activities` or `awards` (`source = 'ai'`) plus a `profile_updates` log row
  the counselor reads at `GET /students/:id/profile-updates`. It never writes
  essay prose.
- **The questionnaire fills the record** (`20261023010001`-`04`). The
  onboarding questionnaire saves `profiles.profile.intakeAnswers` (`PATCH
  /auth/me`, the profile bounded at 300,000 bytes measured after the merge,
  on that route and the counselor's `PATCH /students/:id`
  (`lib/profileSize.ts`; a profile already over may shrink, never grow), and
  in the database for PostgREST writes too, in the same measure (the UTF-8
  bytes of the jsonb text, which `profileBytes` reproduces, so the two agree
  on what fits): `profiles_column_bounds` (`20261024000081`) also bounds
  every other client-writable profiles column (name, school, hometown and
  title 200, headline 300, avatar link 2048, phone 40, time zone 80, class
  year 10; clipped at signup, refused past the bound on update unless the
  value shrinks). `GET /students` reads named columns, not `*`), and a trigger on
  that column (`private.sync_intake_answers`) copies every answer that has a
  real field into it, through the import pipeline's own functions
  (`import_value_ok`, `import_current_value`, the compare-and-set
  `import_set_field`, `import_insert_row` with `source = 'intake'`): high
  school (linked to the catalog on a unique name match), hometown, class
  year, the GPA with its scale (never converted; 'Something else' fills
  nothing) and its range as text ("3.7–3.99 unweighted", "4.5+ weighted (5.0
  scale)"; none on a 100-point scale), class rank, test status, SAT sections
  and total (the sum when only sections are given), ACT, AP/IB scores (an IB
  exam's option reads on the IB scale), advanced courses (not the grade
  level: `courses.grade` is the mark), activities (the type mapped onto
  `ACTIVITY_TYPES`, anything else "Other Club/Activity"; text cut to the
  sheet's limits), honors (keyed on name and year), first-gen and intended
  majors. Rules: **fill only what is empty**; a re-saved questionnaire may
  change a value (or take back a row, or a field whose answer is gone) only
  while it is still exactly what the questionnaire wrote, compared by hash
  in `intake_fills` the way import provenance compares; anything the
  counselor, an import or the student edited elsewhere is never touched
  again, and a cleared value or deleted row stays gone. Grouped fields move
  together or not at all (GPA, scale and the other GPA column; the three
  SAT figures; class rank and its value), and a student's GPA is never
  written under a counselor's scale that doesn't match. Citizenship, aid
  need, aid types, FAFSA status, country, English test and the background
  note are copied nowhere: they stay in `profiles.profile.intakeAnswers`,
  which no AI feature reads (`student_personal_details.citizenship` is on
  the AI allowlist, so the questionnaire never fills it). Each group runs in
  its own subtransaction and the save never fails because of the sync; a
  `progress_events` row (`intake` / `edited`) names the fields changed and
  why others were skipped, never a value. Held import data still wins: the
  Ready to apply queue defaults a field the questionnaire filled (unchanged)
  to accept and says `currentSource: "intake"`. The counselor sees what came
  from the questionnaire: `fromQuestionnaire` on `GET /student-page/:id/info`
  and `/me/overview` (info card keys still as the questionnaire left them)
  and `source` plus `fromQuestionnaire` on each `GET /application/sheets`
  row, read through `intake_filled_fields(p_student)` (`can_view_student`),
  degrading to no marks without the migration. `20261023010004` backfills
  everyone who has answered when it is applied (not yet in production);
  `select private.backfill_intake_answers();` (or `('<student id>')`) re-runs
  it safely and skips archived students. Before `20261023010002` a save
  stores the answers as it always did and copies nothing. Data
  the student reports clears the matching setup steps (`lib/studentSetup.ts`)
  like any other data, before the counselor has checked it.
- **Files is "My documents".** A student lists, uploads into and pastes links
  into their own student folder only (`assertFileableFolder`, restrictive RLS).
- **What the counselor asks for is the student's To-Do** (`20261012000001`).
  The New student page's intake requests ("Transcript", "Resume") become
  counselor tasks of kind `document` when the student joins (a trigger on
  `profiles.counselor_id`, because `accept_invitation` links the student after
  it marks the invitation accepted), and a request added later becomes one
  too. Each task carries `intake_invitation_id` / `intake_request_id`, and two
  triggers keep them in step: the task completing ticks the request on the
  counselor's Overview card, the counselor ticking or unticking the request
  completes or reopens the task. Tasks are never deleted when a request is.
- **New students: Submit, receive, confirm** (`20261015000001`,
  `lib/newStudentIntake.ts`). On a request from New student the student's
  upload only *attaches* the file (`POST /tasks/:id/submissions` does not
  move the task), or they type an answer (`PATCH /me/intake/:taskId`,
  `deliverables.intake_answer`). `POST /me/intake/submit` runs
  `submit_intake()` (SECURITY DEFINER: every outstanding item needs a file or
  an answer), moves them all to `review`, has AxIS read the files **as advice
  only** (`nextTaskStatus(..., advisory)` returns null; no student email) and
  tells the counselor once. Only items that move on this Submit are read and
  named: a repeated Submit reads nothing again and tells nobody (the API
  drops ids that were already in review or complete before it called the
  function; since `20261024000043` the function moves, returns and stamps
  nothing when nothing is left to move), and one after a send-back covers
  that item alone. The counselor ticks each item received
  (`PATCH /invites/:id { receive }`, which sets the request's `provided`) or
  sends it back with a note (`{ sendBack }`: the task returns to the student,
  the files come off it, `submitted_at` clears), then confirms (`{ confirmed:
  true }`, only with every request received). A student never sets an intake
  task `complete` (the guard trigger). `GET /invites/building` lists
  invitations with `confirmed_at` null, each request with its status, files,
  answer and AxIS's read.
- **Setup steps clear themselves** (`lib/studentSetup.ts`). For a confirmed
  student, `GET /work-items?includeDerived=true` adds `origin: "setup"` rows
  (GPA & scores, strength profile, recommend colleges, activities, guardian,
  first meeting) and `GET /me/setup` the student's four. Nothing is stored:
  each is a question about the record asked on every read, so whatever fills
  the data (the counselor, the student, AxIS, an import) clears the step.
- **The student hands a file in, AxIS checks it.** `POST /tasks/:id/submissions`
  (`{ documentId }`, a file already in the student's documents) adds a
  `submission` row, the only `deliverable_documents` row a student may write,
  and moves the task to `review`. `lib/submissionReview.ts` then answers the
  quick refusals at once and reads the file after the response (PDFs and
  images as attachments, .docx/.txt as text). The refusals come first, in
  this order: the shared per-document AI rule (`handInAiDecision`:
  `documentAiDecision`'s keep-out, waived recommendation letter, the
  practice's document-reading switch and `ai_access = 'excluded'`, with
  `other`, `essay` and `common-app` read because handing one in is the
  request to read it, and every other kind outside the defaults, IEP/504,
  counselor-only, financial, award letters and unwaived letters, refused
  unless the counselor set `allowed`), a link, a format it can't open, over
  10 MB. **The file is downloaded on the caller's own client**, never the
  service role, and only when the row names the documents bucket and a path
  of a safe shape (`lib/storagePath.ts`), so Storage RLS decides and a row's
  path can't reach another object. The same file handed in again while the
  task waits on a check changes nothing (200, `review.status: "skipped"`);
  otherwise hand-ins are capped at 6 a task an hour and 40 a student a day
  (`enforceRateLimit`, 429), and counselor notices (bell and email) at 3 a
  task an hour and 20 a student a day, on every path into the review. The
  counselor's email subject carries the student's name, not the task title;
  the client polls `GET /tasks/:id`. AxIS (`submission-review`, Haiku) decides
  only whether this is what was asked for and usable, never grades or
  rewrites it, and copies printed facts (a GPA) into the findings without
  writing them anywhere. Accepted: an `on-track` check and the task complete.
  Needs a fix: `below-the-brief`, the task back to `in-progress`, and the
  student is told what to upload instead. The counselor gets one
  notification and one email per hand-in; the student gets both when AxIS
  hands it back (profile email, like task assignments; each send is a
  `message_deliveries` row, templates `submission-review-*`). `POST /tasks/:id/review` re-runs it (counselor).
  Tracker verdicts are counselor and service-role writes only; a student
  could write one through PostgREST before this migration.
- **A student can't archive or restore themselves.** Archiving takes a
  student out of the escalation sweep, scheduled parent messages and
  reminders, so `archived` on `PATCH /students/:id` is a counselor's, about
  someone else (`canArchive`), and `private.profiles_guard_self_archive`
  refuses a client write of one's own `archived_at` (`20261024000025`).
- **Preferences are the student's, alerts are not.** `student_preferences`
  (banner, theme, the student's own text/email reminder channels) is
  student-written and counselor-readable; `student_alert_prefs` stays
  counselor-written. The banner image lives in the private `student-banners`
  bucket under `<student id>/`, uploaded through a signed URL minted on the
  student's own token.
- **Settings is the display name and the theme** (`PATCH /me/settings`). The
  theme defaults to `light` (`20261013000001`); "Device" (`system`) is a
  choice, never the default.
- **The student's reminder channels send, to the student only.** With texts
  or email on in `student_preferences`, each open task due tomorrow
  (counselor's time zone, outside quiet hours) gets one reminder per channel,
  sent by `lib/studentReminders.ts` on the existing dispatch cron
  (`/communication/internal/dispatch`) under the `student-reminders` lease.
  The `message_deliveries` row (template `task-due-reminder:<date>`) is the
  dedupe record. The student writes `student_preferences`, so neither
  address there is a destination on its own: **email goes only to the
  sign-in address** (`profiles.email`, which no client writes; the address
  typed in Settings is not followed), and **a text goes only to the number
  the counselor recorded** (`profiles.phone_recorded_by_counselor`, set by a
  trigger when a counselor who can edit the student saves the student's
  phone, never by the student, `20261024000042`) and only when the student's
  reminder number is that same number. Without the migration, or with no
  number recorded, no reminder text goes out. At most 5 reminders per channel
  per student per due date, counselor tasks first; a text never carries a
  title the student wrote (a generic line instead), and a counselor's title
  only up to 60 characters with no link, address or long number in it. `GET /me/messages` lists what was sent to the student; RLS
  `message_deliveries_student_self` (`20261013000002`) returns only rows
  addressed to them, never their guardians' or the counselor's.

### Aid generosity is three ratings, not one

v5 settled this and it should not be relitigated: `college_aid_ratings` is keyed
`(college_id, kind)` over `need-based`, `merit-based` and
`income-band-consistency`. The third scores how *steady* the headline is across
income bands — 10 means it holds wherever the family sits, and a low score means
`college_aid_band_ratings` is the only honest answer. `GET /colleges/:id` serves
them as `aidRatings` / `aidBandRatings`, outside `aidProfile`, so a curated
Meridies judgement is never read as one more reported statistic.

## Rate limiting

Two layers, and they are not redundant:

1. `@fastify/rate-limit` — in-process, per authenticated user (falling back to
   IP). Cheap, soaks up floods, **resets on deploy and doesn't span replicas.**
   The IP is the one Railway's edge saw: `trustProxy` trusts exactly
   `TRUST_PROXY_HOPS` hops (default 1), so the X-Forwarded-For entries a
   client writes to the left of the edge's own are ignored by the limiter and
   the request log. Never set it back to `true`: that takes the leftmost,
   client-written entry, and a fresh header per request was a fresh bucket.
   Its hook runs before `authenticate`, so the key comes from verifying the
   bearer token on the spot (`clientKey` in `plugins/rateLimit.ts`,
   `lib/bearer.ts`), not from `request.auth`. A limited request answers 429.
2. `public.consume_rate_limit` / `public.consume_quota` — Postgres counters via
   `lib/limits.ts`. This is the layer that actually holds, and the one that
   protects AI spend. EXECUTE is granted to `service_role` only.

Without `SUPABASE_SERVICE_ROLE_KEY` the second layer degrades to an in-process
map and logs a warning at boot. Set it before going live.

New expensive route? Add a `limit(...)` preHandler. AI routes get 20/min per
user plus a 300-call daily quota.

**Reads get the DB-backed limiter when they carry volume or fan out** — a list,
a roster-wide query, a 2000-row scattergram or history series. Single-row point
lookups mostly do not: the limiter is itself a database round trip, so guarding
a one-row read with one roughly doubles its cost for no protection the
in-process cap doesn't already give. `routes/colleges.ts` has a local `read()`
helper for this; everywhere else spells the array out.

**Fail closed on anything that decides who receives a message.**
`loadAlertPrefs()` throws on a query error rather than returning the default,
because the default is the permissive answer: swallowing the error would copy a
guardian the counselor had switched off. The same reasoning applies to any
future preference of this shape — an absent row is a default, an errored query
is not. `loadSettings()` and the throttle read in `alertBlockedReason()` throw on
error for the same reason: a defaulted `enabled: true` would switch alerts back
on for a counselor who turned them off.

## College catalog and search

The catalog is every operating US college that mainly awards associate's,
bachelor's or graduate degrees, from the U.S. Department of Education:

- **College Scorecard** (`lib/ingest/scorecard.ts`), upserted on the IPEDS
  `unitid`: facts on `colleges`, figures in `college_stats`, majors in
  `college_fields_of_study`. Load once with `npx tsx scripts/ingest/scorecard.ts`;
  refresh monthly with a Railway cron on `POST /internal/ingest/scorecard`
  (`CRON_SECRET`, answers 202, runs under the `scorecard-ingest` lease). Needs
  `SCORECARD_API_KEY` (free, api.data.gov).
- **IPEDS Admissions** (`lib/ingest/ipeds.ts`), yearly:
  `npx tsx scripts/ingest/ipeds-admissions.ts --year <YYYY>` fills
  `college_admission_factors` (what a school weighs; test policy).

**What the profile serves.** `GET /colleges/:id/extras` returns `official`:
`stats` (`toOfficialStats`), `admissionFactors` (IPEDS), `majors` (bachelor's
fields of study) and `associateMajors` (associate's, so a two-year school's
list isn't empty), each most awarded first; `GET /colleges/compare` carries
each school's `official` stats too (null with no Scorecard row). Everything in
it is federal and `sourced`, with its own `stale` flag, and never mixes with the
curated facts beside it. The coded fields are served raw and labelled
(`labels`): `setting` is `settingFromLocale` (the curated campus-setting words,
so a catalog school and a profiled one read alike), `testPolicy` is the IPEDS
consideration code through `testPolicyFrom` (the catalog's
required/recommended/optional/blind), and the Carnegie and predominant-degree
texts are the dictionary's value labels (`lib/scorecardCodes.ts`). Religious
affiliation is `religious: boolean`, not a denomination. Things that are easy
to mislabel, and how the DTO keeps them apart:

- **Completion.** `gradRate150` / `gradRateOnTime` are IPEDS first-time
  full-time rates from one cohort, named by `completionBasis`: `four-year`
  (within 6 / 4 years) or `less-than-four-year` (150% / 100% of normal time, 3
  years for an associate's). `labels.gradRate150` / `labels.gradRateOnTime`
  say which; never call an L4 rate "6-year". `completionByRace` is the same
  cohort by group (a null is suppressed or not reported). `gradRate` is
  Scorecard's own `consumer_rate`, the rate its site sorts by (Outcome
  Measures, an award within 8 years for all entering students, where reported;
  else the 150% rate): show it as Scorecard's graduation rate, never as a
  number of years.
- **Who a figure describes.** Earnings (`medianEarnings6yr`, `10yr`) are of
  federally aided students, working and not enrolled, counted from entry.
  Debt (`medianDebt`, `medianDebtMonthly` as a 10-year payment,
  `medianDebtNoncompleters`) is federal loans only. `avgNetPrice` is what
  students who received federal aid paid on average (in-state at a public
  school), an average and not a quote. `demographics` are shares
  of degree-seeking undergraduates; `retentionRate` is first-time full-time,
  back for a second fall. All shares are 0-1, all money whole dollars.

**More fields, safely** (`20261023080001`). The ingest asks for
`BASE_FIELDS` plus `EXTENDED_FIELD_GROUPS`; every name is on
`test/fixtures/scorecard-field-reference.json` with where it was checked (the
data dictionary or the field list of Scorecard's own site), and `npm test`
fails on a requested field with no entry. The API answers 400 to a request
naming any unknown field, so on the first 400 the fetcher asks for the base
fields alone (a 400 there is a real failure), then base plus each group, and
loads without the groups it refuses. A refused group is a **degraded** run:
it ends `partial` with the reason first in `errors`, logs at error level, and
its heartbeat is not clean, so `/internal/status` lists `scorecard-ingest` as
failing every month until it is fixed, instead of counting a load that never
fills the new columns as clean. Without the migration, the college_stats
upsert is retried without the new columns (`upsertStats`, the
`deliveryInsert.ts` pattern, five-minute memory). That is expected while the
migration is held back, so it is not degraded: the run loads every older
figure as before, ends `succeeded` with the reason in `pending` (logged as a
warning), and its heartbeat stays clean, so production's monitoring doesn't
change until the migration is applied. The migration is not in
`REQUIRED_SCHEMA`. After applying it, run the load once.

Rules: a row Meridies curated (`catalog_source = 'meridies'`) keeps its name,
slug, aliases, colours, deadlines and test policy; official data fills facts
only and never touches ratings or profile copy. Official figures carry
`source_verified_at`, and the API flags them `stale` after 13 months rather than
serving them as current. Every load is an `ingest_runs` row.

Search runs in Postgres, not in memory: `public.search_colleges(q, filters,
sort, limit, offset)` ranks exact name/alias > name prefix > word prefix >
close spelling (pg_trgm) > full text > bachelor's major, filters (state,
distance, size, control, admit rate, test policy, net price at an income band,
majors, HBCU/HSI/women's/religious, setting, fit) and pages. Fit
(reach/target/likely) is `studentOdds` in SQL and is labelled a Meridies
estimate. `GET /colleges/search` keeps its array response; the total and next
cursor are the `X-Total-Count` / `X-Next-Cursor` headers. No embeddings: the AI
rule is Anthropic only.

### Resource library and curated datasets

`library_resources` is the Meridies library (null owner, seeded in
`20261007000004`, read-only to practices) plus each practice's own rows.
Students read the rows meant for them and what is pinned to them. Sites whose
terms forbid scraping (Chegg, CollegeXpress, BigFuture, LinkedIn) are
`link_only`: linked, never read. A weekly cron on `POST /internal/resources/link-check`
asks each link whether it still answers (`lib/links.ts checkLink`, SSRF-safe,
HEAD, body never read) and flags it `ok` / `broken` (404/410 twice, or gone
from DNS) / `blocked` (the site refuses robots); nothing is deleted.

Curated facts live on the school, each with a source: `college_policies`
(superscore, self-reported scores, CSS Profile, STARS, FairTest),
`college_application_requirements` (per cycle) and `college_major_admit_rates`
(UC/CSU by major, SJSU's eligibility index). They are loaded from CSVs the team
compiles, never invented: `npx tsx scripts/ingest/curated-csv.ts --dataset
<policies|requirements|major-admit-rates> --file <csv> [--dry-run]`. A file with
one bad row loads nothing. Checked-in files and their sources are listed in
`scripts/ingest/data/README.md`.

**Events Hub listings** come the same way: `npx tsx --env-file=.env
scripts/ingest/events-csv.ts --file <csv> [--dry-run]` (columns in
`src/lib/ingest/events.ts`). Every row is checked with zod against what
`hub_events` accepts, a file with one bad row loads nothing, and a
`college_unitid` must already be in the catalog. Rows become Meridies-wide
listings (`created_by` and `firm_id` null), which every approved counselor
sees. `hub_events` has no unique constraint, so the loader matches on the
natural key (name, host, start_date), trimmed and ignoring case, among
Meridies-wide rows only: a re-run updates in place, never duplicates, never
touches a counselor's own listing, and deletes nothing. A URL is not the key,
because a recurring webinar shares one page across dates. Renaming an event in
the file inserts a new row; remove the old one by hand. Service role from env.
Optional `audience` column: `counselor | student | everyone`; blank means
everyone for an info session, tour, virtual visit or open house, counselor
for the rest. Loaded rows are `source = 'csv'`, and a curated row always wins
over a discovered one with the same key.

**Events Hub discovery** (`lib/eventsDiscovery.ts`, `20261021000001`) finds
colleges' own upcoming events, so the hub isn't empty and students get real
sign-up links:

- **Which colleges:** the most listed across every roster
  (`lib/rosterColleges.ts`, the same rule as `/colleges/recommended` and
  `/events/recommended`), top `EVENTS_DISCOVERY_COLLEGES` (default 30).
- **How:** `runSystemResearch` (cited research with no user; the ai_runs row
  has no actor) on `DISCOVERY_MODEL` (`claude-sonnet-5-5`; other research
  stays on `RESEARCH_MODEL`), restricted to the college's own site from
  `colleges.website`, plus `ADMISSIONS_HOSTS` for a college whose admissions
  office has its own domain (MIT: mitadmissions.org) and `EVENT_PLATFORMS`.
  Undergraduate admissions only: graduate, professional and certificate
  sessions are refused in the prompt and again in code.
- **What is kept:** a candidate stays only if it validates (known kind, a
  real date from today to six months out, a recognised time zone), its
  sign-up link is on the college's site, the run actually saw that page, the
  page isn't on `research_blocked_domains`, and `checkLink` says it answers
  (`keepCandidates`). The college's visit page, checked the same way, lands
  on `colleges.visit_url`: many colleges load tour dates with script, so the
  student's "Plan a visit" still has somewhere to go.
- **Offerings** (`20261022000001`, `college_visit_offerings`): what the
  admissions office offers when its dates aren't readable (a campus tour
  "most weekdays, 10am and 2pm", an info session, a virtual visit), each with
  its sign-up page, kept by the same checks (`validOfferings`, then
  `keepCandidates`). A successful run replaces the college's offerings; a
  failed one touches nothing. Any signed-in user reads them; only
  service_role writes.
- **Where it lands:** Meridies-wide `hub_events`, `source = 'discovered'`,
  `audience = 'everyone'`, host = the college's name, matched on the CSV
  loader's key (now also a unique index on Meridies-wide rows). Never
  overwrites a CSV or hand-entered row; deletes nothing.
- **When:** weekly `POST /internal/events/discover` (CRON_SECRET, 202, lease
  `events-discovery`, `ingest_runs` + `job_heartbeats`), capped by a system
  budget (`consume_quota` on a fixed subject, 2,000 calls a month). A
  counselor's **Refresh events** (`POST /events/discover { collegeId }`) runs
  one college on their own AI quota. No student fact ever goes into a prompt.
- **Looked up when listed:** opening the student's Events tab (`/me/events`)
  or the Events Hub's college filter (`/events/colleges`) starts a
  background lookup (`lookUpSoon`, system budget, three at a time per
  instance) for listed colleges (four a load) and similar ones (two) not looked up in the past week
  (`colleges.visit_url_checked_at` doubles as "last looked up"), and the
  response names them (`lookingUp`) so the page can say so and check back.

**Students see events** at `/me/events` (`routes/myEvents.ts`): upcoming
Meridies-wide listings whose audience is student or everyone, the colleges on
their own list first, plus each listed college's visit page and offerings;
then **similar colleges** (`lib/similarColleges.ts`): up to six not on the
list, from `college_stats` (admit rate within ten points of the listed range,
1,500+ undergraduates, a website), scored by admit rate, SAT midpoint and
public/private against the closest listed college ("Similar to Cornell"),
the listed colleges taking turns so one doesn't take all six. Each carries
its visit page, events and offerings; their events leave `more`. Saves go to
their own calendar (`/me/events/calendar`). RLS (`hub_events_select_student`) says
the same, so a counselor-only or practice listing never reaches a student.

### Campus photos

Every college surface (search and AI search cards, recommended, slug,
compare, `GET /colleges/:id` as a top-level `photo`, a student's college list
on every row path as `collegePhoto`, Events Hub college refs, alumni) carries
`photo: { url, thumbUrl, width, height, alt, credit, license, licenseUrl,
sourceUrl, title } | null` (`lib/collegePhotos.ts`). `GET
/colleges/photo-credits` lists every photo's full attribution for a credits
page. The list builder and the top-bar search carry none (the app draws none
there).

- **Source** (`lib/ingest/collegePhotos.ts`, `20261023070001`): Wikimedia
  Commons, found through Wikidata: the item whose IPEDS id (P1771) is the
  college's unitid, and its main image (P18). A unitid on two items, or an
  item claiming two unitids, is skipped (it could be another campus). The
  team's `scripts/ingest/data/college-photo-picks.csv` wins over Wikidata,
  seeded with the 43 photos hand-reviewed for the demo; `none` there
  suppresses a college and removes its photo. **No search fallback**: a
  college with no usable free image has no row, and the app shows its plain
  ground.
- **Nothing goes live the moment a wiki says so** (`reviewDecision`,
  `20261024000071`). Wikidata and Commons are crowd-edited: anyone can point
  a college's P18 at another free image, or upload a new version over its
  file, minutes before a run, and the photo is shown to students and
  families. So a new or changed photo (its Commons sha1 differs from the
  stored one) is published only when it has been quiet for `STABLE_DAYS` (7):
  the Wikidata item (`schema:dateModified`, in the same SPARQL query), the
  Commons file version (imageinfo `timestamp`) and its description page
  (latest revision, and the page's `touched` time from `prop=info`, which
  also moves when a template the page uses is edited, such as a
  `{{Creator:}}` or a photographer's own credit template) all last changed
  at least that long before the run, and the file not reached through a
  redirect (whose age no API gives); or a run at least that long ago held
  this exact candidate (source, title, sha1, credit and license) and
  **nothing it depends on changed after that sighting** (`quietSince`: the
  file version, the page revision and `touched`, and for Wikidata the item,
  all at or before it; otherwise the wait starts again, so reverting an edit
  and re-applying it just before the next run doesn't ride on the old
  sighting). A busy Wikidata item (edited every week) therefore waits for a
  quiet week or a pick. A redirect is never confirmed by a sighting. A
  **replacement** of a photo already shown (another file, or a new version
  under the same title, whichever source showed it) always needs that
  sighting, so with the monthly cron it goes live a run later; until then
  the old photo keeps serving. Unknown or future times are never stable.
- **A team pick wins, within limits.** An unpinned pick is published at once
  (the team looked at it), except a new version of the file already shown
  (same title, whatever showed it: picking the title Wikidata shows doesn't
  wave through a version uploaded yesterday) and a title that now redirects
  (`pick-redirected`: whoever edits the redirect page chooses the file; the
  team updates the title). The picks CSV takes an optional fourth column,
  `commons_sha1` (header `unitid,commons_title,note,commons_sha1`): a pinned
  pick is published at once while the file is that version, whatever else
  changed, and held as `pick-changed` while it isn't (only the team moves a
  pin, never a sighting). Pinning is how the team publishes a held new
  version now.
- **The bytes are the version judged** (`sameVersion`). Thumbnail URLs on
  upload.wikimedia.org name the file, not the version, so a swap between the
  metadata read and the downloads would store the swapped bytes under the
  reviewed sha1, and reverting the swap (same sha1) would keep them there
  for good. Downloads go `DOWNLOAD_CHUNK` (20) at a time: the 500 px lookup
  (now `iiprop=timestamp|url|sha1`) must still show the judged sha1 and
  upload time, both copies are fetched, then Commons is asked again and the
  copies are uploaded only if title, sha1 and upload time are unchanged (a
  revert is a new upload with a new time). Otherwise nothing downloaded is
  kept: `changed-during-run`, the stored photo and its queue row stay. A
  failed re-check keeps nothing either. The bytes themselves aren't hashed
  (the sha1 is of the original, often over the 3 MB cap, and the copies are
  thumbnails), so this leans on Wikimedia purging a file's thumbnails on
  every upload: a stale cached thumbnail of a swapped version served after
  the purge failed is the residual case.
- **Credits and licenses wait too** (`textDecision`). The credit is shown
  on every surface and on `/colleges/photo-credits`. For an unchanged file,
  new text (compared by hash with what the row shows) replaces it only after
  a sighting at least a week old with nothing changed since; before the
  migration, only once the page's revision and `touched` times are a week
  old. Until then the row keeps its text (its other facts, the title after a
  move, still refresh): `held-text`, `text-held`, with `text-changed` and,
  when recent, `page-recent`. The sighting covers MediaWiki's job-queue lag
  in moving `touched` after a template edit.
- **The review queue.** Held candidates are `college_photo_candidates` rows
  (service_role only; why, first and last seen; one row per college, for a
  held photo or held text), the team's review queue: read it in the SQL
  editor or in the `--dry-run` CSV (action `held-new` / `held-replace` /
  `held-text`, the reasons, the title shown today). To publish a held photo
  now, pick it (pinned to its sha1 if it is a new version of the file
  shown); to keep it off, pick `none` or a better file. Each run's counts
  (`added`, `replaced`, `held-new`, `held-replace`, `hold:<reason>`,
  `confirmed`, `text-held`, `changed-during-run`, ...) are on its
  `ingest_runs.counts`. Holding is not an error: the run and its heartbeat
  stay clean. Deletions are not held by this gate (a removal is the safe
  direction; the mass-deletion guard below still applies). Without the
  migration nothing is remembered: a new photo still passes on its
  timestamps, a replacement is held with `no-review-table` (every new
  version of a shown file waits until the migration or a pinned pick),
  changed text waits for a quiet page, and the run's row is finished without
  counts. Known limits: an edit that survives a week of Wikidata and Commons
  patrol, with nothing else changing, is published; an unpinned pick shows
  whatever version its file has when the team's pick first runs; a template
  edit whose `touched` update lags past the run is caught only with the
  queue; and Wikidata's item time is the item's, so an unrelated bot edit
  also restarts the wait.
- **What a file must be**: a JPEG on Commons (normalised titles and moved
  files followed), at least 1000 px wide and 1.2:1 landscape unless picked,
  CC0, public domain, CC BY or CC BY-SA (never NC or ND; the CHECK refuses
  them too), not NonFree, no restriction template, and for CC BY and BY-SA a
  credit. A credit over 500 characters is refused, never clipped.
- **Copied, not hotlinked**: two standard widths (500 for cards, 1280 for the
  profile) into the public `college-photos` bucket under
  `<unitid>/<sha1>-<width>.jpg`, so viewers never call Wikimedia and a file
  changed on Commons gets new objects. The bucket is the only public one, it
  has no `storage.objects` policy (only the loader writes), and the row keeps
  paths, not URLs.
- **The run**: monthly `POST /internal/ingest/college-photos` (CRON_SECRET,
  202, 409 while running, 503 naming the migration before it is applied;
  lease `college-photos`, 3 hours; `ingest_runs` + `job_heartbeats`), or
  `npx tsx --env-file=.env scripts/ingest/college-photos.ts [--limit N]
  [--only <unitids>] [--dry-run]`. It re-checks every stored file and
  downloads only changed ones (same sha1: nothing downloaded, the text
  refreshed under the rule above); a deleted or relicensed file loses its row and objects. A
  Wikidata or picks failure ends the run before anything changes, and
  deletions the picks didn't ask for are **held** when they would remove more
  than a tenth of the stored photos (and more than five), so a truncated
  answer can't wipe the catalog's photos. `--dry-run` writes nothing (no
  ingest_runs row, no heartbeat, no review queue) and prints a CSV to review
  (`action,unitid,name,title,license,credit,source,current_title,reasons`);
  every cell a spreadsheet would read as a formula (one starting with `=`,
  `+`, `-`, `@`, a tab or a carriage return) is prefixed with an apostrophe
  (`csvCell`), because the credit and title are Commons text anyone can
  write. `--now <ISO time>` pins the clock, for `--fixture-dir` runs only. Wikimedia
  etiquette: a User-Agent with the team inbox, serial API calls half a second
  apart, `maxlag=5`, Retry-After honoured, two downloads at a time; the three
  hosts are pinned and redirects refused.
- **Deploy order**: either. Every read degrades to `photo: null` while the
  table is missing (remembered five minutes, like `lib/deliveryInsert.ts`);
  not in `REQUIRED_SCHEMA`. After applying it, run the script once by hand,
  or `/internal/status` reads the job overdue. `20261024000071` (the review
  queue and `ingest_runs.counts`) goes in after it, either order with the
  code; not in `REQUIRED_SCHEMA` either.
- **Tests**: `college-photos*.test.ts` (rules, client, run, serving, the
  review gate, the version check, text holds, pins, the store without the
  migration, and `csvCell`), `test/integration/college-photos.test.mjs`
  (RLS, the bucket, a fixture load through the real store, every surface),
  `college-photos-review.test.mjs` (a vandal's P18 and a new version over a
  file held while the old photo keeps serving, published a week on, a pick
  at once, the dry-run CSV) and `college-photos-attacks.test.mjs` (a swap
  during the downloads with and without a revert, a pick of the title shown,
  a pick that now redirects, a revert re-applied around its sighting, a
  credit changed through a template; fixtures in `attacks/`, whose
  `commons-imageinfo-500-recheck.json` is what a fixture run serves on the
  re-check). No suite renames shared tables: the no-migration path is unit
  tested on an injected store. Nothing reaches Wikimedia: the
  fixtures in `test/fixtures/college-photos/` are hand-written in the
  documented shapes (see its README), and the cron route is only tested for
  401 and 409.

### Catalog data: yearly refresh

| When | Source | Who | How |
|---|---|---|---|
| Monthly (cron) | College Scorecard | automatic | `POST /internal/ingest/scorecard` |
| Weekly (cron) | Library links | automatic | `POST /internal/resources/link-check` |
| Weekly (cron) | Colleges' upcoming events and visit pages | automatic | `POST /internal/events/discover` |
| Monthly (cron) | Campus photos (Wikimedia Commons via Wikidata) | automatic; the team edits the picks CSV | `POST /internal/ingest/college-photos` |
| When NCES publishes (usually late summer) | IPEDS Admissions (`ADM<year>.zip`) | engineer | `scripts/ingest/ipeds-admissions.ts --year <year>` |
| August | Common App requirements grid (new cycle) | counselor team compiles, engineer loads | `curated-csv.ts --dataset requirements` |
| August–October | UC application, Cal State Apply (dates, requirements) | counselor team | `requirements`, and update the library rows' `opens_on`/`closes_on`/`cycle` in a migration |
| September | CSS Profile participating list (College Board) | counselor team | `policies` (`css_profile_required`) |
| Summer (UC Information Center, CSU impaction matrix, SJSU eligibility index) | admit rates by major, impacted and open majors | counselor team | `major-admit-rates` |
| Rolling | FairTest list, school superscore/self-report pages | counselor team | `policies` |

Dated library rows (Common App, UC, Cal State Apply, FAFSA, CSS Profile, Cal
Grant, Dream Act) carry the current cycle; roll them forward each August.

## Scheduled jobs

The escalation sweep (`runEscalationSweep` in `lib/accountability.ts`) turns red
flags whose timer expired into parent alerts (a flag about a task that isn't
shared with the student is skipped, with a reason). One implementation, three
triggers:

- **The dashboard button** — `POST /accountability/sweep`, the caller's own
  roster on their RLS-bound client. Unchanged.
- **Railway cron** — `POST /internal/accountability/sweep` with
  `Authorization: Bearer $CRON_SECRET` (constant-time compare; 503 when the
  secret is unset, 409 when a sweep is already running). Create a Railway cron
  service, e.g. schedule `*/15 * * * *`, command:
  ```bash
  curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
    "https://<api-host>/internal/accountability/sweep"
  ```
- **In-process interval** — `SWEEP_INTERVAL_MINUTES` (5–1440) on every replica.
  Use it *or* the cron; both together is safe but redundant.

Scheduled runs (`lib/sweepSchedule.ts`) use `serviceClient()`, so RLS scopes
nothing: each counselor's sweep is handed only students whose `counselor_id`
is that counselor, and archived students are skipped. A run first takes the
`accountability-sweep` lease (`acquire_job_lease` / `release_job_lease`,
migration `20260923000003`, EXECUTE to `service_role` only) — a lease row, not
`pg_advisory_lock`, because PostgREST RPCs don't share a session. The schedule
deliberately lives outside Postgres: the project has neither `pg_cron` nor
`pg_net`, and the migration depends on neither. Each flag is
also *claimed* with a conditional `open -> escalated` update before its alert is
inserted, so an overlapping button click and scheduled run can't queue the same
escalation twice. The throttle, quiet hours (auto-send never fires inside them)
and fail-closed alert prefs apply identically on every path; a flag whose reads
error is held, not sent. Every run writes one `audit_log` row
(`accountability.sweep.{manual,cron,interval}`). Without
`SUPABASE_SERVICE_ROLE_KEY` a scheduled run logs and skips.

**The second cron: scheduled messages.** "Schedule send" in the
Communication composer, and any composer message held for quiet hours, is a
`student_messages` row in `scheduled` until
`POST /communication/internal/dispatch` delivers it. It takes the same
`Authorization: Bearer $CRON_SECRET` (constant-time compare, 503 when unset)
and answers 503 without `SUPABASE_SERVICE_ROLE_KEY`. Add it as a second
Railway cron, every 5–15 minutes:
```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://<api-host>/communication/internal/dispatch"
```
Without it scheduled messages never go out. Each row is claimed with a
conditional `scheduled -> queued` update before it is sent, so overlapping
runs can't send it twice; one inside its counselor's quiet hours is moved to
the next window. There is no in-process interval for this one.

**The third cron: import sweep.** `POST /internal/imports/sweep`, same bearer
token, every 5-15 minutes (see "Import pipeline"):
```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://<api-host>/internal/imports/sweep"
```

## AI inside the search

The model never writes a result list and never changes the catalog.

- `POST /colleges/search/ai`: FAST_MODEL fills the §3 filters through a forced
  tool; the output goes through the same `searchQuery` validation as any query
  string, the real search runs, and the response shows the filters that ran
  (and the parts of the request no filter could express) so the counselor can
  edit them.
- `POST /colleges/research` and `POST /resources/ask`: `runWebResearch`
  (`lib/anthropic.ts`) on `RESEARCH_MODEL` (`claude-opus-5-5`, with the
  server-side refusal fallback) and web search/fetch limited to
  `RESEARCH_DOMAINS` plus the school's own site. Each answer part carries its
  citations; a part with none is connective text, not a sourced claim. The
  research uses the `web_search_20250305` / `web_fetch_20250910` tools on
  purpose: the `_20260209` versions route results through code execution and
  return empty citation lists.
- Where a cited source disagrees with the catalog, a `catalog_change_proposals`
  row is written (allowed fields and values only, source URL must be one the
  answer cited). Only a `catalog_editors` member (Meridies staff, added with
  service_role) can approve, and approval is what changes the catalog.
- `GET /colleges/:id/student-summary`: counselor bullets from catalog facts and
  the student's record only. No model; every bullet names its basis.
- `POST /colleges/list-builder` draws candidates from the whole catalog
  (`catalogListCandidates`) and, with `explain: true`, adds one AxIS line per
  school shown. The order is always the fit model's.

## Anthropic / AI rules

**All product AI goes through Anthropic.** No other providers unless the team
explicitly decides otherwise.

- **Speed first** — counselors use these live, in session with a family
- **Default model:** `claude-haiku-4-5` (`FAST_MODEL` in `lib/anthropic.ts`)
- **Research** (`RESEARCH_MODEL`, `claude-opus-5-5`) only for cited web research
  (`runWebResearch`): a counselor acts on those answers.
- **Sonnet** (`DEEP_MODEL`) only where Haiku's quality genuinely isn't enough —
  currently narrative coherence, college lists, and the concierge, wherever
  they are asked from: `routes/ai.ts`, the AxIS chat tools in `lib/chat.ts`,
  and the Application page's Coherence, Recommended column and Activities
  Build (`routes/applicationAi.ts`). Everything the v10 sync added beyond
  those (college research, the Build College Lists bar, Mass invite, email
  templates, the composer's drafts) runs on Haiku, and so does Profile Update
- **Opus** effectively never on a hot path, and never without documenting why
- Every model must support image and file attachments
- Never enable `thinking` / `effort` on models that don't support them

`runStructured()` handles quota, the `ai_runs` audit row, token accounting and
safe error messages. Use it rather than calling the SDK directly.

AxIS runs on Claude Haiku 5.5 for every call (`lib/axis/models.ts`), with effort set per turn; its side calls use structured outputs.

### AxIS v2 (`src/lib/axis/`, `routes/axis.ts`)

The design is `docs/axis/AXIS_SYSTEM.md`. Counselor only (`requireRole("counselor")`
on every `/axis` route), and every student id, the client's or the model's,
goes through `resolveStudentId(..., "view")`. Reads run on `request.db`; the
service client writes only the `ai_runs` audit rows (`lib/axis/llm.ts`).
Conversations are the `/chat/conversations` rows.

**Deploy order.** Apply `20261018000001_axis_orchestrator.sql` (memory and
dialogue-state columns, `ai_messages.verification`, `axis_actions`, the
`axis*` `ai_runs` labels). It is safe to apply before the code, and the code is
safe to deploy before it: the tables are deliberately **not** in
`REQUIRED_SCHEMA`, because `/chat` keeps working without them and listing them
would hold every deploy until the migration is in.

**Fail-safes** (`lib/axis/failsafe.ts`):

- **The fallback signal.** `POST /axis/conversations/:id/messages` answers
  `503 { error, message, code: "axis_unavailable" }` before the stream opens and
  before it saves the user's message when `ANTHROPIC_API_KEY` is unset or the
  migration isn't applied (three zero-row probes; a ready answer is kept for the
  process, a missing one for 30 s). The app then sends the same message to
  `/chat/conversations/:id/messages`. `/axis/actions*` answer the same 503 on a
  schema error; `/axis/warm` always answers 202 and says why it didn't warm.
- **Limits.** 20 a minute per user on messages (`ai:axis`) and on warm; the
  first model call of a turn is charged against the 300-call daily quota before
  the stream opens, so a spent quota is a plain 429 (not a fallback), and each
  further call is charged as it is made. The pre-warm is charged too.
- **A turn always ends.** `runSseTurn` puts a 90 s hard timeout over the whole
  turn (the tool phase has its own 40 s budget), aborts the model stream, the
  planner and the tools when the counselor closes the panel (the response's
  `close`), and ends any failure before `done` with one `error` event whose
  message is ours (`publicMessage`), never the SDK's or Postgres's. After
  `done`, saving state, the adjudicator and the verification write are logged
  and skipped on failure; the memory fold runs after the stream has ended.
- **Model 400s** on the per-message effort or the mode message turn those
  features off for the process and retry the first call once without them
  (`lib/axis/loop.ts`, tested in `axis-loop.test.ts`).

### AxIS makes changes (`src/lib/axis/ops/`)

AxIS can change almost anything a counselor can change in the app. It does it
the way the app does: every change is one request to this API's own routes,
run in-process with `app.inject` and the counselor's bearer token
(`ops/dispatch.ts`). So a change passes `authenticate` and the approval gate,
the route's zod schema, its own checks and side effects (deadline mirroring,
assignment emails, throttles) and RLS on its queries, exactly as a click would.
AxIS gets no client of its own and no service role; it can never do more than
the counselor could. A rule added to a route later applies to AxIS without
anyone copying it.

- **The catalog** is `ops/catalog/*.ts`: one `op({...})` per action, grouped by
  area and listed in `ops/registry.ts` in a fixed order. Each op has a name
  (`area.verb`), a strict zod input in snake_case, the request it becomes, a
  card line built from the real target (`describe`, which may read it with a
  GET), and, for reads, a `reply` that keeps only safe fields (ids, titles,
  dates; free text wrapped as untrusted data; nothing off the AI allowlist).
  The catalog text sits at the end of `AXIS_SYSTEM`, so it is in the cached
  prefix and never moves it.
- **Two tools**: `lookup` (read ops, runs early like any lookup) and
  `perform_action` (write ops, never started early, 20 s timeout). The model
  picks a name from the enum and passes its input; a zod error comes back with
  the expected signature so it can fix the call once.
- **Two tiers.** `auto` runs at once and is recorded in `axis_actions` as
  `executed`, with the reversal (`undo`: another catalog op and its input, from
  the route's answer or a `snapshot` read before the write) for the card's Undo.
  `confirm` files a `pending` row and nothing else; the counselor's Confirm
  (`POST /axis/actions/:id/confirm`) re-validates the stored input against the
  registry, re-checks edit access to the student and runs it. Confirm is for
  deleting, archiving, sending or scheduling anything, showing something to a
  student or family for the first time, money, practice-wide settings and
  people, and anything that can't be put back. Undo
  (`POST /axis/actions/:id/undo`) runs only a reversal that names a real write
  op with valid input, as the counselor.
- **Guards in code, not in the prompt.** A turn that read outside content
  turns every auto change into a card, so text someone else wrote can't change
  anything without a click. Outside content is documents, mail, connected
  files, chat attachments, **and any text a student, a family, an import or
  the web wrote**: the record sections on `OUTSIDE_SECTIONS`
  (`lib/context/profiles.ts`: profile fields beyond the name and class,
  academics, majors, activities, awards, courses, scores, the college list,
  intake answers, deadlines, essays, documents, and tasks when one is the
  student's own), the roster's high schools, deadlines and student-added
  tasks, the planner's evidence (another student's record, what is due, the
  caseload ranking when it quotes a deadline), `get_student_record`,
  `list_upcoming`, `rank_caseload`, and every `lookup` whose op says
  `outside` (each read op must declare it, true, false or a check on the
  route's answer; `axis-ops.test.ts` fails on one that doesn't, and an
  undeclared one counts as outside). So a change request's system prompt
  carries only what the counselor wrote (`TRUSTED_SECTIONS`, built
  `trustedOnly`: the name and class year, meetings, meeting notes, the
  strength profile and the counselor's own tasks; in a roster chat names,
  class years, meetings and counselor tasks), and the change finds anything
  else with a lookup, which marks the turn if it reads such text. The marked
  turn's next turn inherits it. Known limits: a student's name (up to 200
  characters, on every card the counselor sees) is not counted; earlier
  answers in the verbatim history and the memory summary can quote text from
  more than one turn back; neither is an instruction channel the guard
  reads. Switching parents or a guardian off (`set_alert_recipients` with
  either copy flag, `update_guardian` with `alerts_enabled` or
  `receives_reports`) asks first whichever way it goes. After five auto changes
  in one turn the rest wait for Confirm; twenty changes is the limit per turn.
  Specialists can't write. `dispatch.ts` refuses `/axis`, `/chat`, `/auth`,
  `/ai`, `/me`, `/account`, `/internal`, `/webhooks`, `/imports`, OAuth and the
  dispatch cron whatever the catalog says, and any essay or supplement request
  carrying prose keys (the essay guardrail).
- **Memory.** Each turn's user message opens with the changes AxIS made or
  proposed earlier in the chat and what became of them (confirmed, dismissed,
  undone, failed), so "did that go through?" has an answer.
- **Never in the catalog:** student-only routes, anything that runs a model,
  binary uploads, OAuth, imports, account export/deletion, catalog-editor
  routes, and essay prose.

**Deploy order.** Apply `20261019000001_axis_operations.sql` (widens the
`axis_actions` type and status checks, payload cap 32 KB). Either order is
safe: without it an auto change still runs and only its audit row is skipped
(so it has no Undo), and a confirm change is refused with a message naming the
migration. It is not in `REQUIRED_SCHEMA` for the same reason as `20261018000001`.

### Files in an AxIS chat (`lib/axis/attachments.ts`)

A counselor can attach a PDF, an image (PNG, JPEG, WebP, GIF) or a text file
(.txt, .md, .csv), up to 10 MB and 5 per message, to a chat.
`POST /chat/conversations/:id/attachments` (`{ fileName, mimeType, sizeBytes }`)
records the file in `ai_attachments` and returns a signed upload URL for the
private `axis-attachments` bucket, minted on the counselor's own token under
`<owner id>/<chat id>/`. The app uploads, then names the files in
`attachmentIds` when it sends the message (`/chat` or `/axis`), which ties
them to that message. Only this chat's unclaimed files can be named.

- **Every turn reads them again.** Both paths hand the model the chat's files
  (the newest 8 within 24 MB), not only the new ones, in the latest user
  message: PDFs as `document` blocks, images as `image` blocks, text as a
  plain-text `document`, after a line saying they are the counselor's material
  and not instructions. So a reopened chat still knows what the file said.
- **v2 specifics.** A message that brings a file never gets a direct answer.
  A turn with files counts as outside content, so every change it proposes
  waits for Confirm. A PDF's or image's figures can't be read back by the live
  grounding, so with one in the chat the turn emits no grounding marks and
  skips the after-answer check; text files are indexed like any evidence.
- **Replay and cleanup.** `GET /chat/conversations/:id` lists each message's
  `attachments` (id, name, type, size); `GET /chat/attachments/:id/url` is a
  five-minute download link. Deleting the chat removes its stored files.
- **Deploy order.** Apply `20261020000001_axis_attachments.sql`. Either order
  is safe: before it, the upload route answers
  `503 { code: "attachments_unavailable" }` and messages are sent without
  files as before. Not in `REQUIRED_SCHEMA`, for the same reason as
  `20261018000001`. `test/integration/axis-attachments.test.mjs` and
  `test/unit/axis-attachments.test.ts` cover it.

**Adding an op:** write it in the area's catalog file, add the group to
`registry.ts` if it is new, and run `npm test`: `axis-ops.test.ts` builds a
valid sample input from the zod schema and checks that every op's request
reaches a registered route, that inputs are strict, that no essay request
carries prose, and that the catalog stays under its size budget.
`test/integration/axis-operations.test.mjs` confirms, refuses and undoes real
changes against a local Supabase.

### The essay restriction is a hard product constraint

The product stays well clear of writing, or closely approximating, essay prose.
`/ai/essay-advice` returns bullets only, and so does Narrative Coherence on
the Application page (`routes/applicationAi.ts`), the one v10 surface that
reads a student's prose: `NO_PROSE_SYSTEM` in, `enforceNoProse()` out.

`NO_PROSE_SYSTEM` states the rule, and `enforceNoProse()` drops anything over
two sentences or 240 characters *after* the model responds. Keep both. A system
prompt is a request, not an enforcement mechanism — if you add another
essay-adjacent route, it needs the code-level filter too.

Free-text answers that stream (AxIS v2's agent and synthesis paths, the v1
`/chat` stream) go through `ProseGate` (`lib/proseGuard.ts`) before any of
them reaches the client: at most `FIRST_PERSON_WORD_CAP` (200) words in
first-person-singular sentences per answer, past which the rest is withheld
and the answer ends "I don't write essay text…"; what is saved is what was
shown. Text streams live while it can't cross the cap, so ordinary answers and
email drafts are unchanged. AxIS's essay router also catches requests by word
count, prompt or voice ("650 first-person words for her prompt", "in her
voice"). `/chat` is counselor-only: a student's free-form chat was a
DEEP_MODEL ghostwriter guarded only by its prompt, and the app gives students
no AxIS. Known limit: the gate is a shape test, so a short supplement asked
for in pieces, or in the third person, is not caught by it.

`/ai/essay-review` is the one route that may change a draft, and the rule is
narrow: **mechanics only.** `enforceMechanicalEdit()` accepts a replacement only
on the `grammar` dimension, only when it is short, and only when it doesn't add
sentences — a content mark may describe the problem but never carries the words.
`essay_marks_edits_are_mechanics` enforces the same rule in the database, so the
constraint survives a route someone writes later. That route also computes span
offsets itself by locating the model's verbatim quote in the draft, because a
model that miscounts characters must not be able to splice text into the wrong
place in a student's essay.

Similarly, `/ai/award-appeal`, `/ai/family-report` and `/ai/parent-alert`
produce **drafts**. The first two are written with `status: 'draft'` /
`'counselor-review'`; `/ai/parent-alert` persists nothing at all and returns
text the counselor edits before sending through
`/accountability/parent-alerts`, which is where quiet hours, the anti-spam
throttle and `student_alert_prefs` are enforced. Nothing in this API sends any
of them. `/reports/family/:id/sent` records a send that already happened — it
does not perform one.

`/ai/file-filing` suggests a folder and never moves a file. It verifies the
model's `folderId` against the list it was offered and drops to low confidence
when the id doesn't match, because a fabricated folder id would file a
student's transcript somewhere nobody looks. `/ai/aid-report` is bullets-only
under `enforceNoProse`, and the arithmetic stays the database's:
`award_letters.net_price_cents` is a generated column, so it cannot drift from
the figures above it.

### Fetching a URL a user supplied

`lib/links.ts` is the only place this API makes an HTTP request to an address a
user chose, which makes it the only place that can be turned into server-side
request forgery. It validates scheme, port and credentials, resolves the host and
rejects the private/loopback/link-local/carrier-NAT ranges (and an IPv4
address carried inside IPv6: mapped, NAT64, 6to4), follows redirects
**manually** so every hop is re-validated, and caps time, bytes and content type.
Each hop resolves DNS once and the socket connects only to those checked
addresses (`pinnedLookup` on a fresh `node:http`/`https` request, `agent:
false`), so a name that answers a public address to the check and 127.0.0.1 to
the connection (DNS rebinding) never reaches the second answer; the hostname
still goes out as the Host header and TLS server name.
If another feature ever needs to fetch a user-supplied URL, route it through
there rather than calling `fetch` directly. What it reads (up to 2 MB) is
turned into text by `extractText` with the linear scanners in
`lib/linearText.ts`, never with a regular expression: a page of "<a" or
"<script" with no closing token made the old patterns run for minutes on the
event loop every tenant shares (see "Text a user supplied" below).

### Connected apps (Google / Microsoft OAuth)

`GET /integrations/:provider/authorize` (counselor) returns the consent URL
and stores a single-use, ten-minute `state` (sha256, bound to the user, PKCE
verifier encrypted). The provider redirects to an **app** page,
`<APP_URL>/dashboard/counselor/data-hub/callback/:provider`, never to this API.
That page runs under the counselor's session and posts `{ code, state }` to the
authenticated `POST /integrations/:provider/complete`, which consumes the state
only where `owner_id` is the caller, checks expiry, and exchanges the code with
the same redirect URI and the verifier. This is the login-CSRF fix: an
unauthenticated callback could only trust the state row, so an attacker could
start a sign-in on their own account, hand the consent link to a counselor, and
receive the counselor's Google/Microsoft tokens. **Do not add a GET callback
back.** Tokens live in
`integration_tokens` — RLS on, **no policies**, grants revoked, service role
only, AES-256-GCM ciphertext — never in `integrations.config`. The
`integrations` row is the visible grant, with the scopes the provider actually
returned; `PUT /integrations/google|microsoft` is refused for that reason.
`DELETE` revokes at Google and deletes the tokens (Microsoft has no per-app
revoke endpoint; the response says so). Refresh happens in `accessTokenFor()`,
serialized per grant (an in-process promise map), because Microsoft rotates
refresh tokens and a second concurrent refresh would spend a dead one. A
refused refresh re-reads the row first — if another replica already rotated it,
that token is used — and only then marks the grant `error` so the card says
"reconnect".

After connect: `GET /integrations/:provider/files?q=` lists Drive/OneDrive
files; `POST /integrations/:provider/files/import` copies one into the
student's folder (Storage upload on the caller's client, `source:
'integration'`, `external_*` pointer kept). `POST /meetings` (and `PATCH`) with
`createConference: true` creates the event on the counselor's calendar with a
real Meet/Teams link *before* saving; moves are strict, cancel/delete are best
effort. `POST /tasks/:id/tracker` asks the provider for each linked file's edit
time: an edit by someone other than the importing counselor inside the stall
window makes the task active; none means stalled. Microsoft asks for
`Files.Read.All` (not `Files.Read`) because the watched file is usually the
student's, shared with the counselor.

Google also asks for `drive.file` (added in the v10 sync) so
`POST /application/supplement-docs` can create a student's supplement Doc in
the counselor's Drive, one per school and cycle, and share it with the
student (`lib/supplementDocs.ts`). It is the narrow scope on purpose: it
reaches only files this app created, so it adds no read of anything else.
The scope must be on the Google consent screen, and a counselor who connected
before it must reconnect once; until then the route answers 409 with that
reason and the app files the prompts as plain essay records. These calls go to fixed provider hosts
with provider-issued ids, so they are not the `lib/links.ts` SSRF surface.
Every route answers 503 with the missing setting when a provider is unset.

### Emailed calendar invites (no Google or Microsoft needed)

The Google / Outlook event above has no attendees and emails nobody. A
meeting's own invites are Meridies' (`lib/meetingInvites.ts`, `lib/ics.ts`,
`20261023090001`): with `sendInvites: true` on `POST /meetings` (or
`PATCH`), each invited student is emailed an iCalendar file through Resend
(`text/calendar; method=…` attachment, Reply-To the counselor) that any
calendar can add.

- **Who.** Each invited student (primary and `meeting_attendees`) at their
  sign-in email (`profiles.email`, which no client writes), never
  `student_personal_details.contact_email`: the student writes that row, so
  following it would let them send the counselor's invite, and every update
  and cancellation after it, to any address (the rule the student's
  due-tomorrow reminders follow too). Their guardians only when the
  meeting has `guardians_invited`, the student's `copy_parents` is on
  (`loadAlertPrefs`, fail closed) and the guardian's own `alerts_enabled`
  is on, at most four per student. The meeting's owner (`meetings.counselor_id`,
  never the caller: a write collaborator may edit) is the ORGANIZER and gets a
  PUBLISH copy when the meeting isn't on their connected calendar. A student
  who is archived, unreadable, or off the owner's caseload (their counselor
  or a `student_collaborators` row) receives nothing, and nor do their
  guardians. Recipients are read on the caller's client before the
  response; any read that errors drops what it decides (the whole round for
  the roster or the owner's address, the guardians for their reads).
  One email per address: an invite outranks a cancellation, and an address
  still invited (a guardian of two siblings) is never sent a cancellation.
- **One file per recipient**, whose only ATTENDEE is that recipient, with
  `RSVP=FALSE` (Meridies has no inbound mail). UID `meeting-<id>@meridiesai.com`
  for the life of the meeting; SEQUENCE is `meetings.ics_sequence`, written
  only by a trigger that raises it on every change a calendar shows (and on
  `send_invites` switching) and ignores any client value. Delete sends the
  last sequence plus one. Times are UTC; typed text is escaped as TEXT or a
  quoted parameter so it can't start a property.
- **What goes out.** Booking, switching invites on, and un-cancelling: REQUEST
  `meeting-invite`. A move, title, place, link, mode or agenda change: REQUEST
  `meeting-update` to everyone kept. Students added: an invite; removed: a
  cancellation; the guardians flag toggled: an invite or a cancellation to
  the kept students' guardians. Cancelling, deleting, or switching invites
  off after they went out: CANCEL `meeting-cancel` to everyone who held it.
  Held, no-show and a meeting already over send nothing. `notifyAttendees:
  false` on a PATCH (default true) keeps a change to Meridies; switching
  `sendInvites` either way always sends. An end time is required while
  invites are on: the route answers 400 and the CHECK
  `meetings_invites_need_end` refuses a direct write.
- **Transactional.** Quiet hours don't hold an invite and the student's own
  reminder channels don't gate it, like a task assignment. A round that sends
  an invite or update costs one of 60 an hour per meeting owner
  (`consumeRateLimit`, `meeting-invites:<owner>`), charged only after the
  round is resolved to someone who will receive it; a round of cancellations is
  never held back, and a throttled mixed round still sends its cancellations.
- **Delivery.** The response carries `invites` (`{ status: "sending",
  recipients, skipped, note? } | { status: "none" } | { status: "skipped" |
  "unavailable", reason }`, `recipients` counting students and guardians,
  not the counselor's copy); the sends run after it, one at a time 250 ms
  apart, each retried once on a Resend 429 after Retry-After, each a
  `message_deliveries` row (templates `meeting-invite`, `meeting-update`,
  `meeting-cancel`; `student_id` the invited student, `meeting_id` the
  meeting, null for a deleted meeting's cancellations). A failed send never
  fails the save; a restart mid-round loses the rest of it (rows exist only
  for attempts that ran). The round runs on what persisted even if the
  attendee write fails after the row update. `GET /meetings/:id/invites`
  (counselor) lists the newest send per address with its delivery status;
  the student's own invites show in `GET /me/messages`.
- **AxIS.** `meetings.update` always sends `notifyAttendees: notify_attendees
  === true`, so an auto change emails nobody; `notify_attendees` and
  `send_invites` (either way) make it a Confirm card, as does `send_invites`
  on `meetings.create`. `meetings.delete` (already Confirm) cancels emailed
  invites. Undo restores `send_invites` and re-notifies a notified change.
- **Deploy order.** Either order is safe. Before `20261023090001` is applied,
  `invitesReady` (a zero-row probe; ready kept for the process, missing for
  30 s) is false: no write names `send_invites`, `sendInvites` is accepted and
  answered `invites: { status: "unavailable" }`, `sendInvites` reads false,
  the invites list is empty, and `insertDelivery` drops `meeting_id` the same
  way it drops `invitation_id`. Not in `REQUIRED_SCHEMA`. Invites reach
  families only once `INVITE_FROM_EMAIL` is on a verified Resend domain.
  Known limits: Outlook desktop may show the attachment as a file to open
  rather than an inline meeting request, Google may show an "Add to calendar"
  button instead of adding it for an unknown sender, and a student removed and
  re-added with no other change gets an invite at the same SEQUENCE as their
  cancellation.

### Documents and AI context

Files live in the private `student-documents` Storage bucket
(`20261011000001`). An object is readable by its uploader or by anyone who can
see the `documents` row pointing at it, so Storage is never more generous than
the file list; uploads go under a student the caller can edit, a folder they
can see, their own id, or `unfiled`. A row's `bucket` and `storage_path` are
the client's word for where it uploaded: `POST /files/documents` accepts only
the documents bucket and a path of the shape `lib/storagePath.ts` allows (a
uuid or `unfiled` first, no leading or trailing `/`, no empty, `.` or `..`
segment, no `?`, `#`, backslash, control character or encoded dot or slash),
because storage-js strips leading slashes and the request URL resolves dot
segments, so `/x` or `a/../x` would be a new row reaching the object `x`.
The database refuses the same from a client and refuses moving a row
(`documents_guard_storage_path`, `20261024000041`). Nothing downloads a
document's object with the service role: read it on the caller's client. `DELETE /files/documents/:id` removes the
Storage object too, on the caller's own client after the row is gone (best
effort: Storage's delete policy lets the uploader remove it, so a file a
student uploaded stays in the bucket when a counselor deletes its row).

`documents.available_to_llm` and `document_links.available_to_llm` are
data-handling switches, not display preferences. Anything that reads a document
into a prompt must filter on them (see `routes/tasks.ts`, and the context
layer below). A link kept out of AI is saved `skipped` and never fetched or
digested (`readLink` in `routes/files.ts`), and a link digest runs only when
the practice's "AI summaries" switch is on: the counselor's own practice, or
for a student their counselor's (`studentPracticeSettings` in
`lib/practiceSettings.ts`, service client keyed by the caller's own profile,
failing closed; `assertAiAllowed` applies it to every gated module a student
reaches, submission review included). Students don't see waived recommendation letters, IEP/504 or
counselor-only documents they didn't upload (`documents_student_restricted_select`),
nor the task-document links of those files (`deliverable_documents_student_restricted_select`),
nor their names in the activity log (the upload's `progress_events` row omits the filename).
A document or link names no student or one the caller can edit
(`private.can_edit_student`), and a new one lands unfiled, in one of the
caller's folders, or in the student folder of a student they can edit; a
client creates only plain folders under a parent of their own, and can't
point a folder at a student they can't edit (restrictive policies,
`20261024000022`; the routes check the same in code). A client inserts a
document or link only as its owner (`owner_id` = the caller), never changes
`owner_id`, and moves a row only into a folder it may file into
(`private.can_file_into_folder`; the `*_guard_client` triggers, keyed on
`current_user` so caseload transfer still moves rows). Before that, an
editor of any student could plant a row "owned" by a counselor in another
practice, which showed in that counselor's Files and, filed into their
Policy & research folder, reached their college-research prompt; that
prompt also drops a filed link about a student the counselor can't see
(`readableResearch` in `routes/collegeAi.ts`), so a row planted earlier
never reaches it. Owning the row was
enough before, so any approved counselor could plant a "transcript" with
their own parsed text on another practice's student, where its counselor's
Files and the AI context layer read it.
Only a counselor sets `aiAccess` and `ferpaWaived`, on create and on patch: the
route answers 403 to anyone else, and the `documents_guard_student_restricted`
trigger refuses a student's write of either, also through PostgREST. The same
trigger stops a student filing a document they didn't upload under a restricted kind.

### AI context layer

What AxIS may read about a student is decided in one place, `src/lib/context/`.

**Deploy order.** Apply `20261016000001_context_documents.sql` before deploying
this code: the documents loader, the essays list and task documents select
the new columns (`ai_access`, `ferpa_waived`) and fail without them. The
migration is safe to apply first; the previous code ignores the new columns.

- **Counselors only.** `buildStudentContext` refuses a caller whose role isn't
  `counselor` (403) before any read, the six `/ai/*` routes that call it have
  `requireRole("counselor")`, and every `/chat` route but deleting your own
  chat is `requireRole("counselor")` (RLS refuses a non-counselor's new chat
  rows too, `20261024000051`). A student's own session never builds a context.
  `buildStudentContext` also returns `outside` (the used sections someone other
  than the counselor wrote, for AxIS) and takes `trustedOnly`.
- **One entry point.** `buildStudentContext(request, studentId, feature, { only }?)`
  runs on `request.db`, so it never returns more than the counselor can see. A
  feature is `chat`, `student-ai`, `narrative-coherence`, `college-list` or
  `activities`; `profiles.ts` gives each its budget (60,000, 40,000, 50,000,
  24,000 and 24,000 characters) and its sections in priority order. It returns
  `text`, `used`, `omitted`, `studentName` and `facts`.
- **Deny by default.** `ai-allowlist.ts` lists the tables and columns AI may
  read, and every loader selects through `columns(...)`, never `select *` (a
  unit test fails on any `.select(` in the layer that doesn't). Private notes, status overrides, red flags, guardians,
  address, birthday, gender, contact email, phone, the aid tables and
  `profiles.profile` are not on it. The login email is read separately (the one
  annotated exception to the `columns(...)` rule), only for the `college-list`
  and `activities` features and only into `facts.identity`, to feed the identity
  filter; for other features `facts.identity.email` stays null. It never enters `text`.
- **Free text is data.** Every free-text value a student, an import or a
  document supplied goes into an escaped `<data kind="untrusted">` block
  (`wrapUntrusted` in `pack.ts`). That includes names and titles, not only
  descriptions and bodies. A section's `body` is for server-written labels,
  numbers, dates and constrained enum values only. `wrapUntrusted` escapes `&`,
  `<` and `>` in the content, and `"` as well in the `source` attribute. Every
  system prompt that carries a context also carries `UNTRUSTED_DATA_RULE`.
  `StudentContext.facts` and `studentName` hold raw student text, so wrap them
  with `wrapUntrusted` before they enter any prompt.
- **Budgets drop whole sections, never cut one.** A section that doesn't fit is
  left out and listed in `omitted` with reason `budget`.
- **Documents** (`documentAiDecision` in `documentAi.ts`, in this order):
  keep-out (`available_to_llm = false`) always wins; then a waived
  recommendation letter (never); then the practice's document-reading setting;
  then `ai_access` (`excluded` out, `allowed` in); then the kind defaults
  (transcript, resume, test-report, activity-list); an `other` file is
  `not-categorized` so the client can ask the counselor to categorize it, and
  any other kind is out. An allowed document with no parsed text, or with more
  than 12,000 characters of it, is reported in `omitted` (`empty`, `budget`)
  rather than dropped silently.
- **Essays.** The layer's `essays` section selects and renders a body only for
  a feature that asks for bodies (narrative coherence), and leaves it out when
  the linked document is kept out of AI or isn't readable by the caller
  (`essayBodyReadable`); a linked file that didn't come back fails closed. No
  current consumer reads essay bodies through that section: the Application
  page's Coherence builds its ticked essays through `coherenceMaterial.ts`
  (`usableEssay`), which applies the same `essayBodyReadable` rule.
  `GET /students/:id/ai-context?feature=narrative-coherence` shows the layer's
  view, not the ticked material a coherence run sends.
- **Chat and the `student-ai` routes read intake answers.** `intake_responses.answers`
  is free-form JSON from a counselor-designed form, so what reaches AI is whatever
  that form asks. It is wrapped as untrusted data (`source: "intake"`) in both profiles.
- **Narrowing.** `{ only }` narrows a feature's sections and never widens them.
  Narrative coherence asks for `profile` and `personal` only, and builds its
  ticked material (essays, activities, awards) through `coherenceMaterial.ts`,
  which wraps each piece, skips a block that would pass the 80,000-character cap
  whole, and reports only what was actually sent.
- **What each consumer returns.** The `/ai/*` student routes
  (`/ai/profile-summary`, `/ai/narrative-coherence`, `/ai/family-report`,
  `/ai/school-reframing`, `/ai/college-list`, `/ai/concierge`) and the
  Application page's Coherence (`POST /application/coherence` and
  `/coherence/ask`) return `contextUsed: { used, omitted }`. AxIS chat sends a
  `context` SSE event with the same shape. `ai_runs.input.context` stores it:
  section names, document file names and reasons, never the text itself.
- `GET /students/:id/ai-context?feature=` (counselor only, default `chat`)
  shows what AxIS would see.

**Not on the layer yet** (follow-up work; each still reads the record on its
own, with the text it reads wrapped as data where the route does so). The list
covers routes that read a student's record: `/ai/essay-review` (its
verbatim-quote span matching breaks under escaping, so it needs a different
defense), `/ai/award-appeal`, `/ai/aid-report`, `/ai/file-filing`,
`/ai/parent-alert`, and the single-essay routes (`/ai/essay-advice`,
`/ai/draft-quality`). Profile Update, submission review, email templates and
college research have their own inputs and are not part of this list.
On the Application page, the recommended-colleges column
(`POST /application/college-list/recommendations/axis`) and Activities Build
(`POST /application/activities-build`) still use a local `studentBrief` in
`src/routes/applicationAi.ts`.

### Research (counselor only)

A counselor asks for college or activity suggestions for a student. A
web-research model works from a de-identified brief and returns cited
candidates; code keeps only the candidates whose citations were really seen in
that run; a cheaper model picks the ones that fit; the counselor accepts or
dismisses what is left. The code is `src/lib/research/` and `routes/research.ts`.

**Deploy order.** Apply `20261016000002_research.sql` before deploying this code,
and after `20261016000001`. The code filters and writes `deliverables.visible_to_student`
and reads `research_runs`, `recommendations` and `research_blocked_domains`.
With the code first, every query that names the new column fails: creating a
counselor task, every `PATCH /tasks/:id` (including a student's progress
updates), raising a flag on a task, the escalation sweep, the parent-alert draft,
the student's due-tomorrow reminders, the calendar feed for a student, stall
detection, the composer's overdue check, and the research routes. The list is
not exhaustive. The migration is safe to apply first: the previous code ignores the new
column and tables.

- **Routes** (all `requireRole("counselor")`; a student gets 403):
  - `POST /students/:id/research/college-list` and `.../research/activities`,
    body `{ refresh?: boolean, focus?: string (max 2000) }`, strict. Limited to
    5 a minute per user (`limit("research:run", 5, 60)`, a preHandler, so it
    also counts requests that are then refused or served from the cache) and
    50 runs per practice per 24-hour window. The window is fixed, not sliding:
    `consume_rate_limit` anchors it at the first run, so a practice can spend up
    to about 100 across a boundary. The daily cap is `enforceRateLimit` on the
    key `research-day:<firm id, or the counselor's id when solo>`, not
    `enforceQuota`: `usage_counters` is keyed by one profile and its metric names
    are fixed by a CHECK constraint, so a per-practice count would need a
    migration, while a rate-limit key is any string. The limiter falls back to a
    per-process counter when its database call errors or no service-role key is
    set, so the cap is not a hard guarantee. A request served from the cache,
    refused for its focus, refused because the same run is already in flight, or
    refused by the up-front AI check does not spend the daily cap.
  - `GET /students/:id/recommendations?feature=college_list|activities`
    (newest first, 200 at most). Each row carries `createdAt` and `repeatOf`
    (below).
  - `POST /recommendations/:id/accept` and `.../dismiss`. These two and the
    list share a limit of 120 a minute per user. Accept answers `{ acceptedAs,
    alsoDismissed }`, dismiss `{ id, status, alsoDismissed }`. Their 409s carry
    a `code`: `recommendation_decided` (this row was accepted or dismissed
    already), `already_accepted` (the same suggestion was accepted before,
    below) and, for a college, `already_on_list` (the school is on the list
    already, by hand or otherwise; the claim is released and the row stays
    suggested).
  - Order inside a run: access (the counselor must be able to see the student:
    403 or 404), the brief and its identity filter, the cache, the practice's AI
    switches, the in-flight check, the daily cap, the run row, then the model.
  - **One identical run at a time.** If a `research_runs` row for the same
    student, feature and inputs hash is `running` and was created in the last 10
    minutes, the request gets 409 ("Research is already running for this
    student. Try again in a minute."). A `running` row older than 10 minutes is
    treated as dead and ignored: nothing sweeps them.
- **What the research model receives.** `RESEARCH_CANDIDATES_SYSTEM` (fixed
  instructions) and the brief as a data block (`buildResearchQuestion(brief)` in
  `prompt.ts`, a pure function that takes only the brief), so nothing else about
  the student can reach it by construction. The brief is the allowlisted fields
  only; the one free-text part of it is the counselor's focus, which has passed
  the identity filter. The match step (`FAST_MODEL`) is the
  only step that reads the student's context (`buildStudentContext`, the
  `college-list` or `activities` profile); it sees the kept candidates, not the web.
- **The brief** (`brief.ts`): `feature`, `grade`, `region`, `city`, `majors`,
  `interests`, `gpaBand`, `testBand`, `focus`. Majors are kept only when they pass
  a shape rule (1 to 5 words, at most 60 characters, letters, spaces and
  `& - / , '` only; anything else is dropped silently), at most 5. A major that
  holds the student's name, email or school (the identity filter below) is
  dropped too and the run goes ahead without it. Interests are the student's
  activity categories turned into a fixed vocabulary of generic words
  (`ACTIVITY_CATEGORIES`): `ACTIVITY_TYPE_CATEGORY` in `brief.ts` maps every
  value of `ACTIVITY_TYPES` (the Common App list in `profileUpdates.ts`) to
  exactly one vocabulary word, and `category()` looks a category up there first,
  then in the vocabulary itself; anything else is dropped. "other" is never sent,
  and neither are "LGBT" and "School Spirit" (mapped to "other" on purpose: a
  protected characteristic must not reach an outside model, and the other has no
  research use). A unit test imports the real `ACTIVITY_TYPES` and fails when a
  type has no row. The GPA is a 0.2-wide
  band on a 4.0 or 5.0 scale, the scale label chosen by the scale kind and never
  copied from the student's string (`unknown` when the GPA can't be put on a 4 or
  5 point scale). The test band is the SAT in 100s, else the ACT in 3s, else
  null. The grade is 9 to 12 from the graduation year, else null. `region` and
  `city` come from the student's hometown (`facts.identity.hometown`, free text,
  the only location on the AI allowlist), parsed in `brief.ts` (`locationOf`): a
  state or city is shared by many students and brings back local results, so
  both are sent. `region` is the part after the last comma when it is a US state
  code or full state name (all 50 plus DC), as the two-letter uppercase code,
  else null; a non-null `facts.state` (null today) would win, kept only as two
  letters. `city` is the part between the second-to-last and the last comma
  ("Brooklyn, New York, NY" gives "New York"), or just before the last comma, or
  the whole string when there is no comma and it isn't a state; it is kept only
  when it is 1 to 4 words, at most 40 characters, with letters, spaces and `- ' .`
  only (no digits, `@` or other punctuation), title-cased, else null, so a street
  address, an email or a sentence never reaches the model ("123 Main St,
  Cheyenne, WY" gives "Cheyenne"; "New York NY" with no comma gives city "New
  York Ny", region null). The counselor's
  focus is scanned for identity in full, then cut to 200 characters.
- **The identity filter** (`identityTokens`, `assertNoIdentity`). Identifying
  text is the student's name, email and school; the hometown is not (the brief
  carries the state and city, and a counselor may type a town in the focus).
  Each token carries a kind, `{ text, prefix }`. Name and email tokens
  (`prefix: true`): the name's parts of three or more characters (two when they
  hold a non-ASCII letter), the whole name, the name with its apostrophes and
  hyphens fused ("obrien"), the email, its local part and the pieces of it.
  School tokens (`prefix: false`): the school whole and with punctuation
  stripped, each word of it of four or more characters (two when non-ASCII) that
  isn't on `IDENTITY_STOPLIST` (generic school words such as "high", "academy",
  "north"), and the school's short form: its name without the last word when
  that word is generic and a distinctive word is left ("Lee High School" also
  yields "lee high"). Filler words (`IDENTITY_FILLER_WORDS`: of, the, for, and,
  at, in, on, a, an, de, la, el, del, des, du, le, les, y, &) never count as
  distinctive and are trimmed from both ends of the alias, so "Academy of
  Science" and "The Arts Academy" get no alias and "Bronx High School of Science"
  yields "bronx high school"; fillers are never single-word tokens. Text and
  tokens are compared after a Unicode fold (NFKC,
  lowercase, invisible format characters and combining marks removed, then the
  letters that don't decompose mapped to ASCII: ø to o, ł to l, đ to d, ß to ss,
  æ to ae, œ to oe, þ to th, ı to i), so accents, full-width letters and
  zero-width characters don't hide a name. Matching: ASCII name and email tokens
  of 5 or more characters match as a word prefix (the token starts at a word
  boundary and anything may follow, so "the Okafors" and "avery2027" are
  caught); school tokens and shorter ASCII tokens match whole words or whole
  phrases only (so a student named Will doesn't refuse "willing", and a student
  at "Academy of Science" refuses "academy of science robotics" but not
  "national academy of sciences"); tokens with a non-ASCII letter match
  anywhere. The scan runs on the
  counselor's focus (in full, before it is cut to 200 characters) and on each
  major; nothing else in the brief is scanned, because the rest is built by code
  from fixed sets and would only trip on the brief's own words (a surname
  "Null", a school "Health Sciences High"). A focus that holds any of it is
  refused with 400 ("The focus contains the student's name, email or school")
  before the daily cap is spent, a run row is written or a model is
  called. After the research, every query the model issued (each search, and
  each URL it fetched) is checked against the same tokens; a hit discards the
  run (`status = 'discarded'`, 400 to the counselor, nothing stored or served).
  Known limits: two-letter Latin name parts ("Li", "Bo") are not tokens; names
  transliterated from a non-Latin script are caught only in the script the
  student's record uses; the two layers (focus and post-run queries) share
  one token list, so a form of the identity the list lacks is missed by both;
  the hometown is parsed from free text, so a hometown typed in an odd form
  gives a null city or region (the run still works, without local results); and
  because the city is in the brief, the model's searches will contain it, which
  is intended.
- **Sources.** A candidate is kept only if it has a source that came back as a
  real citation, on a URL the run searched or fetched (`seenUrls`, compared
  ignoring `#fragment`, a trailing slash and http versus https), not on
  `research_blocked_domains` (the host or a subdomain of it), and answering
  `checkLink` with `ok` (`blocked`, a site refusing robots, doesn't pass). URLs
  the model types into its answer are ignored: sources are citations only. The
  API splits one answer into text blocks at citation boundaries, so
  `parseCandidates` joins the blocks in order and gives each JSON candidate
  object the citations of every block that overlaps it; an object that overlaps
  no citation is dropped. At most 8 candidates and 5 sources each. Colleges
  search the official-site allowlist (`researchDomains`); activities search the
  open web minus the blocklist.
- **Before anything is stored** (`validatePicks`): a pick must name a real,
  unused candidate and have an effort of low, medium or high; `why` is at most
  200 characters and two sentences, otherwise the pick is dropped whole (never
  clipped); the title is at most 300 characters; a deadline or cost is kept only
  as a plain string of at most 120 characters; `details.verify` is always
  true. A pick whose `why` names the student is kept and its `why` is replaced
  with "Fits the student's interests and record." (`replaceWhysNamingStudent`).
  A `why` names the student when it holds the email; the whole name (two or more
  parts, in order, any case, with a word boundary at both ends, so "may strongly
  help" is not a hit for "May Strong"); or one name part (3+ characters, 2+ when
  non-ASCII) written with a capital first letter as a whole word in the middle of
  a sentence. That single-part rule is case-sensitive and skips the first word of
  a sentence, so "This will help the student" and "May suit the student" survive
  for a student named Will or May, while "Fits Will's interest" doesn't.
  Non-ASCII parts match anywhere, ignoring case. A `why` that holds a link
  (`http://`, `https://`, `www.`), an email address or a phone number (7 or more
  digits in a row, or a ddd-ddd-dddd shape) is replaced the same way, because
  reasons are copied into task text that can be shared.
  Titles, deadlines and costs are checked too (`dropStudentInfoInSuggestions`,
  after `validatePicks`): a title holding the student's email, whole name (same
  word-boundary rule) or contact text (link, email address, phone number) drops
  the whole suggestion; a deadline or cost holding any of those loses just that
  field. Single name parts and the school are deliberately not
  checked in titles: a single part would drop real programs ("Lincoln Scholars"
  for a student named Lincoln), and the owner allows a title to name the
  student's town or school, since a local program is a good result.
- **Cache.** A run that succeeded is served for 7 days for the same student,
  feature and brief hash (`briefHash`; majors and interests sorted). `refresh:
  true` bypasses it, and so does any change to the brief, the focus included. A
  run whose answer held no candidate objects at all is cached too, so a repeat
  click doesn't pay for the same empty search. A run whose answer held
  candidates but stored none (dropped by the citation keeper, the link check, the
  match step or the reason checks) is stored as `succeeded` with an empty list
  but expires at once, so the next request runs again. Each run logs its counts
  with the run id (numbers only): answer parts, candidate objects found,
  candidates parsed, kept by the keeper, picked, stored. The scanner steps into an
  object with no string `title`, so a `{"candidates":[...]}` wrapper yields its
  inner candidates. Failed and discarded runs are never served.
- **Recommendations.** `recommendations` and `research_runs` are readable by a
  counselor who can view the student (RLS: role `counselor` and
  `private.can_view_student`): never the student, never a same-firm counselor
  who isn't on the case. Only the service role writes them. A college
  recommendation carries `collegeId` when exactly one catalog college has that
  name. Accepting needs edit access to the student. It claims the row first with
  a conditional update (`status = 'suggested'`; a second click gets 409), then
  creates, and releases the claim if creating fails. A college becomes a row on
  the student's college list (`addToList`). An activity becomes a counselor task
  (kind `custom`, `source = 'counselor'`, `visible_to_student = false`, no
  deadline mirroring, no notification) whose instructions are the `why`, the
  source URLs and "Verify dates and costs before applying."; what was created is
  stored in `accepted_as`. Dismiss is the same conditional update. Nothing is
  shared across practices.
- **The same suggestion across runs** (`repeats.ts`). Every run that isn't
  served from the cache stores fresh rows, so "search again" or a new focus
  leaves one program or college `suggested` twice, or suggests again one that
  was accepted. Two rows are the same suggestion when they share a feature and
  a key: a college's catalog id when it has one, else the title folded
  (Unicode NFKC, lowercase, accents and punctuation dropped, `&` read as
  "and"). Every recommendation DTO (the list, a run's answer, a cached answer)
  carries `repeatOf`, set only on a `suggested` row: `{ id, status:
  "suggested" }` on every older copy, pointing at the newest, which stands for
  them all (a list shows the newest only); `{ id, status: "accepted" }` on the
  newest copy when an accepted row for it still has its college-list row or
  task (read on the caller's client; an accepted row whose thing was deleted,
  or with no `accepted_as`, doesn't count). Accepting such a copy is refused
  with 409 `already_accepted` before anything is claimed, so one program can't
  become two tasks; dismissing it works. A decision on one copy, accept or
  dismiss, dismisses the student's other `suggested` copies (service role,
  ids read on the caller's client for that student, `status = 'suggested'`
  repeated in the update; best effort, logged on failure) and returns them as
  `alsoDismissed`. A failed repeat read on a fresh run is logged and the paid
  answer is returned unmarked; on the list, a cached answer and accept it
  fails the request (accept fails closed). Known limit: two copies accepted at
  the same instant can both pass the check. AxIS's `recommendations.list`
  reply names the repeat.
- **Hidden tasks.** `deliverables.visible_to_student` (default true). Enforced in
  RLS by restrictive select policies, so a student's read never returns a hidden
  task or what points at it: `deliverables`, `deliverable_stages`,
  `deliverable_documents`, `progress_events`, `draft_quality_checks`,
  `deliverable_tracker_checks`, `red_flags` and `message_deliveries`. Counselors
  are unaffected. Side channels that skip hidden tasks in code: the student's
  due-tomorrow reminders, the student's calendar feed, stall detection, the
  escalation sweep (a flag about a hidden task is skipped with a reason, so it
  never reaches the family), the composer's overdue check and its AxIS draft,
  the parent-alert draft (`POST /ai/parent-alert`), the "needs a fix" notice
  after a submission review, `POST /tasks/:id/notify` (409), and creating a hidden
  task (no deadline mirroring, no assignment email or text). Only a counselor
  sets the flag; a student gets 403. Sharing is one-way: `PATCH /tasks/:id {
  visibleToStudent: true }` mirrors the dated stages into deadlines and tells the
  student, and a task the student can already see can't be hidden again (409). A
  red flag can't be raised on a hidden task (409), and an intake request task
  from New student can't be hidden (400).
- **`RESEARCH_FAKE=fixture`** is for tests. It works only when `NODE_ENV` is
  `development` or `test`: `seamFor` returns the fixtures only then, and
  `src/index.ts` exits at boot with a message naming `RESEARCH_FAKE` if it is
  set with `NODE_ENV=production` or with `NODE_ENV` unset. Any other value
  (staging, say) never gets that far: `env.ts` rejects a `NODE_ENV` that is not
  `development`, `production` or `test` first, with its own error. The boot check reads
  the raw `process.env.NODE_ENV`, so the default of "development" when it is unset
  does not unlock the fake. The server logs a warning whenever it is on. With it on, research, the match step and the link
  check return canned answers (including a candidate on a blocked domain and one
  the run never saw, to exercise the keeper) and no model or web call is made.
- **Checking the live path by hand:** `scripts/smoke/research.ts` (its header
  says how to make the fixture student). It refuses a student whose name doesn't
  start with "Fixture ", and an API that isn't on localhost unless
  `SMOKE_ALLOW_REMOTE=1`.

**Not built or not covered.** There is no student-facing research. Nothing
sweeps a run left `running` after a crash; such a run is never served and stays
as it is (the in-flight check ignores one older than 10 minutes). Two identical
uncached requests made at the same instant can both pass the in-flight check and
run.
Research is in none of the practice AI switches (`practiceSettings.ts`), so the
up-front AI check gates nothing yet. The app's screens: the College list's
Recommended column (Research colleges), Activities Build (Research
activities), and sharing a hidden task from the student page's task card.

### Import pipeline (step 1)

Spec: `docs/superpowers/specs/2026-10-09-import-pipeline-design.md`.

- **The browser never writes import data.** It reads `roster_imports`,
  `import_files`, `import_items`, `import_changes` under
  `private.can_view_import` (uploader while in the practice, plus firm
  owners/admins) and *requests* jobs through `request_import_commit`,
  `request_import_undo`, `request_held_apply`.
- **Jobs run on `IMPORT_DATABASE_URL` as `import_worker`** (session pooler,
  never the transaction pooler, never the `postgres` login; the server exits
  at boot otherwise). `commit_import`, `undo_import` and `apply_held_item` are
  one transaction each with `statement_timeout = 300s`, lock with SKIP LOCKED,
  and write their audit row inside the transaction. Commit, undo and apply
  each require the requester's claim (`p_actor = job_actor`).
- **Runner hardening.** The pool has an error listener and a 10s connect
  timeout; a busy job is retried 3 times, 2s apart; job error logs carry only
  the error code and message, never SQL or row values.
- **No dynamic SQL.** Writes go through `private.import_set_field` (one
  compare-and-set UPDATE per field) and `private.import_insert_row` (fixed
  columns, `source = 'import'`). `import_fields` is the only list of
  importable fields; `import_changes (target_table, field)` has a foreign key to it.
- **Apply order.** GPA fields first (GPA <= 10), then scale, then the rest,
  each with `clock_timestamp()` as `applied_at`; undo runs in exact reverse.
- **Staging must read `old_value` with `private.import_current_value`** so the
  compare-and-set matches what the database holds.
- **Held data never attaches on acceptance**: `accept_invitation` moves it to
  the counselor's "Ready to apply" queue for 30 days (old roster rows too).
  Held data follows the student's email across resends. In
  `request_held_apply`, an omitted decision uses the queue's default, and the
  request is refused while an import is still processing.
- **GPA has a scale.** Read GPA through `src/lib/gpa.ts`; fit, odds, class
  rank and scholarship minimums use `fourPointGpa`, which returns null for
  non-4/5-point scales.
- **Imported text is data.** Rows with `source = 'import'` (activities, test
  scores, courses) must be passed to any model as data, never as instructions.
- Cron: `POST /internal/imports/sweep` every 5-15 minutes (finishes stuck
  jobs, fails jobs whose requester's account is gone, expires held data with
  a 7-day warning, compacts after 30 days).
- Held-data expiry and warning emails are off until the Ready-to-apply page
  ships (`IMPORT_HOLD_EXPIRY_ENABLED=true` turns them on).
- `request_held_apply` records each field's current value as `old_value`;
  `apply_held_item` compare-and-sets against it, so a value that changed
  while waiting is kept (`skipped_stale`).
- **The questionnaire writes through the same functions** (see "The
  questionnaire fills the record"). Since `20261023010001`, `import_fields`
  also lists `profiles.high_school` / `hometown` / `grad_year`,
  `student_academics.gpa_band` and award rows (25 entries), activity rows may
  carry `timing`, `continuing` and `uc_description`, inserted activities and
  awards go to the end of the sheet, and `import_insert_row` has a 4-argument
  form taking the source (`'import'` or `'intake'`); the 3-argument form is
  unchanged for the import's callers. `import_row_snapshot` keeps its
  activity shape, because undo compares against snapshots stored at commit.
  A value the questionnaire filled and nobody changed since defaults to
  accept in the held queue (`private.intake_owns_current`).

### Import pipeline (step 2: the CSV/XLSX path)

Spec as above (§5.1-§5.10, "v1.0 as built" at its end). The Import page's API;
Ready to apply (`GET /imports/held`, `POST /imports/held/:itemId/apply`) is
step 1's and is never gated.

- **Rollout.** `IMPORTS_ROLLOUT=off|pilot|all` (default `pilot`) and
  `IMPORTS_PILOT` (comma-separated firm ids, or a solo counselor's own id;
  `lib/imports/rollout.ts`). Env-based, so a new pilot practice needs a
  redeploy. `IMPORTS_AI=off` is the kill switch for the AI column mapping.
  `GET /imports/availability` and `GET /imports` answer `{ enabled, available,
  aiAvailable }` and never 503; every other step-2 route answers
  `403 { code: "imports_not_enabled" }` outside the rollout and
  `503 { code: "imports_unavailable" }` before the migrations or without
  `IMPORT_DATABASE_URL` (`lib/imports/availability.ts`). Invitations, discard
  and template delete ask only for the migrations, so a saved import can
  still send after its practice leaves the pilot.
- **Deploy order.** `20261023020001`-`20261023020003`, either order (see
  `DATABASE_MIGRATION_INSTRUCTIONS.md`). The readiness probe asks for
  `imports_step2_ready()`, the last object of the last file; a ready answer is
  kept for the process, a missing one for 30 s. Not in `REQUIRED_SCHEMA`: no
  request outside `/imports` needs it.
- **Which rows are which.** A new-pipeline import is one `start_import`
  created: `permission_confirmed_at` is set (the family-permission box, who
  ticked it and when). The old roster flow's rows have it null. `/roster/*`
  never lists or acts on a new-pipeline import, `/imports` never lists an old
  one, and **the client guard makes a new-pipeline row the API's alone**: no
  client update or delete at all. A new `roster_imports` column must be added
  to `private.roster_imports_guard_client()` (it names every protected column).
- **Flow.** `POST /imports { permissionConfirmed: true }` (draft, 7-day
  expiry; shares `roster:import`'s 20 an hour) -> `POST /:id/files/upload-url`
  (signed upload into `imports/<uid>/<import>/<file>-<name>`, minted on the
  counselor's token; only the uploader, only a draft) -> `POST /:id/files`
  (download on the same token, size, sha256, magic bytes, parse and profile;
  a bad file fails by name and the rest go on; up to 20 files and 5,000 rows)
  -> `POST /:id/plan` (template by header fingerprint, then presets, then the
  AI fallback; the import moves to `mapping`) -> `PUT /:id/plan` (every edit;
  a plan with problems is stored with them, staging refuses until there are
  none; `saveTemplate: { name }` is "Remember this layout") -> `POST /:id/stage`
  (synchronous, about 30 s for 5,000 rows; a double click gets 409) ->
  `GET /:id/review?section=summary|groups|changes|suggested|invites|skipped|problems`
  and `PATCH /:id/review` (one transaction: `fixes`, `items` confirm/skip/invite,
  `changes`, `patterns`) -> `POST /:id/commit { invitations: N }` (required, and
  equal to the staged count, whenever the import invites anyone: `409 { code:
  "confirm-invitations", count }`; checked again under the lock) ->
  `POST /:id/invitations` -> `POST /:id/undo`. `DELETE /:id` discards a draft or
  review; `DELETE /templates/:id`.
- **Parsing** (`lib/imports/sheet.ts`, `parse.ts`). In a forked child process,
  not a worker thread: a process-wide `--max-old-space-size` (NODE_OPTIONS)
  silently overrides a worker's `resourceLimits`. The child gets its own heap
  flag (256 MB), a 20 s kill, an environment holding only PATH, and no stdout.
  Type from bytes (UTF-8 or windows-1252 CSV; XLSX by its content types; xls,
  xlsm and the rest refused). XLSX: declared sizes (100 MiB in all, 50 MiB an
  entry, 2,000 entries), no external links, no DOCTYPE/ENTITY in any XML part;
  the parser (`read-excel-file/universal`, saxen) then reads only the parts
  that passed, rezipped uncompressed, so it never re-reads the original
  archive and never starts fflate's helper threads. Formulas give cached
  values only. `scripts/smoke/parse-worker.mjs` checks the built child (CI).
  **What comes back is capped too** (`caps.ts`): the heap flag protects the
  child, not the API, and a small XLSX whose cells all point at one shared
  string answers with a copy per cell. So the child counts characters before
  it answers (`MAX_CELL_CHARS` 32,767 a cell; `MAX_PARSED_CHARS` 8 million
  for all of an import's files, each profile keeping its count, registration
  and staging each handing a parse what the earlier files left) and refuses
  by name (`too-large-unpacked`, `cell-too-long`, `import-too-large`); the
  answer never goes back over IPC but as JSON on fd 3, whose bytes the parent
  counts, killing the child past `MAX_PARSE_OUTPUT_BYTES` (32 MiB); and
  `checkOutcome` (zod) checks its shape and recounts before anyone uses it.
- **What the model sees** (`profile.ts`, `mask.ts`, `aiPlan.ts`, module
  `import-mapping`, Haiku through `runStructured`): masked headers, column
  counts and shapes, numeric min/max only for small numbers (at most 2,100),
  a date column's year range, sheets numbered not named, sensitive columns
  left out; wrapped as untrusted data. Never a real text cell, and a header
  only when it reads as a label (`headerIsLabel`: label words, a number of
  at most four digits, and no value inside it). A file with no header row
  makes its first student's row the headers, so a header that holds a value
  (`headerHoldsValue`: a run of joined digits with five or more digits or
  three groups, "Cell 555 123 4567", "DOB 05/14/2008"; or an email), any two
  to four letter words that aren't a label (`<name>`, whatever the case), or
  one shaped like its column (compared without letter case) is masked as a
  cell (`maskHeader`). A row with two such strong signals, or half its
  headers, is masked whole (`headerRowIsData`); a single word shaped like
  its column ("Sport" over "Soccer") is masked alone but never masks the
  row, so a real header row keeps its labels. Its answer is
  filtered to the columns it was asked about and targets on the fixed list;
  a score column's exam comes from the file's header. Two retries, then the
  counselor maps by hand. Spend per import (`onUsage` on `runStructured`,
  `spend.ts`) is capped at 200 cents. It is under the practice's "reading
  uploaded documents" switch (`practiceSettings.ts` `DOCUMENT_MODULES`). AI
  cell cleanup (`import-cleanup`) is deferred: a cell that won't clean is a
  manual fix in review.
- **Sensitive values** (`sensitive.ts`, §7.4): a header naming a never-stored
  category is forced to ignore whoever mapped it (`validatePlan`); an
  SSN-shaped value is dropped and counted; a bare 9-digit value is flagged
  `nine_digit_id`, never blocked.
- **Matching** (`match.ts`; `import_roster_for_matching`): only the
  uploader's own caseload (their students and write collaborations),
  intersected with what the actor may write, so a firm admin staging a
  member's import never matches the admin's wider reach. Email + name:
  matched; email with a different name: suggested, confirmed one by one; name
  + birthday or grad year + school: suggested; else invite or skip. Siblings on
  a parent's email are never merged, matched or invited on their own;
  `stage_import` keeps one invitation per address and the review's "invite"
  refuses a second at the same address. **Across imports and routes**
  (`heldAddresses.ts`): `accept_invitation` moves the held items of every
  pending or revoked invitation from the same counselor at the same address,
  so an address whose such invitation carries a different student's held
  data is skipped at staging, refused when sending, and refused by
  `insertInvitation` (409 `address_holds_other_student`), which every route
  that invites uses (single, New student, resend, Mass invite, pipeline,
  referrals; the old roster send checks per row). Read through the service
  role, filtered to that counselor's own invitations, so imports made in a
  firm they left still count; every read error refuses. The same student is
  the same non-blank full name ignoring case and spacing (`sameStudentName`):
  a re-import or a resend (which carry the imported name) follow the email;
  a nickname ("Sam Lee", "Samuel Lee") or a missing name is someone else.
  `20261024000062` applies the same rule inside `accept_invitation` (another
  invitation's items move only when both name the same student), which also
  closes a race between two routes inviting at the same instant; sends of
  one counselor's imports are serialized by a lease (`import-invites:<id>`,
  409 while one runs). Known limits: an item refused this way is marked
  failed, and Retry refuses it again until the other invitation is accepted
  or its data expires; held data whose invitation the counselor then resends
  under a different name, or that has no name, stays behind once
  `20261024000062` is applied and expires; the old roster flow's own rows
  still follow the address as before.
- **Staging defaults** (`stage_import`, `private.import_assess`): old values
  read with `import_current_value`; equal values dropped (3.8 = 3.800); rows
  already on the record dropped and counted, near matches kept back as
  `possible_duplicate`; an empty field fills (`auto` on a high-confidence
  email match, else `accept`); a value an earlier import from the same
  `source_system` or template wrote, unedited since, is `accept`; anything
  else `keep_old` (an unknown author counts as the student), except a value
  the student's onboarding questionnaire wrote and nobody changed since,
  which is `accept` with old source `intake` (`private.intake_owns_current`,
  the same rule as Ready to apply; a review fix reads it the same way).
  Conflicting values in one file are one change flagged `conflict_in_file`
  with its `alternatives`. `student_academics.gpa_band` and the `profiles`
  and `awards` rows are on `import_fields` for the questionnaire only: no
  column maps to them (`QUESTIONNAIRE_ONLY` in `lib/imports/fields.ts`,
  refused by `validatePlan`), though `values.ts` validates their types and
  `import_row_presence` knows the award key (name and year).
- **Invitations** (`invitations.ts`): only the uploader sends (accepting makes
  the inviter the counselor), so a firm admin gets 403. Items are claimed
  (`invite_state = 'sending'`, SKIP LOCKED; a claim older than ten minutes
  can be retaken), never-tried addresses first; the invitation row is inserted
  and tied to the item before the email goes out (`insertInvitation`, then
  `import_link_invitation`, then `emailInvitation` with the Resend
  idempotency key `import-invite/<item>/<invitation>`); 25 per request; the
  `invites` quota (100 a day, 50 for an account under 14 days), charged only
  after the batch's held addresses were read. **Meridies looks once per
  counselor** (`inviteReview`): when the invitations their saved imports have
  sent or still hold, with this import's, pass 50 and none of their imports
  is approved yet, the import is saved but its invitations wait
  (`invites_held_reason = 'first-import-review'`, written through the
  service role) until Meridies sets `invites_approved_at` on any one of their
  imports by hand, which releases all of them, earlier ones included; one
  email goes to `ACCESS_REVIEW_EMAIL`. Splitting a list or saving a one-row
  import first doesn't skip it. Counted over every import whose counselor is
  the uploader, never on the caller's RLS client (which hides imports made in
  a firm they left, and a member's solo imports from a firm admin): through
  `public.import_invite_review` when `20261024000061` is applied, else on the
  service role, and held when it can ask neither. Checked after each commit
  request and again before every send; `20261024000061` also makes
  `request_import_commit` and `import_claim_invites` apply it (either deploy
  order, not in `REQUIRED_SCHEMA`). Items a caseload transfer brought count
  toward the receiver's 50. The old roster send (`/roster/imports/:id/send`)
  answers 409 `use_import` for a practice with the Import page, so it is no
  way around the review. Mass invite and single invites are not import
  invitations and carry no file's data: the daily `invites` quota (and Mass
  invite's 10 sends an hour) is their only volume limit.
- **Retention** (`retention.ts`, `import_retention`), every sweep, not behind
  `IMPORT_HOLD_EXPIRY_ENABLED`: drafts and reviews expire after 7 days with
  their staged values; never-sent invitations' data expires 14 days after the
  save, sent ones' when the invitation does; matching dead for ten minutes
  returns to mapping; masked samples go at commit; raw files once an import is
  saved, undone or expired; objects nobody registered after 24 hours (through
  the Storage API on the service client). Skipped before the migrations;
  isolated, so it never fails the sweep's heartbeat. The 30-day expiry of
  accepted, waiting data and its warnings stay behind the flag.
- **Ready to apply** carries each student's current `gpaScale`, and
  dismissing an entry (every change `reject`) needs no typed name. The
  name check's 409 (`name-confirmation-required`) carries its sentence as
  `error`, the shape every client reads (and as `message`).
- **Not built** (v1.0): AI cell cleanup; pausing invitations on bounce or
  complaint rates (§6.5) and the §12 metrics (counts are in `stats` and
  `job_result`); PDFs (v1.1); direct Google Sheets; shared starter templates;
  `high_school` and `grad_year` as import targets (matching keys and the
  invitation's grad year only); template management beyond list and delete;
  a database-held pilot list. Header presets and source-system detection are
  deliberately conservative until real exports arrive (spec §13).

## Safe coding standards

- TypeScript strict — no `any`
- ESM imports with `.js` extensions (`import { env } from "./env.js"`)
- Zod at every boundary, `.strict()` on request bodies
- Thin route handlers — logic in `src/lib/`
- Always authenticate **and** authorize
- Never log secrets; never return stack traces or key hints to a client.
  Every `err` in a log line goes through `serializeErr` (`lib/requestLog.ts`):
  type, redacted message and stack, `code`/`status` only, so a PostgREST
  `details` or an SDK's request echo never lands in Railway. `redactText`
  strips emails, bearer tokens, JWTs, API keys, phone numbers and query
  values; use it on any free text you log outside `err`, and log a
  user-supplied URL as `logHost(url)`. Never log a body, a prompt or essay text.
- Never commit `.env` — keep `.env.example` current
- **Text a user supplied is scanned in linear time.** Node serves every
  tenant from one thread, so a regular expression that rescans the rest of
  its input from every position (a quantified run followed by something that
  may be missing: `/<[^>]+>/`, `/<a[\s\S]*?<\/a>/`, `/[ \t]+\n/`,
  `/\s*@\s*/`, `/[^\s@]+@[^\s@]+\.[^\s@]+/`, `,(?![^(]*\))`, `/x[^>]*y/`,
  `/[chars]+$/` unanchored, nested `(a+)+`) is a denial of service when the
  text is a pasted link's page, an uploaded document, a Mass invite paste, an
  import cell or header, an AxIS message or a model's streamed reply. Use the
  scanners in `lib/linearText.ts` and `lib/imports/textShapes.ts` (each names
  the expression it replaces and is checked against it on random input), cap
  the input before matching (`MAX_DOCUMENT_BYTES` for document text, a window
  for log redaction), or anchor and bound the pattern so each position does a
  bounded amount of work. A new scan of such text gets a unit test that feeds
  the worst case and asserts it finishes in well under 100 ms
  (`test/unit/regex-dos-helpers.ts`); `test/integration/regex-dos.test.mjs`
  runs the review's attacks against the API and checks `/health` still
  answers while each one is in flight.
- CORS is an allowlist from `CORS_ORIGIN` — never `*`
- Treat model output as untrusted user content

## Caseload transfer

Spec: `docs/superpowers/specs/2026-10-15-caseload-transfer-design.md`.
Migrations `20261023030001`-`3` (runbook in `DATABASE_MIGRATION_INSTRUCTIONS.md`),
code `lib/caseloadTransfer.ts`, routes in `routes/management.ts` and
`routes/firms.ts`.

- **Who.** A firm owner or admin (approved), moving a member's students to
  other approved members of the same firm. The from side may be pending or
  revoked; every receiver passes the approval gate
  (`private.caseload_can_receive`). Only the owner transfers the owner's
  students. A solo counselor is refused ("Start a firm..."). Not in the AxIS
  catalog.
- **Routes.** `GET /management/consultants/:id/transfer-preview`,
  `POST /management/consultants/:id/transfer` (`{ mode: "one_person", toId }`
  or `{ mode: "per_student", assignments: [{ studentId, toId }] }`, at most
  500; `notifyStudents` default true, `removeAfter`, `includePracticeItems`,
  `practiceToId`), `GET /management/transfers`,
  `GET`/`PATCH /firms/mine/caseload-policy`. Before the migrations they answer
  503 `caseload_transfer_unavailable`.
- **One transaction** (`transfer_caseload`, SECURITY DEFINER): every row about
  a moved student that the old counselor owns and that would cascade with
  their account moves (meetings, notes, reports, messages, research runs,
  outcomes, the student folder with its subtree, documents and links,
  supplement Doc rows, accepted invitations); open work moves. A document or
  link moves only when it is about a moved student (to that student's
  receiver) or has no student and is filed in the moved folder tree (with
  the tree); one about anybody else filed in that tree stays with its owner,
  unfiled, and is counted as `attention.keptFiles` (`20261024000082`), and a
  moved file whose folder isn't the receiver's afterwards is unfiled. The
  files routes refuse filing a document or link about one student anywhere in
  another student's folder tree, or moving a folder that holds one there
  (`folderTreeStudent` in `routes/files.ts`); scheduled sends
  and queued parent alerts are cancelled; a group meeting moves only when
  every attendee goes to the same receiver; held import data moves into a
  carrier import owned by the student's receiver (no import function
  changes). Practice items (pending invitations, imports, templates, the firm
  pipeline rows they made) move only with the whole caseload and when the
  consultant is leaving, and not while one of their imports is saving or its
  invitations are being sent (a fresh step-2 `sending` claim finishes only for
  the uploader): 409, try again in a few minutes. "Transfer and remove" removes the member inside the
  same transaction. A transfer is recorded in `caseload_transfers` /
  `caseload_transfer_students` and `audit_log`.
- **No addresses from SQL.** The functions return ids and names; the API
  reads the addresses of exactly the returned ids on the service client after
  the commit, to mail the receiver, the old counselor and each active,
  non-alumni student (templates `caseload-transfer-*`). Guardians are not
  emailed.
- **Hand-kept table list.** `caseload-transfer.test.mjs` fails when a new
  cascading counselor-owned column appears on a student table that the
  transfer doesn't handle and that isn't on its "stays" list. Decide it there.
- **Temporary delegation** is specified in the spec (§13) and not built.

## Teams, guardians, delivery status, data rights, monitoring

- **Firm teams.** `profiles.firm_id` can't be updated by clients, so firms
  change through SECURITY DEFINER functions: `create_firm`,
  `accept_firm_invitation` (the invite's email must match the account; seats
  are enforced), `set_firm_member_role` (the owner's seat never changes),
  `remove_firm_member` (the owner can't leave; a member who still has
  students, archived included, is refused with 409 `caseload_not_transferred`
  until their caseload is transferred or an owner/admin releases them with
  `?releaseStudents=true`). Routes: `/firms`, `/firms/mine/{members,invites}`,
  `/firms/mine/caseload-policy`, `/firms/join`. Invitation tokens are stored
  as sha256 only; the app page for the link is `/join-firm/<token>`.
  `firm_members` is read-only to clients (no insert, update or delete grant,
  no write policy), and a client updates only a firm's branding columns
  (`name`, `website`, `logo_url`, `logo_updated_at`, `banner_url`, the
  accent): `owner_id`, `seats` and `plan` change only inside those functions,
  and a client inserts no firm row (`create_firm` makes it;
  `20261024000021`). A firm_members row is what makes someone a member to
  `firm_consultant_students`, `can_assign_work` and the staff blast, so it
  must never be writable by an admin directly.
- **Guardians.** A student may add a guardian, but one they add starts with
  `alerts_enabled = false`, and only the counselor side changes or removes a
  guardian (`private.can_manage_guardians`). Otherwise a student could redirect
  the parent alerts their counselor sends.
- **Delivery status.** `POST /webhooks/resend` (Svix signature,
  `RESEND_WEBHOOK_SECRET`) and `POST /webhooks/twilio/status`
  (`X-Twilio-Signature`, `TWILIO_AUTH_TOKEN` over `PUBLIC_API_URL`) move
  `message_deliveries` to delivered / bounced / failed; a status never moves
  backwards. With `PUBLIC_API_URL` set, every SMS asks Twilio to report there.
  What the app shows (`lib/inviteDelivery.ts`): `GET /invites` and
  `/invites/building` carry `delivery` (`{ status, channel, at, deliveredAt,
  reason }` or null) per invitation, from `message_deliveries.invitation_id`
  (`20261018000002`, read on the caller's client under
  `message_deliveries_invitation_counselor`; the invite email stamps it).
  `GET /communication/:id/messages` overlays each attempt's live status the
  same way. The status is the row's own: a row only `sent` is never reported
  delivered, and `reason` (bounced/failed only) never names a server setting.
  **Apply `20261018000002` to light up delivery status.** Until then invites
  work and show "Pending": the list reads `delivery: null`, and the delivery
  row insert (`lib/deliveryInsert.ts`) retries without `invitation_id`
  when the column is missing (42703 / PGRST204), remembering that for five
  minutes per process so each send doesn't fail first. It is deliberately not
  in `REQUIRED_SCHEMA`. `meeting_id` (`20261023090001`, meeting invites) gets
  the same treatment, each column cached on its own, and a row whose meeting
  was deleted mid-send is kept without the link.
- **Data rights.** `GET /account/export` (self) and
  `GET /account/students/:id/export` (counselor) read through the caller's RLS
  client, so an export holds exactly what that person can already see (the
  counselor's export of a student includes `recommendations` and `research_runs`;
  the student's own export holds neither).
  `DELETE /account` (body `{"confirm":"delete my account"}`) deletes the auth
  user; a counselor with an active roster or an owned firm is refused, and a
  firm member with any student, archived included, is told to ask an owner or
  admin to transfer them.
- **Monitoring.** Every scheduled job writes `job_heartbeats`.
  `GET /internal/status` (CRON_SECRET) answers 503 and lists the overdue job
  when one hasn't run cleanly within twice its interval. It also lists as
  `failing` any job whose last run failed or was degraded (last error newer
  than last clean run); for a job that runs daily or less often (the monthly
  Scorecard load, weekly event discovery) that alone makes
  it 503 with `status: "failing"`, because waiting for "overdue" would mean
  weeks of silence (`summarizeHeartbeats` in `lib/heartbeat.ts`). A frequent
  job's single failure is listed but left to the overdue rule. The error text
  stays in the table, never in the response. Point an uptime monitor
  at `/health` (public) and `/internal/status` (with the bearer header).

## Tests and CI

- `npm test`: unit tests (`test/unit`, Node's test runner via tsx) for the pure
  rules: search ranking and sanitising, fit and odds, Scorecard/IPEDS/curated
  mapping (against a recorded real Scorecard response in `test/fixtures`; the
  extended fields, the field reference, the degrade paths and the status
  summary in `scorecard-extended` and `college-official`), the
  essay guardrails, the link guard, payments, class rank, proposals, webhook
  signatures, heartbeats, the context layer (allowlist, packing, feature
  profiles, coherence material, consumers), and research (`research-brief`,
  `research-citations`, `research-extract`, `research-run`,
  `research-boot-guard`, `research-repeats`: the brief and identity filter, the
  citation keeper, the answer parser, the match validation, the boot check and
  the repeat rule), the
  counselor approval gate (`access`, `access-review`, `service-callsites`),
  the questionnaire sync's read side and activity-type list (`intake-sync`),
  caseload transfer bodies and answers (`caseload-transfer`), campus photos
  (`college-photos*`), /health's key check (`anthropic-key-check`), the
  import pipeline (`import-*`: parsing and the zip guard, the capped
  child process, profile and masking, sensitive values, the plan and presets,
  the AI mapping with its spend, rows and matching, values, rollout),
  meeting invites (`ics`, `meeting-invites`, `email-attachments`,
  `delivery-insert`), the meeting calendar owner rule (`meeting-calendar`),
  the ownership checks in code (`ownership-guards`:
  who archives, which acceptance is trusted, which frozen recipients a
  scheduled message may still reach), linear-time text scanning (`linear-text`, `mass-invite`,
  `import-text-shapes`, `regex-dos`: each scanner against the expression it
  replaced on random input, and the worst cases under 100 ms), document storage
  paths (`storage-path`), the hand-in AI rule (`submissions`), reminder
  destinations (`studentReminders`), the streamed-answer essay gate
  (`prose-guard`), and AxIS (`axis-*`: understanding, risk, ledger, retrieval, grounding, the
  loop and engine against a scripted model, and the fail-safes).
- `npm run test:integration`: persona suites (`test/integration`) against a
  local Supabase and a running API, as real counselor and student accounts,
  including `context-layer`, `context-documents`, `research-tables` (RLS and
  hidden tasks), `research-api` (the routes, with the test double),
  `research-repeats` (the same suggestion across runs),
  `intake-sync` and `intake-held-backfill` (the questionnaire, every field
  and rule, against held imports, and the backfill),
  `meeting-invites` (emailed calendar invites), `meeting-calendar-owner`
  (forged owners and calendar pointers, read-only collaborators),
  `submission-hardening` (a hand-in can't read another object, skip the AI
  rule, flood the counselor or re-run Submit), `student-reminders`
  (reminders reach the student only), `college-photos`,
  `ownership-rls` (each table-level path a signed-in user could take
  straight through PostgREST, tried as the attacker, beside the path that
  still works),
  `college-official` (the federal figures on extras and Compare, on the rows
  the fixture load writes, and a failing Scorecard heartbeat), the
  approval gate (`approval-db`, `approval-api`, `approval-review`,
  `approval-jobs`), the import pipeline (`imports-*`; step 2's
  `imports-step2-api`, `-rls`, `-malicious`, `-dedupe`, `-invites`,
  `-retention`, `-guard`, `-security`, with the API on `IMPORTS_ROLLOUT=all IMPORTS_AI=off`),
  `caseload-transfer` (every persona, every table that follows a student,
  removal, the firm setting), `regex-dos` (the regular-expression attacks:
  a student's document, a Mass invite paste, an import file; `/health` keeps
  answering while each runs) and `security-guardrails` (a spoofed
  X-Forwarded-For, `/chat` refused to students in the API and in RLS, link
  digests and keep-out-of-AI). AxIS's outside-content rule needs a model, so
  it is covered by `axis-engine` and `axis-ops` against a scripted one. `npm run test:imports-load` (pre-release) commits
  and undoes 5,000 rows and stages 5,000 more through the API; `npm run
  test:caseload-load` checks 500 students in one call. The harness's `user()`
  approves the counselors it makes;
  pass `{ approved: false }` for a pending one.
- `npm run test:perf`: the 60-student speed test (B14,
  `test/integration/perf-roster.mjs`; not a `*.test.mjs`, so the persona run
  doesn't pick it up). It seeds one firm owner with 60 fully populated students
  (academics, polygon, activities, awards, essays, 8 colleges, 4 tasks with
  dated steps, deadlines, a meeting, a guardian, a work item each), two firm
  members, 60 pipeline contacts with 20 billed, Management tasks, pending
  invitations and saved events, plus three other practices of the same size,
  because a counselor's pages must not slow down as other practices grow. Then
  p50/p95/max and row counts per endpoint and per page (Overview, Calendar, My
  Work Queue, Contact Pipeline, Management, and the Payment Tracker), a page
  timed as the layout's `/students` followed by its own calls together.
  Requests are paced under the in-process limit and every route's DB limit, so
  a 429 never passes as a fast answer. Report only, writing
  `perf-roster.json`; `PERF_ENFORCE=1` exits 1 when a page's p95 reaches
  `PERF_BUDGET_MS` (500). It leaves its rows behind: `supabase db reset` after a
  local run. `test/unit/fanout-limits.test.ts` checks every list read on those
  pages carries a DB-backed `limit()`.
- `scripts/seed/e2e-stack.mjs` (`npm run seed:e2e -- [--students 60] [--roster 12]`):
  the seed the app's signed-in Playwright workflow runs against a throwaway
  local stack. It prints `KEY=value` lines for `$GITHUB_ENV`: `E2E_COUNSELOR_*`
  (firm owner, populated roster and pipeline, for read sweeps), `E2E_MEMBER_*`
  (same firm, seat `counselor`, not an admin), `E2E_WRITER_*` and
  `E2E_WRITER_MEMBER_*` (a second firm for specs that change things),
  `E2E_BILLING_*` (a solo counselor holding only the Payment Tracker scenario in
  `scripts/seed/billing-scenario.mjs`, whose hand-worked figures
  `test/unit/seed-scenario.test.ts` checks against `deriveAccount`),
  `E2E_STUDENT_*` and `E2E_STUDENT_ID`, `E2E_JOINER_*` with `E2E_JOIN_TOKEN` and
  `E2E_JOIN_CONTACT_ID` (a pipeline contact's invitation, for the "contact
  becomes a student" check), `E2E_PERF_*`, and `E2E_STACK=local`. Passwords are
  random per run. Rows go in through PostgREST as the counselor, firms through
  `create_firm` and a firm invitation; psql only for bulk auth users,
  `counselor_id`/role/approval and Meridies-wide Events Hub rows. It and the
  speed test refuse any `SUPABASE_URL`, `DB_URL` or `API_URL` that isn't
  localhost, and anything naming the production project, with no override
  (`scripts/seed/local-only.mjs`): they create approved accounts with the
  service-role key. A `DB_URL` may carry only `sslmode`, `connect_timeout`
  and `application_name` (libpq's `host`, `hostaddr` and `service` keywords
  beat the URL's host) in the one shape libpq and WHATWG parse alike, and
  psql runs without `PGHOST`, `PGHOSTADDR` and the service-file variables
  (`psqlEnv`), so every host it can reach is this machine. `test/integration/e2e-seed.test.mjs` runs each helper and
  reads the result back through the API.
- `.github/workflows/ci.yml` runs on every PR: actionlint over the workflows
  (every action pinned to a commit); typecheck, build, unit tests (including
  `migration-plan`, the plan reader against CLI output captured in
  `test/fixtures/supabase-cli`, and `migrations-workflow`, the rules
  `migrations.yml` must keep); then a throwaway Supabase with every migration
  (CLI 2.121.0, the version that applies to production), the plan reader run
  against that CLI's real output, an RLS-on-every-table check, the fixtures, and the persona suites, with the API started under
  `RESEARCH_FAKE=fixture` so research runs without a model or the web. After
  them it runs the e2e seed (output kept out of the log) and the speed test,
  report only, and uploads `perf-roster.json`. Other AI
  calls are not exercised in CI (they cost money); their pure parts are
  unit-tested. The live research path is checked by hand with
  `scripts/smoke/research.ts`.

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
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Optional; without them (and a sender) SMS is recorded `queued`, never sent |
| `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID` | The SMS sender: an E.164 number, or a Messaging Service (wins if both) |
| `CORS_ORIGIN` | Allowed frontend origins, comma-separated |
| `PORT` | Defaults to 4000 |
| `TRUST_PROXY_HOPS` | Proxies in front of the API (default 1, Railway's edge); `request.ip` is the address the outermost one saw. 0 trusts no forwarding header |
| `CRON_SECRET` | Optional, 32+ chars; authenticates `/internal/*` and `/communication/internal/dispatch`, which 503 without it |
| `IMPORT_DATABASE_URL` | Optional; import save/undo/apply. Must log in as `import_worker` via the Supabase session pooler. The role is created NOLOGIN by migration; turn on its login and set its password by hand |
| `IMPORT_HOLD_EXPIRY_ENABLED` | Optional; `true` turns on held-data expiry and warning emails in the import sweep. Off until the Ready-to-apply page ships |
| `IMPORTS_ROLLOUT` / `IMPORTS_PILOT` | The Import page: `off`, `pilot` (default; only the practices in `IMPORTS_PILOT`, firm or solo counselor ids, comma-separated) or `all`. Ready to apply is never gated |
| `IMPORTS_AI` | `on` (default) or `off`: the AI column mapping's kill switch |
| `RESEARCH_FAKE` | Tests only (`fixture`): research, match and link check return canned answers, no model or web calls. Works only when `NODE_ENV` is `development` or `test`; the server refuses to start otherwise, and logs a warning whenever it is on |
| `SWEEP_INTERVAL_MINUTES` | Optional; runs the accountability sweep in-process on this schedule |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional; Google connect. Redirect URI to register: `<APP_URL>/dashboard/counselor/data-hub/callback/google` (the app, not this API) |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | Optional; Microsoft connect (tenant defaults to `common`). Redirect URI to register: `<APP_URL>/dashboard/counselor/data-hub/callback/microsoft` |
| `APP_URL` | The app's origin: invite links, and the OAuth redirect URIs above — must match what is registered exactly |
| `INTEGRATION_TOKEN_KEY` | 32 bytes base64; encrypts OAuth tokens. Changing it forces every reconnect |
| `ACCESS_REVIEW_EMAIL` | Optional; inbox for counselor access requests. Defaults to `team@meridiesai.com`. The review link is built from `PUBLIC_API_URL` |

`GET /health` reports `{ status, database, schema, anthropic, serviceRole }` — presence
and reachability only, never values, URLs or error text. `database` is a 2s HEAD
probe on `colleges` (cached 5s); when it fails the route returns **503** with
`status: "degraded"`, so a Railway healthcheck sees an unreachable database.

`anthropic` is `true` when Anthropic accepted the key (asked with one cheap
`models.list` call, re-checked every 10 minutes), `false` when no key is set or
Anthropic refused it (401 or 403, re-checked every minute), and `null` until a
check has given a firm answer (right after a deploy). A timeout, an outage, a
rate limit or any other error keeps the last firm answer and asks again a
minute later (`lib/anthropicKeyCheck.ts`). /health waits at most 2 s for the
check and otherwise answers from the cache while it finishes. Like
`serviceRole`, it never changes the status code. The AxIS fail-safe and the
503 gates read only whether the key is set (`hasAnthropic`), never this check.

`schema` is whether the tables and columns this build cannot run without
exist (`REQUIRED_SCHEMA` in `lib/schemaCheck.ts`); when one is missing the route
returns **503** too. `railway.json` points Railway's healthcheck at `/health`,
so a build that is merged before its migration is applied never goes live: the
previous deployment keeps serving until the migration is in. **A migration that
adds something every request needs gets a line in `REQUIRED_SCHEMA` in the same
pull request.** The Apply migrations workflow applies a merged migration within
minutes, but not necessarily before the code that needs it goes live (see
"How migrations reach production"), so this check and code that degrades
safely without its migration are still what keep a deploy from serving a
schema it can't use.

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

Railway runs `npm run start` (plain `node dist/index.js`). Migrations are **not
applied on deploy**. Commit the SQL under `supabase/migrations/` in the same
PR; after the merge the Apply migrations workflow plans it and applies it once
a person approves (see "How migrations reach production").

**Commit in steps on big changes.** A large PR lands as many commits, each a
coherent step that builds on its own (a migration with its route, one screen,
one fix). A PR the size of the v10 sync (around 20k lines) carries at least 25
to 40 commits, never one. Squash merge still gives `main` one commit; the steps
are for whoever reviews the PR.
