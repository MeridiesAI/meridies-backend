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
│   ├── documentText.ts    # .txt/.md/.docx text on the server, for word counts
│   ├── studentAid.ts      # Financial aid page: FAFSA status + due date only, matching
│   ├── studentMessages.ts # Communication composer: frozen recipients, gated delivery
│   ├── collegesV10.ts     # Colleges search query/cards, official stats + freshness, decision rounds, list builder
│   ├── ingest/            # scorecard.ts (catalog), ipeds.ts (admission factors), curated.ts (team CSVs), linkCheck.ts, run.ts
│   ├── eventsHub.ts       # Events Hub feed, recommendations, calendar saves
│   ├── crm.ts             # the practice workspace (firm or solo) for pipeline/management
│   ├── payments.ts        # Payment Tracker arithmetic; nothing stored
│   ├── practiceFolders.ts # the two practice system folders, created lazily
│   ├── calendarFeed.ts    # the Calendar's one feed of everything dated
│   ├── practiceSettings.ts # Data & privacy switches, enforced (AI summaries, document reading, report sharing)
│   ├── heartbeat.ts       # job_heartbeats: each cron's last clean run, for /internal/status
│   ├── collegeIntel.ts    # NL search filters, proposal rules, the per-student summary (no model)
│   ├── studentView.ts     # the student's own preferences (banner, theme, reminder channels)
│   ├── profileUpdates.ts  # Profile Update: draft validation, completeness, filing into the sheets
│   ├── gpa.ts             # GPA scale: fourPointGpa, null for non-4/5-point scales
│   ├── imports/           # import pipeline: worker pool + role check, job runner, name rule
│   ├── context/           # the AI context layer: allowlist, section loaders, packing, document rule
│   ├── research/          # research: brief + identity filter, prompts, citation keeper, run, accept, test double
│   ├── submissionReview.ts # AxIS checks a handed-in file against its task, moves the task, notifies
│   ├── studentReminders.ts # due-tomorrow reminders on the student's own text/email channels
│   ├── axis/              # AxIS v2 on Haiku 5.5: understanding in code, direct answers, planner, loop, grounding, memory, fail-safes
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
│   ├── pipeline.ts        # /pipeline     Contact Pipeline + Payment Tracker
│   ├── management.ts      # /management   consultants, consultant tasks, staff blast
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
│   └── internal.ts        # CRON_SECRET machine routes (scheduled sweep)
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

**The v10 sync added 24 migrations (`20261005*`) that are not applied
automatically.** `DATABASE_MIGRATION_INSTRUCTIONS.md` at the repo root is the
runbook: backup first (`20261005030002` deletes FAFSA data on purpose), the
order, what each file changes in place, the checks, and the two settings
outside the database (Google's `drive.file` scope, the dispatch cron). Routes
that read the new columns fail until it has run, including existing screens
(meetings, AxIS chats, Files, invitations, Financial aid).
`node --env-file=.env scripts/verify-v10.mjs` checks, read-only, that every
table the 24 files create exists. `LAUNCH_CHECKLIST.md` is everything else
left before going live (Railway, crons, Supabase Auth, Resend, OAuth, smoke test).
`private.attach_student_policies()` stamps the standard student-scoped shape;
use it rather than hand-writing four policies and getting one wrong.

**The catalog seed** is `20260923000001_seed_catalog.sql`, generated by
`scripts/seed/generate-catalog.ts` from the meridies-demo fixtures (edit the
script, then `MERIDIES_DEMO_DIR=../meridies-demo npx tsx
scripts/seed/generate-catalog.ts > supabase/migrations/20260923000001_seed_catalog.sql`).
Apply it like any migration (`supabase db push`, or paste it into the SQL
editor as the project owner). It is idempotent (ON CONFLICT / WHERE NOT EXISTS)
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
  alerts on and the same address, an alert still clear of the throttle.
  Anything unreadable holds the send; a refusal cancels it with the reason.
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
  Only the meeting's counselor adds or removes attendees, and only their own
  students; an invited student may read the meeting (`meetings_select_attendee`)
  but not move it. The helpers are SECURITY DEFINER to avoid policy recursion
  between the two tables.
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
  `profile-update`, `submission-review`) read
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
  tells the counselor once. The counselor ticks each item received
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
  quick refusals at once (AI document reading off for the student's practice,
  kept out of AI, a format it can't open, over 10 MB) and reads the file
  after the response (PDFs and images as attachments, .docx/.txt as text);
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
- **Preferences are the student's, alerts are not.** `student_preferences`
  (banner, theme, the student's own text/email reminder channels) is
  student-written and counselor-readable; `student_alert_prefs` stays
  counselor-written. The banner image lives in the private `student-banners`
  bucket under `<student id>/`, uploaded through a signed URL minted on the
  student's own token.
- **Settings is the display name and the theme** (`PATCH /me/settings`). The
  theme defaults to `light` (`20261013000001`); "Device" (`system`) is a
  choice, never the default.
- **The student's reminder channels send.** With texts or email on in
  `student_preferences`, each open task due tomorrow (counselor's time zone,
  outside quiet hours) gets one reminder per channel, sent by
  `lib/studentReminders.ts` on the existing dispatch cron
  (`/communication/internal/dispatch`) under the `student-reminders` lease.
  The `message_deliveries` row (template `task-due-reminder:<date>`) is the
  dedupe record. `GET /me/messages` lists what was sent to the student; RLS
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

### Catalog data: yearly refresh

| When | Source | Who | How |
|---|---|---|---|
| Monthly (cron) | College Scorecard | automatic | `POST /internal/ingest/scorecard` |
| Weekly (cron) | Library links | automatic | `POST /internal/resources/link-check` |
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

### The essay restriction is a hard product constraint

The product stays well clear of writing, or closely approximating, essay prose.
`/ai/essay-advice` returns bullets only, and so does Narrative Coherence on
the Application page (`routes/applicationAi.ts`), the one v10 surface that
reads a student's prose: `NO_PROSE_SYSTEM` in, `enforceNoProse()` out.

`NO_PROSE_SYSTEM` states the rule, and `enforceNoProse()` drops anything over
two sentences or 240 characters *after* the model responds. Keep both. A system
prompt is a request, not an enforcement mechanism — if you add another
essay-adjacent route, it needs the code-level filter too.

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
rejects the private/loopback/link-local/carrier-NAT ranges, follows redirects
**manually** so every hop is re-validated, and caps time, bytes and content type.
If another feature ever needs to fetch a user-supplied URL, route it through
there rather than calling `fetch` directly.

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

### Documents and AI context

Files live in the private `student-documents` Storage bucket
(`20261011000001`). An object is readable by its uploader or by anyone who can
see the `documents` row pointing at it, so Storage is never more generous than
the file list; uploads go under a student the caller can edit, a folder they
can see, their own id, or `unfiled`.

`documents.available_to_llm` and `document_links.available_to_llm` are
data-handling switches, not display preferences. Anything that reads a document
into a prompt must filter on them (see `routes/tasks.ts`, and the context
layer below). Students don't see waived recommendation letters, IEP/504 or
counselor-only documents they didn't upload (`documents_student_restricted_select`),
nor the task-document links of those files (`deliverable_documents_student_restricted_select`),
nor their names in the activity log (the upload's `progress_events` row omits the filename).
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
  `requireRole("counselor")`, and chat answers 403 before it saves the message
  or opens the stream when a student id comes with a non-counselor caller (chat
  without a student id is unchanged). A student's own session never builds a context.
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
    (newest first, 200 at most).
  - `POST /recommendations/:id/accept` and `.../dismiss`. These two and the
    list share a limit of 120 a minute per user.
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
up-front AI check gates nothing yet. The app has no screens for any of this.

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

## Teams, guardians, delivery status, data rights, monitoring

- **Firm teams.** `profiles.firm_id` can't be updated by clients, so firms
  change through SECURITY DEFINER functions: `create_firm`,
  `accept_firm_invitation` (the invite's email must match the account; seats
  are enforced), `set_firm_member_role` (the owner's seat never changes),
  `remove_firm_member` (the owner can't leave). Routes: `/firms`,
  `/firms/mine/{members,invites}`, `/firms/join`. Invitation tokens are stored
  as sha256 only; the app page for the link is `/join-firm/<token>`.
- **Guardians.** A student may add a guardian, but one they add starts with
  `alerts_enabled = false`, and only the counselor side changes or removes a
  guardian (`private.can_manage_guardians`). Otherwise a student could redirect
  the parent alerts their counselor sends.
- **Delivery status.** `POST /webhooks/resend` (Svix signature,
  `RESEND_WEBHOOK_SECRET`) and `POST /webhooks/twilio/status`
  (`X-Twilio-Signature`, `TWILIO_AUTH_TOKEN` over `PUBLIC_API_URL`) move
  `message_deliveries` to delivered / bounced / failed; a status never moves
  backwards. With `PUBLIC_API_URL` set, every SMS asks Twilio to report there.
- **Data rights.** `GET /account/export` (self) and
  `GET /account/students/:id/export` (counselor) read through the caller's RLS
  client, so an export holds exactly what that person can already see (the
  counselor's export of a student includes `recommendations` and `research_runs`;
  the student's own export holds neither).
  `DELETE /account` (body `{"confirm":"delete my account"}`) deletes the auth
  user; a counselor with an active roster or an owned firm is refused.
- **Monitoring.** Every scheduled job writes `job_heartbeats`.
  `GET /internal/status` (CRON_SECRET) answers 503 and lists the overdue job
  when one hasn't run cleanly within twice its interval. Point an uptime monitor
  at `/health` (public) and `/internal/status` (with the bearer header).

## Tests and CI

- `npm test`: unit tests (`test/unit`, Node's test runner via tsx) for the pure
  rules: search ranking and sanitising, fit and odds, Scorecard/IPEDS/curated
  mapping (against a recorded real Scorecard response in `test/fixtures`), the
  essay guardrails, the link guard, payments, class rank, proposals, webhook
  signatures, heartbeats, the context layer (allowlist, packing, feature
  profiles, coherence material, consumers), and research (`research-brief`,
  `research-citations`, `research-extract`, `research-run`,
  `research-boot-guard`: the brief and identity filter, the citation keeper,
  the answer parser, the match validation and the boot check), the
  counselor approval gate (`access`, `access-review`, `service-callsites`),
  and AxIS (`axis-*`: understanding, risk, ledger, retrieval, grounding, the
  loop and engine against a scripted model, and the fail-safes).
- `npm run test:integration`: persona suites (`test/integration`) against a
  local Supabase and a running API, as real counselor and student accounts,
  including `context-layer`, `context-documents`, `research-tables` (RLS and
  hidden tasks), `research-api` (the routes, with the test double) and the
  approval gate (`approval-db`, `approval-api`, `approval-review`,
  `approval-jobs`). The harness's `user()` approves the counselors it makes;
  pass `{ approved: false }` for a pending one.
- `.github/workflows/ci.yml` runs both on every PR: typecheck, build, unit
  tests; then a throwaway Supabase with every migration, an RLS-on-every-table
  check, the fixtures, and the persona suites, with the API started under
  `RESEARCH_FAKE=fixture` so research runs without a model or the web. Other AI
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
| `CRON_SECRET` | Optional, 32+ chars; authenticates `/internal/*` and `/communication/internal/dispatch`, which 503 without it |
| `IMPORT_DATABASE_URL` | Optional; import save/undo/apply. Must log in as `import_worker` via the Supabase session pooler. The role is created NOLOGIN by migration; turn on its login and set its password by hand |
| `IMPORT_HOLD_EXPIRY_ENABLED` | Optional; `true` turns on held-data expiry and warning emails in the import sweep. Off until the Ready-to-apply page ships |
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

`schema` is whether the tables and columns this build cannot run without
exist (`REQUIRED_SCHEMA` in `lib/schemaCheck.ts`); when one is missing the route
returns **503** too. `railway.json` points Railway's healthcheck at `/health`,
so a build that is merged before its migration is applied never goes live: the
previous deployment keeps serving until the migration is in. **A migration that
adds something every request needs gets a line in `REQUIRED_SCHEMA` in the same
pull request.** This is the backstop, not the process: apply the migration
first.

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

**Commit in steps on big changes.** A large PR lands as many commits, each a
coherent step that builds on its own (a migration with its route, one screen,
one fix). A PR the size of the v10 sync (around 20k lines) carries at least 25
to 40 commits, never one. Squash merge still gives `main` one commit; the steps
are for whoever reviews the PR.
