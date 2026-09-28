# STEPS: bring meridies-app and meridies-backend up to Demo v6

The demo (`meridies-demo`) moved to v6. The production frontend (`meridies-app`) and the API (`meridies-backend`) sit at roughly v5 data parity, with pre-v5 visuals in several places. The demo stays hardcoded; the app and backend get the schema, routes, types and screens to show the same content from real data.

| | Repo | Commit these steps were written against |
|---|---|---|
| Source of truth | `MeridiesAI/meridies-demo` | `a71a4b4` (Demo v6, #29), plus `47b8688` (#28 splash/auth) and `43fa030` (#27 declutter) |
| Frontend | `MeridiesAI/meridies-app` | `244d130` (#12) |
| API | `MeridiesAI/meridies-backend` | `8c5c8ee` (#12) |

- The v6 spec is `meridies-demo/TODOv6.md` (15 steps, "TODOv6 Step N" below). The brief text is `meridies-demo/docs/briefs/demo-v6.txt`, page renders in `docs/briefs/demo-v6/`.
- `STEPS.md` sits, identical, at the root of `meridies-app` and `meridies-backend`. Edit both copies together.
- `file:line` references are against the commits above. Re-grep before editing; lines drift.
- Paths prefixed `demo:`, `app:` and `be:` mean `meridies-demo/`, `meridies-app/` and `meridies-backend/`.

---

## Contents

0. [How to run these steps](#0-how-to-run-these-steps)
1. [Rules that carry over](#1-rules-that-carry-over)
2. [Decisions to settle before Phase 2](#2-decisions-to-settle-before-phase-2)
3. [Step map](#3-step-map)
4. [Phase 0: fix what is broken or unsafe today](#phase-0-fix-what-is-broken-or-unsafe-today)
5. [Phase 1: app foundations (brand, primitives, declutter, auth, splash)](#phase-1-app-foundations)
6. [Phase 2: shell, Overview, Calendar tasks, Invitations](#phase-2-shell-overview-calendar-tasks-invitations)
7. [Phase 3: the student page (TODOv6 Steps 4, 5, 9)](#phase-3-the-student-page)
8. [Phase 4: college list, activity and award sheets, essays (TODOv6 Steps 6, 7, 8)](#phase-4-college-list-sheets-essays)
9. [Phase 5: Communication composer and referrals (TODOv6 Steps 10, 15)](#phase-5-communication-composer-and-referrals)
10. [Phase 6: College Profiles and Files (TODOv6 Steps 11, 12)](#phase-6-college-profiles-and-files)
11. [Phase 7: AxIS (TODOv6 Steps 13, 14)](#phase-7-axis)
12. [Phase 8: docs and the final walkthrough](#phase-8-docs-and-the-final-walkthrough)
13. [Appendix A: migrations in order](#appendix-a-migrations-in-order)
14. [Appendix B: routes added, changed and retired](#appendix-b-routes-added-changed-and-retired)
15. [Appendix C: demo file to app file map](#appendix-c-demo-file-to-app-file-map)
16. [Appendix D: never port](#appendix-d-never-port)

---

## 0. How to run these steps

### 0.1 Order

1. Phase 0 is independent of v6 and fixes security holes and broken output. Ship it first.
2. Phase 1 is app-only and changes shared primitives. Every later app step assumes it is merged.
3. From Phase 2 on, each phase has backend steps (tagged **[backend]**) and app steps (tagged **[app]**). Land the backend steps of a phase first, apply their migrations, then the app steps. This is the cross-repo rule in both AGENTS.md files: add backend routes first, then wire `lib/api.ts`.
4. Phases 3, 4, 5 and 6 can run in parallel once Phase 2 is in, with one exception: Phase 4 mounts its popups on the icon row built in Phase 3 (Step 3.8).
5. Phase 7 (AxIS) depends on Phase 4 (essays, sheets and college list data) and on Step 2.1 (collapsible sidebar).

### 0.2 One PR per step

- Branch off `main` in the repo the step touches: `git checkout main && git pull && git checkout -b feat/v6-<step-id>-<short-name>`.
- Keep a step to one PR. A step tagged **[backend + app]** is two PRs, backend first.
- Squash merge only. Never commit to `main` (Vercel deploys app `main` to production; Railway deploys backend `main`).
- Check off the step's "Done when" list in the PR description.

### 0.3 Checks before pushing

| Repo | Command |
|---|---|
| backend | `npm run typecheck && npm run build` |
| app | `npm run build && npm run lint` |

Then, for app steps, run the app against a local backend (`NEXT_PUBLIC_API_URL=http://localhost:4000`) and click through the changed surface at desktop width and at 375 px.

### 0.4 Migrations

- The schema lives in `be:supabase/migrations/`. There is one database: Supabase project `kerstlpuvpmstiavxblv`.
- Migrations are **not** applied on deploy. Apply each one deliberately (`supabase db push`, or paste into the SQL editor as the project owner) after review, and commit the SQL in the same PR as the code that needs it.
- The newest migration at the baseline is `20260923000005_student_red_flag_view.sql`. Number new files from `20260929000001` upward, in the order given in [Appendix A](#appendix-a-migrations-in-order). Any later timestamp works as long as the order holds.
- Every migration ships its own RLS policies. Use `private.attach_student_policies('<table>')` only where the student may write the table; several tables below are counselor-only on purpose.
- Every SQL block in the steps is a draft. Before running a `drop constraint`, confirm the constraint name in the live project (`select conname from pg_constraint where conrelid = 'public.<table>'::regclass;`). Postgres names inline checks `<table>_<column>_check`.

### 0.5 After every step

- Update the AGENTS.md of each repo you touched when an architectural fact changed (both files ask for this).
- Delete what the step replaces in the same PR, including copy that names the old surface ("the Files tab").

---

## 1. Rules that carry over

These hold across every step. Where the demo does something that breaks one of them, the app follows the rule, and the step says so.

### 1.1 App rules (from `app:AGENTS.md`)

1. `lib/api.ts` is the only place that calls the backend. Every call sends `Authorization: Bearer <supabase_access_token>`.
2. Empty arrays render `EmptyState`. No mock fixtures, no `lib/mockData.ts`, no `lib/storage.ts`, no demo reset.
3. Never invent a value. When a route has no data, render the em dash placeholder (`—`) and put the reason where the counselor can find it (after v6: an `InfoTip`, see 1.3).
4. Curated data says so. A Meridies rating renders labelled as ours and never inside a grid of reported statistics. `Provenance` branches three ways: sourced, curated, estimated.
5. The essay guardrail. Anything that reads a student's prose with AI emits bulleted diagnosis addressed to the counselor, never a paragraph a student could paste. It is enforced in code (`enforceNoProse`, `enforceMechanicalEdit`), in the database (`essay_marks_edits_are_mechanics`), in the `lib/api.ts` types, and printed as visible UI text where the AI answer lands.
6. Colours come from the CSS variables in `app:app/globals.css`. Colour is reserved for meaning. No mint fills, gradient backgrounds, coloured shadows, or translate-on-hover.
7. Server Actions that can fail with a message the counselor must read return `{ ok: true, ... } | { ok: false, message }` instead of throwing (Next hides thrown messages in production).
8. Route guarding lives in `lib/session.ts` and `useGuardedUser`, not in `middleware.ts`.

### 1.2 Backend rules (from `be:AGENTS.md`)

1. Authenticate and authorize every route, and let RLS enforce the same thing underneath.
2. `request.db` for nearly everything; `serviceClient()` only for work a user may not do as themselves, and never with an unchecked client-supplied id.
3. Zod at every boundary, `.strict()` on request bodies. TypeScript strict, no `any`, ESM `.js` imports.
4. List and fan-out reads get the DB-backed `limit(...)` preHandler. New expensive routes get one. AI routes: 20/min per user plus the 300-call daily quota through `runStructured()`.
5. Fail closed on anything that decides who receives a message (`loadAlertPrefs`, `loadSettings`, the throttle read).
6. All product AI goes through Anthropic via `runStructured()`. Default `FAST_MODEL` (Haiku 4.5); `DEEP_MODEL` (Sonnet) only for narrative coherence, college lists and the concierge. Model output is untrusted input.
7. `documents.available_to_llm` and `document_links.available_to_llm` are data-handling switches. Anything that reads a document into a prompt filters on them.
8. `lib/links.ts` is the only place that fetches a user-supplied URL.
9. `AiModule` in `be:src/lib/anthropic.ts:34-41` must stay in step with the `ai_runs_module_check` constraint (last set in `20260918000001:557-566`). A new AI route adds its module to both.

### 1.3 Rules v6 adds

1. No gray caption or descriptor line under a heading, popup title, icon, card header or empty-state title. A count goes in a `CountPill`. A source, methodology note or reason goes behind an `InfoTip` beside its label.
2. Fewer lines: one container edge per section; separate rows with spacing or a zebra tint (`even:bg-muted/40`) before adding a border; hairlines at `border-border/40` to `/60`.
3. v6 overrides v5 where they conflict. Where v6 is silent, v5 holds: **FAFSA and SSN stay deleted**, the CSS Profile is the aid form, curated Meridies ratings stay labelled.
4. The company is "Meridies". The assistant is "AxIS" and wears the Meridies logo (`MeridiesMark`), not a sparkle.

### 1.4 Load-bearing text is not a caption

Rule 1.3.1 targets decoration. Before deleting a gray line, check it against this list; these facts move into an `InfoTip`, the title, or an inline error:

- failure reasons (`students/[id]/page.tsx:47 detail={message}`, `colleges/[id]:388`);
- "class rank is never guessed" (`HighSchoolPanel.tsx:355`);
- "Meridies has not scored this school's aid" (`AidGenerosity.tsx:218`);
- "not the same as none existing" (`CombinedPrograms.tsx:92`);
- "history is recorded, not filled in backwards" (`StatPolygonHistory.tsx:134`);
- "nothing is inferred from an unsorted card" (`PreferenceReadout.tsx:88`);
- "counselors only, students never see this" (`StatusPicker.tsx:294`);
- "nothing sends until you approve it" and the true SMS/queued delivery states (`TaskStudentModal.tsx:282,289`, `lib/delivery-copy.ts`);
- "invitations expire and only work for the address you enter";
- the essay guardrail line (`GuardrailNote`).

### 1.5 Vocabulary

- Demo "text" = API `"sms"`. Map it in the UI only.
- Demo "Yours" / `suggested` = "Custom deadline" = `student_colleges.custom_deadline`.
- Demo "Overview" = `/dashboard/counselor`. Demo "Files" = app route `/dashboard/counselor/data-hub` (keep the path: the Google/Microsoft OAuth redirect URI is registered against `data-hub/callback/<provider>`).
- Demo `/dashboard/assistant` = app `/dashboard/counselor/assistant` (keep the app path).

---

## 2. Decisions to settle before Phase 2

Each row has a recommended default. The steps assume the default; if the product owner picks the other option, the affected steps name what changes.

| # | Decision | Recommended default | Steps affected |
|---|---|---|---|
| D1 | The Step 5 "glass" icon tile uses a gradient, a green shadow and a hover lift, which app AGENTS forbids. | Token-only glass: `bg-card/70 backdrop-blur-md ring-1 ring-border shadow-[var(--shadow-sm)]`; hover changes ring and label colour only. | 3.8 |
| D2 | Status colours. v6: on-track blue, ahead green, at-risk amber "Needs attention". App today: on-track green, at-risk red "At risk", ahead blue. | Adopt v6. | 2.3 |
| D3 | Global `h1`-`h4` Lora base rule (demo has it; app opts in per heading with `font-serif`). | Adopt it inside `@layer base`, then check headings that should stay sans. | 1.1 |
| D4 | Content width: demo `max-w-[1400px]`, app `max-w-6xl`. | Adopt 1400 px; the banner's inner measure must match. | 2.1, 2.3 |
| D5 | Where the counselor's work queue is stored. | New counselor-only `counselor_work_items` table. `deadlines` rows are student-readable and need a `student_id`. | 2.2 |
| D6 | Removing the Dashboard cards orphans the task list, alerts, escalation check, meetings, narrative flags and invitations. | Calendar gets a Tasks mode (task list, work queue, meetings, escalation check); narrative flags stay in the Review drawer; a new Invitations page. All in the same release as Overview. | 2.3, 2.4, 2.5 |
| D7 | Invitations page entry point (the demo has none; app AGENTS fixes the left menu). | A "View all" link in `InviteStudentDialog`, a Settings row, and the composer's referral toast. No nav item. | 2.5, 5.7 |
| D8 | "Message counselor" on the student dashboard has no handler and contradicts "no in-software inbox". | Remove it. Student AxIS is a separate decision. | 0.9 |
| D9 | Live polygon on Overview cards needs one read per student today. | Add `polygon` and `gpaWeighted` to `GET /students` rows (one batched query). | 2.2, 2.3, 7.x |
| D10 | Top-bar quick-action order: local or server. | `localStorage` wrapped in try/catch (a per-viewer convenience). | 2.1 |
| D11 | `available_to_llm` after v6 removes the "In context" pills. | Keep both columns and their `true` default. Remove every pill and switch. Add "Exclude from AI" / "Include in AI" to a row overflow menu, and an `EyeOff` marker on excluded rows only. Never flip existing `false` rows. | 3.12, 6.6 |
| D12 | Red flags lose their card on the student page (v6 Alerts are task-derived). | Fold open red flags into the Alerts columns by trigger (missed-deadline to Overdue; no-progress, low-quality, likely-ai to No activity); acknowledge / resolve from a menu on the row. | 3.7 |
| D13 | Overdue vs No activity de-duplication. Demo lists a task in both; app's `buildAlerts` de-duplicates. | Match the demo. | 3.7 |
| D14 | Personal details on the info card (gender, citizenship, living with parent, marital status, address). | Store `us_citizen` as a nullable boolean only. Do not put DACA/undocumented status on the card. Review the intake's `citizenship` select. | 3.1 |
| D15 | "Applications" count on the info card. | Count `student_colleges` rows whose status is not `withdrawn`. | 3.5 |
| D16 | Counselor note scope. | One note per student, shared by the student's counselor and collaborators. | 3.1 |
| D17 | Aid popup extras the demo does not have (Award Appeal Assistant, "Next aid dates"). | Appeal becomes a per-school action in the comparator; drop "Next aid dates" (the checklist's Priority deadline column covers it). | 3.11 |
| D18 | Scholarship actions. Demo: Recommend only. App: Pursuing / Save / Dismiss. | Recommend (creates a student deadline and a notification) and Dismiss. | 3.3, 3.11 |
| D19 | Growth history default scale. Demo "Years", app "Months". | Months (history is recorded, so a young record shows one Years bucket). | 3.10 |
| D20 | Who writes `fit` and `custom_deadline` on a student's college list (RLS lets the student write every column). | Counselor-only, enforced by a trigger. | 4.1 |
| D21 | Activity categories: demo lists 27, the intake 30 (adds Foreign Language, Internship, Social Justice). | CHECK accepts all 30; the popup offers the demo's 27 plus any stored value. | 4.2 |
| D22 | Essay text for documents excluded from AI. | Store it in `essays.body` (display and word counts need it) and gate every AI reader on `available_to_llm`. | 4.3 |
| D23 | Composer Parent / student toggle vs the automated alert gates (`copy_parents`, `copy_student`). | Keep them separate. Put "Alerts go to..." in the composer's more menu. | 5.1, 5.6 |
| D24 | Editable "From" in the composer. An arbitrary From address is spoofing. | The field edits the reply-to (validated server-side: the counselor's own email). The From stays the verified sender. | 5.2, 5.6 |
| D25 | Parent recipients: one email to all, or one per guardian. | One per guardian (one delivery row each), matching `deliverParentAlert`. | 5.2 |
| D26 | Meaning of "post-application referral management" (TODOv6 open question 1, unconfirmed). | Confirm with the brief owner before Step 5.4. Build it as an isolated table so a different reading is cheap. | 5.4, 5.7 |
| D27 | Campus photo hosting. | Supabase Storage public bucket `college-photos`, pointer and credit on the `colleges` row. | 6.1 |
| D28 | Student home location for the AxIS maps (the demo centres on Ithaca, NY as an example). | Counselor picks a ZIP from a seeded Census ZCTA centroid table. No default location; missing home disables the map with the reason. | 7.3 |
| D29 | AxIS Events and Updates. | Curated tables only (`college_events`, existing `policy_updates`). No web search yet. | 7.6 |
| D30 | Activities Build when nothing in the catalog is near the student. | Honest empty state. No web-search fallback yet. | 7.4 |
| D31 | Retire 2D essay review. | `POST /ai/essay-review` returns 410; keep `essay_marks` and its CHECK for history. | 7.7 |
| D32 | Enter-to-send on touch devices in AxIS. Demo sends on Enter everywhere; the app deliberately does not on touch. | Keep the app's touch exception. | 7.8 |

---

## 3. Step map

| Step | Repo | Title | TODOv6 | Depends on |
|---|---|---|---|---|
| 0.1 | backend | Guardians: counselor-only writes | (bug) | none |
| 0.2 | backend | Polygon axes: counselor-only writes | (bug) | none |
| 0.3 | backend + app | Delete FAFSA and EFC everywhere | v5 rule | none |
| 0.4 | backend | Coherence route returns stored rows | (bug) | none |
| 0.5 | backend | Files: derive `student_id` from the folder | (bug) | none |
| 0.6 | backend | Class-rank wording follows band provenance | (bug) | none |
| 0.7 | backend | `toCollege` stops inventing `fit: "target"` | (bug) | none |
| 0.8 | app | CSS layer fix, Next 15.5.26, BrandProvider scope | #28 | none |
| 0.9 | app | Dead and fake controls; invite actions return results | (bug) | none |
| 1.1 | app | Brand pass: Newsreader, slogan, MeridiesMark on AxIS | 1 | 0.8 |
| 1.2 | app | Shared primitives: CountPill, Tooltip, InfoTip, SourceTip, Modal lg + stack, InlineEdit, wordCount | 2, 5, 6 | none |
| 1.3 | app | Declutter: captions out, fewer lines | 2, #27 | 1.2 |
| 1.4 | app | Auth pages and form primitives | #28 | 1.1 |
| 1.5 | app | Splash and role picker | #28 | 1.1 |
| 2.1 | app | Shell: nav, collapsible sidebar, top bar, search | 3, 13.7 | 1.x |
| 2.2 | backend | Counselor work items; roster additions | 3 | none |
| 2.3 | app | Overview page | 3 | 2.1, 2.2 |
| 2.4 | app | Calendar: Tasks mode | 3 | 2.2 |
| 2.5 | app | Invitations page (no referrals yet) | 15 | 0.9 |
| 3.1 | backend | Student personal details, counselor note, detail DTO | 4 | none |
| 3.2 | backend | Aid: v6 inputs, per-school grid | 9 | 0.3 |
| 3.3 | backend | Scholarships: scan, feed, recommend | 9 | none |
| 3.4 | backend | Tasks: tick every stage at once | 4 | none |
| 3.5 | app | Student page layout and info card | 4 | 3.1, 1.x |
| 3.6 | app | Assigned tasks card | 4 | 3.4 |
| 3.7 | app | Alerts card and My Work Queue card | 4 | 2.2 |
| 3.8 | app | Icon row and popup frame | 5 | 1.2 |
| 3.9 | app | Meeting notes popup | 9 | 3.8 |
| 3.10 | app | Strength profile popup | 9 | 3.8, 0.2 |
| 3.11 | app | Student aid and Scholarship matching popups | 9 | 3.2, 3.3, 3.8 |
| 3.12 | app | Upload files popup | 9 | 3.8 |
| 4.1 | backend | College list: catalog fees, supplements, editable columns | 6 | 0.7 |
| 4.2 | backend | Activity and award sheets | 7 | none |
| 4.3 | backend | Essays: one record per document | 8 | 4.1 |
| 4.4 | backend | Seed generator repair and v6 catalog seed | 6, 7, 11 | 4.1 |
| 4.5 | app | Student record context and API client | 6-8 | 4.1-4.3 |
| 4.6 | app | College list popup | 6 | 4.5, 3.8 |
| 4.7 | app | Activities list and Awards & honors popups | 7 | 4.5, 3.8 |
| 4.8 | app | Essays popup and Files word budgets | 8 | 4.5, 3.8 |
| 5.1 | backend | Composer schema: messages, prefs, multi-guardian alerts | 10 | 0.1 |
| 5.2 | backend | Messages: send, schedule, cancel, dispatcher | 10 | 5.1 |
| 5.3 | backend | `/ai/compose` draft route | 10 | 5.1 |
| 5.4 | backend | Referrals and invitation notes | 15 | 5.1, D26 |
| 5.5 | backend | Family report create route | 10 | none |
| 5.6 | app | Communication composer | 10 | 5.1-5.3, 5.5, 3.8 |
| 5.7 | app | Referrals on the Invitations page | 15 | 5.4, 2.5 |
| 6.0 | demo | Fetch the campus photos | 11 | none |
| 6.1 | backend | College photos: columns, bucket, seed, upload | 11 | 6.0 |
| 6.2 | backend | College profile facts: net price bands, student life, requirements | 11 | 4.4 |
| 6.3 | backend | College routes: list DTO, detail DTO, drop scattergram | 11 | 6.1, 6.2 |
| 6.4 | backend | Files: link filing suggestion, practice-folder import | 12 | 0.5 |
| 6.5 | app | College Profiles | 11 | 6.3, 1.2 |
| 6.6 | app | Files page | 12 | 6.4, 1.2 |
| 7.1 | backend | Chat schema and protocol for tool runs | 13 | 4.3 |
| 7.2 | backend | Coherence pipeline | 14 | 7.1, 4.2, 4.3 |
| 7.3 | backend | Geography: student home, college and program locations | 14 | D28 |
| 7.4 | backend | Activities Build pipeline | 14 | 7.1, 7.3 |
| 7.5 | backend | College List Builder pipeline | 14 | 7.1, 7.3, 4.1 |
| 7.6 | backend | College research, events, updates | 13 | 7.1 |
| 7.7 | backend | Retire cut tools and tidy the registry | 13 | 7.2-7.6 |
| 7.8 | app | AxIS layout, panel, chats, composer, answers | 13 | 7.1, 2.1 |
| 7.9 | app | Coherence panel | 14 | 7.2, 7.8 |
| 7.10 | app | BubbleGroup and RadiusMap | 14 | 7.3 |
| 7.11 | app | Activities Build panel | 14 | 7.4, 7.10 |
| 7.12 | app | College List Builder panel | 14 | 7.5, 7.10 |
| 7.13 | app | College research | 13 | 7.6, 7.8 |
| 7.14 | app | AxIS cleanup | 13 | 7.9-7.13 |
| 8.1 | both | AGENTS.md, README, final walkthrough | finish line | all |

---

## Phase 0: fix what is broken or unsafe today

These are defects found while mapping v6. None needs a design decision. Each is small and independent.

### Step 0.1 [backend] Guardians: counselor-only writes

**Today.** `public.guardians` (`be:supabase/migrations/20260828000006_intake_documents_guardians_notifications.sql:146-166`) uses `private.attach_student_policies('guardians')`. That helper's write check is `private.can_edit_student`, which returns true when `student = viewer` (`20260828000002:134-143`). A student can therefore insert, edit and delete their own guardians, including `alerts_enabled = false`, which switches off the parent alerts their counselor sends about them. `student_alert_prefs` was made counselor-only for exactly this reason (`20260918000001:174-208`). The collection routes at `be:src/routes/accountability.ts:30-43, 63-66` have no role check either.

**Do.**

1. Migration `20260929000001_guardians_counselor_writes.sql`:

   ```sql
   drop policy if exists guardians_insert on public.guardians;
   drop policy if exists guardians_update on public.guardians;
   drop policy if exists guardians_delete on public.guardians;
   create policy guardians_write_counselor on public.guardians
     for all to authenticated
     using (private.is_counselor_of(student_id, (select auth.uid())))
     with check (private.is_counselor_of(student_id, (select auth.uid())));
   -- guardians_select from attach_student_policies stays: the student may read.

   create unique index if not exists guardians_student_email_unique
     on public.guardians (student_id, lower(email)) where email is not null;
   ```

   Before creating the unique index, check for duplicates: `select student_id, lower(email), count(*) from public.guardians where email is not null group by 1,2 having count(*) > 1;`.
2. In `be:src/routes/accountability.ts`, give the guardians collection a `beforeWrite` that throws `forbidden()` for a student caller (or wrap the POST/PATCH/DELETE with `requireRole("counselor")`).
3. Add a camelCase serializer `toGuardian(r)` in `be:src/lib/serialize.ts` (`{ id, studentId, fullName, email, phone, relationship, preferredChannel, alertsEnabled, receivesReports, isPrimary }`) and use it as the collection's `toDto` (today it returns raw rows).
4. Normalise on write: lower-case `email`; pass `phone` through `toE164` (`be:src/lib/email.ts:170-176`) and return 400 when it cannot be parsed.

**Done when.**
- [ ] A student token gets 403 on `POST`, `PATCH` and `DELETE /accountability/guardians`, and can still `GET` their own.
- [ ] Direct PostgREST writes to `guardians` as the student fail under RLS.
- [ ] `be:AGENTS.md` "Three rules the schema encodes" lists `guardians` beside `student_alert_prefs`.

### Step 0.2 [backend] Polygon axes: counselor-only writes

**Today.** `PUT /polygon/axes`, `PATCH /polygon/axes/:id` and `DELETE /polygon/axes/:id` (`be:src/routes/records.ts:316-414`) authorize with `resolveStudentId(..., "edit")` only, so a student can rewrite their own strength scores. The demo treats the scores as the counselor's judgement.

**Do.**

1. Add `requireRole("counselor")` to the three preHandler arrays (it is already imported at `records.ts:10`).
2. Optional, defence in depth: a `before insert or update` trigger on `student_polygon_axes` that raises `42501` when `auth.uid() = new.student_id`, following the guard pattern in `20260923000005`.

**Done when.**
- [ ] A student token gets 403 on the three routes; `GET /polygon` and `GET /polygon/history` still work for the student.

### Step 0.3 [backend + app] Delete FAFSA and EFC everywhere

**Today.** v5 deleted FAFSA and SSN on privacy grounds ("potential privacy and data leaks would be catastrophic and the data isn't needed by counselors"), and v6 keeps that. Both repos still carry it:

- backend columns `student_aid_profiles.fafsa_status`, `fafsa_submitted_at`, `efc_estimate` (`be:...20260828000007_financial_aid_and_scholarships.sql:57-64`); checklist item `'fafsa'` (`:91`); zod at `be:src/routes/aid.ts:21-29, 47`; the GET default at `aid.ts:126` returns `fafsa_status: "not-started"`;
- app: the FAFSA select (`app:components/dashboard/StudentAid.tsx:44-51, 406-420`), the `StudentAidProfile` type (`app:lib/api.ts:429-442`), the intake field `fafsaStatus` (`app:lib/aggregator.ts:880`), and two FAFSA lines in the family aid draft (`app:components/dashboard/StudentCommunication.tsx:315, 327`).

School-level aid policy stays: `college_aid_profiles.aid_methodology = 'fafsa-only'` is published by the school and is nobody's private data. Award renewal conditions that mention the form also stay.

**Do (backend PR first).**

1. Migration `20260929000002_delete_fafsa.sql`:

   ```sql
   delete from public.student_aid_checklist where item = 'fafsa';
   alter table public.student_aid_checklist drop constraint if exists student_aid_checklist_item_check;
   alter table public.student_aid_checklist add constraint student_aid_checklist_item_check check (item in
     ('css-profile','idoc','verification','institutional-form','award-letter','appeal',
      'scholarship-application','tax-transcript'));
   alter table public.student_aid_profiles
     drop column if exists fafsa_status,
     drop column if exists fafsa_submitted_at,
     drop column if exists efc_estimate;
   update public.profiles set profile = profile - 'fafsaStatus' where profile ? 'fafsaStatus';
   ```

   Confirm the checklist item list against the live constraint first and keep every non-FAFSA value it has today.
2. `be:src/routes/aid.ts`: remove the three keys from `aidProfileBody`, `'fafsa'` from `checklistBody`, and `fafsa_status` from the default at `:126`.
3. Grep: `rg -n -i "fafsa|efc" src` returns only aid-methodology references.

**Do (app PR).**

1. Remove `fafsa_status`, `fafsa_submitted_at` and `efc_estimate` from `StudentAidProfile` in `lib/api.ts`.
2. Remove `FAFSA_STATUSES` and the FAFSA select from `StudentAid.tsx`, the EFC input, and the header comment at `:14`.
3. Remove `fafsaStatus` from `lib/aggregator.ts:880` and its intake question.
4. Remove the FAFSA bullet and sentence from `aidDraft` in `StudentCommunication.tsx:315, 327`. Where the draft needs an outstanding aid form, it is the CSS Profile.
5. `rg -n -i "fafsa|efc|social security|ssn" app components lib` returns only the school-methodology label.

**Done when.**
- [ ] No FAFSA status, date, EFC or SSN field exists in the schema, the API, the app types or the UI.

### Step 0.4 [backend] Coherence route returns stored rows

**Today.** `POST /ai/narrative-coherence` inserts `narrative_flags` rows and then returns the model's raw flags (`be:src/routes/ai.ts:182-187`, `return { flags: result.flags }`). The raw flags have no `id` or `status`, and the app filters on `f.status === "open"` (`app:components/assistant/CoherenceSurface.tsx:288`), so every scan shows "No open coherence conflicts".

**Do.** Insert with `.select("*")` and return the inserted rows through the same serializer `GET /reports/flags` uses. Phase 7 replaces this route; the fix keeps it honest until then.

**Done when.**
- [ ] A scan with findings renders them in the current app.

### Step 0.5 [backend] Files: derive `student_id` from the folder

**Today.** A link filed into a student folder from the Files page stores `student_id = null`: `app:components/dashboard/LinkUploads.tsx:160` sends only `folderId`, and `POST /files/links` (`be:src/routes/files.ts:447-459`) never looks at the folder. The link then never appears on the student's page, which filters `GET /files/links?studentId=`. `POST /files/documents` and a `PATCH` that moves a document have the same gap.

**Do.** In `POST /files/links`, `POST /files/documents`, and `PATCH /files/documents/:id` / `PATCH /files/links/:id` when `folderId` changes: load the folder; when it has a `student_id`, set the row's `student_id` from it; return 400 when the body names a different `studentId`. `be:src/routes/integrations.ts:241-248` already does this for imports; reuse that logic in a helper.

**Done when.**
- [ ] A link pasted into Sophia's folder shows in her student-scoped list, and moving a document between student folders updates its `student_id`.

### Step 0.6 [backend] Class-rank wording follows band provenance

**Today.** `be:src/lib/classRank.ts:55` always says the reading is "on the school's published scale", including for bands seeded with `provenance = 'estimated'` (for example Westview Prep, `20260923000001_seed_catalog.sql:1064-1074`). That presents a Meridies estimate as a published figure.

**Do.** Carry the matched band's `provenance` into the summary: published bands keep today's wording; estimated bands say the placement is a Meridies estimate from the school's published GPA distribution. Return `provenance` in the `ClassRankRead` payload so the app can label it (Step 3.5).

### Step 0.7 [backend] `toCollege` stops inventing `fit: "target"`

**Today.** `be:src/lib/serialize.ts:131` returns `fit: "target"` when the column is null. That breaks the "never invent a value" rule.

**Do.** Return `null`. Update the app readers of `ProfileCollege.fit` to render nothing (or the em dash placeholder) for null: `StudentProfileClient.tsx` `CollegeListCard`, `StudentProfileSelf.tsx:230-258`, `CollegeListSurface.tsx`.

### Step 0.8 [app] CSS layer fix, Next 15.5.26, BrandProvider scope

1. **`app/globals.css:109-111`.** `* { border-color: var(--border); }` sits outside any layer. Under Tailwind v4 an unlayered rule beats every utility, so `border-primary/25`, `border-danger/25` and `border-white/10` all render gray today (for example the signup confirmation notice, `app/signup/page.tsx:369`, and the dashboard error banner, `CounselorDashboardClient.tsx:497`). Wrap it in `@layer base { ... }`, as demo #28 did (`demo:app/globals.css:113-124`).
2. **Next.js.** Bump `next` and `eslint-config-next` from `15.5.22` to `15.5.26` in `package.json` (two critical advisories; the demo bumped in #29). Run `npm install` and commit the lockfile.
3. **`components/branding/BrandProvider.tsx`.** Port the demo #28 version: apply the practice accent only when `usePathname()` is `/dashboard` or under it, swap tokens in `useLayoutEffect` (no flash on route change), and clear the overrides on the way out or at the default accent. Today the app applies the accent on every route from `localStorage`, so one practice's colour tints `/login` for the next person on that machine.

**Done when.**
- [ ] A coloured border utility renders its colour (check the signup notice).
- [ ] With a stored aubergine accent, `/`, `/login`, `/signup` and `/join/<token>` wear Meridies green; `/dashboard/*` wears aubergine; navigating between them does not flash.

### Step 0.9 [app] Dead and fake controls; invite actions return results

1. `app/dashboard/counselor/intake/page.tsx:214`: "Send link" flips local state and calls nothing. Wire it to `inviteStudentAction(email)`, or remove it until intake creates students. The "Create student & build profile" button (`:396-403`) has no handler; do the same.
2. `app/dashboard/student/StudentDashboardClient.tsx:106-114`: "Message counselor" has no `onClick` and contradicts "no in-software inbox". Remove it (D8).
3. `app/actions.ts:22-49`: `inviteStudentAction`, `listInvitationsAction`, `revokeInvitationAction` and `acceptInvitationAction` throw, so "That address already has a pending invitation" reaches the dialog as a production digest. Switch them to the `ActionResult` pattern already used at `:98-111` and update `InviteStudentDialog`, the dashboard card and onboarding to read `ok`.
4. Delete the orphaned `components/dashboard/SchoolReframingPanel.tsx` and the unused actions `generateSchoolReframingAction` and `runNarrativeCoherenceAction` (`app/actions.ts:67-89`).

**Done when.**
- [ ] Inviting an address with a pending invitation shows the backend's sentence in production.

---

## Phase 1: app foundations

App-only. These change shared code, so they land before any screen work. No backend changes.

### Step 1.1 [app] Brand pass: Newsreader, slogan, MeridiesMark on AxIS (TODOv6 Step 1)

**Demo reference.** `demo:app/layout.tsx:2, 33-40, 112`; `demo:app/globals.css:105`; `demo:components/Wordmark.tsx`; `demo:components/MeridiesMark.tsx`; `demo:components/dashboard/DashboardSidebar.tsx:155, 285-299`; `demo:components/splash/SplashScreen.tsx:68, 92-108`; `demo:components/AuthShell.tsx:52-59`.

**Today in the app.**
- `app/layout.tsx:2, 30-36, 105` load Instrument Serif; nothing uses `font-display` (`globals.css:101`).
- `Wordmark.tsx:34, 38` sets "Meridies" in Inter Tight semibold.
- `MeridiesMark.tsx:12` has tones `brand | light` only, no `title` prop, always `role="img"`.
- The sidebar's AxIS entry reads **"Meridies LLM"** with a `Sparkles` icon (`DashboardSidebar.tsx:309-321`); the brand label is Inter Tight (`:167`).
- No slogan anywhere; no "Ask AxIS" buttons anywhere.

**Do.**

1. `app/layout.tsx`: replace `Instrument_Serif` with
   ```ts
   const newsreader = Newsreader({
     subsets: ["latin"], weight: "variable", style: ["normal"], axes: ["opsz"],
     variable: "--font-newsreader", display: "swap",
   });
   ```
   and put `${newsreader.variable}` in the `<html>` className beside Inter Tight and Lora. Fix the comments at `:21-22`. Optionally add `data-scroll-behavior="smooth"` to `<html>` as the demo does.
2. `app/globals.css`: in `@theme inline`, replace `--font-display: var(--font-instrument-serif);` with `--font-brand: var(--font-newsreader);`. If D3 is accepted, add the demo's heading rule inside `@layer base`:
   ```css
   @layer base {
     h1, h2, h3, h4 { font-family: var(--font-lora), Georgia, serif; letter-spacing: -0.01em; }
   }
   ```
3. One brand cut everywhere, Newsreader upright weight 500:
   - `components/Wordmark.tsx:34, 38`: `font-brand text-[1.45rem] font-medium tracking-[-0.01em] text-foreground`.
   - Sidebar brand label: `truncate font-brand text-[1.2rem] font-medium tracking-[-0.01em] text-white`.
4. Slogan "Less work, more consulting." in that same cut, on the splash (Step 1.5) and in the AuthShell panel (Step 1.4). Search for "workload" and fix any hit.
5. `components/MeridiesMark.tsx`: copy the demo file. It adds `tone="current"` (strokes and fills in `currentColor`, ring transparent, highlight at full opacity) and a `title` prop (`title=""` renders `aria-hidden` with no role). The SVG geometry is unchanged, so `public/meridies-mark.svg` stays.
6. AxIS entry points wear the mark:
   - Sidebar: `<MeridiesMark size={18} tone="current" className="shrink-0" title="AxIS" />`, label **"AxIS"**, `title="AxIS, Adaptive Experience Intelligence System"`. Drop the `Sparkles` import.
   - A top-bar "Ask AxIS" link on Overview (Step 2.3) and on the student page (Step 3.5):
     ```tsx
     <Link href={href} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-primary px-4 font-sans text-[13.5px] font-medium text-primary-foreground transition hover:bg-primary-hover">
       <MeridiesMark size={16} tone="current" title="" />
       <span className="hidden sm:inline">Ask AxIS</span>
     </Link>
     ```
     `href` is `/dashboard/counselor/assistant`, plus `?student=<id>` on the student page (the assistant reads it from Step 7.8).
   - The AI draft buttons in `StudentCommunication.tsx:770, 901` and `ParentAlertModal.tsx:613, 622` swap `Sparkles` for `<MeridiesMark tone="current" size={14} title="" />` and read "Draft with AxIS". `Button` accepts only a Lucide icon today; add an `iconNode?: React.ReactNode` prop rather than rendering the mark as a loose child.
   - Leave Sparkles where it marks curated data or non-AxIS features: `components/college/provenance.tsx:77`, `AidGenerosity.tsx:206`, `ScholarshipFeed.tsx:259`, `components/files/filing.tsx:131`, `LinkUploads.tsx:290`, intake, onboarding.
7. Design kit (`app/design-kit/page.tsx`): brand label at `:651` to `font-brand`; Typography description at `:331` names Newsreader for the wordmark and slogan; add a `tone="current"` mark sample beside `:672`.
8. `app:AGENTS.md` Design system: "Inter Tight for UI, **Lora (`font-serif`) for headings**, **Newsreader (`font-brand`)** for the 'Meridies' wordmark and the slogan 'Less work, more consulting.' only." Remove the Instrument Serif line. Add a Naming note: AxIS wears `MeridiesMark` (`tone="current"` inside buttons); no sparkle on AxIS entry points.

**Optional.** `be:src/lib/email.ts:360` sets the email wordmark in uppercase sans; for parity use `font-family:Newsreader,Georgia,'Times New Roman',serif;text-transform:none;font-weight:500`.

**Done when.**
- [ ] `rg -n "font-display|Instrument|Meridies LLM|workload" app components lib` returns nothing.
- [ ] Sidebar, auth panel, splash and design kit set "Meridies" in the same Newsreader cut.
- [ ] Every AxIS entry point shows the Meridies mark.

### Step 1.2 [app] Shared primitives (TODOv6 Steps 2, 5, 6)

Later steps depend on these. Port them into `components/dashboard/DashboardUI.tsx` unless noted.

| Primitive | Demo source | Notes |
|---|---|---|
| `CountPill` | `demo:DashboardUI.tsx:90-96` | `shrink-0 rounded-full bg-muted px-2.5 py-1 font-sans text-[11.5px] font-semibold text-muted-foreground`. Counts that used to sit in subtitles go here. |
| `Tooltip` | `demo:DashboardUI.tsx:676-700` | Text-only hover/focus tip. |
| `InfoTip` | `demo:DashboardUI.tsx:703-715` | `({ text, side = "top" })`, an info glyph with a `Tooltip`. It is `pointer-events-none`, so it cannot hold a link. |
| `SourceTip` (new, app-only) | built on `app:components/dashboard/Citation.tsx` hover-card mechanics | An `InfoTip` that can hold a link: opens on hover, focus or click, with a padding bridge. Shows "Source: <host link> · verified {date}" or "not yet verified". Used by `Provenance` (Step 6.5). |
| `Modal size="lg"` | `demo:DashboardUI.tsx:414-417, 424, 434, 527` | `export const MODAL_LG = "max-w-[min(88rem,95vw)]"`; the panel gets `${MODAL_LG} sm:min-h-[min(40rem,88dvh)]` inside `max-h-[92dvh]`, body scrolling. |
| `MODAL_STACK` | `demo:DashboardUI.tsx:414, 449, 473, 495-496` | A module-level `symbol[]`. A dialog pushes a token on open and removes it on close; only the topmost handles Escape. The app Modal (`:471-475`) closes every open dialog on Escape today, which breaks stacked popups (Upload files to confirm-delete, Aid to award form, composer AxIS bar). Also add an `e.defaultPrevented` guard to the Modal's Tab focus trap so a child that consumes Tab (the composer's AxIS bar) is not double-handled. |
| `Card id` | demo `Card` | Pass-through `id` so a page can scroll to a card. |
| `Anchored` | `demo:components/student/InlineEdit.tsx:38-114` | A popover portalled to `document.body`, `z-[120]` (above the Modal's `z-[100]`), `max-h-64`, flips above the anchor when less than 260 px is free below, closes on outside mousedown or when the anchor scrolls away, and stops Escape from reaching the parent modal. |
| `InlineSelect`, `InlineMultiSelect`, `InlineText`, `InlineNumber`, `InlineDate` | `demo:components/student/InlineEdit.tsx:116-540` | New file `app:components/student/InlineEdit.tsx`. Port verbatim, then make `onCommit` / `onChange` accept `async` handlers and show a pending state; a failed save restores the old value and surfaces the error. `InlineText` supports `multiline` (Enter commits, Shift+Enter newline, Esc cancels) and a soft `limit` with a live `n/limit` counter; over-limit text saves and shows red. |
| `lib/wordCount.ts` | `demo:lib/wordCount.ts` | `countWords`, `toneFor(used, limit)` (red at or above the limit, green under a third, yellow between), `TONE_CLASS`, `LIMITS = { personalStatement: 650, supplement: 350 }`. Limits are soft everywhere. |

Keep the app's `Tabs` primitive for now; Steps 3.5 and 6.6 remove its last users.

**Done when.**
- [ ] The design kit shows `CountPill`, `InfoTip`, `SourceTip`, a `size="lg"` modal and a stacked modal where Escape closes only the top one.

### Step 1.3 [app] Declutter: captions out, fewer lines (TODOv6 Step 2 and demo #27)

**Today.** The app still has every caption slot: `SectionHeader.subtitle` (`DashboardUI.tsx:64-84`), `PageHeader.subtitle` (`:209-236`), `ToggleRow.description` (`:281-318`, required), `EmptyState.detail` (`:320-339`, required), `Modal.description` (`:429-563`), plus a second `components/EmptyState.tsx` with `description`, and `StepBody.description` (required). About 165 call sites use them.

**Do.**

1. Primitives:
   - Delete `subtitle` from `SectionHeader` and `PageHeader`, `description` from `ToggleRow` and `Modal`, `detail` from the DashboardUI `EmptyState`, and `description` from `components/EmptyState.tsx` (keep its `action`).
   - `SectionHeader` row becomes `flex items-center justify-between gap-3 px-5 pb-3 pt-4`.
   - `PageHeader` h1 becomes `text-[24px] sm:text-[26px]`.
   - `StepBody.description` becomes optional and renders only when present.
2. Let TypeScript list the call sites (`npm run build`), then treat each one:
   - A number the counselor uses moves into a `CountPill` in the header's action slot, for example `{n} recorded`, `{n} schools`, `{n} tracked`, `{n} open`, `{n} shared`, `{used} of {seats} seats`.
   - Load-bearing text (section 1.4) moves into an `InfoTip` beside the label, becomes the `EmptyState` title, or becomes an inline error line.
   - Everything else is deleted.
3. Call sites by kind (from `rg "subtitle=|description=|detail="`, design kit excluded):
   - `PageHeader subtitle`: counselor `calendar/page.tsx:464`, `colleges/page.tsx:152`, `data-hub/page.tsx:145`, `firm/page.tsx:23`, `intake/page.tsx:119`, `privacy/page.tsx:29`, `settings/page.tsx:51`, `students/StudentsPageClient.tsx:76`; student `calendar/page.tsx:259`, `flags/page.tsx:167`, `reports/page.tsx:25`, `settings/page.tsx:44`, `updates/page.tsx:83`.
   - `SectionHeader subtitle`: `intake:177`, `privacy:39, 65`, `StudentDashboardClient.tsx:140, 279`, `StudentProfileSelf.tsx:234`, `student/settings:73, 102`, `student/updates:153`, `AwardComparator.tsx:353`, `LinkUploads.tsx:254`, `ScholarshipFeed.tsx:153`, `StudentAid.tsx:391, 572, 692`, `StudentCommunication.tsx:715, 971`, `StudentFiles.tsx:386`, `RosterImportPanel.tsx:281, 347, 582, 678`. The `CounselorDashboardClient` and `StudentProfileClient` sites disappear with Steps 2.3 and 3.5.
   - `Modal description`: `StatPolygonHistory.tsx:134` (load-bearing, to `InfoTip`), `TaskStudentModal.tsx:195`, `BrandUploadModal.tsx:71`, `AssignTaskModal.tsx:331`, `AwardComparator.tsx:643`, `EmailBlastModal.tsx:227`, `MeetingModal.tsx:286`, `ParentAlertModal.tsx:400` (load-bearing), `PolygonEditor.tsx:213`, `StatusOverridePanel.tsx:71` and `StatusPicker.tsx:294` (load-bearing: "counselors only"), `StudentAid.tsx:767`, `IntegrationsPanel.tsx:641` (load-bearing: "does not open a provider consent screen"), `:726`.
   - `EmptyState detail/description`: see the 65 sites listed by `rg "detail=|description=" app components` after step 1; keep failure reasons as titles.
   - `ToggleRow description`: `settings/page.tsx:71, 75, 80, 85`, `privacy/page.tsx:44, 49, 54, 70, 75, 80`, `student/settings:78, 83, 88, 93, 106, 111`.
   - `StepBody description`: `onboarding/counselor:145, 170, 197, 255`, `onboarding/student:147, 186, 321, 375` (see step 6 below).
   - Hard-coded caption paragraphs: `AlertsPanel.tsx:267`, `AssignTaskModal.tsx:448-449`, `BrandUploadModal.tsx:195`, `settings/page.tsx:63-65` and the link `detail` strings at `:21, 27, 33` (rendered at `:107`), `student/updates/page.tsx:96-98`, `student/settings/page.tsx:152-154`.
4. ToggleRow labels that stand alone (the demo's wording where one exists):
   - Settings: "Show manual controls inside each AxIS tool"; "Draft monthly family reports for my approval" (on); "Surface matched programs for each student without being asked" (on); "Remind students more often as a critical deadline gets close" (on).
   - Privacy: "Generate AI profile summaries and next steps"; "Read uploaded transcripts, resumes and score reports into the profile"; "Allow de-identified data to be used to improve Meridies"; "Let students see the reports and feedback I share"; "Let team members see every student, not just their own"; "Tell students when I act on an update they sent".
   - Student settings: "Remind me before application and aid deadlines" (on); "Tell me when my counselor shares a report" (on); "Email me when my counselor books a meeting" (on); "Send me a Monday progress digest"; "Share my profile with my counselor" (on); "Share my updates as soon as I post them" (on).
   - These toggles persist nothing today (local state only). That is a pre-existing gap; note it in the PR and leave the wiring for a later change.
5. Lines, in the primitives and on every page this step touches:
   - lists in a card: `divide-y divide-border` becomes `divide-y divide-border/60`, rows get `hover:bg-muted/40`;
   - remove `border-t border-border` wrappers directly under a `SectionHeader`, and separator rows between `ToggleRow`s;
   - tables: zebra rows (`even:bg-muted/40`), hairlines `border-border/40`;
   - a group inside a card uses `rounded-xl bg-muted/30 p-3` instead of a second bordered card;
   - optionally adopt the demo's lighter `--border: #eaece7`.
6. Student-role pages and onboarding (#27):
   - `student/updates/page.tsx`: one column `mt-6 max-w-3xl`, composer first, feed below; the feed's title is "Recent updates" with a `CountPill "{n} shared"`; the empty state is a title only.
   - `StudentProfileSelf.tsx`: counts to `CountPill`; bordered stat tiles become `rounded-xl bg-muted/30 p-3`.
   - Student calendar and flags: the "ask your counselor to move a meeting" fact goes into an `InfoTip` if it matters.
   - Onboarding counselor: delete the Drive description at `:197`; `:255` becomes "You can also do this later.". Onboarding student: delete `:147` and `:375`; `:186` becomes "Skip a category and its follow-ups disappear. Uploading documents works too."; review the dynamic `:321`.
7. `app:AGENTS.md` "Do not": add "Put a gray caption or descriptor line under a heading, popup title, icon or empty state (v6). A count goes in a `CountPill`; a source or methodology note goes in an `InfoTip`."

**Done when.**
- [ ] `rg -n "subtitle=|description=|detail=" app/dashboard components` returns only the design kit, onboarding prompts that stayed, and deliberate `InfoTip`/`SourceTip` texts.
- [ ] Every load-bearing text in section 1.4 is still reachable on its surface.

### Step 1.4 [app] Auth pages and form primitives (demo #28)

**Demo reference.** `demo:components/AuthShell.tsx`, `TextField.tsx`, `Select.tsx`, `PrimaryButton.tsx`, `GoogleButton.tsx`, `RoleCards.tsx`, `app/login/page.tsx`, `app/signup/page.tsx`.

**Do.**

1. Form primitives, copied from the demo:
   - `TextField`: 40 px input `h-10 rounded-lg px-3 text-[14.5px]`, `placeholder:text-muted-foreground/60`, border `border-border-strong hover:border-muted-foreground/40 focus:border-primary focus:ring-primary/15`, error state `border-danger focus:ring-danger/15`. **The error sits on the label row**, right-aligned, `role="alert"`, `truncate text-[12px] font-medium text-danger`, so an error never changes the form's height. The hint sits under the input. `aria-describedby` joins the error and hint ids.
   - `Select`: `h-10 w-full appearance-none rounded-lg border border-border-strong bg-card px-3 pr-10 text-[14.5px] transition-colors hover:border-muted-foreground/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15`.
   - `PrimaryButton`: new `size?: "md" | "sm"` (`md` is `px-7 py-3 text-[15px]`, `sm` is `h-10 px-4 text-[14.5px]`).
   - `GoogleButton`: demo classes (`h-10 gap-2.5 rounded-lg border border-border-strong bg-white px-4 text-[14.5px] font-medium text-[#3c4043]`, 16 px G mark), keeping the app's `loading` prop and label.
   - `RoleCards` compact variant: `grid-cols-2 gap-2.5`, cards `h-11 items-center gap-2.5 px-3`, icon box `h-7 w-7`, `COMPACT_LABEL` "Student" / "Counselor".
2. `components/AuthShell.tsx`: rewrite from the demo with props `{ children }` only.
   - Grid `lg:grid-cols-[minmax(0,1fr)_minmax(0,46%)]`; form column `px-5 py-6 sm:px-10 lg:px-14` with `<Wordmark markSize={28} labelClassName="text-[1.2rem]!" />`; `main` `pt-12 sm:items-center`, width `max-w-[360px]`.
   - Aside `bg-surface-dark` with `<PolygonScene chartClassName="absolute left-[8%] top-[7%] h-[60%] w-[84%]" />` (Step 1.5), a 12 px `accent-strong/60` rule, the slogan (`font-brand max-w-[15ch] text-[42px] font-medium leading-[1.06] tracking-[-0.01em] text-[#f5f6f3] xl:text-[48px]`), and "Every student's record, deadlines and drafts in one place, so the hour with a family goes to the family." (`text-white/60 text-[14px]`).
   - Export `AuthDivider` ("or", `my-4`, `text-[11.5px] uppercase tracking-[0.12em]`).
   - Do not port the demo's `ResetDemo` footer (`AuthShell.tsx:37-39`).
   - Remove `brandHeadline`, `brandSubcopy` and `BRAND_POINTS`.
3. `app/login/page.tsx`:
   - h1 "Log in" (`AnimatedWords`, `text-[26px]`) and "Welcome back.";
   - "Log in as" label row with the role error ("Pick one to continue."), then `RoleCards compact`;
   - **Google first**, then `AuthDivider`, then Email and Password (`gap-3.5`);
   - Supabase credential errors on the Email row; the wrong-role redirect notice and unexpected errors on a `role="alert"` line above submit;
   - `PrimaryButton size="sm" className="mt-1.5 w-full"`; "Don't have an account? Sign up";
   - remove the stray `</div>    </AuthShell>` at `:168`.
4. `app/signup/page.tsx`: h1 "Create your account"; a fixed `h-5` line "Signing up as a {role} · Change" or "Choose a role, then your details."; "I'm a" label row with the role error; Google, divider, Full name / Email / Password with per-field errors; "Create account"; "Already have an account? Log in". Keep `errors.form` and the email-confirmation `notice` (real states). Delete the local `Divider`.
5. `app/join/[token]/page.tsx`: drop the brand props; keep "You've been invited to Meridies." with the counselor's name in the form column.
6. Optional: `components/OnboardingShell.tsx:23-28` drops the "{role} setup" pill, as the demo did; update both callers.

**Done when.**
- [ ] `/login`, `/signup?role=student`, `/signup?role=counselor` and `/join/<token>` match the demo at desktop and 375 px, and a validation error does not move the form.

### Step 1.5 [app] Splash and role picker (demo #28)

**Today.** `app/page.tsx` is the role picker; the app has no splash.

**Do.**

1. Add `components/splash/PolygonScene.tsx` (decorative art, not student data): props `labels?`, `chartClassName?`, `ground? = true`, `delay? = 0`, `labelClassName?`; 8 axes (Grades, Testing, Rigor, Activities, Recommendations, Fit, Essays, Deadlines), 4 rings, `MARK #9cc5af`, `LINE #c7e3d2`; draws rings, spokes, outline, dots, then loops across 3 profiles over 22 s. Reduced motion changes transitions only, never `initial` (avoids hydration mismatch).
2. Add `components/splash/SplashScreen.tsx` (props `{ leaving; onEnter(origin) }`): fixed `inset-0 z-40 bg-surface-dark`, `max-w-[1280px]`; header with the mark (`tone="light"`), the wordmark and a "Log in" link; two columns `lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]`. Left: eyebrow "For independent college counselors", the slogan h1 (`mt-5 font-brand text-[clamp(42px,5.4vw,72px)] font-medium leading-[1.02] tracking-[-0.015em] text-[#f5f6f3]`, "Less work," rises in, "more consulting." wipes in), sub copy, and "Get started". Right: the polygon on a faint 32 px grid, figcaption "A sample student profile, eight axes". On a phone the figure comes first. **Delete** the demo line "Interactive demo. Nothing you enter leaves this browser." (`SplashScreen.tsx:132-135`).
3. Add `components/splash/LiquidReveal.tsx` (1700 ms pour, 550 ms settle; a 320 ms fade under reduced motion).
4. Add `components/WelcomeLanding.tsx` holding today's `app/page.tsx` body (pill, "Welcome to Meridies", `RoleCards`, log-in link), without the demo's `<ResetDemo />`.
5. Rewrite `app/page.tsx` to the demo's phases `"splash" | "pouring" | "landing"`, mounting `WelcomeLanding` only after `onCovered`. Optionally redirect a signed-in visitor from `/` to `/dashboard/{role}`.

**Done when.**
- [ ] Splash, pour and role picker work at desktop and 375 px, and under `prefers-reduced-motion`.

---

## Phase 2: shell, Overview, Calendar tasks, Invitations

TODOv6 Step 3 merges Dashboard and Student Profiles into **Overview**: the banner with a **My Work Queue** card on it, then the student cards. The app's dashboard today carries much more (task list, alerts and escalation, upcoming deadlines and meetings, narrative flags, invitations). Steps 2.3, 2.4 and 2.5 ship together so none of those features disappears (D6).

### Step 2.1 [app] Shell: nav, collapsible sidebar, top bar, search

**Today.** Fixed 264 px sidebar (`DashboardSidebar.tsx:149`) with nav items Dashboard, Student Profiles, College Profiles, Calendar, "App Integrations & File Uploads", Settings, "Meridies LLM"; the roster opens only under `/students` (`:96-98`); the header search is a static input (`DashboardShell.tsx:137-145`); the top bar hard-codes "Assign task" and "Review" (`:149-172`). No `lib/nav.ts`, `lib/useSidebar.ts`, `lib/topBar.ts`, `QuickIcon` or `GlobalSearch`.

**Do.**

1. `lib/nav.ts` (new, demo shape with app paths):
   - `NavKey` includes `"overview"`.
   - `COUNSELOR_NAV`: Overview (`LayoutDashboard`, `/dashboard/counselor`, exact), College Profiles (`/dashboard/counselor/colleges`), Calendar, **Files** (`Database`, `/dashboard/counselor/data-hub`), Settings.
   - `STUDENT_NAV`: Dashboard, Calendar, My profile, Updates, Shared reports, and keep the app's **Red flags** (#12).
   - Constants: `ASSISTANT_HREF = "/dashboard/counselor/assistant"`, `OVERVIEW_HREF = "/dashboard/counselor"`, `STUDENT_HREF_PREFIX = "/dashboard/counselor/students/"`, `SIDEBAR_EXPANDED = 268`, `SIDEBAR_RAIL = 76`, `SIDEBAR_SNAP = 168`, `SIDEBAR_MIN_DRAG = 208`, `SIDEBAR_MAX_DRAG = 360`.
2. `lib/useSidebar.ts` (new, port `demo:lib/useSidebar.ts` **with the `ready` flag from the start**): key `meridies:sidebar`, `{ collapsed, width }`, returns `{ collapsed, width, ready, dragging, toggle, collapse, expand, startDrag }`. `ready` turns true only after the stored state loads. Wrap `localStorage` in try/catch.
3. `components/dashboard/DashboardShell.tsx` (rewrite, keeping the app's session-token effect, `NotificationBell` and `ReviewQueuePanel`):
   - new props `collapsed` handling, `autoCollapse`, `hideHeader`, `primaryActionKey`; `banner` renders **above** the content container, full-bleed (demo `:264-265`), not inside it with `mb-6` (app `:184-186`);
   - the `autoCollapse` effect records the prior state only once `ready`:
     ```ts
     useEffect(() => {
       if (!autoCollapse || !ready) return;
       wasExpanded.current = !collapsed;
       collapse();
       return () => { if (wasExpanded.current) expand(); };
     }, [autoCollapse, ready]);
     ```
   - drag handle and hover collapse button (`PanelLeftClose` / `PanelLeftOpen`), width transition `220ms cubic-bezier(0.25,1,0.5,1)`;
   - header `h-[60px] px-4 sm:px-6`; content `max-w-[1400px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6` (D4).
4. `components/dashboard/DashboardSidebar.tsx` (rewrite from the demo):
   - `onOverview = pathname === OVERVIEW_HREF || pathname.startsWith(STUDENT_HREF_PREFIX)` drives both the Overview item's active state and the roster's default-open state;
   - the Overview row carries the roster count badge and a chevron (`aria-expanded`); the roster sublist comes from `useCounselorRoster()` with a status dot per student;
   - keep the app's `rosterUnavailable` Retry and the `StatusPicker variant="dot"` per student (recoloured in Step 2.3);
   - a rule, then AxIS (Step 1.1);
   - `collapsed` rail mode: labels hidden, `title` tooltips;
   - account menu: Settings and Log out. No "Reset demo".
5. `lib/topBar.ts` and `components/dashboard/QuickIcon.tsx` (new):
   - `QUICK_ACTIONS`: `assign-task` (ListPlus, intent), `book-meeting` (CalendarPlus, **intent**: opens `MeetingModal` from the shell, since the app calendar does not read `?book=1`), `add-student` (UserPlus, **intent**: opens `InviteStudentDialog`; the intake page cannot create students, Step 0.9), `blast-email` (Send, intent), `upload-data` (Upload, `/dashboard/counselor/data-hub#uploads`), `new-chat` "Ask AxIS" (`MeridiesMark`, `ASSISTANT_HREF`), `college-search` (GraduationCap), and an app-only `review` intent for `ReviewQueuePanel`.
   - `DEFAULT_ENABLED = ["assign-task", "book-meeting", "add-student"]` (the sketch's top bar: Search, Assign Task, Book a Meeting, Add Students, bell, Ask AxIS).
   - `useSyncExternalStore` store with `toggle`, `move`, `reorder`, persisted to `localStorage` key `meridies:topbar` (D10). No reset export.
   - Shell `QuickButton`: `inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 font-sans text-[12.5px] font-medium hover:border-border-strong hover:bg-muted/60`, icon `h-3.5 w-3.5 text-primary`, label `hidden xl:inline`, first three shown in `hidden lg:flex`. `primaryActionKey` hides the duplicate of the page's own action.
   - Settings gets a "Top menu bar" section: ordered list with up/down and Remove, "Available actions" with Add, empty "No quick buttons yet.".
6. `components/dashboard/GlobalSearch.tsx` (new, 235 lines in the demo): a combobox `hidden max-w-md flex-1 sm:block`, input `h-10 rounded-xl border bg-muted/40 pl-10 pr-12`, `⌘K` hint; Cmd/Ctrl+K focuses it anywhere; arrows, Enter, Escape. Hits (max 10) in the order Student, College, Task, Page. Sources: pages from `lib/nav.ts` plus "AxIS"; students from `useCounselorRoster()`; colleges through `searchColleges(token, { search, limit: 6 })`, debounced 250 ms, at least 2 characters; tasks through `getTasks(token)` fetched once on first focus. Empty: "Nothing matches “{q}”.". The student role searches pages only.

**Backend (optional).** Add `preHandler: [app.authenticate, read("colleges:search", 240)]` to `GET /colleges` now that search hits it on every keystroke burst.

**Done when.**
- [ ] The sidebar reads Overview (with the student list), College Profiles, Calendar, Files, Settings, a rule, AxIS.
- [ ] The sidebar collapses to a rail and drags between 208 and 360 px; the state survives reload.
- [ ] Cmd+K finds a student, a college, a task and a page.

### Step 2.2 [backend] Counselor work items; roster additions

**Today.** No work-queue table or route. `deadlines.owner = 'counselor'` looks close but is wrong for this: `attach_student_policies('deadlines')` (`20260828000004:138`) lets the student read and tick those rows, `student_id` is NOT NULL (`20260806000001:33`) so practice-wide items are impossible, and private notes ("Parents prefer evening calls after 6pm") would leak. `GET /students` returns neither polygon axes nor academics (`be:src/routes/students.ts:46-94`).

**Do.**

1. Migration `20260929000003_counselor_work_items.sql`:

   ```sql
   create table if not exists public.counselor_work_items (
     id               uuid primary key default gen_random_uuid(),
     counselor_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
     student_id       uuid references public.profiles(id) on delete cascade,     -- null = practice-wide
     kind             text not null default 'task'
                        check (kind in ('task','note','deadline','report','meeting')),
     title            text not null check (length(btrim(title)) between 1 and 300),
     detail           text check (length(detail) <= 2000),
     due_date         date,
     done             boolean not null default false,
     done_at          timestamptz,
     source           text check (length(source) <= 120),
     family_report_id uuid references public.family_reports(id) on delete cascade,
     meeting_id       uuid references public.meetings(id) on delete cascade,
     created_at       timestamptz not null default now(),
     updated_at       timestamptz not null default now()
   );
   create index if not exists counselor_work_items_owner_idx
     on public.counselor_work_items (counselor_id, done, due_date);
   create index if not exists counselor_work_items_student_idx
     on public.counselor_work_items (student_id) where student_id is not null;
   drop trigger if exists counselor_work_items_set_updated_at on public.counselor_work_items;
   create trigger counselor_work_items_set_updated_at before update on public.counselor_work_items
     for each row execute function public.set_updated_at();

   alter table public.counselor_work_items enable row level security;
   -- "My" work queue: the owner only, never the student, same reasoning as student_status_overrides.
   create policy counselor_work_items_owner on public.counselor_work_items
     for all to authenticated
     using (counselor_id = (select auth.uid()))
     with check (counselor_id = (select auth.uid())
       and (student_id is null or private.is_counselor_of(student_id, (select auth.uid()))));
   ```

2. `be:src/routes/workItems.ts` (new), registered in `be:src/app.ts` at prefix `/work-items`; all counselor-only (`requireRole("counselor")`):
   - `GET /work-items?studentId=&includeDone=` with `limit("work-items:list", 240, 60)`. Returns the caller's rows. Optionally appends **derived, read-only** rows tagged `origin`: draft family reports awaiting approval (`kind: "report"`, title "Approve the {title}") and scheduled meetings in the next 7 days (`kind: "meeting"`).
   - `POST /work-items` body `z.object({ studentId: z.string().uuid().nullable().optional(), kind: z.enum([...]), title: z.string().trim().min(1).max(300), detail: z.string().max(2000).optional(), dueDate: z.string().date().nullable().optional(), source: z.string().max(120).optional() }).strict()`; when `studentId` is set, `resolveStudentId(request, studentId, "edit")`.
   - `PATCH /work-items/:id` with the same fields `.partial()` plus `done: z.boolean()`; sets `done_at`.
   - `DELETE /work-items/:id`.
   - Serializer `toWorkItem` in `lib/serialize.ts`: `{ id, origin: "work-item" | "family-report" | "meeting", kind, title, detail, studentId, dueDate, done, source, createdAt }`.
3. Roster additions on `GET /students` (D9), each one batched `.in("student_id", ids)` query like the deadlines batch at `students.ts:63-74`:
   - `polygon`: the stored `student_polygon_axes` rows (read-only; do not call `ensure_default_polygon_axes` from the list);
   - `gpaWeighted` from `student_academics`;
   - `nextMeeting`: the earliest `meetings` row with `status = 'scheduled'` and `starts_at >= now()`.
   Keep the handler behind its list limiter.
4. `be:AGENTS.md`: add `routes/workItems.ts` to the tree and a line under "Three rules the schema encodes": `counselor_work_items` is owner-only in both directions.

**Done when.**
- [ ] A student token cannot read or write `counselor_work_items`; a second counselor cannot read the first counselor's items.
- [ ] `GET /students` returns `polygon`, `gpaWeighted` and `nextMeeting` per row in one request.

### Step 2.3 [app] Overview page (TODOv6 Step 3)

**Demo reference.** `demo:app/dashboard/counselor/page.tsx`, `components/branding/BrandBanner.tsx`, `lib/forest.ts`, `components/dashboard/MyWorkQueueCard.tsx`, `components/dashboard/WorkQueueRows.tsx`, `components/overview/StudentProfiles.tsx`, `lib/mockData.ts:79-84` (status colours).

**Today.** `app/dashboard/counselor/page.tsx` (server, 97 lines) plus `CounselorDashboardClient.tsx` (902 lines): a "Counselor" pill (`:443-448`), an "Add student" action (`:449-458`), a constellation `BrandBanner` on cream inside the content container, 4 stat tiles, Student task list, Recent alerts with escalation, Upcoming deadlines, Upcoming meetings, Narrative flags and an Invitations card. `students/page.tsx` plus `StudentsPageClient.tsx` hold the roster.

**Do.**

1. **Banner.** TODOv6 says to keep the banner "as it is today"; for the app that means porting the demo's v5 forest banner.
   - Add `lib/forest.ts` (`seeded` mulberry32, `pine`, `treeline`).
   - Replace `components/branding/BrandBanner.tsx` with the demo version: full-bleed `relative overflow-hidden border-b`; tone `"dark"` (the forest: sky gradient `--surface-dark-secondary` to `--surface-dark`, an `--accent-strong` moon, three treelines with seeds 5, 17, 29, mist, fog, seven fireflies, all respecting reduced motion) or `"light"` (an uploaded photo with scrim `from-card/92 via-card/70 to-card/25`); inner `mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 sm:py-10 lg:px-7`; `children` is a node or `(tone) => node`.
   - Banner content: h1 `text-[28px] font-semibold tracking-tight sm:text-[34px]` "{Good morning|afternoon|evening}, {first}"; a line "Next deadline: {date} · {relative}" from the earliest open task stage, or "No assigned tasks are outstanding."; buttons "Assign task" (`h-14 rounded-2xl bg-primary px-7 text-[15.5px] font-semibold`, `ListPlus`), "Students" (scrolls to `#student-profiles` with `scrollIntoView({ behavior: "smooth", block: "start" })`), "Email blast" (`Send`); on the right, `<MyWorkQueueCard />`.
   - The pencil button (practice photo upload through `BrandUploadModal`) stays.
2. **My Work Queue.** Add to `lib/api.ts`:
   ```ts
   export type WorkItemKind = "task" | "note" | "deadline" | "report" | "meeting";
   export type WorkItem = {
     id: string; origin: "work-item" | "family-report" | "meeting"; kind: WorkItemKind;
     title: string; detail: string | null; studentId: string | null; dueDate: string | null;
     done: boolean; source: string | null; createdAt: string;
   };
   export function getWorkItems(token: string, q?: { studentId?: string; includeDone?: boolean }): Promise<WorkItem[]>;
   export function createWorkItem(token: string, input: {...}): Promise<WorkItem>;
   export function updateWorkItem(token: string, id: string, patch: {...}): Promise<WorkItem>;
   export function deleteWorkItem(token: string, id: string): Promise<void>;
   ```
   plus a `toggleWorkItemAction(id, done)` Server Action returning `ActionResult`.
   - `components/dashboard/WorkQueueRows.tsx`: round 18 px check button (`aria-pressed`, done `border-primary bg-primary`), title `text-[12.5px] font-medium` struck through when done, date "Oct 28" (`text-[11.5px] font-semibold tabular-nums`, `text-danger` when overdue, `text-warning` within a day), `AnimatePresence` exit, empty "Nothing on your queue.". A derived row (`origin !== "work-item"`) opens its source (the Review drawer or the meeting) instead of toggling.
   - `components/dashboard/MyWorkQueueCard.tsx`: `w-full rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-lg)] sm:w-[22rem]`, header `CalendarClock` plus "My Work Queue" (`font-sans text-[13px] font-semibold`), rows in `mt-2 max-h-[15.5rem] space-y-0.5 overflow-y-auto`. Items: open, sorted overdue, today, next 7 days, scheduled, then by date.
   - A failed fetch renders the reason, not an empty list.
3. **Student cards.** `components/overview/StudentProfiles.tsx` (new), `<section id="student-profiles" className="scroll-mt-6">` with h2 `font-serif text-[22px] font-semibold` "Student Profiles":
   - chips All / Needs attention / On track / Ahead, **each with its count** (`ml-1.5 tabular-nums`); "Filter by name..." (`h-9 sm:w-56`); cards / list toggle;
   - card: `group relative h-full rounded-lg border bg-card hover:border-primary/40 hover:bg-muted/40` with a link underlay; avatar 44 px, name, "Class of {gradYear}", status badge; the student's polygon (from `GET /students.polygon`, read-only `StatPolygon` at 176 px); a block with "Next deadline:" and "Next meeting:" ("Not scheduled" when none); a hover "Open ›";
   - list view: Student / Status / Applications ("{n} on list") / Next, rows `divide-border/60`;
   - empty roster: `EmptyState` (icon `Users`, title "No students yet") with an action that opens `InviteStudentDialog`; filtered empty: "No students match your filters.";
   - no hover lift, no off-palette icons (the app's `text-[#a9660f]` calendar icon goes).
   - **Do not port the demo's "stage"** (`STAGE_LABELS`, `StageTrack`): there is no stage data. Keep the app's onboarded / onboarding-in-progress line or drop it.
4. **Status colours (D2).** In `lib/profileDisplay.ts` add `STATUS_LABELS`:
   - `on-track`: label "On track", `dot #3b82c4`, `text #2563a8`, `bg #e3eefa` (blue);
   - `ahead`: label "Ahead", `dot #2e9a61`, `text #176b45`, `bg #e4f4ea` (green);
   - `at-risk`: label "Needs attention", `dot #e0932f`, `text #a9660f`, `bg #fbf0dd` (amber);
   and `effectiveStatus(s) = s.counselorStatus?.status ?? (deadlineStatus(s.nextDeadline).key === "needs-attention" ? "at-risk" : "on-track")`. Recolour `deadlineStatus`'s on-track to blue. In `components/dashboard/StatusPicker.tsx` `STATUS_META`, use the same three sets and the label "Needs attention"; keep the override-versus-derived look (filled pill vs dashed "Derived"). Every status dot and badge (sidebar, cards, calendar filters, AxIS student list) reads these. Update design kit `:583`.
5. **Page and shell.**
   - `page.tsx` (server): `requireUser("counselor")`, then `Promise.allSettled` over `getTasks(token)` (open only, for the banner line) and `getWorkItems(token)`; pass each failure down as a message. Students come from the layout's roster context. Drop `listInvitations`, `getAccountabilityOverview` and `getDeadlines` from this page.
   - Replace `CounselorDashboardClient.tsx` with `OverviewClient.tsx`: `DashboardShell` with `primaryActionKey="new-chat"` and the Ask AxIS link as `action`; no `contextPill`; no "Add student" action; `banner` = banner + hero + `MyWorkQueueCard`; children `<StudentProfiles />`; modals `BrandUploadModal`, `AssignTaskModal` (its `onCreated` calls `router.refresh()`), `EmailBlastModal`, `Toast`.
   - Delete the stat tiles, and the helpers `relativeTime`, `deriveFlags`, `urgencyLabel` if nothing else uses them.
6. **Routes.**
   - `next.config.ts`: add
     ```ts
     async redirects() {
       return [{ source: "/dashboard/counselor/students", destination: "/dashboard/counselor#student-profiles", permanent: false }];
     }
     ```
   - Delete `app/dashboard/counselor/students/page.tsx` and `StudentsPageClient.tsx`. Keep `students/[id]`.
   - Delete `components/dashboard/StatusOverridePanel.tsx` (status stays editable from the sidebar dot and the student page pill).
   - Repoint links: intake breadcrumb becomes "Overview › New student" and pushes `/dashboard/counselor#student-profiles`; `students/[id]/page.tsx:52-57` becomes "Back to Overview"; `app/actions.ts:28` `revalidatePath` points at `/dashboard/counselor/invitations` (and add it to `revokeInvitationAction`); design kit `:655-658` sample nav reads "Overview" with `LayoutDashboard`, breadcrumb sample "Overview › College Profiles › Stanford University"; the comment at `InviteStudentDialog.tsx:16`.
7. **Re-home what the removed cards did** (D6), in the same release:

   | Removed from the dashboard | New home |
   |---|---|
   | Student task list and stage ticking | Calendar → Tasks (Step 2.4) and the student page (Step 3.6) |
   | Recent alerts, raise red flag, parent alert (`AlertsPanel`, `ParentAlertModal`) | Calendar → Tasks until Steps 3.7 and 5.6 land, then the student page and the composer |
   | "Run escalation check" | Calendar → Tasks header. The backend also runs it on cron or interval |
   | Upcoming meetings | Calendar → Tasks → Meetings, and "Next meeting" on each card |
   | Upcoming deadlines | Calendar (already) and the banner's "Next deadline" line |
   | Narrative flags | Top-bar Review drawer (already there) |
   | Invitations card | Invitations page (Step 2.5) |

**Done when.**
- [ ] `/dashboard/counselor/students` lands on the cards.
- [ ] The banner is the forest (or the uploaded photo) with greeting, next deadline, three buttons and a working My Work Queue.
- [ ] On track is blue and Ahead is green on cards, sidebar dots and calendar filters; at-risk reads "Needs attention" in amber.
- [ ] Nothing from the table in item 7 is unreachable.

### Step 2.4 [app] Calendar: Tasks mode

**Demo reference.** `demo:app/dashboard/counselor/calendar/page.tsx` (Calendar | Tasks switch, `?view=tasks`), `components/dashboard/WorkQueueCard.tsx`, `NextMeetingsCard.tsx`, `StudentTaskList.tsx`.

**Do.** Keep the app's own month/agenda grid (no need to port `CalendarBoard`). Add:

1. A page bar with h1 "Calendar" / "Tasks" and a segmented Calendar | Tasks switch bound to `?view=tasks`.
2. Tasks mode: a left rail with "My Work Queue", "Student tasks" and "Meetings", each with its count; the main area shows the chosen list:
   - **My Work Queue**: `WorkQueueRows` over `getWorkItems(token, { includeDone: true })`, title "My Work Queue" with `CountPill "{n} open"`, plus an inline add row (title, optional student, optional date) calling `createWorkItem`;
   - **Student tasks**: the existing `StudentTaskList` with `getTasks` and `updateTaskStage` (moved from the dashboard), plus, until Step 3.7, `AlertsPanel` and a "Run escalation check" button;
   - **Meetings**: `getMeetings(token, { status: "scheduled", from: now })` rendered with `MeetingRow` ("No meetings booked." when empty).
3. Support `?student=<id>` (preselect the student filter) and `?book=1` (open `MeetingModal`).
4. Drop the `PageHeader` subtitle (`:464`). Student filter dots use `STATUS_LABELS`.

**Done when.**
- [ ] `/dashboard/counselor/calendar?view=tasks` shows the three lists with counts, and ticking a work item or a task stage persists.

### Step 2.5 [app] Invitations page (referrals come in Step 5.7)

**Demo reference.** `demo:app/dashboard/counselor/invitations/page.tsx` (504 lines), `lib/invitations.ts`.

**Today.** No page. Invitations live in the dashboard card that Step 2.3 removes, `InviteStudentDialog`, the onboarding invite step and `RosterImportPanel`. Backend: `POST /invites {email}` (re-posting supersedes the pending one, so it doubles as resend), `GET /invites`, `POST /invites/revoke {id}`.

**Do.**

1. `app/dashboard/counselor/invitations/page.tsx` (server: `requireUser("counselor")`, `listInvitations`) and `InvitationsClient.tsx`:
   - `PageHeader title="Invitations"`;
   - left card "Sent invitations": filter chips All / Pending / Joined / Expired with counts. "Expired" is `status === "pending" && expiresAt < now`. Hide `revoked` rows (the demo deletes on revoke; the backend keeps the row);
   - rows: mail icon, email (or the accepted student's name), sub-line "Sent {date}", status badge (pending "Invitation sent" amber, accepted "Joined" green, expired gray), **Resend** (calls `inviteStudentAction(email)`) and **Revoke** (aria "Revoke the invitation to {email}") while not accepted;
   - right card "Invite a student": "Student email" (placeholder `student@school.org`), "Send invitation", success line "Invitation sent to {email}. You'll see it move to “Joined” once they accept.", the backend's error on failure;
   - keep the fact "Invitations expire and only work for the address you enter" as an `InfoTip` beside the form title (match the real expiry, `invitations.expires_at` default 14 days);
   - `EmptyState title="Nothing here yet"`.
2. Entry points (D7): a "View all invitations" link in `InviteStudentDialog`, and a row in Settings.
3. The personal note field and the Referrals chip wait for Step 5.4 / 5.7.

**Done when.**
- [ ] A counselor can send, resend and revoke from the page, and every server error reaches the screen.

---

## Phase 3: the student page

TODOv6 Steps 4, 5 and 9. The page loses its tabs. Top to bottom: back link and two buttons; the info card with notes; the icon row (ten popups); Assigned tasks; Alerts beside My Work Queue.

**Today.** `app:app/dashboard/counselor/students/[id]/page.tsx` (server) and `StudentProfileClient.tsx`: back link "All students", an identity bar, `Tabs` (`:96-111`, rendered `:361-366`) with Overview, Activities, Aid, Scholarships, Communication, Files; a page-local `AssignTaskModal` (`:976-1206`); no "Book a meeting".

### Step 3.1 [backend] Student personal details, counselor note, detail DTO

**Today.** The info card's Gender, US citizen, Living with parent, Marital status and Address have no column anywhere. `profiles.phone` exists (`20260828000001:18`) but `toMeridiesUser` (`be:src/lib/serialize.ts:54-80`) never returns it. `profiles.high_school_id` exists (`20260828000009:29-30`) and is not serialized. `guardians` is not in `GET /students/:id`. There is no counselor-private note.

**Do.**

1. Migration `20260929000004_student_personal_details_and_notes.sql`:

   ```sql
   -- Info card fields. A separate table: profiles UPDATE is a column-level grant list
   -- (20260828000016:19-23) and the roster selects every profile column.
   create table if not exists public.student_personal_details (
     student_id        uuid primary key references public.profiles(id) on delete cascade,
     gender            text check (length(btrim(gender)) between 1 and 60),
     us_citizen        boolean,
     lives_with_parent boolean,
     marital_status    text check (marital_status in ('single','married','civil-union',
                         'domestic-partnership','separated','divorced','widowed')),
     address_line1     text check (length(address_line1) <= 200),
     address_line2     text check (length(address_line2) <= 200),
     city              text check (length(city) <= 120),
     region            text check (length(region) <= 120),
     postal_code       text check (length(postal_code) <= 20),
     country           text check (country ~ '^[A-Z]{2}$'),
     updated_by        uuid references public.profiles(id) on delete set null,
     created_at        timestamptz not null default now(),
     updated_at        timestamptz not null default now()
   );
   create trigger student_personal_details_set_updated_at before update on public.student_personal_details
     for each row execute function public.set_updated_at();
   select private.attach_student_policies('student_personal_details');
   comment on table public.student_personal_details is
     'v6 info card. Every column nullable with no default: unset renders as an em dash, never "Single" or "Yes".';

   -- "Add notes": private to the student's counselors, never the student.
   create table if not exists public.student_counselor_notes (
     student_id  uuid primary key references public.profiles(id) on delete cascade,
     body        text not null default '' check (length(body) <= 20000),
     updated_by  uuid references public.profiles(id) on delete set null,
     created_at  timestamptz not null default now(),
     updated_at  timestamptz not null default now()
   );
   create trigger student_counselor_notes_set_updated_at before update on public.student_counselor_notes
     for each row execute function public.set_updated_at();
   alter table public.student_counselor_notes enable row level security;
   create policy student_counselor_notes_counselor on public.student_counselor_notes
     for all to authenticated
     using (private.is_counselor_of(student_id, (select auth.uid())))
     with check (private.is_counselor_of(student_id, (select auth.uid())));
   ```

   Do not add defaults such as `us_citizen default true`; the demo invents `usCitizen: true`, `livingWithParent: true`, `maritalStatus: "Single"` and a placeholder parent (`demo:lib/mockData.ts:675-726`), and none of that is portable (D14).
2. `GET /students/:id` (`be:src/routes/students.ts:95-173`): add to its `Promise.all` `student_personal_details` (`maybeSingle`), `guardians` (order `is_primary desc, created_at`) and `student_counselor_notes` (`maybeSingle`; RLS returns nothing to the student). Return `personal`, `guardians`, `counselorNote`. Serializers `toPersonalDetails`, `toGuardian` (Step 0.1), `toStudentNote`; add an `nbool` helper.
3. `toMeridiesUser`: add `high_school_id` to the `Profile` row type; emit `profile.phone = p.phone ?? blob.phone ?? null` and `profile.highSchoolId = p.high_school_id ?? null`. This also reaches the roster and `/auth/me`.
4. `PATCH /students/:id` (schema `:31-42`): add `phone: z.string().trim().max(40).nullable().optional()` (validated with `toE164`) and `highSchoolId: z.string().uuid().nullable().optional()`. Both columns are already in the grant list.
5. `PUT /students/:id/personal` (new): `assertCanEditStudent`, upsert on `student_id`, `limit("students:personal", 120, 60)`, body
   ```ts
   z.object({
     gender: z.string().trim().min(1).max(60).nullable(),
     usCitizen: z.boolean().nullable(),
     livesWithParent: z.boolean().nullable(),
     maritalStatus: z.enum(["single","married","civil-union","domestic-partnership","separated","divorced","widowed"]).nullable(),
     address: z.object({ line1: ..., line2: ..., city: ..., region: ..., postalCode: ..., country: z.string().regex(/^[A-Z]{2}$/) }).partial().strict(),
   }).partial().strict()
   ```
6. `PUT /students/:id/note` (new): `requireRole("counselor")`, `assertCanEditStudent`, upsert, `limit("students:note", 240, 60)` (autosave), body `z.object({ body: z.string().max(20000) }).strict()`.
7. Intake: add the personal-detail questions to the student intake (`app:lib/aggregator.ts`) and have the backend intake apply step (Step 4.2 item 5) write them to `student_personal_details`. Review the intake's `citizenship` select (`app:lib/aggregator.ts:821-834`, includes "DACA / undocumented"), which lands in `profiles.profile` today (D14).

**Done when.**
- [ ] `GET /students/:id` returns `personal`, `guardians`, `counselorNote`, `profile.phone`, `profile.highSchoolId`, with nulls where nothing is on file.
- [ ] A student token reading their own record gets `counselorNote: null` and cannot write the note table.

### Step 3.2 [backend] Aid: v6 inputs and the per-school grid

**Today.** After Step 0.3, `student_aid_profiles` has `css_status` (without `verified`), `sai_estimate`, `household_size`, `number_in_college`, `income_band`, `assets_band`. The demo's popup shows a CSS note, an SAI note and numeric Parent AGI, Parent assets, Student income, Student assets. `GET /aid/checklist` is a raw collection with no school names (`be:src/routes/aid.ts:151-154`), so the app groups every item under "Not tied to one school" (`app:StudentAid.tsx:97-106, 288-296`).

**Do.**

1. Migration `20260929000005_aid_v6.sql`:

   ```sql
   alter table public.student_aid_profiles drop constraint if exists student_aid_profiles_css_status_check;
   alter table public.student_aid_profiles add constraint student_aid_profiles_css_status_check
     check (css_status in ('not-started','in-progress','submitted','verified','not-required','not-applicable'));
   alter table public.student_aid_profiles
     add column if not exists css_note             text     check (length(css_note) <= 1000),
     add column if not exists sai_note             text     check (length(sai_note) <= 1000),
     add column if not exists agi_tax_year         smallint check (agi_tax_year between 2000 and 2100),
     add column if not exists parent_agi_cents     bigint   check (parent_agi_cents >= 0),
     add column if not exists parent_assets_cents  bigint   check (parent_assets_cents >= 0),
     add column if not exists student_income_cents bigint   check (student_income_cents >= 0),
     add column if not exists student_assets_cents bigint   check (student_assets_cents >= 0);
   ```

2. `PUT /aid/profile` zod: add `css_note`, `sai_note`, `agi_tax_year` and the four `*_cents` fields as `.nullable()`; `css_status` accepts `verified`.
3. `GET /aid/checklist/grid?studentId=` (new, DB limiter): one row per `student_colleges` row, joined to `college:colleges(college_aid_profiles(css_profile_required, priority_aid_deadline))` and to the checklist rows for `css-profile`, `verification`, `award-letter`. Response:
   ```ts
   { schools: { studentCollegeId: string; school: string; priorityDeadline: string | null;
       cells: { item: "css-profile" | "verification" | "award-letter"; checklistId: string | null;
                status: string | null; applicable: boolean; done: boolean; dueDate: string | null }[] }[];
     completion: number | null }   // done / applicable cells, null when nothing applies
   ```
   `applicable` for the CSS cell comes from `css_profile_required`; when that is null, the cell is applicable and unknown, not "not required".
4. `PUT /aid/checklist/cell` (new): body `{ studentId, studentCollegeId, item, status }.strict()`. The unique index on `student_aid_checklist` is an expression index (`coalesce(student_college_id, ...)`, `20260828000007:107-108`), which PostgREST `onConflict` cannot target; select, then insert or update.
5. Retire `GET /aid/checklist` once the app stops calling it (Step 3.11).

### Step 3.3 [backend] Scholarships: scan, feed, recommend

**Today.** `scholarships` has 22 seeded rows (basis and scope live in `tags`, for example `array['both','national']`). Nothing inserts into `scholarship_matches`: there is no scan route, only GET and PATCH (`be:src/routes/aid.ts:248-297`). The app's feed footer claims pursued deadlines flow into the dashboard (`app:ScholarshipFeed.tsx:350-355`); no code does that.

**Do.**

1. Migration `20260929000006_scholarship_recommendations.sql`:

   ```sql
   alter table public.scholarship_matches drop constraint if exists scholarship_matches_status_check;
   alter table public.scholarship_matches add constraint scholarship_matches_status_check check (status in
     ('suggested','recommended','saved','applying','applied','awarded','dismissed'));
   alter table public.scholarship_matches
     add column if not exists recommended_at timestamptz,
     add column if not exists recommended_by uuid references public.profiles(id) on delete set null;
   create unique index if not exists scholarship_matches_student_catalog
     on public.scholarship_matches (student_id, scholarship_id) where scholarship_id is not null;
   ```

2. `POST /aid/scholarships/scan` (new): body `{ studentId }.strict()`, counselor only, `limit("scholarships:scan", 20, 60)`. A deterministic matcher over `scholarships.eligibility` jsonb: majors (profile intended majors), states (hometown state), `gpa_min` (weighted GPA), grade levels (grad year), gender (from `student_personal_details`, Step 3.1), activity keywords (activity categories and names), need. Upsert every eligible scholarship with a templated `why_fit` naming the attributes that matched ("Matches: intended major Biomedical Engineering; GPA 4.1 weighted"). No model call. Returns the feed.
3. `GET /aid/scholarships/feed?studentId=` (new): the stored matches joined to `scholarships(amount_note, amount_cents, renewable, opens_at, deadline, tags, description, url, sponsor)`, partitioned against today into `matches` (open now), and `held` with `reason: "not-open" | "closed"`, plus `scannedAt`. Basis and scope are read out of `tags`.
4. `POST /aid/scholarships/:id/recommend` (new): body `{ on: z.boolean() }.strict()`. On `true`: status `recommended`, `recommended_at`, `recommended_by`; insert a `deadlines` row (owner `student`, type `financial`, `due_date` = the scholarship deadline) and store its id in `deadline_id`; insert a `notifications` row of kind `scholarship` for the student. On `false`: back to `suggested` and delete the linked deadline if it is not done. Return what happened so the toast can say it.
5. Keep `PATCH` for `dismissed`.

### Step 3.4 [backend] Tasks: tick every stage at once

**Today.** The demo's task checkbox ticks every stage (`setTaskDone`). `PATCH /tasks/:id` (`be:src/routes/tasks.ts:460-516`, body `:96-109`) has no stage field, and a stage PATCH does not touch `deliverables.status`.

**Do.**

1. Add `stagesDone: z.boolean().optional()` to `patchTaskBody` and to the student allow-list at `tasks.ts:476` (a student may tick their own task).
2. Handler: update every `deliverable_stages` row of that deliverable (`done`, `done_at`, `completed_by`) and set `deliverables.status` to `complete` or `in-progress`. A task with no stages flips `status` only. Leave `progress_pct` alone (it is word-count driven where a target exists).
3. Optional: a trigger on `deliverable_stages` that keeps `deliverables.status` in step when the last stage is ticked individually.

### Step 3.5 [app] Student page layout and info card (TODOv6 Step 4)

**Demo reference.** `demo:app/dashboard/counselor/students/[id]/page.tsx:75-276`, `components/student/Detail.tsx`, `components/dashboard/HighSchoolProfileCard.tsx`, `components/dashboard/StudentStatusPicker.tsx`, `lib/highSchools.ts` (`rankSummary`).

**Do.**

1. `lib/api.ts`:
   - `Profile` gains `phone?: string | null; highSchoolId?: string | null`; optionally `MeridiesUser.avatarUrl`.
   - `StudentDetail` gains `guardians: Guardian[]; personal: StudentPersonalDetails | null; counselorNote: StudentNote | null`.
   - New types `Guardian`, `MaritalStatus`, `StudentPersonalDetails { gender, usCitizen, livesWithParent, maritalStatus, address: { line1, line2, city, region, postalCode, country }, updatedAt }`, `StudentNote { body, updatedBy, updatedAt }`.
   - New functions `saveStudentPersonalDetails(token, studentId, patch)`, `saveStudentNote(token, studentId, body)`, `getGuardians`, `createGuardian`, `updateGuardian`, `deleteGuardian`, and `updateDeadline(token, id, patch)` (the route exists; the client is missing).
2. `page.tsx` (server): fetch `getStudent`, and when `profile.highSchoolId` is set, `getHighSchool` and `getClassRank(weightedGpa)` with `Promise.allSettled`. The not-found fallback reads "Student not found" with "Back to Overview" to `/dashboard/counselor`.
3. `StudentProfileClient.tsx` (rewrite):
   - `DashboardShell` with `primaryActionKey="new-chat"` and the Ask AxIS link (`/dashboard/counselor/assistant?student={id}`) as `action`.
   - Header row: left, `← Overview` to `/dashboard/counselor`; right, **"Book a meeting"** (primary `h-11`, `CalendarPlus`, opens `MeetingModal` with `roster={useCounselorRoster()}`, `meeting={null}`, `defaultStudentId={student.id}`) and **"Assign a task"** (accent `h-11`, `ListPlus`, opens the shared `components/dashboard/AssignTaskModal.tsx`). Delete the page-local `AssignTaskModal` (`:976-1206`).
   - Body order: info card, icon row (Step 3.8), `StudentTaskCard` (3.6), then `lg:grid-cols-2` with `StudentAlertsCard` and `StudentWorkQueueCard` (3.7).
   - Delete `Tab`, `TAB_DEFS`, the tab state and `<Tabs>`; the identity bar's "Next deadline" line and onboarding badge; `AiSummaryCard` (`:715-803`); `DeadlinesCard` (`:1441-1480`); `SnapshotItem`, `AcademicChip`, `TASK_STATUS_META`, `TASK_KINDS`, `TaskList`; the `PreferencePanel` render (`:456-458`; keep the component, the intake uses it). `CollegeListCard`, `EssaysCard`, the activities sheet, the awards list and `MeetingNotesCard` move into popups (Steps 3.8, 3.9, 4.6-4.8).
   - Keep the `DashboardShell` content width.
4. `components/student/Detail.tsx` (new): label 11 px uppercase muted, value 13.5 px medium `truncate`; renders the em dash placeholder for null or empty.
5. `components/student/StudentInfoCard.tsx` (new), `Card className="p-5 sm:p-6"`:
   - small line "Class of {gradYear} · {highSchool}" (omit a missing part; never "Class of —");
   - avatar (48 px), name in the heading face (`font-serif text-[26px] sm:text-[28px]`), then the status pill: the app's `StatusPicker variant="pill"` with `derivedLabel` from `deadlineStatus(nextDeadline)`, keeping "Clear";
   - three sections in `grid lg:grid-cols-3 lg:divide-x lg:divide-border/70`:

     | Contact info | Personal details | Academics |
     |---|---|---|
     | Email (`student.email`) | Gender (`personal.gender`) | GPA (weighted) (`profile.gpaWeighted`) |
     | Phone (`profile.phone`) | Grad year (`profile.gradYear`) | Testing ("SAT {n}" or "ACT {n}", "Test optional" when `testStatus === "test-optional"`) |
     | Address (joined `personal.address`) | High school (`profile.highSchool`) | Rigor (`profile.rigor`) |
     | Parent / guardian (primary guardian: `{fullName} · {email ?? phone}`) | US citizen (Yes / No / —) | Applications (D15) |
     | | Living with parent (Yes / No / —) | Intended majors (ordered list) |
     | | Marital status | |

   - "High school profile": `components/student/HighSchoolProfileBar.tsx` (new), props `{ highSchool, profile, rank }`. One bar: school name, the placement sentence (`rank.summary` plus "of a class of {graduatingClass}", or `rank.unavailableReason`, never a number the backend did not give), and a chevron. Expanded: Class rank practice, APs offered (plus "IB diploma"), AP cap, Median SAT, Median ACT, Counselor load, "What a reader needs to know" (`notes`), "Where the class went" (`matriculation`; do not hard-code a year). An estimated band gets an `InfoTip` saying the placement is a Meridies estimate (Step 0.6). `sourceLabel` sits behind an `InfoTip`. No meta line, no "Synced" pill, no source footer. With no profile on file: a flat bar with the school name, or "No high school on file".
   - Notes: `components/student/StudentNoteField.tsx` (new), a `Textarea rows={2}` with `placeholder="Add notes"`, `aria-label="Notes about this student"`, classes `mt-4 border-border/70 bg-muted/20 placeholder:font-normal placeholder:text-muted-foreground/70`. No label, no "Saved" caption. Debounced autosave (about 600 ms, and flush on blur) through `saveStudentNote`; a failed save shows one `text-danger` line. Seeded from `student.counselorNote?.body`.
6. Copy that still says "tab": `components/files/IntegrationsPanel.tsx:893`, `components/dashboard/StudentCommunication.tsx:826`, `app:AGENTS.md:76`.

**Done when.**
- [ ] Top to bottom: back link and two buttons; info card with notes; icon row; Assigned tasks; Alerts beside My Work Queue.
- [ ] The tab bar, headline, "Save a note" label and College preferences are gone.
- [ ] Every info-card field with no data shows the em dash placeholder, and none shows an invented default.

### Step 3.6 [app] Assigned tasks card (TODOv6 Step 4)

**Demo reference.** `demo:components/student/StudentTaskCard.tsx`, `demo:lib/tasks.ts:20-70`.

**Do.**

1. Move the task helpers out of components into `app:lib/tasks.ts`: `TRACKER_META`, `daysFromToday`, `formatDay`, `formatShortDate`, `relativeDay`, `isTaskComplete`, `nextTaskDue`, `isTaskOverdue`, `taskProgress`, `trackerNote` (today in `components/dashboard/StudentTaskList.tsx:41-116`) and `StudentAlert`, `alertCount`, `buildAlerts` (today in `components/dashboard/AlertsPanel.tsx:48-140`).
2. `TaskPatch` gains `stagesDone?: boolean` (Step 3.4).
3. `components/student/StudentTaskCard.tsx` (new), props `{ tasks: Task[]; onAdd(): void; onChange(task): void }`:
   - header "Assigned tasks", a red count of open tasks (`bg-danger-bg text-danger`), right-aligned column heading "Due date";
   - each task: a square checkbox calling `updateTask(token, id, { stagesDone: !done })`; the title (struck through when complete); for a single-stage or stage-less task, the due date on the title row ("Today", "Tomorrow", "Yesterday" or "Oct 28"; `text-danger` when past, `text-warning` within a day); the tracker note line under it (`text-[12.5px] text-foreground/70`) from `tracker.note`, and when `tracker.source === "ai"` a small `MeridiesMark` with an aria-label marking it as the tracker's reading;
   - multi-stage tasks: "Subtasks" label, then one row per stage with a checkbox (`updateTaskStage(token, stageId, { done })`), struck through when done, due date right-aligned in a `w-24` column;
   - "Attached / related documents" chips from `task.documents` (`FileText` plus `title ?? filename`);
   - a "+ Add" row at the bottom calling `onAdd` (opens `AssignTaskModal`);
   - order: open first, then by next due;
   - with no tasks: "Nothing assigned yet" and the "+ Add" row;
   - optimistic toggles with rollback; errors inline; token colours only (no demo hex).

**Done when.**
- [ ] Ticking a subtask updates the card and the Alerts progress bar at once, and survives reload.

### Step 3.7 [app] Alerts card and My Work Queue card (TODOv6 Step 4)

**Demo reference.** `demo:components/student/StudentAlertsCard.tsx`, `demo:lib/alerts.ts:24-73`, `demo:components/student/StudentWorkQueueCard.tsx`.

**Do.**

1. `studentAlert(tasks: Task[], redFlags: RedFlag[])` in `app:lib/tasks.ts`, returning `{ overdue, noActivity, lowQuality, progress: number | null, flags }`:
   - `overdue`: open tasks whose next due is before today;
   - `noActivity` / `lowQuality`: open tasks whose `tracker.verdict` is `no-activity` / `below-the-brief`, not de-duplicated against overdue (D13);
   - `progress`: stage-weighted `taskProgress`, `null` when nothing is assigned (render the em dash placeholder, not 100%);
   - open red flags folded in by trigger (D12): `missed-deadline` joins Overdue; `no-progress`, `low-quality`, `likely-ai` join No activity (amber dot for low-quality).
2. `components/student/StudentAlertsCard.tsx` (new): header "Alerts" with a red `alertCount`; three columns `sm:grid-cols-3`: **Overdue** (task titles, danger bullets), **No activity** (titles; low-quality with the amber dot), **Progress** (`ProgressBar` and "{n}%"); an empty column reads "None". A red-flag row has a small menu with Acknowledge and Resolve (`updateRedFlag(token, id, { status })` in `lib/api.ts`), so escalations can still be stopped from the page. No "Alert parents" button (it moves to the composer, Step 5.6).
3. `components/student/StudentWorkQueueCard.tsx` (new): `getWorkItems(token, { studentId, includeDone: true })`; header "My Work Queue" with a right-aligned "Deadline"; rows through the shared `WorkQueueRows` (Step 2.3); empty "Nothing on your queue.". An inline add row creates an item with this `studentId`.
4. Delete `AlertsCard` (`StudentProfileClient.tsx:1210-1349`), `SEVERITY_META` and `openParentAlert`. Once this lands, remove the temporary `AlertsPanel` from Calendar → Tasks (Step 2.4).

**Done when.**
- [ ] Alerts and My Work Queue sit side by side at desktop and stack on a phone, each showing real data.

### Step 3.8 [app] Icon row and popup frame (TODOv6 Step 5)

**Demo reference.** `demo:components/student/StudentIcons.tsx`, `demo:components/student/OverviewTiles.tsx`.

**Do.**

1. `components/student/StudentIcons.tsx` (new): ten line icons in one family. Shared frame `viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5}`, round caps and joins, `aria-hidden`, rendered `text-primary` (follows the practice accent). Exports: `CollegeListIcon` (pantheon), `EssaysIcon`, `MeetingNotesIcon`, `StrengthProfileIcon`, `ActivitiesIcon`, `AwardsIcon` (trophy), `StudentAidIcon` (coin stack), `ScholarshipIcon` (mortarboard), `CommunicationIcon` (envelope), `UploadFilesIcon` (folder). Port the paths verbatim.
   - `StrengthProfileIcon({ axes, size })` takes `axes: StatAxis[]` (the app computes `mergeStoredAxes(getProfileStats(profile), storedAxes)`, `lib/profileDisplay.ts:39-121`): a guide ring at r=25 (opacity 0.35) and the shape with `r = 4 + value/100 * 21` around (32, 33), starting at -90°. It redraws when the axes change.
2. `components/student/OverviewTiles.tsx` (new): props `{ student, user, token, derived, storedAxes, onAxesChange, tasks, onToast }`.
   - `TileKey = "colleges" | "essays" | "notes" | "polygon" | "activities" | "awards" | "aid" | "scholarships" | "communication" | "upload"`.
   - Order and labels: **College list, Essays, Meeting notes, Strength profile, Activities list, Awards & honors, Student aid profile, Scholarship matching, Communication, Upload files**, icons at `size={58}`.
   - `Tile`: one `<button className="group flex w-32 flex-col items-center gap-2.5 focus-visible:ring-2 ...">` holding the glass square and the label; no box around the button. Glass per D1: `h-24 w-24 rounded-[24px] bg-card/70 backdrop-blur-md ring-1 ring-border shadow-[var(--shadow-sm)]`; hover changes the ring to `ring-primary/30` and the label to `text-primary`; no lift. Label 13.5 px medium. Glyph and label both open the popup.
   - Row: `mx-auto flex max-w-[52rem] flex-wrap justify-center gap-x-8 gap-y-7 py-2` (two centred rows of five at desktop; a short row stays centred).
   - Popups, all `Modal size="lg"` except Strength profile (its own modal, `max-w-4xl`) and Communication (`max-w-4xl`): College list (4.6), Essays (4.8), Meeting notes (3.9), Strength profile (3.10), Activities list and Awards & honors (4.7), Student aid profile and Scholarship matching (3.11), Communication (5.6), Upload files (3.12).
   - Until Steps 4.6-4.8 and 5.6 land, the College list, Essays, Activities, Awards and Communication popups hold the existing app pieces (`CollegeListCard`, `EssaysCard`, the activities sheet, the awards list, `StudentCommunication`) so nothing is lost in between.
3. The College list popup's supplements button opens the Essays popup focused on that school (`essaysFocus` state here).

**Done when.**
- [ ] Ten green line icons in one stroke style, each on a glass square with a plain label; clicking the glyph or the label opens its popup.
- [ ] Two students with different scores show different strength icons, and editing the polygon redraws the icon.

### Step 3.9 [app] Meeting notes popup (TODOv6 Step 9)

`components/student/MeetingNotesPanel.tsx` (new) in `Modal size="lg"` titled "Meeting notes". Keep the app's behaviour: list `profile.notes` (format the ISO `date` as "Oct 28, 2026"; title; summary; tags). With none, `EmptyState icon={Mic} title="No meeting notes yet"` and the link "Connect a notetaker in Files" to `/dashboard/counselor/data-hub#apps`. Delete `MeetingNotesCard` from `StudentProfileClient.tsx`. No backend change.

### Step 3.10 [app] Strength profile popup (TODOv6 Step 9)

**Demo reference.** `demo:components/StatPolygonHistory.tsx`, `demo:components/StatPolygonEditor.tsx:78-197`, `demo:components/StatPolygonCard.tsx`.

**Today.** `app:components/StatPolygonHistory.tsx:44-334` shows real recorded history (`getPolygonHistory`), `max-w-3xl`, no editing, with captions at `:134, 173, 201, 255-259, 314-319, 323-329`. Editing is a separate modal, `app:components/dashboard/PolygonEditor.tsx:63-366`.

**Do.**

1. Extract the axis rows from `PolygonEditor` into `components/student/PolygonAxisRows.tsx`: one row per axis with name input (commit on blur or Enter, Esc reverts), number, range (hidden on a phone), a "clear override" (`manualScore: null`) and delete (custom axes only; the backend refuses default axes); an add row (name, score default 60, Add; placeholder "Add an axis", or "Ten axes at most" at ten). Debounced `setAxisScore`, `upsertPolygonAxis`, `deletePolygonAxis`. No captions, no live-preview polygon (the history polygon is the preview). Then delete `PolygonEditor.tsx`.
2. Extend `StatPolygonHistory`: title "{name}'s growth", `width="max-w-4xl"`; new props `editable`, `startEditing`, `derived`, `storedAxes`, `onAxesChange`; a controls row with Weeks / Months / Years (default Months, D19), the current point label, and an **Edit / Done** `Button size="sm"` (`Pencil` / `Check`, `aria-pressed`). Not editing: the polygon, the timeline scrubber and "Change since {first label}". Editing: `grid lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]` with the polygon on the left drawing the **live** `mergeStoredAxes(derived, local)` and `PolygonAxisRows` on the right. On Done, refetch history (the trigger has recorded new rows).
3. Captions: delete them; "Record begins {date} · {n} readings" moves into an `InfoTip` beside the scale control; "history is recorded, not filled in backwards" stays reachable there too (section 1.4). An empty history renders `EmptyState`.
4. The strength icon opens this popup directly. `StatPolygonCard` on other surfaces opens the same popup (`startEditing` for its pencil). Drop the card's `subtitle` prop.
5. Editing requires a counselor (Step 0.2); pass `editable={false}` for the student role.

**Done when.**
- [ ] One click on the strength icon shows the growth view; "Edit" changes scores inside the same popup and the polygon redraws as you drag.

### Step 3.11 [app] Student aid and Scholarship matching popups (TODOv6 Step 9)

**Demo reference.** `demo:components/student/StudentAidPanel.tsx`, `demo:components/dashboard/AidChecklistTable.tsx`, `demo:components/dashboard/AwardComparator.tsx`, `demo:components/student/ScholarshipPanel.tsx`, `demo:components/dashboard/ScholarshipFeed.tsx`.

**Do (aid).**

1. `lib/api.ts`: `StudentAidProfile` gains `css_note`, `sai_note`, `agi_tax_year`, `parent_agi_cents`, `parent_assets_cents`, `student_income_cents`, `student_assets_cents`, and `css_status` as a union including `verified`. New `AidChecklistCell`, `AidChecklistSchool`, `getAidChecklistGrid(token, studentId)`, `setAidChecklistCell(token, input)`. Retire `getAidChecklist(): Promise<unknown[]>`.
2. `components/student/StudentAidPanel.tsx` (new, replaces `components/dashboard/StudentAid.tsx`, 826 lines):
   - stat strip, three cells: "CSS Profile" with an `InfoTip(css_note)` and an editable status badge (a badge-styled select); "SAI estimate" with `InfoTip(sai_note)` and currency or the em dash placeholder; "Aid file complete" with `{completion}%` and a `ProgressBar` (or the placeholder when `completion` is null);
   - "Family contribution inputs": six `Detail`s with inline edit: Household size, Number in college, Parent AGI ({agi_tax_year}), Parent assets (non-retirement), Student income, Student assets;
   - "Per-school aid checklist": `components/student/AidChecklistTable.tsx` (new) over `getAidChecklistGrid`, columns School | Priority deadline (with relative) | CSS Profile | Verification | Award letter; cells done (check), open (ring), not applicable (dash); a click cycles the stored status through `setAidChecklistCell`. No "override" marker: every cell is a stored value. Empty: "No schools on the list yet";
   - `AwardComparator`: captions move into `InfoTip`s (`:353, 409-413, 446, 616-622, 631-636, 643`); "Net price excludes loans and work study" stays reachable (methodology);
   - the Award Appeal Assistant becomes a per-school action in the comparator (D17); "Next aid dates" is dropped.
3. Delete `StudentAid.tsx` after the move.

**Do (scholarships).**

1. `lib/api.ts`: `ScholarshipMatch` gains `amount_note`, `renewable`, `basis`, `scope`, `opens_at`, `found_at`, `recommended_at`, and `"recommended"` in `status`. New `ScholarshipFeed { matches, held, scannedAt }`, `getScholarshipFeed`, `scanScholarships`, `recommendScholarship(token, id, on)`.
2. `components/student/ScholarshipPanel.tsx` (new):
   - "Matched on" as one compact row (`bg-muted/45`): Majors, Location (hometown), Class of, GPA ("{n} weighted");
   - `ScholarshipFeed` reworked to the demo: title "Matched scholarships" plus **Rescan** (`scanScholarships`); a collapsible "Opening later or closed" with a `CountPill`, listing held rows ("Opens {date}" / "Closed {relative}"); rows with chevron, name, amount (`amount_note`, else the formatted `amount_cents`, else nothing; never an invented amount), "Closes {date} · {relative}", sponsor, basis badge (Merit / Need-based / Merit + need), and the toggle "Recommend to {first}" / "Recommended" calling `recommendScholarship`; expanded: eligibility, the `why_fit` line (a provenance glyph, not Sparkles), Renewable / One-time, scope, "Sponsor page"; Dismiss in a row menu (D18); empty "Nothing open right now";
   - the toast says what happened ("Recommended. Added a deadline to Sophia's calendar and notified her.");
   - delete the second polygon card, the "What the scan reads" card (`StudentProfileClient.tsx:543-605`), the count line, and the false footer (`ScholarshipFeed.tsx:350-355`).

**Done when.**
- [ ] The aid popup has no FAFSA, shows each school by name in the checklist, and every cell edit survives reload.
- [ ] Rescan fills the feed from the catalog, and Recommend creates the student's deadline.

### Step 3.12 [app] Upload files popup (TODOv6 Step 9)

**Demo reference.** `demo:components/dashboard/StudentFiles.tsx:128-263`.

**Do.** Render `StudentFiles` in `Modal size="lg"` titled "Upload files".

1. Strip the card chrome: no `Card`, `SectionHeader "Files"` or subtitle (`:384-400`).
2. A dashed drop zone "Drop files here, or click to browse", then a "From" row: pill chips This computer / Google Drive / Microsoft 365 (their hints in `Tooltip`s), an `InfoTip`, and a right-aligned "Connections" link to `/dashboard/counselor/data-hub#apps`. Google and Microsoft open `RemoteFilePicker`.
3. The list inside `rounded-xl border`: kind tile, name, "kind · size · date · source" (or a "Written by Meridies" chip when `source === "generated"`, replacing the paragraph at `:619-641`), the word budget (Step 4.8), a preview eye (`FilePreview`, Step 6.6) and remove.
4. Delete the file-types caption (`:490`), the staged caption (`:497-501`), `EmptyState detail` (`:661`), both context switches (`:706-730`, `:790-810`), `toggleContext` / `toggleLinkContext` (`:305-346`) and the links caption (`:771`). Add the "Exclude from AI" overflow action and the `EyeOff` marker (D11).
5. Keep the `uploadStudentDocument` export (`AwardComparator` imports it) and the AI filing review.
6. Delete the "Where files come from" card from the old Files tab (`StudentProfileClient.tsx:644-667`).

**Done when.**
- [ ] The popup shows no captions and no context pills; excluding a file from AI is still possible and visible only on excluded rows.

---

## Phase 4: college list, sheets, essays

TODOv6 Steps 6, 7 and 8. Three popups where every cell or card is live. Three facts shape this phase:

- The backend already generates full CRUD for `/student-colleges`, `/activities`, `/awards` and `/essays` (`be:src/routes/records.ts:157-175` through `be:src/lib/collection.ts:85-199`), but `lib/api.ts` wraps none of them.
- Nothing writes the `activities` and `awards` tables in production: the intake grids save to `intake_responses.answers` (`be:src/routes/intake.ts:72-120`) and are never copied over, and `GET /students/:id` builds those arrays from the tables only.
- The demo's shared stores (`useCollegeList`, `useApplicationSheets`, `useLiveEssays`) become one client context seeded from the server-rendered `StudentDetail` (Step 4.5).

### Step 4.1 [backend] College list: catalog fees, supplements, editable columns (TODOv6 Step 6)

**Demo reference.** `demo:lib/collegeList.ts` (`ROUND_OPTIONS`, `TESTING_OPTIONS`, `CollegeRowEdits`, `CollegeListRow`), `demo:lib/mockData.ts:335-373, 441-445`.

**Today.** `colleges` has no application fee and no supplement prompts; `test_policy` has no `flexible`. `student_colleges` (`20260828000004:42-70`) has `round in ('ED','ED2','EA','REA','RD','rolling','priority')` (no SCEA), `status in ('considering','applying','submitted',...)` (not the demo's `not-started` / `in-progress`), and no custom deadline, intended major, recommendations, testing or fee. `collegeBody` (`records.ts:94-114`) has nothing nullable, so a cell cannot be cleared. `toCollege` omits `college_id`.

**Do.**

1. Migration `20260929000007_college_list_v6.sql`:

   ```sql
   -- Catalog
   alter table public.colleges
     add column if not exists application_fee_cents integer check (application_fee_cents between 0 and 100000);
   alter table public.colleges drop constraint if exists colleges_test_policy_check;
   alter table public.colleges add constraint colleges_test_policy_check
     check (test_policy in ('required','optional','flexible','blind','recommended'));

   create table if not exists public.college_supplements (
     id                 uuid primary key default gen_random_uuid(),
     college_id         uuid not null references public.colleges(id) on delete cascade,
     admission_cycle    text not null default '2026-27' check (admission_cycle ~ '^\d{4}-\d{2}$'),
     title              text not null check (length(btrim(title)) between 1 and 120),
     prompt             text not null check (length(btrim(prompt)) between 1 and 2000),
     word_limit         integer check (word_limit between 1 and 5000),
     required           boolean not null default true,
     sort_order         integer not null default 0,
     source_url         text,
     source_verified_at timestamptz,
     created_at         timestamptz not null default now(),
     updated_at         timestamptz not null default now(),
     constraint college_supplements_slot unique (college_id, admission_cycle, sort_order)
   );
   create trigger college_supplements_set_updated_at before update on public.college_supplements
     for each row execute function public.set_updated_at();
   alter table public.college_supplements enable row level security;
   create policy college_supplements_select on public.college_supplements
     for select to authenticated using (true);
   -- Catalog data: service_role writes only, like every college_* table.

   -- A student's list
   alter table public.student_colleges drop constraint if exists student_colleges_round_check;
   alter table public.student_colleges add constraint student_colleges_round_check
     check (round in ('ED','ED2','EA','REA','SCEA','RD','rolling','priority'));
   alter table public.student_colleges drop constraint if exists student_colleges_status_check;
   update public.student_colleges set status = 'not-started' where status = 'considering';
   update public.student_colleges set status = 'in-progress' where status = 'applying';
   alter table public.student_colleges alter column status set default 'not-started';
   alter table public.student_colleges add constraint student_colleges_status_check check (status in
     ('not-started','in-progress','submitted','accepted','denied','waitlisted','deferred','enrolled','withdrawn'));
   alter table public.student_colleges
     add column if not exists custom_deadline       date,
     add column if not exists intended_major        text check (length(intended_major) <= 200),
     add column if not exists recs_required         smallint check (recs_required between 0 and 10),
     add column if not exists recs_in_hand          smallint check (recs_in_hand between 0 and 10),
     add column if not exists testing               text check (testing in ('required','optional','flexible','blind')),
     add column if not exists application_fee_cents integer check (application_fee_cents between 0 and 100000);
   alter table public.student_colleges add constraint student_colleges_recs_consistent check (
     recs_in_hand is null or (recs_required is not null and recs_in_hand <= recs_required));
   comment on column public.student_colleges.custom_deadline is
     'The internal date the counselor holds the student to ("Custom deadline", v6). Not constrained to precede deadline; the UI colours a late one red.';
   comment on column public.student_colleges.recs_required is '0 = "Not required"; null = not recorded.';
   comment on column public.student_colleges.testing is 'Per-student override; null reads colleges.test_policy.';
   comment on column public.student_colleges.application_fee_cents is 'Per-student override; null reads colleges.application_fee_cents.';

   -- "Add to list" dedupes by catalog identity as well as by name. Check duplicates first:
   -- select student_id, college_id, count(*) from public.student_colleges
   --   where college_id is not null group by 1, 2 having count(*) > 1;
   create unique index if not exists student_colleges_unique_college
     on public.student_colleges (student_id, college_id) where college_id is not null;
   ```

   Counselor-only `fit` and `custom_deadline` (D20): add a `security definer` `before insert or update` trigger on `student_colleges` that raises `42501` when `auth.uid() = new.student_id` and `fit` or `custom_deadline` is set or changed. The pattern is `documents_external_pointer_guard` (`20260923000004:95-125`).
2. `records.ts` `collegeBody`: every field `.nullable().optional()`, and
   ```ts
   round: z.enum(["ED","ED2","EA","REA","SCEA","RD","rolling","priority"]).nullable().optional(),
   fit: z.enum(["reach","target","likely"]).nullable().optional(),
   status: z.enum(["not-started","in-progress","submitted","accepted","denied","waitlisted","deferred","enrolled","withdrawn"]).optional(),
   deadline: z.string().date().nullable().optional(),
   custom_deadline: z.string().date().nullable().optional(),
   intended_major: trimmed(200).nullable().optional(),
   recs_required: z.number().int().min(0).max(10).nullable().optional(),
   recs_in_hand: z.number().int().min(0).max(10).nullable().optional(),
   testing: z.enum(["required","optional","flexible","blind"]).nullable().optional(),
   application_fee_cents: z.number().int().min(0).max(100000).nullable().optional(),
   college_id: z.string().uuid().nullable().optional(),
   ```
3. `registerCollection` (`be:src/lib/collection.ts:54-83`): add an optional `select?: string` used at `:96, 128, 163` instead of `"*"`. For student-colleges pass `"*, college:colleges(id, slug, test_policy, application_fee_cents, deadlines, supplements:college_supplements(count))"`, and use the same select in `GET /students/:id` (`students.ts:120`).
4. Student-colleges `beforeWrite` on insert with a `college_id`: load the catalog row (404 when missing); default `name`, `initials`, `brand_color` from it; default `deadline` from `colleges.deadlines[planFor(round)]` (plan names "Early Action", "Restrictive Early Action", "Regular Decision", "Regular Action", "Early Decision", "Early Decision II"; reuse `nextOccurrence` from `scripts/seed/generate-catalog.ts:255-265`); leave `testing` and `application_fee_cents` null so they inherit.
5. `toCollege` (`serialize.ts:125-137`):
   ```ts
   const c = (r.college ?? null) as Row | null;
   return {
     id, collegeId: nstr(r.college_id), name, initials, color,
     round: nstr(r.round), fit: nstr(r.fit), status: str(r.status), binding,
     deadline: nstr(r.deadline), customDeadline: nstr(r.custom_deadline),
     intendedMajor: nstr(r.intended_major),
     recsRequired: nnum(r.recs_required), recsInHand: nnum(r.recs_in_hand),
     testing: nstr(r.testing) ?? (c ? nstr(c.test_policy) : null), testingOverridden: r.testing != null,
     applicationFeeCents: nnum(r.application_fee_cents) ?? (c ? nnum(c.application_fee_cents) : null),
     supplementCount: Number((c?.supplements as { count: number }[] | undefined)?.[0]?.count ?? 0),
     notes, sortOrder,
   };
   ```
   `deadline` changes from `""` to `null`: update the app readers in the same release (Step 4.5).
6. `GET /colleges/:id` returns `supplements` (current cycle, ordered).
7. `be:src/routes/blasts.ts:93-98, 166-170`: the "status" audience now sees `not-started` / `in-progress`; label them "Not started" / "In progress".

**Done when.**
- [ ] Every column the popup edits can be set and cleared through `PATCH /student-colleges/:id`, and a student token cannot set `fit` or `custom_deadline`.

### Step 4.2 [backend] Activity and award sheets (TODOv6 Step 7)

**Demo reference.** `demo:lib/applicationSheets.ts` (`ACTIVITY_TYPES` (27), `GRADE_OPTIONS`, `WHEN_OPTIONS`, `UC_ACTIVITY_CATEGORIES`, `UC_ORG_DESCRIBED`, `COMMON_APP_LEVELS`, `UC_LEVELS`, `UC_AWARD_TYPES`, `SHEET_LIMITS`, `FORM_CAPS`, `ActivityRow`, `HonorRow`).

**Today.** `activities` and `awards` (`20260828000003:87-137`) have `name NOT NULL` (blocks the demo's blank "+ Add" row; in v6 the organization is the name), no UC category, no UC organization description, and awards lack grade levels, Common App recognition levels, UC type and UC level. No CHECK on category, grades or timing.

**Do.**

1. Pre-check: `select category, count(*) from public.activities group by 1;` and `select level, year, count(*) from public.awards group by 1, 2;`.
2. Migration `20260929000008_application_sheets_v6.sql`:

   ```sql
   -- Activities
   alter table public.activities alter column name drop not null;
   alter table public.activities drop constraint if exists activities_name_check;
   alter table public.activities add constraint activities_name_check
     check (name is null or length(btrim(name)) between 1 and 300);
   update public.activities set organization = name where organization is null and name is not null;
   alter table public.activities
     add column if not exists uc_category text
       check (uc_category in ('coursework-other','educational-prep','extracurricular','volunteer','work')),
     add column if not exists uc_org_description text check (length(uc_org_description) <= 2000);

   -- Normalise legacy values, then constrain.
   update public.activities a set grade_levels = coalesce((
     select array_agg(case when lower(g) = 'pg' then 'PG' else g end order by i)
     from unnest(a.grade_levels) with ordinality u(g, i)
     where lower(g) in ('9','10','11','12','pg')), '{}');
   update public.activities a set timing = coalesce((
     select array_agg(lower(t) order by i) from unnest(a.timing) with ordinality u(t, i)
     where lower(t) in ('school','break','year')), '{}');
   update public.activities set timing = timing[1:1] where cardinality(timing) > 1;
   update public.activities set category = 'Work (paid)' where category = 'Work (Paid)';
   -- Map any other unknown category to 'Other Club/Activity' after reviewing the pre-check output.
   alter table public.activities
     add constraint activities_grade_levels_check check (grade_levels <@ array['9','10','11','12','PG']::text[]),
     add constraint activities_timing_check check (timing <@ array['school','break','year']::text[] and cardinality(timing) <= 1),
     add constraint activities_category_check check (category is null or category in (
       'Academic','Art','Athletics: Club','Athletics: JV/Varsity','Career-Oriented','Community Service (Volunteer)',
       'Computer/Technology','Cultural','Dance','Debate/Speech','Environmental','Family Responsibilities',
       'Foreign Exchange','Foreign Language','Internship','Journalism/Publication','Junior R.O.T.C.','LGBT',
       'Music: Instrumental','Music: Vocal','Religious','Research','Robotics','School Spirit','Science/Math',
       'Social Justice','Student Govt./Politics','Theater/Drama','Work (paid)','Other Club/Activity'));
   -- 150 / 350 / 250 character limits are soft (red in the UI); 2000 stays the sanity cap.

   -- Awards
   alter table public.awards alter column name drop not null;
   alter table public.awards drop constraint if exists awards_name_check;
   alter table public.awards add constraint awards_name_check
     check (name is null or length(btrim(name)) between 1 and 300);
   alter table public.awards
     add column if not exists grade_levels       text[] not null default '{}',
     add column if not exists recognition_levels text[] not null default '{}',   -- Common App, multi
     add column if not exists uc_type  text check (uc_type in ('academic','non-academic')),
     add column if not exists uc_level text check (uc_level in
       ('school','city-community','state','regional','national','international'));
   alter table public.awards
     add constraint awards_grade_levels_check check (grade_levels <@ array['9','10','11','12','PG']::text[]),
     add constraint awards_recognition_levels_check
       check (recognition_levels <@ array['school','state-regional','national','international']::text[]),
     add constraint awards_uc_text_caps check (length(uc_criteria) <= 2000 and length(uc_earned) <= 2000);
   comment on column public.awards.uc_criteria is 'UC "What are the eligibility requirements" (250, soft).';
   comment on column public.awards.uc_earned  is 'UC "What did you do to achieve it" (350, soft).';

   -- Backfill only from stated values (international before national: '%national%' matches both).
   update public.awards set recognition_levels = array[case
       when level ilike '%international%' then 'international'
       when level ilike '%national%' then 'national'
       when level ~* 'state|regional|district' then 'state-regional'
       else 'school' end]
    where level is not null and btrim(level) <> '' and recognition_levels = '{}';
   update public.awards set uc_level = case
       when level ilike '%international%' then 'international'
       when level ilike '%national%' then 'national'
       when level ilike '%state%' then 'state'
       when level ilike '%regional%' then 'regional'
       when level ilike '%district%' then 'city-community'
       else 'school' end
    where level is not null and btrim(level) <> '' and uc_level is null;
   -- uc_type stays null: the demo's honorType regex is a guess.
   ```

   RLS stays `attach_student_policies` on both tables (a student edits their own sheets).
3. `activityBody` (`records.ts:26-42`), every field `.nullable().optional()`:
   ```ts
   name: trimmed(300).nullable().optional(),
   category: z.enum([...the 30 values]).nullable().optional(),
   grade_levels: z.array(z.enum(["9","10","11","12","PG"])).max(5).optional(),
   timing: z.array(z.enum(["school","break","year"])).max(1).optional(),
   hours_per_week: z.number().min(0).max(168).nullable().optional(),
   weeks_per_year: z.number().int().min(0).max(52).nullable().optional(),
   continuing: z.boolean().nullable().optional(),
   position: trimmed(200).nullable().optional(),
   organization: trimmed(300).nullable().optional(),
   description: z.string().max(2000).nullable().optional(),
   uc_category: z.enum(["coursework-other","educational-prep","extracurricular","volunteer","work"]).nullable().optional(),
   uc_org_description: z.string().max(2000).nullable().optional(),
   uc_description: z.string().max(2000).nullable().optional(),
   ```
   `awardBody` (`:44-54`): `name` nullable; `grade_levels` (same enum); `recognition_levels: z.array(z.enum(["school","state-regional","national","international"])).max(4)`; `uc_type`; `uc_level`; `uc_criteria` and `uc_earned` `.max(2000).nullable()`.
4. `beforeWrite` on insert: refuse past 20 rows per table per student (the most the UI can reach). The form caps (10 Common App activities, 5 honors before the warm tint, 20 UC entries across both) stay UI rules, as in the demo.
5. Serializers (`serialize.ts:84-110`), keeping the legacy fields for existing readers:
   ```ts
   toActivity: { id, name: str(r.name) || str(r.organization), role: str(r.position), commitment,   // legacy
     position: str(r.position), organization: str(r.organization), category: nstr(r.category),
     gradeLevels: arr(r.grade_levels), timing: arr(r.timing)[0] ?? null,
     hoursPerWeek: nnum(r.hours_per_week), weeksPerYear: nnum(r.weeks_per_year),
     continuing: r.continuing == null ? null : Boolean(r.continuing),
     description: str(r.description), ucCategory: nstr(r.uc_category),
     ucOrgDescription: str(r.uc_org_description), ucDescription: str(r.uc_description), sortOrder }
   toAward: { id, name: str(r.name), level: str(r.level), year: str(r.year),                      // legacy
     gradeLevels: arr(r.grade_levels), recognitionLevels: arr(r.recognition_levels),
     ucType: nstr(r.uc_type), ucLevel: nstr(r.uc_level),
     ucEligibility: str(r.uc_criteria), ucAchievement: str(r.uc_earned), sortOrder }
   ```
6. **Intake to tables.** `POST /intake/apply` (or run on intake completion): insert the intake grid rows into `activities` and `awards` with `source = 'intake'`, mapping `gradeLevels` to `grade_levels`, `timing` to `timing[]`, `continuing`, `description`, `ucDescription`, and award `level` to `recognition_levels` / `uc_level`. Also write the Step 3.1 personal details. Idempotent: skip when `source = 'intake'` rows already exist for the student.
7. The AI readers that select `name, position, organization, category, hours_per_week, description` (`be:src/lib/chat.ts:179-190`, `be:src/routes/ai.ts:43-44`) keep working; switch them to `coalesce(name, organization)`.

**Done when.**
- [ ] A blank activity row can be created and every sheet field can be set and cleared.
- [ ] A finished intake produces `activities` and `awards` rows once.

### Step 4.3 [backend] Essays: one record per document (TODOv6 Step 8)

**Demo reference.** `demo:lib/essays.ts` (`EssayDoc`, `schoolGroups`, `isUcCampus`, `budgetFor`), `demo:lib/readDocument.ts`.

**Today.** `essays` (`20260828000003:184-205`) has free-text `school`, a **client-supplied** `word_count`, and no link to a school on the list, a supplement prompt, or a document. No personal-statement kind. `toEssay` returns no body or excerpt. `be:src/lib/suiteApi.ts:336-340` says there is no dependency-free way to read a `.docx`; `node:zlib.inflateRawSync` is exactly what `readDocument.ts` needs.

**Do.**

1. Migration `20260929000009_essays_v6.sql` (after 4.1):

   ```sql
   alter table public.essays
     add column if not exists essay_kind text not null default 'supplement'
       check (essay_kind in ('personal-statement','supplement','other')),
     add column if not exists student_college_id    uuid references public.student_colleges(id)    on delete set null,
     add column if not exists college_supplement_id uuid references public.college_supplements(id) on delete set null,
     add column if not exists document_id           uuid references public.documents(id)           on delete set null,
     add column if not exists text_status text not null default 'read'
       check (text_status in ('pending','read','unreadable')),
     add column if not exists text_synced_at timestamptz;
   alter table public.essays alter column title drop not null;
   create index if not exists essays_student_college_idx on public.essays (student_college_id) where student_college_id is not null;
   create index if not exists essays_document_idx on public.essays (document_id) where document_id is not null;

   -- Word counts are the database's, like award_letters.net_price_cents.
   create or replace function private.essays_set_word_count()
   returns trigger language plpgsql set search_path to 'private','public' as $$
   begin
     new.word_count := case when new.body is null or new.body !~ '\S' then 0
       else array_length(regexp_split_to_array(regexp_replace(new.body, '^\s+|\s+$', '', 'g'), '\s+'), 1) end;
     return new;
   end $$;
   revoke all on function private.essays_set_word_count() from public, anon, authenticated;
   create trigger essays_set_word_count before insert or update of body on public.essays
     for each row execute function private.essays_set_word_count();
   create trigger essay_versions_set_word_count before insert or update of body on public.essay_versions
     for each row execute function private.essays_set_word_count();
   -- Recount existing rows once (this also bumps updated_at through set_updated_at).
   update public.essays set word_count = case when body is null or body !~ '\S' then 0
     else array_length(regexp_split_to_array(regexp_replace(body, '^\s+|\s+$', '', 'g'), '\s+'), 1) end;

   -- Links stay inside one student (an FK check bypasses RLS).
   create or replace function private.essays_links_same_student()
   returns trigger language plpgsql security definer set search_path to 'private','public' as $$
   begin
     if new.student_college_id is not null and not exists (
          select 1 from public.student_colleges where id = new.student_college_id and student_id = new.student_id) then
       raise exception 'That school is not on this student''s list' using errcode = '23514';
     end if;
     if new.document_id is not null and not exists (
          select 1 from public.documents where id = new.document_id and student_id = new.student_id) then
       raise exception 'That document is not filed to this student' using errcode = '23514';
     end if;
     if new.college_supplement_id is not null and new.student_college_id is not null and not exists (
          select 1 from public.college_supplements cs join public.student_colleges sc on sc.college_id = cs.college_id
           where cs.id = new.college_supplement_id and sc.id = new.student_college_id) then
       raise exception 'That prompt belongs to a different school' using errcode = '23514';
     end if;
     return new;
   end $$;
   revoke all on function private.essays_links_same_student() from public, anon, authenticated;
   create trigger essays_links_same_student
     before insert or update of student_college_id, document_id, college_supplement_id
     on public.essays for each row execute function private.essays_links_same_student();

   -- Backfill from the free-text columns.
   update public.essays set essay_kind = 'personal-statement'
    where (school is null or btrim(school) = '') and title ~* 'personal statement|common app';
   update public.essays e set student_college_id = sc.id
     from public.student_colleges sc
    where sc.student_id = e.student_id and e.student_college_id is null
      and e.school is not null and lower(btrim(e.school)) = lower(sc.name);
   ```

   Normalise non-breaking spaces to plain spaces on ingest so Postgres `\s` and JS `\s` agree.
2. `essayBody` (`records.ts:79-92`): **remove `word_count`** (the trigger owns it); add `essay_kind`, `student_college_id`, `college_supplement_id`, `document_id` (`z.string().uuid().nullable().optional()`); `title` nullable. `beforeWrite`: with `college_supplement_id`, default `title`, `prompt`, `word_limit` and `school` from the supplement; with `essay_kind = 'personal-statement'`, default `title = "Personal Statement"` and `word_limit = 650`; a supplement without a prompt defaults `word_limit` to the school's largest supplement limit, else 350.
3. Collection `select` on `/essays` and in `GET /students/:id`: `"*, document:documents(id, filename, mime_type, source, external_provider, external_web_url, available_to_llm, parse_status)"`.
4. `toEssay` (`serialize.ts:112-123`), legacy fields kept, plus: `essayKind`, `studentCollegeId`, `collegeSupplementId`, `documentId`, `source` (`gdoc` when `external_provider = 'google'`, `word` when `microsoft`, else `upload`), `url` (`external_web_url`, the real Docs / Word link; null for uploads), `fileKind` (`google-doc`, `word`, `pdf`, `image`, `other`), `textStatus`, `readable` (`text_status !== 'unreadable'`), `excerpt` (first 800 characters; the full body stays off the profile payload).
5. `be:src/lib/documentText.ts` (new): port `demo:lib/readDocument.ts` to Node (`Buffer`, `DataView` for the zip central directory, `zlib.inflateRawSync` for method 8). Handles `.txt`, `.md`, `.docx`; returns null for PDFs and scans (`text_status = 'unreadable'`). Fix the comment at `suiteApi.ts:336-340`.
6. `POST /essays/from-document` (new, `limit("essays:from-document", 60, 60)`), body `{ studentId, documentId, essayKind?, studentCollegeId?, collegeSupplementId?, title? }.strict()`: resolve the student for edit, load the document (same student), read its text (`parsed_data.text`; else a Google doc via `exportGoogleDocText`; else a Microsoft `.docx` via `downloadRemoteFile` plus `documentText`; else the Storage object plus `documentText`), insert the essay with `body` and `text_status`, return `toEssay`.
7. `POST /integrations/:provider/files/import` (`importBody`, `integrations.ts:80-94`) gains an optional `essay: { kind, studentCollegeId?, collegeSupplementId?, title? }`; after the document insert, run the same essay creation, so one call does both. Extract `.docx` text from OneDrive too.
8. `POST /essays/sync` (new), body `{ studentId }`, `limit("essays:sync", 20, 60)`, at most 25 linked documents per call at concurrency 4 (as `liveDocuments.ts` does): for essays whose document has an `external_*` pointer, compare the provider's `modifiedAt` with `text_synced_at`, re-read the text when newer, update `essays.body` (the trigger recounts), `text_synced_at` and `documents.external_modified_at`. The app calls it when the Essays popup opens.
9. `GET /files/documents` embeds `essays(id, word_count, word_limit, essay_kind, text_status)`; `toDocument` gains `essayBudget: { used, limit, label } | null` computed like the demo's `budgetFor` (skip unreadable essays; sum words and limits; label "Supplements" for more than one, else "Personal statement" or "Supplement"; null when no essay is linked).
10. `DELETE /files/documents/:id`: also delete essays with `document_id = id` when `documents.source = 'upload'` (the demo drops an uploaded essay with its file and keeps suite ones).
11. **AI gating (D22).** `/ai/essay-advice` (`ai.ts:306-330`), `/ai/draft-quality` (`:363-380`), `/ai/essay-review` (`:738-760`) and `tasks.ts` `loadEssayBody` (`:966-973`) join `document:documents(available_to_llm)` and refuse or skip when it is false.

**Done when.**
- [ ] An imported Google Doc and an uploaded `.docx` each produce an essay whose word count matches its text, and the Files row shows the same count.
- [ ] `word_count` can no longer be set by a client.

### Step 4.4 [backend] Seed generator repair and v6 catalog seed

**Today.** `be:scripts/seed/generate-catalog.ts:194-197` imports `llmTools.COMBINED_PROGRAMS`, `llmTools.POC_PROGRAMS` and `moduleData.POLICY_UPDATES`. v6 deleted all three (they exist at demo `47b8688`; `POC_PROGRAMS` became `PROGRAMS` in `demo:lib/programs.ts` with a different shape), so the `.map` calls at `:840, 844, 846` throw. The committed `20260923000001_seed_catalog.sql` still applies; only regeneration fails. `testPolicy()` (`:283-288`) throws on "Test flexible". The seed inserts with `on conflict do nothing`, so it never updates rows that exist.

**Do.**

1. Freeze the v5 sections: move the combined-programs, POC-programs and policy-updates emitters into `scripts/seed/generate-catalog-v5.ts`, reading from a demo checkout at `47b8688` (`git -C ../meridies-demo worktree add ../meridies-demo-v5 47b8688`, then `MERIDIES_DEMO_DIR=../meridies-demo-v5`). The committed SQL does not change.
2. Add `scripts/seed/generate-catalog-v6.ts`, which reads the current demo and emits **new** migrations with UPDATEs guarded by `is null` and INSERTs guarded by `on conflict ... do nothing`:
   - `20260929000010_seed_v6_catalog.sql`: `colleges.application_fee_cents` from `applicationFee`, the "Test flexible" mapping, and `college_supplements` rows from each college's `supplements` (prompt without "(250 words)", `word_limit` from it, `title` from `demo:lib/essays.ts:88-97` `SUPPLEMENT_TITLES`). `source_verified_at` stays null, as the seed's own rules require.
   - Steps 6.2 and 7.3 add their own emitters (profile facts; program and college geography).
3. The generator's roster-name assertion (`assertNoRosterNames`) runs on every new text field.
4. Caveat for the supplements: the real UC Personal Insight Questions are 8 system-wide prompts, of which a student picks 4. The demo seeds 4 on Berkeley only. Seed what the demo states now; model all eight later as `required = false` rows or through a `colleges.application_system` column so every UC campus shares one prompt set (the demo's `isUcCampus` grouping).
5. `be:AGENTS.md` catalog-seed paragraph: describe the v5 / v6 split and the worktree command.

**Done when.**
- [ ] `MERIDIES_DEMO_DIR=../meridies-demo npx tsx scripts/seed/generate-catalog-v6.ts` runs clean against the v6 demo.

### Step 4.5 [app] Student record context and API client

1. `lib/api.ts` types (replacing `ProfileCollege` `:41-48`, `ProfileActivity` `:30-35`, `ProfileAward` `:37`, `ProfileEssay` `:39`):
   ```ts
   export type ApplicationRound = "ED" | "ED2" | "EA" | "REA" | "SCEA" | "RD" | "rolling" | "priority";
   export type ApplicationStatus = "not-started" | "in-progress" | "submitted" | "accepted" | "denied"
     | "waitlisted" | "deferred" | "enrolled" | "withdrawn";
   export type TestingPolicy = "required" | "optional" | "flexible" | "blind";
   export type ProfileCollege = {
     id: string; collegeId: string | null; name: string; initials: string; color: string;
     round: ApplicationRound | null; fit: CollegeFit | null; status: ApplicationStatus; binding: boolean;
     deadline: string | null; customDeadline: string | null; intendedMajor: string | null;
     recsRequired: number | null; recsInHand: number | null;
     testing: TestingPolicy | "recommended" | null; testingOverridden: boolean;
     applicationFeeCents: number | null; supplementCount: number; notes: string; sortOrder: number;
   };
   export type GradeLevel = "9" | "10" | "11" | "12" | "PG";
   export type ActivityTiming = "school" | "break" | "year";
   export type UcActivityCategory = "coursework-other" | "educational-prep" | "extracurricular" | "volunteer" | "work";
   export type RecognitionLevel = "school" | "state-regional" | "national" | "international";
   export type UcAwardLevel = "school" | "city-community" | "state" | "regional" | "national" | "international";
   export type ProfileActivity = { id: string; name: string; role: string; commitment: string; position: string;
     organization: string; category: string | null; gradeLevels: GradeLevel[]; timing: ActivityTiming | null;
     hoursPerWeek: number | null; weeksPerYear: number | null; continuing: boolean | null; description: string;
     ucCategory: UcActivityCategory | null; ucOrgDescription: string; ucDescription: string; sortOrder: number };
   export type ProfileAward = { id: string; name: string; level: string; year: string; gradeLevels: GradeLevel[];
     recognitionLevels: RecognitionLevel[]; ucType: "academic" | "non-academic" | null; ucLevel: UcAwardLevel | null;
     ucEligibility: string; ucAchievement: string; sortOrder: number };
   export type EssayKind = "personal-statement" | "supplement" | "other";
   export type ProfileEssay = { id: string; title: string; prompt: string; school: string; words: string;
     wordCount: number; wordLimit: number | null; status: EssayStatus; dueDate: string | null; updatedAt: string;
     essayKind: EssayKind; studentCollegeId: string | null; collegeSupplementId: string | null;
     documentId: string | null; source: "gdoc" | "word" | "upload"; url: string | null;
     fileKind: "google-doc" | "word" | "pdf" | "image" | "other";
     textStatus: "pending" | "read" | "unreadable"; readable: boolean; excerpt: string };
   export type CollegeSupplement = { id: string; collegeId: string; title: string; prompt: string;
     wordLimit: number | null; required: boolean; sortOrder: number };
   ```
   Functions (snake_case bodies, matching the collection zod): `getStudentColleges`, `addStudentCollege`, `updateStudentCollege`, `removeStudentCollege`; `getActivities`, `createActivity`, `updateActivity`, `deleteActivity`; `getAwards`, `createAward`, `updateAward`, `deleteAward`; `getEssays`, `createEssay`, `updateEssay`, `deleteEssay`, `createEssayFromDocument`, `syncEssays`. `CollegeDetail.supplements: CollegeSupplement[]`. `RemoteFileImport` gains `essay?`. `StoredDocument` gains `essayBudget`.
2. Server action `importEssayFromSuiteAction(provider, input)` returning `ActionResult<{ document; essay }>`.
3. `lib/student-record-context.tsx` (new): a client context seeded from the page's `StudentDetail.profile` (colleges, activities, awards, essays), with optimistic `update*` helpers that call `lib/api.ts` and roll back with a toast on failure. The College list, sheets, Essays, the composer's suggestions (Step 5.6) and the Coherence panel (Step 7.9) read from it.
4. Update the readers of the changed DTOs: `StudentProfileSelf.tsx:125-172, 230-258` (round label, formatted date, new activity fields), `lib/profileDisplay.ts:51-60`, `StudentDashboardClient.tsx:44-92, 157`, `StudentCommunication.tsx:189, 206, 425-426, 800-801`, and the app intake option lists in `lib/aggregator.ts:233-286` (`pg` to `PG`, "Work (Paid)" to "Work (paid)", award level `state` to `state-regional`).

### Step 4.6 [app] College list popup (TODOv6 Step 6)

**Demo reference.** `demo:components/student/CollegeListSheet.tsx`, `demo:components/student/InlineEdit.tsx`, `demo:lib/collegeList.ts`.

**Do.**

1. `lib/collegeList.ts` (app version, no store): `ROUND_LABEL` (`ED` "ED", `ED2` "ED II", `EA` "EA", `REA` "REA", `SCEA` "SCEA", `RD` "RD", `rolling` "Rolling", `priority` "Priority"; offer the demo's seven and show `priority` only when stored); `TESTING_LABEL` ("Test required", "Test optional", "Test flexible", "Test blind", "Test recommended"); `APPLICATION_STATUS_META` (the demo's three: Not started `#64736a/#f0f1f2/#9aa5a0`, In progress `#2563a8/#e3eefa/#3b82c4`, Submitted `#176b45/#e4f4ea/#2e9a61`, plus labels for the decision statuses); `recsOptions()` mapping "{inHand} of {required} in hand" and "Not required" to `{ recs_required, recs_in_hand }`; `roundTone` (ED* `#a13a24/#fbe9e4`, EA/REA/SCEA `#a9660f/#fbf0dd`, else `#5b635d/#f0f1f2`); `isLate(row)` (custom deadline on or after the school deadline); `isCustomOverdue(row, today)` (custom date passed and not submitted, on the real date); `sameSchool(a, b)` by `collegeId` or lower-cased name.
2. `components/student/CollegeListSheet.tsx` (new), props `{ colleges, onUpdate(id, patch), waiverEligible: boolean | null, onOpenEssays(studentCollegeId) }`:
   - shared grid `minmax(14.5rem,1.7fr) 4.75rem 5.5rem 6.75rem minmax(9rem,1.2fr) 6rem 8rem 7.5rem 5.5rem 7rem`, container `min-w-[81rem]`, sticky header;
   - headings: School, Round, Deadline, **Custom deadline**, Intended major, Supplements, Recommendations, Testing, Fee, Status;
   - rows zebra `even:bg-muted/30`, `hover:bg-accent/20`; no row link overlay;
   - cells: **School** avatar, name as a link to `/dashboard/counselor/colleges/{collegeId}` (plain text when not in the catalog), and the fit `InlineSelect` badge (Reach / Target / Likely, empty when null); **Round** `InlineSelect` tone pill; **Deadline** and **Custom deadline** `InlineDate` shown as "Nov 1", custom in `text-danger` when `isLate || isCustomOverdue`, else `text-primary`, with no added text; **Intended major** `InlineText` (em dash placeholder when null; do not fall back to the profile's first major); **Supplements** the count (or the placeholder) and a `FileText` button (aria "{name} supplemental essays") calling `onOpenEssays`; **Recommendations** `InlineSelect` over `recsOptions()`; **Testing** `InlineSelect` (append an unknown stored value as an option); **Fee** `InlineNumber prefix="$"` (display dollars, commit cents) plus a green "waiver" mark when `waiverEligible` (from `getAidProfile().sai_estimate <= 0`; no mark when SAI is null); **Status** `InlineSelect` badge with a dot;
   - every edit is optimistic through the record context;
   - empty: `EmptyState icon={GraduationCap} title="No colleges on the list yet"`.
3. Mount in the icon row: `<Modal title="College list" size="lg">`. Delete `CollegeListCard` (`StudentProfileClient.tsx:1353-1402`).

**Done when.**
- [ ] The column reads "Custom deadline", there is no footer caption, and each cell edits with its own control and survives reload.

### Step 4.7 [app] Activities list and Awards & honors popups (TODOv6 Step 7)

**Demo reference.** `demo:components/student/ApplicationSheets.tsx`, `demo:lib/applicationSheets.ts`.

**Do.**

1. `lib/applicationSheets.ts` (app): the option lists as `{ value, label }`: `ACTIVITY_TYPES` (the 27, value = label); `GRADE_OPTS` (9 "9th" ... PG "Post-grad"); `WHEN_OPTS` (school "School", break "Break", year "Year"); `CONTINUE_OPTS` (true "Yes", false "No"); `UC_ACTIVITY_CATEGORIES` (codes to "Coursework other than A-G", "Educational preparation program", "Extracurricular activity", "Volunteer / community service", "Work experience"); `UC_ORG_DESCRIBED = ["volunteer", "work"]`; `COMMON_APP_LEVELS` (school "School", state-regional "State/Regional", national "National", international "International"); `UC_LEVELS` (six); `UC_AWARD_TYPES` (Academic, Non-academic). Port `SHEET_LIMITS = { position: 50, organization: 100, description: 150, honorTitle: 100, ucDescription: 350, ucOrgDescription: 250, ucEligibility: 250, ucAchievement: 350 }`, `FORM_CAPS = { commonAppActivities: 10, commonAppHonors: 5, ucEntries: 20 }` and `gradeRange` ("10th to 12th", "9th, 11th", "Post-grad").
2. `components/student/ApplicationSheets.tsx` (new), porting `FormSwitch` (`role="radiogroup" aria-label="Application"`, "Common App" / "UC"), `CharCount`, `Sheet`, `Toolbar` (switch plus `CountPill "{used} / {cap}"`), `ActivitiesSheet`, `HonorsSheet`:
   - `Sheet`: grid `2.25rem {cols} 1.75rem`; header `bg-muted/50 border-border/70`, headings 10.5 px uppercase with the limit in small type under them; rows `border-border/40` alternating `bg-muted/45` and `bg-card`; bold row numbers; hover-only delete (aria "Remove row N"); bottom "+ Add activity" / "+ Add honor", disabled at the cap.
   - Activities, Common App: # · Category (select, 27) · Years (multi, shown with `gradeRange`) · When · Hr/wk (number, max 168, right-aligned) · Wk/yr (max 52) · "Plan to continue in college?" · "Position / leadership" (50) · Organization (100) · "Activity description" (150) · "Char count". `min-width 74rem`. Cap: 10 rows.
   - Activities, UC: # · "UC category" (5) · "Organization / program / course" (the same `organization` field, no limit) · "About the organization" (250, editable only for volunteer and work, otherwise the placeholder) · "What did you do?" (350) · Years · Hr/wk · Wk/yr · "Char count". `min-width 70rem`. Cap: activities plus honors at 20, shown "N / 20".
   - Honors, Common App: "Name of honor" (100) · "Grade level" (multi) · "Level of recognition" (multi, 4) · Char count. `min-width 48rem`. Rows past five take a warm tint (`bg-warning-bg/60`, not the demo's hex); add is disabled at 10.
   - Honors, UC: "Name of award" (same `name`) · Type · "Level of recognition" (single, 6) · "Grade level" · "Eligibility requirements" (250) · "What did you do to achieve it?" (350) · Char count. `min-width 72rem`.
   - Each form's text lives in its own columns; switching forms keeps the rows. Every edit goes through the record context (camelCase to snake_case).
3. Mount `<Modal title="Activities list" size="lg">` and `<Modal title="Awards & honors" size="lg">`. Delete the Activities tab body (`StudentProfileClient.tsx:463-516`, awards card `:479-513`), the local `ActivitiesSheet` with `SHEET_COLUMNS` / `COLUMN_LETTERS` (`:1537-1622`) and the "Upload spreadsheet" / "Descriptions · 150 characters each" bits.
4. Do not add "Draft with AxIS", "Improve description" or "Rewrite" to any description cell (essay guardrail).

**Done when.**
- [ ] Both popups follow the p. 7 and p. 8 sheets (numbered rows, zebra, faint lines, dropdowns where the brief lists options, every text cell editable), the switch swaps columns and limits and keeps rows, and edits survive reload.

### Step 4.8 [app] Essays popup and Files word budgets (TODOv6 Step 8)

**Demo reference.** `demo:components/student/EssaysPanel.tsx`, `demo:lib/essays.ts:344-382`.

**Do.**

1. `lib/readDocument.ts`: port verbatim, used only for an instant count on a computer upload while the server call runs (the server stays authoritative).
2. `lib/essays.ts` (app): `essayGroups(colleges, essays)` ported from `schoolGroups` (group by `studentCollegeId` in list order; UC campuses merge into one group with heading "UC Berkeley · UCLA" via the ported `isUcCampus`; a trailing "Other documents" group for supplements with no school); `inferTarget(filename, colleges)` ported (statement for `personal statement|common app|\bps\b`, a school by whole-word name match, the first UC campus for `\bpiq\b|personal insight`, else "Other documents"); `budgetLabel`.
3. `components/student/EssaysPanel.tsx` (new), props `{ studentId, studentName, focus?: string | null, onToast }`:
   - on open, call `syncEssays` and update the context;
   - layout `space-y-8`: "Personal Statement" h3 (14 px semibold) with an **Upload** button on the right; its cards; then the school groups in `flex flex-wrap items-start gap-x-8 gap-y-8`, each a `<section>` with its heading and cards in `flex flex-wrap gap-3`;
   - card (150 × 204 px, `h-[12.75rem] w-[9.375rem]`): a 144 px top showing a white page with the first lines of `excerpt` in small serif type (placeholder lines when empty; a large provider glyph when unreadable; the image for an image upload); a bottom strip with the title (one line) and the glyph plus "{used} / {limit}" in the `toneFor` colour ("— / {limit}" muted when unreadable); `aria-label="{title}, {used} of {limit} words"`. No hover lift or coloured shadow;
   - clicking a card with a `url` opens it in a new tab (`target="_blank" rel="noopener noreferrer"`); an upload without a url opens `FilePreview` (Step 6.6);
   - for each supplement prompt of a listed school with no essay yet, a "not started" card from `college_supplements` (title, `0 / limit`) that opens the Upload menu targeted at that prompt. The dashed "+" card appears only when a group has neither prompts nor essays. Do not create empty essay rows for prompts;
   - Upload menu (`Anchored`, `role="menu"`, "Upload from"): **From computer** (hidden `<input type="file" multiple accept=".docx,.doc,.txt,.md,.pdf">`, then `uploadStudentDocument(token, file, { studentId, kind: "essay" })`, then `createEssayFromDocument`), **Google Drive** and **OneDrive** (render `RemoteFilePicker` with a new `essay` prop forwarded to the import). A suite without tokens (`getIntegrationProviders().tokensHeld`) shows "Connect", which starts `startIntegrationConnectAction`;
   - toasts: "{filename} added to {heading}, and to {first}'s folder in Files." / "{n} documents added, and filed in {first}'s folder in Files.";
   - `focus` (a `studentCollegeId`) scrolls that group into view and flashes a ring for 1.6 s.
4. Mount `<Modal title="Essays" size="lg">`; the College list's supplements button sets `focus`. Delete `EssaysCard` (`StudentProfileClient.tsx:1404-1439`). Keep essay `status` (the dashboard and profile display read it).
5. Files budgets: add a chip "{used} / {limit}" in `TONE_CLASS[toneFor()]` from `doc.essayBudget` to the rows in `StudentFiles.tsx` and `FolderBrowser.tsx`.
6. No guardrail caption here; this popup reads no prose with AI.

**Done when.**
- [ ] Personal Statement comes first, then one heading per school on the list with cards on an even grid and wider gaps between schools.
- [ ] Each card shows a name and a word count computed from its text, and the Files row shows the same count.
- [ ] Upload adds a card; clicking a Docs or Word card opens that document.

---

## Phase 5: Communication composer and referrals

TODOv6 Steps 10 and 15. In the demo the Communication popup is a single composer: a Parent | {first name} toggle, an Email | Text toggle in the student view, editable From / To / Subject, "/" or the logo opens a green AxIS bar whose placeholder cycles through suggestions (Tab accepts, Enter runs), and a toolbar with Send ▾ (Send, Schedule send, File as family report). Send is a `mailto:` or `sms:` link there. In the app it has to send for real.

**Today.** No backend route sends a one-to-one message a counselor wrote. The real outbound paths are `POST /accountability/parent-alerts` (family only, throttled, one guardian), `POST /blasts`, invites and task notifications. Nothing delivers `parent_alerts` left `scheduled` (quiet hours) or `queued` (sweep): `lib/parentAlertDelivery.ts:18-21` says "a scheduled sender can reuse it", and none exists. `nextSendWindow` (`be:src/lib/accountability.ts:391-396`) uses server-local `setHours` instead of `settings.timezone`. No AI route drafts a free-form parent or student message. `/ai/family-report` writes a `family_reports` row on every call, and the app's "Open with a family report" button triggers that as a side effect (`app:StudentCommunication.tsx:645-670`). The app has no guardian management at all, so production parent alerts fail with "No guardian on file" unless rows were inserted by hand.

### Step 5.1 [backend] Composer schema: messages, prefs, multi-guardian alerts

**Do.** Migration `20260929000011_composer_messages.sql` (after Step 0.1):

```sql
-- 1. Composer memory beside the fail-closed delivery gates (D23). The demo's lib/alertPrefs.ts
--    changed meaning in v6 to {audience, channel}; copy_parents / copy_student keep theirs.
alter table public.student_alert_prefs
  add column if not exists composer_audience text not null default 'parent'
    check (composer_audience in ('parent','student')),
  add column if not exists student_channel text not null default 'email'
    check (student_channel in ('email','sms'));

-- 2. One-to-one counselor messages. Not parent_alerts: those rows feed the alert throttle,
--    and a family update must not block a real alert.
create table if not exists public.outbound_messages (
  id              uuid primary key default gen_random_uuid(),
  counselor_id    uuid not null references public.profiles(id) on delete cascade,
  student_id      uuid not null references public.profiles(id) on delete cascade,
  audience        text not null check (audience in ('parent','student')),
  channel         text not null check (channel in ('email','sms')),
  purpose         text not null default 'other' check (purpose in ('family-update','aid','meeting',
                    'referral-ask','deadline-reminder','open-tasks','essay-start','other')),
  subject         text check (length(subject) <= 300),
  body            text not null check (length(btrim(body)) between 1 and 20000),
  guardian_ids    uuid[] not null default '{}',      -- frozen when queued
  include_student boolean not null default false,
  reply_to        text check (length(reply_to) <= 320),
  attachment_ids  uuid[] not null default '{}',      -- public.documents ids
  ai_drafted      boolean not null default false,
  status          text not null default 'queued' check (status in
                    ('scheduled','queued','sending','sent','partial','failed','cancelled')),
  send_at         timestamptz,
  sent_at         timestamptz,
  cancelled_at    timestamptz,
  error           text check (length(error) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint outbound_messages_parent_is_email   check (audience = 'student' or channel = 'email'),
  constraint outbound_messages_email_has_subject check (channel = 'sms' or length(btrim(coalesce(subject, ''))) > 0),
  constraint outbound_messages_sms_length        check (channel = 'email' or length(body) <= 1600),
  constraint outbound_messages_sms_no_attach     check (channel = 'email' or cardinality(attachment_ids) = 0),
  constraint outbound_messages_has_recipient     check (cardinality(guardian_ids) > 0 or include_student),
  constraint outbound_messages_audience_matches  check (
    (audience = 'parent' and not include_student) or (audience = 'student' and cardinality(guardian_ids) = 0)),
  constraint outbound_messages_scheduled_has_time check (status <> 'scheduled' or send_at is not null)
);
create index outbound_messages_student_idx on public.outbound_messages (student_id, created_at desc);
create index outbound_messages_due_idx on public.outbound_messages (send_at) where status = 'scheduled';
create trigger outbound_messages_set_updated_at before update on public.outbound_messages
  for each row execute function public.set_updated_at();
alter table public.outbound_messages enable row level security;
create policy outbound_messages_counselor on public.outbound_messages
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (counselor_id = (select auth.uid()) and private.is_counselor_of(student_id, (select auth.uid())));

alter table public.message_deliveries
  add column if not exists outbound_message_id uuid references public.outbound_messages(id) on delete set null;
create index if not exists message_deliveries_outbound_idx on public.message_deliveries (outbound_message_id);

-- 3. Parent-view alerts go to every chosen guardian, not one.
alter table public.parent_alerts add column if not exists guardian_ids uuid[] not null default '{}';
alter table public.parent_alerts drop constraint if exists parent_alerts_has_a_recipient;
alter table public.parent_alerts add constraint parent_alerts_has_a_recipient
  check (guardian_id is not null or cardinality(guardian_ids) > 0 or copy_student);

-- 4. Audit module for the composer draft (keep in step with AiModule).
alter table public.ai_runs drop constraint if exists ai_runs_module_check;
alter table public.ai_runs add constraint ai_runs_module_check check (module in (
  'profile-summary','narrative-coherence','family-report','school-reframing',
  'college-list','college-fit','concierge','scholarship-match','award-appeal',
  'aid-report','draft-quality','essay-advice','visualizer','chat',
  'document-tracker','essay-review','link-digest','parent-alert','file-filing',
  'composer-draft'));
```

Add `"composer-draft"` to `AiModule` in `be:src/lib/anthropic.ts:34-41`.

### Step 5.2 [backend] Messages: send, schedule, cancel, dispatcher

**Do.**

1. `GET` / `PUT /accountability/alert-prefs` (`accountability.ts:150-220`): PUT zod gains `composerAudience?: z.enum(["parent","student"])` and `studentChannel?: z.enum(["email","sms"])`; `toAlertPref` (`serialize.ts:664-671`) returns both; the GET default returns `"parent"` / `"email"`. Writes stay counselor-only; a read error still throws.
2. `sendEmail` (`be:src/lib/email.ts:84-146`): add `replyTo`, `attachments` (bytes plus filename plus content type) and an `outboundMessageId` written to `message_deliveries`. Add a `composerEmail()` template that escapes the text, then renders `**bold**`, `_italic_`, lines starting with "• " as a list, and bare `https?://` links. SMS strips the markers. Optionally `OUTBOUND_FROM_EMAIL`, defaulting to `INVITE_FROM_EMAIL`.
3. `GET /messages/senders` (new, counselor): `{ email: { from, replyTo, available, unavailableReason }, sms: { from, available, unavailableReason } }`. `sms.from` is the E.164 sender, never the Messaging Service SID. The composer's From shows these values, or the em dash placeholder with the reason. This replaces the demo's `PRACTICE_PHONE`.
4. `POST /messages` (new): preHandler `app.authenticate`, `requireRole("counselor")`, `limit("messages:send", 30, 3600)`, plus `enforceQuota(userId, "messages", "day", 150)`. Body:
   ```ts
   z.object({
     studentId: z.string().uuid(),
     audience: z.enum(["parent","student"]),
     channel: z.enum(["email","sms"]),
     guardianIds: z.array(z.string().uuid()).min(1).max(10).optional(),
     subject: z.string().trim().min(1).max(300).optional(),
     body: z.string().trim().min(1).max(20000),
     replyTo: z.string().trim().toLowerCase().email().max(320).optional(),
     attachmentIds: z.array(z.string().uuid()).max(10).optional(),
     purpose: z.enum(["family-update","aid","meeting","referral-ask","deadline-reminder","open-tasks","essay-start","other"]).default("other"),
     sendAt: z.string().datetime({ offset: true }).optional(),
     overrideQuietHours: z.boolean().optional(),
     aiDrafted: z.boolean().optional(),
   }).strict().superRefine(/* parent => email; email => subject; sms => body <= 1600 and no attachments;
                              sendAt in the future and within 60 days */)
   ```
   Rules:
   - Authorize with `resolveStudentId(request, studentId, "edit")`.
   - **Recipients come from ids, never from typed addresses**, so the route cannot become an open relay. Guardians: `.eq("student_id", studentId).in("id", guardianIds).eq("receives_reports", true)` with an email present; any ineligible id is a 400 naming who. Student: `profiles.email` / `profiles.phone`.
   - **Fail closed** through `loadAlertPrefs`: a read error refuses; a parent send when `copy_parents = false` is a 400 "Parents are switched off for {first}". The student audience is not gated by `copy_student` (that flag means "copy the student on alerts").
   - `replyTo` must equal the caller's own email (D24). The `from` stays the verified sender.
   - An SMS inside `inQuietHours(settings)` without `overrideQuietHours` becomes `scheduled` at the next window **computed in `settings.timezone`**. Email is not held. `sendAt` makes it `scheduled`. The alert throttle does not apply (alerts use their own route).
   - Otherwise deliver in-request: one email per guardian (D25) through `sendEmail`, or `sendSms`; write `message_deliveries.outbound_message_id`; set the status truthfully: `sent`, `partial`, `failed`, or `queued` (SMS provider not configured).
   - Attachments: only `documents` rows whose `student_id` matches, downloaded from Storage, total capped around 10 MB.
   - `purpose: "referral-ask"` with a resulting status of `sent`, `scheduled` or `queued` upserts the open `referrals` row (Step 5.4).
   - Response `{ message, status, blockedReason, delivery: { attempts[] } }`, the same shape as parent alerts.
5. `GET /messages?studentId=&status=` (new, counselor, `limit("messages:list", 120, 60)`, up to 200 rows) and `POST /messages/:id/cancel` (conditional `scheduled` to `cancelled`; deletes a linked referral still `asked` with `ask_message_id = id`).
6. Dispatcher: `POST /internal/messages/dispatch` behind `requireCronSecret`, plus an optional in-process `MESSAGE_DISPATCH_INTERVAL_MINUTES` like `SWEEP_INTERVAL_MINUTES`. Takes the `acquire_job_lease("message-dispatch")` lease, uses `serviceClient()`, claims due `outbound_messages` (`scheduled`, `send_at <= now()`) with a conditional update to `sending`, and **also delivers `parent_alerts` in `scheduled` / `queued` with `scheduled_for <= now()`** (the pre-existing gap). Re-check guardian opt-outs (they can only narrow the list) and `loadAlertPrefs` (an error holds the message; it never defaults). Re-hold an SMS inside quiet hours. One `audit_log` row per run. Document the Railway cron next to the sweep in `be:AGENTS.md`.
7. Fix `nextSendWindow` to compute in `settings.timezone`.
8. `POST /accountability/parent-alerts` accepts `guardianIds?: uuid[] <= 10` and `sendAt?`; `resolveAlertRecipients` returns every eligible guardian (`alerts_enabled`) intersected with the requested ids, frozen into `guardian_ids`; `deliverParentAlert` loops over them. Throttle, quiet hours and fail-closed prefs stay as they are.

**Done when.**
- [ ] A counselor can send an email to two guardians and a text to the student, and the response reports each delivery's true status.
- [ ] A scheduled email goes out when the dispatcher runs, and a cancelled one does not.
- [ ] A parent alert held by quiet hours is delivered when the window opens.

### Step 5.3 [backend] `/ai/compose` draft route

**Do.** `POST /ai/compose` (new), drafts only:

- preHandler `aiLimit("composer-draft")` (20/min); `runStructured` adds the 300/day quota and the `ai_runs` row; `requireRole("counselor")`; `resolveStudentId(edit)`.
- Body `z.object({ studentId, audience: z.enum(["parent","student"]), channel: z.enum(["email","sms"]), instruction: z.string().trim().min(1).max(500), purpose: z.enum([...]).optional(), guardianIds: z.array(z.string().uuid()).max(10).optional() }).strict()`.
- Context is built server-side, never from the client: student and guardian first names (for the greeting); open deliverables with due dates; `student_colleges` (name, round, status, deadline, custom deadline); essays as title, school, word count and status only (**no bodies**); aid form status (CSS Profile only, no FAFSA or SSN); the "behind" state from `buildBehindList`; the counselor's name and firm name for the sign-off.
- `FAST_MODEL`; output schema `{ subject <= 200, body <= 4000 }`. Returns `{ subject, body, purpose, status: "draft" }`. **Persists nothing and sends nothing.**
- SMS: flatten whitespace and clamp to 320 characters in code, as `ai.ts:995-999` does for parent alerts.
- Essay guardrail in code (the student view reaches the student directly): the system prompt forbids writing, rewriting or approximating essay prose; screen the instruction for essay-writing intent and refuse with 400 "AxIS doesn't write essays"; feed no document text to the model.
- For `purpose: "alert"` in the Parent view, the app calls the existing `/ai/parent-alert` with `context = instruction` instead.

### Step 5.4 [backend] Referrals and invitation notes (TODOv6 Step 15)

Confirm the meaning with the brief owner first (D26). The demo's reading: once a student's applications are in, the counselor asks the family for referrals and tracks each referred family through to intake.

**Do.**

1. Refactor: extract `createInvitation(db, { counselorId, email, note?, audience? })` into `be:src/lib/invites.ts` (supersede the pending one, insert, `sendInviteEmail`). Use it from `routes/invites.ts`, `routes/roster.ts:224-247` and the referral routes.
2. Migration `20260929000012_referrals_and_invitation_notes.sql`:

   ```sql
   alter table public.invitations
     add column if not exists note text check (length(note) <= 1000),
     add column if not exists audience text not null default 'student' check (audience in ('student','family'));

   create table if not exists public.referrals (
     id              uuid primary key default gen_random_uuid(),
     counselor_id    uuid not null references public.profiles(id) on delete cascade,
     from_student_id uuid not null references public.profiles(id) on delete cascade,
     family_name     text check (family_name is null or length(btrim(family_name)) between 1 and 200),
     contact_email   text check (contact_email is null or length(contact_email) <= 320),
     -- Stored status is the counselor's last move. 'signed', and the fall-back from a revoked or
     -- expired invitation, is derived from invitations in the serializer (demo referralStatus()).
     status          text not null default 'asked' check (status in ('asked','introduced','invited','signed')),
     invitation_id   uuid references public.invitations(id) on delete set null,
     ask_message_id  uuid references public.outbound_messages(id) on delete set null,
     note            text check (length(note) <= 1000),
     asked_at        timestamptz not null default now(),
     introduced_at   timestamptz,
     invited_at      timestamptz,
     created_at      timestamptz not null default now(),
     updated_at      timestamptz not null default now(),
     constraint referrals_named_once_introduced
       check (status = 'asked' or (family_name is not null and contact_email is not null))
   );
   create unique index referrals_one_open_ask on public.referrals (counselor_id, from_student_id) where status = 'asked';
   create index referrals_counselor_idx on public.referrals (counselor_id, updated_at desc);
   create index referrals_invitation_idx on public.referrals (invitation_id);
   create trigger referrals_set_updated_at before update on public.referrals
     for each row execute function public.set_updated_at();
   alter table public.referrals enable row level security;
   -- Counselor-only in both directions: business development about a family, not the student's record.
   create policy referrals_counselor on public.referrals for all to authenticated
     using (counselor_id = (select auth.uid()))
     with check (counselor_id = (select auth.uid()) and private.is_counselor_of(from_student_id, (select auth.uid())));
   ```

3. `be:src/routes/referrals.ts` (new, prefix `/referrals`, counselor-only):
   - `GET /referrals?studentId=` (`limit("referrals:list", 120, 60)`): joins invitations, returns the **derived** status (`signed` when the invitation was accepted; `invited` while it is live; back to `introduced` or `asked` when it was revoked or expired) plus `fromStudentName`;
   - `POST /referrals` `{ studentId, familyName?, contactEmail? }` (a manual record of an ask; the composer path creates asks server-side in `POST /messages`);
   - `PATCH /referrals/:id` `{ familyName, contactEmail }`: strips a trailing "family", lower-cases the email, sets `introduced`, `introduced_at`, clears `invitation_id`; errors "Add the family's name." / "Enter a valid email address.";
   - `POST /referrals/:id/invite`: `enforceQuota("invites", "day", 100)`; reuses this counselor's live pending invitation to the same email, else `createInvitation(..., { audience: "family" })`; sets `invited`, `invited_at`, `invitation_id`; 400 "Add the family's email first." when no contact;
   - `DELETE /referrals/:id`.
4. Invites: `POST /invites` gains `note?: z.string().trim().max(1000)` (included in the email) and `audience?`; it returns 409 "That student has already joined your practice." when an accepted invitation or a roster profile already has that email (it re-invites today). `GET /invites` returns `note`, `acceptedBy` (id) and `expired` (`status === 'pending' && expires_at < now`). Optional `POST /invites/:id/resend`. `sendInviteEmail` gets a `family` variant ("{counselor} invited your family to Meridies; share this link with your student"); accepting still needs a student account (`accept_invitation` requires role student).

### Step 5.5 [backend] Family report create route

`POST /reports/family` (new, counselor, `limit("family-reports:create", 60, 60)`), body `z.object({ studentId, title: 1..200, summary?: <= 4000, highlights?: <= 12 x 240, body: <= 20000, kind: z.enum(["ad-hoc","progress"]).default("ad-hoc") }).strict()`. Always inserts `status: "draft"`, which then appears in the Review drawer (`ReviewQueuePanel`). Optionally also insert a `counselor_work_items` row `kind: "report"` with `family_report_id` ("Approve the {family} family report").

### Step 5.6 [app] Communication composer (TODOv6 Step 10)

**Demo reference.** `demo:components/dashboard/StudentCommunication.tsx` (893 lines), `demo:lib/composerDrafts.ts`, `demo:lib/alertPrefs.ts`, `demo:lib/familyContacts.ts`.

**Today.** `app:components/dashboard/StudentCommunication.tsx` (1005 lines, v5): template cards Family update / Alert / Aid / Other, deterministic drafts, AI buttons, a `mailto:` to the student's own email, and panels v6 removes (context line, "Why this is a draft", "Family reports on file", Regenerate/Copy footer). `ParentAlertModal.tsx` (685 lines) is still opened from the dashboard.

**Do.**

1. `lib/api.ts`:
   - `AlertPref` gains `composerAudience: "parent" | "student"`, `studentChannel: "email" | "sms"`; `saveAlertPrefs` accepts them.
   - `MeridiesUser` / `StudentDetail` gain `phone` (Step 3.1).
   - `queueParentAlert` input gains `guardianIds?: string[]`, `sendAt?: string`.
   - New: `MessageSenders`, `getMessageSenders`; `OutboundMessage`, `MessagePurpose`, `sendMessage`, `getMessages`, `cancelMessage`; `draftComposerMessage` (`POST /ai/compose`); `createFamilyReport` (`POST /reports/family`). Guardian functions come from Step 3.5.
2. Primitives: `Anchored` and `Tooltip` (Step 1.2); the Modal stack so Escape in the AxIS bar closes only the bar; the Tab-trap `defaultPrevented` guard.
3. `lib/composerSuggestions.ts` (new), built client-side from data the page already has (the record context, tasks, alert state, aid profile presence, the current month). Port `suggestionsFor`, `nextTarget` and `TEXT_LIMIT = 320`:
   - Parent: "Ask the {family} family for a referral" (only when applications are in: at least one college and every row `submitted`, `accepted`, `denied`, `waitlisted`, `deferred` or `enrolled`); "Update the {family} family on {Month} progress"; "Alert the family about overdue work" (only with alert issues); "Explain the aid checklist to {parentFirst}" (only with an aid profile); "Ask the {family} family for a time to meet".
   - Student: "Remind {first} the {school} {round} draft is due {date}" (custom deadline) or "...deadline is {date}"; "Nudge {first} about overdue work" (with an alert); "Send {first} this week's open tasks"; "Ask {first} to start the {school}: {title} essay" (an unstarted supplement at a school not yet submitted).
   Each suggestion carries a `purpose`. Keep the app's deterministic `familyDraft` / `aidDraft` / `otherDraft` (with the FAFSA lines gone, Step 0.3) as the fallback when `/ai/compose` answers 503.
4. Rewrite `components/dashboard/StudentCommunication.tsx` as the composer, props `{ token, student, profile, counselorName, counselorEmail, firmName, tasks, redFlags, onToast }`:
   - top row: segmented "Write to" Parent | {first} (saves `composerAudience`); in the student view, segmented "Send as" Email | Text (saves `studentChannel`); the parent view is email only. Update optimistically and revert on error; a prefs read error disables Send with the reason (fail closed);
   - fields as underlined inputs: **From** (the verified sender from `getMessageSenders`, or the Twilio number in Text mode; the editable part is the reply-to, D24), **To** (Parent: guardians as chips with ×, plus an input where Enter, comma or blur commits via the ported `parseContact` and `createGuardian`, × calls `deleteGuardian` after a confirm, Backspace on empty removes the last chip; placeholder "Add a parent or guardian". Student: the student's email, or phone in Text mode; editing the phone saves through `PATCH /students/:id { phone }` explicitly), **Subject** (email only);
   - body: a large borderless textarea, placeholder "Press / to write using Meridies AxIS"; "/" on an empty line with no modifier opens the bar;
   - AxIS bar (above the toolbar): Meridies green (add a named token for it; the brief asks for Meridies green whatever the practice wears), `MeridiesMark tone="light"`, an input with placeholder "Describe what you want to write" that cycles every 3 s through the suggestions while empty, and a `Tab` key hint. Tab takes the visible suggestion; Enter runs `draftComposerMessage` (or `draftParentAlert` for the alert suggestion) with a loading state and an inline error for 429 / 503; the result fills Subject and body and remembers `purpose` until the draft is discarded; Escape closes only the bar;
   - toolbar: email mode "Send ▾" (Send; Schedule send with "Tomorrow, 8:00 AM", "Monday, 8:00 AM" computed in the counselor's `accountability_settings.timezone`, plus a custom date and time; "File as family report" in the Parent view only); text mode a round paper-plane "Send text" with a `{length} / 320` counter toned by `toneFor`; then Aa (Bold wraps `**`, Italic wraps `_`, Bulleted list), the AxIS mark (toggles the bar), attach (uploads to the student's folder via `uploadStudentDocument` and attaches by document id), link (insert a URL), emoji (16-emoji grid), Drive (the student's `source: "integration"` documents; inserts `externalWebUrl`, or opens `RemoteFilePicker` to import), image, more (Copy draft, Insert signature "Best,\n{counselor}\n{firm}", and "Alerts go to..." holding the two delivery switches from `ParentAlertModal`, D23), and a trash can on the right (Discard draft);
   - Send: the alert purpose goes to `queueParentAlert` (throttle, quiet hours and prefs apply; show `blockedReason` verbatim; offer "Send now anyway" when quiet hours hold it); everything else goes to `sendMessage`. The toast reports the true status (`lib/delivery-copy.ts`: add `describeMessageStatus`; an SMS without Twilio is "queued, not sent"). A referral ask's toast links to Invitations ("The ask is tracked under Invitations.");
   - File as family report: split the body into summary and highlights (port `reportBlocks` from `demo:lib/communication.ts`) and call `createFamilyReport`; toast "Filed as a family report. Approving it is on your work queue.";
   - the text opener and signature use the counselor or firm name, not "from Meridies" / "Meridies College Counseling".
5. Remove from the popup: the template cards (`:62-94, 718-754`), the "Other" box, the context line, "Why this is a draft", "Family reports on file", the Regenerate/Copy/mailto footer.
6. Retire `ParentAlertModal.tsx`: its dashboard mount is gone after Step 2.3; Calendar → Tasks and the student Alerts card deep-link to the composer with the alert suggestion (`/dashboard/counselor/students/{id}?compose=alert`); keep `describeParentAlertStatus`. Delete the file.
7. Mount the composer in the icon row's Communication popup (`Modal`, `max-w-4xl`), and update `StudentProfileClient` copy at `:1338-1345`.
8. Do not port: `mailto:` / `sms:` links, `PRACTICE_PHONE`, `DEMO_TODAY` presets, attachment chips that upload nothing, the `saveDraft` stores, the regex routing in `draftFor` (only as the 503 fallback, if at all), `AXIS_GREEN` hard-coded hex.

**Done when.**
- [ ] The Parent and student views switch recipients, and the student view switches between Email and Text.
- [ ] "/" or the logo opens the green AxIS bar, Tab accepts the cycling suggestion, and Enter produces a real draft in Subject and body.
- [ ] Send, Schedule send and File as family report each do what they say, and the toast reports the backend's status.

### Step 5.7 [app] Referrals on the Invitations page (TODOv6 Step 15)

**Demo reference.** `demo:app/dashboard/counselor/invitations/page.tsx`, `demo:lib/referrals.ts`.

**Do.**

1. `lib/api.ts`: `Invitation` gains `note`, `acceptedBy`, `expired`; `inviteStudent(token, email, note?)`; `resendInvitation`; `ReferralStatus`, `Referral { id, fromStudentId, fromStudentName, familyName, contactEmail, status, invitationId, askedAt, introducedAt, invitedAt, updatedAt }`; `getReferrals`, `createReferral`, `introduceReferral`, `inviteReferral`, `deleteReferral`. Server actions for each, returning `ActionResult` and revalidating `/dashboard/counselor/invitations`.
2. `InvitationsClient.tsx` (from Step 2.5): add the **Referrals** chip with its count; list open referrals (asked, introduced) first; a "Referred by" column (`{Last} family`, fixed width from `sm`; on a phone "Referred by the {Last} family");
   - referral row: handshake icon; title "Waiting on an introduction" or "{Family} family"; sub-line "Asked {date}" or "{email} · introduced {date}"; status pill (Asked, Introduced, "Invitation sent", "Joined"); **Invite** when introduced; **Add family** when asked (inline form "Family name", "parent@email.com", Save, Cancel); trash (aria "Remove the referral from the {x}"); a row error in red;
   - invitation row: the note as ` · “{note}”` on the sub-line;
   - the side form gains "Personal note (optional)" (placeholder "Looking forward to working with you this year.");
   - "Joined" links to the new student (`acceptedBy`).
3. `InviteStudentDialog`: the optional note, and `ActionResult`.
4. The composer's referral suggestion appears only in the Parent view once applications are in (Step 5.6); sending records the ask server-side.

**Done when.**
- [ ] Asking the Chen family from the composer shows an "Asked" row under Referrals; adding the family and inviting moves it to "Invitation sent"; accepting moves it to "Joined".

---

## Phase 6: College Profiles and Files

TODOv6 Steps 11 and 12, plus open question 5. v6 builds on v5 surfaces the app never ported (the photo card, the column-per-school compare, `FilingModal`, `FilePreview`, the Connections popup, the two-box Files layout), so each step here is v5 carry-over plus the v6 deltas.

### Step 6.0 [demo] Fetch the campus photos

**Today.** `demo:lib/collegePhotos.json` is `{}` and `demo:public/colleges/` holds only an empty `CREDITS.md` table. `demo:scripts/fetch-college-photos.mjs` has never been run, so every demo card shows the `photoTint` gradient.

**Do (in `meridies-demo`, the one step here that touches the demo).** Run `node scripts/fetch-college-photos.mjs` from a machine that can reach `commons.wikimedia.org` and `upload.wikimedia.org`. It keeps CC0, public domain, CC BY and CC BY-SA (never NC or ND), JPEG, landscape, source width 1600 or more, saved at 1280 px, and writes `public/colleges/<id>.jpg`, `lib/collegePhotos.json` and `public/colleges/CREDITS.md`. Review every photo by hand as the script header asks (a recognisable campus exterior, no close-ups of identifiable students; use the per-college `pick` override to swap one), then commit.

Until this lands, Steps 6.1 and 6.5 ship with null photo columns and the app shows the tint fallback.

### Step 6.1 [backend] College photos: columns, bucket, seed, upload

**Do.**

1. Migration `20260929000013_college_photos.sql` (D27):

   ```sql
   alter table public.colleges
     add column if not exists photo_path         text,  -- object key in bucket college-photos, e.g. 'stanford.jpg'
     add column if not exists photo_alt          text,
     add column if not exists photo_credit       text,  -- Commons artist, HTML stripped
     add column if not exists photo_license      text,  -- 'CC BY-SA 4.0', 'CC0', 'Public domain'
     add column if not exists photo_source_url   text,  -- Commons description page
     add column if not exists photo_source_title text;  -- 'File:....jpg'
   alter table public.colleges add constraint colleges_photo_path_format
     check (photo_path is null or photo_path ~ '^[a-z0-9][a-z0-9-]*\.(jpg|jpeg|webp)$');
   alter table public.colleges add constraint colleges_photo_attributed
     check (photo_path is null or (photo_alt is not null and photo_credit is not null
            and photo_license is not null and photo_source_url ~* '^https://'));
   -- Same rule as fetch-college-photos.mjs allowedLicense(): no NC, no ND.
   alter table public.colleges add constraint colleges_photo_license_free
     check (photo_license is null or (photo_license ~* '^(CC0|Public domain|PD|CC BY(-SA)? [0-9](\.[0-9])?)'
                                      and photo_license !~* '\y(NC|ND)\y'));

   insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
   values ('college-photos', 'college-photos', true, 1048576, array['image/jpeg','image/webp'])
   on conflict (id) do nothing;
   -- No storage.objects policies: reads use the public endpoint, writes are service_role only.
   ```

   Note: the `student-documents` bucket and its `storage.objects` policies are not in `supabase/migrations/` today. Export them from the dashboard into a migration so the repo describes every bucket.
2. `scripts/seed/generate-college-photos.ts` (new; not part of `generate-catalog*`): reads `${MERIDIES_DEMO_DIR}/lib/collegePhotos.json`, asserts the licence rule, `src === "/colleges/<id>.jpg"` and that the file exists, and emits `20260929000014_seed_college_photos.sql` with one guarded UPDATE per college:
   ```sql
   update public.colleges set photo_path = 'stanford.jpg', photo_alt = 'Stanford University campus',
     photo_credit = '...', photo_license = 'CC BY-SA 4.0',
     photo_source_url = 'https://commons.wikimedia.org/wiki/File:...', photo_source_title = 'File:...'
   where slug = 'stanford' and photo_path is null;
   ```
3. `scripts/seed/upload-college-photos.ts` (new): with the service-role key, uploads `${demo}/public/colleges/<id>.jpg` to `college-photos/<id>.jpg` (`upsert: false`, `contentType: image/jpeg`).
4. Optionally generate `docs/college-photo-credits.md` from the same JSON.

### Step 6.2 [backend] College profile facts: net price bands, student life, requirements

**Today.** No per-income net price, no student life (retention, full-time share, gender, ethnicity), no application requirement levels. `college_admission_stats` exists but is unseeded (`cohort_year` is NOT NULL and the demo states no cohort year). The demo card shows "Net price · $75k–110k", and the compare columns show SAT/ACT midpoints, requirement pills, fee, full-time and retention gauges, gender and ethnicity bars, and net price at the band.

**Do.**

1. Migration `20260929000015_college_profile_facts.sql`: three tables, each SELECT-only for `authenticated`, maintained by `service_role`, each carrying `provenance public.data_provenance`, `source_url`, `source_verified_at` (null from the seed):
   - `college_net_price_bands`: primary key `(college_id, band)`, `band in ('0-30k','30-48k','48-75k','75-110k','110k-plus')`, `band_label`, `net_price_cents bigint >= 0`, `residency text default 'in-state'`, `sort_order`;
   - `college_student_life`: primary key `college_id`; `total_enrollment`, `full_time_undergrad_pct`, `retention_rate`, `female_pct`, `male_pct` (`numeric(5,4)`, 0 to 1), `ethnicity jsonb` (`[{ group, pct }]`), `graduation_rate_4yr`, `graduation_rate_6yr`;
   - `college_application_requirements`: primary key `college_id`; `essay`, `testing`, `subject_tests`, `interview`, each in `('required','optional','conditional','not-accepted')`; `note <= 1000`. (The fee lives on `colleges.application_fee_cents`, Step 4.1.)
2. `generate-catalog-v6.ts` (Step 4.4) emits `20260929000016_seed_college_profile_facts.sql` from the demo's `netPriceByIncome` ("Under $30k", "$30k–48k", "$48k–75k", "$75k–110k", "$110k+" to the five band codes), `studentLife`, `graduationRate4yr`, `graduationRate6yr` and `admissionRequirements`.
3. Optional v5 carry-over: `college_admitted_profiles (college_id pk, axes jsonb, rating_kind text check (rating_kind = 'meridies-curated'))` from the demo's `admittedProfile`, for the "Typical admitted student" polygon on the detail page (the app has no admitted polygon today). It is curated: label it as a Meridies rating.
4. Do **not** seed `scattergram_points` and do not drop the table; v6 cut the scattergram "right now", which is reversible.

### Step 6.3 [backend] College routes: list DTO, detail DTO, drop scattergram

**Do.**

1. `serialize.ts`: `toCollegePhoto(r)` returns `{ url, alt, credit, license, sourceUrl, sourceTitle } | null`, with `url = ${env.SUPABASE_URL}/storage/v1/object/public/college-photos/${photo_path}` (no host stored in the database).
2. `GET /colleges` (`be:src/routes/colleges.ts:45-63`): add the `photo_*` columns to the select at `:56`; embed `college_aid_ratings(kind, rating, label)` and `college_net_price_bands(band, band_label, net_price_cents)` filtered to `75-110k`; return each row's existing fields plus `photo`, `generosity: { needBased: { rating, label } | null, meritBased: ... }` (a separate curated key, never mixed into the reported figures) and `netPriceAtBand: { band, bandLabel, cents, residency, provenance } | null`. Add `read("colleges:list")`. Optionally extend `search` to city, state and major.
3. `GET /colleges/:id`: add `photo`, `netPriceBands[]`, `studentLife | null`, `applicationRequirements | null`, `supplements` (Step 4.1) and optionally `admittedProfile`, beside the existing keys; `aidRatings` and `aidBandRatings` stay outside `aidProfile`.
4. Delete `GET /colleges/:id/scattergram` (`colleges.ts:305-330`) and its limiter comment (`:37-43`). Keep `/high-schools`, `/high-schools/:id` and `/high-schools/:id/rank` (the student info card uses them) and `/colleges/:id/combined-programs`.
5. `be:AGENTS.md`: the seed note (`:84`), drop "a 2000-row scattergram" (`:149`), the photo columns, the bucket, the upload script.

### Step 6.4 [backend] Files: link filing suggestion, practice-folder import

**Do.**

1. `POST /ai/file-filing` (`ai.ts:1107-1198`): accept `url: z.string().trim().max(2000).optional()` as an alternative to `filename` (refine: one of them). The prompt reads "URL: ..."; the route never fetches it, so it is no SSRF surface. The pasted-link flow becomes: suggestion, `FilingModal`, `POST /files/links { url, folderId, studentId }`.
2. Optional: `importBody.studentId` (`integrations.ts:80-94`) becomes optional when `folderId` is the caller's custom folder (store `student_id null`, Storage path `practice/${ownerId}/...`, after checking the bucket policies). Without this, the app disables From Drive / From OneDrive on practice folders with a tooltip.
3. Optional, for previews: `GET /files/documents/:id/text` returning `parsed_data.text` when `available_to_llm` or when the caller owns the document.
4. No migration for `available_to_llm` (D11): both columns are already `not null default true`. Do not flip existing `false` rows. Optionally write an `audit_log` row when a counselor excludes or re-includes a file.

### Step 6.5 [app] College Profiles (TODOv6 Step 11)

**Demo reference.** `demo:app/dashboard/counselor/colleges/page.tsx`, `colleges/[id]/page.tsx` (the a71a4b4 diff), `components/dashboard/CollegeCard.tsx`, `components/dashboard/CollegeCompare.tsx`, `components/college/CompareColumn.tsx`, `components/college/CompareCharts.tsx`.

**Do.**

1. `lib/api.ts`: `CollegePhoto`; `CollegeSummary` gains `photo`, `generosity` (commented as curated) and `netPriceAtBand`; `CollegeDetail` gains `photo`, `netPriceBands`, `studentLife`, `applicationRequirements`, `supplements`, optionally `admittedProfile`; `ProfileCollege.collegeId` (Step 4.5). Delete `ScattergramPoint` and `getCollegeScattergram`. Keep `getHighSchool`, `getClassRank`.
2. `next.config.ts`:
   ```ts
   const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname : undefined;
   // inside nextConfig:
   images: supabaseHost ? { remotePatterns: [{ protocol: "https", hostname: supabaseHost, pathname: "/storage/v1/object/public/college-photos/**" }] } : undefined,
   ```
3. `components/dashboard/CollegeCard.tsx` (new, port): link card `rounded-lg border bg-card shadow-[var(--shadow-sm)] hover:border-border-strong`; image block `relative aspect-[16/9] overflow-hidden` with `next/image fill` (`sizes="(min-width: 1280px) 22vw, (min-width: 1024px) 30vw, (min-width: 640px) 45vw, 92vw"`), falling back to `linear-gradient(135deg, brand_color ?? var(--surface-dark), var(--surface-dark))`; the credit on hover via `title="Photo: {credit}, {license}"`; the admit-rate pill top right (`bg-surface-dark/60 backdrop-blur-sm`, "{n}% admit rate"); **no monogram**. Body: name (15.5 px semibold), "{city}, {state}", a 2-column grid "Net price · $75k–110k" (" in-state" for publics; the em dash placeholder with an `InfoTip` reason when missing, never a computed band figure) and "Generosity · Meridies" ("{need}/10 need", "{merit}/10 merit"); the reason line at the bottom (`mt-auto truncate border-t pt-2.5 text-[12px] font-medium text-foreground/80`) only when a student has the school.
4. `app/dashboard/counselor/colleges/page.tsx`:
   - delete the subtitle (`:152`), the compare subtitle (`:194-197`), `initialsFor` (`:55-63`), the inline card markup (`:272-337`), "Not on any student's list" (`:332-334`), the `EmptyState detail` (`:258-262`) and the footer (`:344-349`);
   - heading "Recommended based on your roster" (or "Search results" with a `CountPill` count while searching; keep the spinner);
   - a right-aligned `InfoTip`, for example "Reported institution-wide figures. Open a school for each figure's source and verification date.";
   - reason line: `students.slice(0, 2).join(" • ") + (n > 2 ? ` +${n - 2}` : "")` (full names), matched by `collegeId` rather than the fuzzy `namesMatch`;
   - compare open by default (optional, as the demo).
5. `components/college/CompareCharts.tsx` (port as is): `ArcGauge`, `FillBar`, `SplitBar`, `StackedBar`, `RatingMeter`, `IncomeBandChart`. Review `StackedBar`'s categorical palette against "colour is reserved for meaning". `IncomeBandChart` reads `AidBandRating { bandLabel, rating, note }`.
6. `components/college/CompareColumn.tsx` (port): a fragment of cells placed by `gridColumn: col`; `SECTION_ROWS = 5`, `COMPARE_ROWS = 1 + SECTION_ROWS * 3`; each `SectionCard` uses `gridRow: ${row} / span 5` with `gridTemplateRows: "subgrid"`. **Each section emits exactly 5 children (title plus 4) even when data is missing**, or rows misalign; a missing value renders the placeholder and its reason. Header row: a `h-16` photo strip with the hover credit and a remove button, name link, "{city}, {state} · {control}". Admissions: SAT and ACT midpoints (latest `admissionStats`, or the placeholder with "No admitted-class profile on file"), acceptance `FillBar`, requirement pills (Essay, SAT/ACT, Subject tests, Interview), application fee. Student life: undergrads / total, Full-time and Retention `ArcGauge`s, gender `SplitBar`, ethnicity `StackedBar`. Cost & aid: sticker and average need package, net price at the band with "Meets full need" or "Gapping happens", "Generosity · curated Meridies ratings" with an `InfoTip` and three `RatingMeter`s, "Generosity by family income" with an `InfoTip` and `IncomeBandChart dense`. No fixed column widths.
7. Rewrite `components/dashboard/CollegeCompare.tsx`: a search input (`searchColleges(token, { search, limit: 6 })`, debounced, excluding pinned schools; Enter adds the first suggestion, Esc clears; a brand-colour dot on each suggestion); `MAX_SELECTED = 5`; pinned chips with Remove and Clear, and a source `InfoTip`; **nothing below the chips until two schools are pinned**; the shared grid inside `overflow-x-auto`:
   ```tsx
   style={{ gridTemplateColumns: `repeat(${n}, minmax(15rem, 1fr))`, gridTemplateRows: `repeat(${COMPARE_ROWS}, auto)` }}
   ```
   Move today's `ROWS` table into a `<details>` "All attributes" with Show / Hide (no row count), keeping its "Meridies rating" and "Meridies arithmetic" labels. Delete the chip picker (`:367-409`), the empty text (`:421-424`) and the footnote (`:482-491`; the generosity explanation goes into an `InfoTip`). The `options` prop goes away.
8. `colleges/[id]/page.tsx`: remove `outcomes` from `SECTIONS` (`:177`), the imports at `:31, 49, 52, 66`, the `scopedSchool` state (`:309`), the Outcomes block (`:1152-1179`) and the class-rank scattergram caption (`:793-799`); remove `Panel.subtitle` and `SectionHeading.blurb` and their call sites; `divide-border` to `divide-border/60`; the not-found `EmptyState detail` (`:388`) becomes the title; other `EmptyState detail`s keep the title as the reason and move longer text into an `InfoTip`; the footer (`:1405-1410`) becomes a `SourceTip`. Optionally use the photo in the hero.
9. Delete `components/dashboard/Scattergram.tsx`. `components/college/HighSchoolPanel.tsx` loses its only entry point: reuse its pieces in the Step 3.5 `HighSchoolProfileBar`, then delete it.
10. Open question 5, as the demo resolved it: sources sit behind an info glyph beside the label; curated labels stay visible text. Rewrite `components/college/provenance.tsx`:
    - **sourced**: a right-aligned `SourceTip` ("Source: <host link> · verified {date}" or "not yet verified");
    - **curated**: a visible compact label ("Meridies rating", `text-[10.5px] font-semibold uppercase tracking-[0.1em] text-primary`) plus a `SourceTip` with the explanation and evidence link;
    - **estimated**: a visible "Estimated" label plus a tip "Modelled from reported figures, not published as such.".
    `AidGenerosity.tsx` captions (`:171-175, 243-249, 266-270, 320-325`) move into `InfoTip`s beside "Meridies ratings" and the band label; `CombinedPrograms.tsx` loses its panel subtitle and `EmptyState detail` and converts `Sourced`.
11. `app:AGENTS.md`: the photo licence rule (CC0 / PD / CC BY / CC BY-SA only, credit on hover, stored with the row); sources sit behind a tip; the scattergram is gone.

**Done when.**
- [ ] The list page shows zero captions; cards show a campus photo (or the tint), name, location, net price, generosity and "Name • Name".
- [ ] Two pinned schools fill two equal columns, three fill thirds, up to five, and rows line up across columns.
- [ ] `rg -n "Scattergram|getCollegeScattergram|ScattergramPoint" app components lib` returns only `components/assistant/CollegeListSurface.tsx`, which Step 7.14 deletes.

### Step 6.6 [app] Files page (TODOv6 Step 12)

**Demo reference.** `demo:app/dashboard/counselor/data-hub/page.tsx`, `components/dashboard/LinkUploads.tsx`, `components/dashboard/FolderBrowser.tsx`, `components/files/FilingModal.tsx`, `components/files/ConnectionsModal.tsx`, `components/dashboard/FilePreview.tsx`.

**Today.** `app/dashboard/counselor/data-hub/page.tsx`: `PageHeader` "App Integrations & File Uploads" plus subtitle, `Tabs` (Connected apps, Roster import, Upload files, Upload links), an apps summary card, a files caption. `FolderBrowser.tsx` (999 lines) loads its own data, has "Students · automatic", an app-only "Unfiled" folder, hover buttons that reserve about 56 px (the truncation bug), an inline staging panel, a "Meridies may read / Excluded from AI" pill, plain-text link rows, and no From Drive / From OneDrive buttons. `LinkUploads.tsx` (489 lines) is a whole page section. No `FilingModal`, `ConnectionsModal` or `FilePreview`.

**Do.**

1. **Keep the path** `/dashboard/counselor/data-hub` and the `#apps` hash (the OAuth callback at `data-hub/callback/[provider]/page.tsx:40, 67, 99` returns there). Only the page title and nav label become "Files".
2. Rewrite `data-hub/page.tsx`:
   - an `h1` "Files" (`font-serif text-[26px]`) and a **Connections** button showing a Google glyph and an "M" tile, gray when disconnected (state from `getIntegrationProviders`: connected only when tokens are held);
   - `ConnectionsModal` (`components/files/ConnectionsModal.tsx`, new) wrapping the existing `IntegrationsPanel` in `Modal size="lg"`; `#apps` and the OAuth `?integration=&result=` return open it and show the fixed-copy toast;
   - `#roster` (and the `FilingModal` roster route) opens `RosterImportPanel` in a `Modal` with `incomingFile`;
   - two boxes (`grid lg:grid-cols-2`): the upload drop zone (`Card id="uploads"`, `UploadCloud` tile, "Upload files" or "Reading..." with a spinner, `font-serif 19px`, **no caption lines**) and the new `LinkUploads`;
   - `FolderBrowser` below;
   - delete `Tabs`, `SUBTABS`, the apps summary card (`:159-177`), the files caption (`:197-212`) and the `getDocuments` load used only by that card (`:103-125`);
   - lift folders, documents and links into a shared hook (`lib/useDrive.ts`) so the three surfaces update together.
3. `components/files/FilingModal.tsx` (new, port the UI onto the app's `askForFiling` / `FilingSuggestionNote`): title "Reading your files..." or "Where these go", no description; each row shows a link icon or kind tile, the name, the confidence dot and reason, the label pill, an arrow, a folder `<select>` (default: the FolderBrowser's active folder, the app's rule, with a "Use suggested folder" click) or "Map columns" for rosters, and Skip; footer Cancel and "File N document(s)". Rows carry either a `File` or a link. Confirm uploads files (Storage plus `registerDocument({ folderId, studentId: folder.studentId })`) and links (`addDocumentLink({ url, folderId, studentId: folder.studentId, read: true })`). Move the staging logic out of `FolderBrowser.tsx:348-411, 657-760`.
4. Rewrite `components/dashboard/LinkUploads.tsx` to about 50 lines: `Card p-6`, a `Link2` tile on `bg-accent/60 text-primary`, "Paste links" (`font-serif 19px`), an `Input` (placeholder `admissions.university.edu/deadlines`, aria "Website or domain") and a primary `Sparkles` "Read link" button (disabled when empty) calling `onSubmit(url)`, which asks `/ai/file-filing` with `url` and opens `FilingModal`. Delete the section header, subtitle, folder select, status line, list, badges, key points, toggles and empty state.
5. `components/dashboard/FolderBrowser.tsx`:
   - rail label "Students" (`:485`); delete the empty-rail caption (`:493-494`);
   - `FolderRow` (`:927-998`): `group relative flex items-center rounded-lg`; selected `bg-accent/60 ring-1 ring-primary/40 font-semibold text-foreground`, else `font-medium text-foreground/75`; hover actions `absolute inset-y-0 right-1 hidden ... group-hover:flex focus-within:flex` over a `bg-gradient-to-l from-card via-card to-transparent pl-6` fade (use accent stops on the selected row), so names run to the rail edge; optionally hide rename on student folders; the "Unfiled" row gets the same selected style (keep it: real documents can have no folder);
   - the panel wrapper (`:606`): `min-w-0 lg:m-3 lg:rounded-xl lg:border border-primary/40 bg-accent/15` (`bg-accent/30` while dragging over);
   - header (`:612-617`): the name and "{n} file|files · {n} link|links"; delete "· N readable by Meridies" and "· created with the student";
   - replace "Choose files" and its input (`:620-646`) with **From Drive** (`HardDrive`) and **From OneDrive** (`LayoutGrid`), opening `RemoteFilePicker` in a `Modal` for the active folder; an unconnected suite opens Connections and a toast;
   - delete the staging block (`:657-760`), `EmptyState detail` (`:779`), the footer caption (`:869-874`); `divide-border` to `/60` (`:782`);
   - delete the toggle pill (`:814-831`) and `toggleLlm` (`:421-445`); add "Exclude from AI" / "Include in AI" to a row overflow menu and an `EyeOff` marker with a `Tooltip` ("Excluded from AI") on excluded rows only (D11);
   - link rows (`:845-861`) become `<a target="_blank" rel="noopener noreferrer" title={summary}>` with `{title ?? domain}` and "Reading|Link · date · url", a `Loader2` while `queued` / `reading`, a trash button (`deleteDocumentLink`); a `failed` link keeps its `error` visible with a retry icon (`readDocumentLink`);
   - file rows open `FilePreview`; the word budget chip from Step 4.8.
6. `components/files/RemoteFilePicker.tsx`: delete the "Readable by the assistant" checkbox and caption (`:170-183`, `:72`) and send `true`; the not-connected link (`:141`) opens Connections.
7. `components/dashboard/FilePreview.tsx` (new): `Modal` titled with the filename, no description; a PDF or image through a signed URL (`supabase.storage.createSignedUrl` on `student-documents`, after the bucket policy export in Step 6.1); otherwise "No inline preview for this type"; a linked essay renders its text; footer "Open in Google Drive" / "Open in OneDrive" when `externalWebUrl`, Download, Done; the Exclude / Include action.
8. `RosterImportPanel.tsx:281` subtitle goes (Step 1.3).
9. Delete the `Tabs` primitive once `ReviewQueuePanel` no longer uses it (or leave `Tabs` for that drawer only).
10. `app:AGENTS.md`: rewrite the Connected apps paragraph (Connections is a popup on Files; `RemoteFilePicker` also sits on the folder panel header) and the Key files rows; the IA label becomes "Files".

**Done when.**
- [ ] One Files page with no tabs, captions, context pills or folder dropdowns.
- [ ] The selected student row and its panel share an accent colour, and "Practice templates" and "Policy & research" show in full at the default rail width.
- [ ] A pasted link goes through the same filing confirmation as an upload and lands in the chosen student's folder.

---

## Phase 7: AxIS

TODOv6 Steps 13 and 14, plus open questions 6, 7 and 8. AxIS shrinks to three student tools (**Coherence**, **Activities Build**, **College List Builder**) and one research tool (**College research**). 2D essay review, school-specific reframing, the policy tracker and the resource hub are cut, along with every acronym (NCE, POC, ICLB, ESSAY2D, SSR, IPT, ACRH). "AXIS must be very simple so that a middle schooler could navigate through it without confusion."

**Today (app).** `components/assistant/AssistantWorkspace.tsx` (1033 lines) with `ConversationRail` (New chat, "Student tools", "Informational tools" with acronym badges, a flat chat list), `ContextPicker` (a full-page student picker that calls `getPolygon` once per student), `ToolSurface` switching `CoherenceSurface`, `ActivitiesBuild`, `EssayReviewSurface`, `CollegeListSurface`, and a 300 px `Newsreel`. `components/assistant/tools.ts` defines `StudentToolKey = "NCE" | "POC" | "ICLB" | "ESSAY2D"` and `OrgToolKey = "SSR" | "IPT" | "ACRH"`. The composer has a real mic (`useSpeechInput`, keep it), sends on Enter only on fine-pointer devices, and has no "+" attach. `CollegeListSurface` never calls a list-building route. The page does not read `?student=`.

**Today (backend).** `/chat` (`be:src/routes/chat.ts`, `be:src/lib/chat.ts`) streams free text and persists only `content` (reasoning is discarded); the registry keys are `general`, `narrative-coherence` (NCE), `opportunity-concierge` (POC), `school-reframing` (SSR), `college-list` (ICLB), `profile-review` (PR), and `BASE_CHAT_SYSTEM` introduces itself as "Meridies". Chat output under the coherence tool is not prose-filtered (`chat.ts:266-274`), which is the guardrail hole v6 would widen. Nothing reads essay bodies for coherence (`studentBrief`, `ai.ts:35-68`, and `buildStudentContext`, `lib/chat.ts:166-238`, select metadata only). `POST /ai/concierge` invents programs from model knowledge and never reads the `opportunities` catalog. `policy_updates` and `resources` exist (`20260828000011:223-284`) but no route serves them. There are no coordinates anywhere: `profiles.hometown` is free text; `colleges` and `opportunities` have no lat/lng.

### Step 7.1 [backend] Chat schema and protocol for tool runs

**Do.**

1. Migration `20260929000017_axis_v6_chat.sql`:

   ```sql
   alter table public.ai_conversations
     add column if not exists criteria jsonb not null default '{}'::jsonb;   -- the panel as sent
   update public.ai_conversations set module = case module
     when 'narrative-coherence'   then 'coherence'
     when 'opportunity-concierge' then 'activities'
     when 'school-reframing'      then 'general'
     when 'profile-review'        then 'general'
     else module end;
   alter table public.ai_conversations add constraint ai_conversations_module_check
     check (module is null or module in ('general','coherence','activities','college-list','college-research'));
   create index if not exists ai_conversations_owner_student_idx
     on public.ai_conversations (owner_id, student_id, updated_at desc);

   alter table public.ai_messages
     add column if not exists tool text,
     add column if not exists payload jsonb,                            -- the structured answer
     add column if not exists reasoning text[] not null default '{}';   -- the persisted trace
   -- The guardrail in the database, beside essay_marks_edits_are_mechanics:
   -- a coherence answer carries sections only, never a lead or closing paragraph.
   alter table public.ai_messages add constraint ai_messages_coherence_is_bullets
     check (tool is distinct from 'coherence' or payload is null
            or (not (payload ? 'lead') and not (payload ? 'closing')));
   ```

   Extend `ai_runs_module_check` and `AiModule` with `'college-research'` (and any other new module name the steps below use).
2. Registry (`be:src/lib/chat.ts:21-147`): keys `general`, `coherence`, `activities`, `college-list`, `college-research`; labels "Coherence", "Activities Build", "College List Builder", "College research"; no badges; `BASE_CHAT_SYSTEM` says "AxIS"; `getChatTool` keeps an alias map for the old module values.
3. `POST /chat/conversations/:id/messages` body:
   ```ts
   const DURATIONS = ["Under 1 day","1 day to 2 weeks","2+ weeks","Ongoing"] as const;
   const coherence = z.object({ tool: z.literal("coherence"),
     statement: z.boolean(), activities: z.boolean(), awards: z.boolean(),
     supplementEssayIds: z.array(z.string().uuid()).max(40) }).strict();
   const activities = z.object({ tool: z.literal("activities"),
     subjects: z.array(z.string().trim().min(1).max(60)).max(15),
     types: z.array(z.string().trim().min(1).max(60)).max(10),
     miles: z.number().int().min(10).max(600),
     durations: z.array(z.enum(DURATIONS)).max(4) }).strict();
   const collegeList = z.object({ tool: z.literal("college-list"),
     majors: z.array(z.string().trim().min(1).max(80)).max(10),
     sizes: z.array(z.enum(["Small","Medium","Large","Very large"])).max(4),
     settings: z.array(z.enum(["Rural","Small city","Major city","Suburban","College town"])).max(5),
     testOptional: z.enum(["Yes","No"]).nullable(),
     miles: z.number().int().min(50).max(3000),
     aid: z.enum(["No preference","Lenient","Limited"]),
     diversity: z.enum(["No preference","Yes","No"]) }).strict();
   const research = z.object({ tool: z.literal("college-research"),
     mode: z.enum(["report","presentation","debate","other","events","updates"]),
     other: z.string().trim().max(120).optional(),
     collegeId: z.string().uuid().optional() }).strict();
   const messageSchema = z.object({
     content: z.string().trim().min(1).max(8000),     // the client sends the tool's ask when the box is empty
     tool: z.enum(["general","coherence","activities","college-list","college-research"]).optional(),
     studentId: z.string().uuid().optional(),
     criteria: z.discriminatedUnion("tool", [coherence, activities, collegeList, research]).optional(),
     documentIds: z.array(z.string().uuid()).max(10).optional(),   // "+" attachments, filtered by available_to_llm
   }).strict();
   ```
   `createConvSchema` accepts `criteria` and a client `title` ("Full profile scan", "MIT: updates").
4. Protocol: a new SSE event `answer { payload }`. A guarded tool (coherence) **never streams free text**: it emits `reasoning` steps, then one `answer`. `delta` streaming stays for `general` and for non-guarded follow-ups without criteria. The assistant row persists `tool`, `payload` and `reasoning`. The server emits honest reasoning steps built from the criteria ("Reading Personal statement, Stanford supplements").
5. Rate limits: the message route keeps its 30/min limiter; runs with criteria add `limit("ai:axis-tools", 20, 60)`; every model call goes through `runStructured` (300/day).
6. `GET /students` roster rows carry `polygon` and `gpaWeighted` (Step 2.2); that replaces `ContextPicker`'s per-student fan-out.

### Step 7.2 [backend] Coherence pipeline (TODOv6 Step 14)

**Demo reference.** `demo:lib/coherence.ts` (`CoherenceDocs`, `CoherenceCriteria`, `everything()`, `onFile()`, `coherenceAnswer`).

**Do.** When `criteria.tool === "coherence"` (student required, `resolveStudentId(..., "edit")`):

1. Load only the ticked items: the personal statement (`essays.essay_kind = 'personal-statement'` with `word_count > 0`), essays whose id is in `supplementEssayIds` and whose `student_id` matches, and the activities and awards sheets if ticked. Drop anything not on file silently (the demo's `onFile()`). Skip essays whose linked document has `available_to_llm = false` (D22).
2. Model: `DEEP_MODEL` (AGENTS names narrative coherence as the Sonnet exception). System: `NO_PROSE_SYSTEM` plus the coherence focus. Output schema `{ findings: { what <= 240, where <= 200, fix <= 240 }[] (max 5) }`; `validate` runs `enforceNoProse` on `what` and `fix` and drops failing findings.
3. Compose the demo's three sections server-side: "Contradictions, ranked", "Where each one is", "How to run it in session" (always ending "Give {first} a word budget for each fix and let them write it."). Empty cases: "Nothing to read" ("No documents are ticked. Pick at least one under Documents.") and "Nothing to reconcile" ("The ticked documents agree with each other on dates and roles."). `usedSources` are labels ("Personal statement", "UC Personal Insight Questions", "{School} supplements", "Activities list", "Awards").
4. Insert `narrative_flags` rows and return them with `id` and `status` (the Review drawer reads them).
5. Retire `POST /ai/narrative-coherence` once the app no longer calls it (Step 7.7).

### Step 7.3 [backend] Geography: student home, college and program locations (D28)

**Do.**

1. Migration `20260929000018_axis_geography.sql`:

   ```sql
   -- Student home, picked by the counselor from a ZIP gazetteer. No default location.
   alter table public.profiles
     add column if not exists home_label text check (length(home_label) <= 120),
     add column if not exists home_lat numeric(8,5) check (home_lat between -90 and 90),
     add column if not exists home_lng numeric(8,5) check (home_lng between -180 and 180);
   grant update (home_label, home_lat, home_lng) on public.profiles to authenticated;

   create table if not exists public.us_zcta_centroids (
     zip text primary key check (zip ~ '^\d{5}$'),
     lat numeric(8,5) not null, lng numeric(8,5) not null,
     city text, state text check (state ~ '^[A-Z]{2}$')
   );
   alter table public.us_zcta_centroids enable row level security;
   create policy us_zcta_centroids_select on public.us_zcta_centroids for select to authenticated using (true);

   -- College geography and the two v6 filters that have no column yet.
   alter table public.colleges
     add column if not exists latitude  numeric(8,5),
     add column if not exists longitude numeric(8,5),
     add column if not exists setting text
       check (setting in ('Rural','Small city','Major city','Suburban','College town')),
     add column if not exists setting_provenance public.data_provenance,   -- 'College town' is a curated call
     add column if not exists largest_group_pct numeric(5,2) check (largest_group_pct between 0 and 100),
     add column if not exists demographics_source_url text,
     add column if not exists demographics_verified_at timestamptz;

   -- Program geography, type and duration for Activities Build.
   alter table public.opportunities
     add column if not exists latitude  numeric(8,5),
     add column if not exists longitude numeric(8,5),
     add column if not exists online boolean not null default false,
     add column if not exists program_type text
       check (program_type in ('Job','Internship','Summer program','Lab','Research','Volunteer')),
     add column if not exists duration text
       check (duration in ('Under 1 day','1 day to 2 weeks','2+ weeks','Ongoing'));
   create index if not exists opportunities_geo_idx on public.opportunities (latitude, longitude);
   ```

2. Load `us_zcta_centroids` from the Census ZCTA Gazetteer (public domain, about 33,000 rows) with a script (`scripts/seed/load-zcta.ts`, service role, `COPY` or batched inserts), not a migration.
3. `PUT /students/:id/home` (new, counselor, `assertCanEditStudent`): `{ zip }` resolves through the gazetteer and writes `home_label` ("Ithaca, NY 14850"), `home_lat`, `home_lng`; `{ clear: true }` nulls them. `GET /places?zip=` (or `?q=`) for the picker. Serialize `home` in `toMeridiesUser`.
4. Seed (through `generate-catalog-v6.ts`, Step 4.4):
   - the 8 profiled colleges' coordinates and `setting` from `demo:lib/listBuilder.ts:99-117` `RECORD_EXTRAS` (coordinates are public facts; `setting_provenance = 'curated'` for "College town", else `'estimated'` until verified); `largest_group_pct` from each college's `studentLife.ethnicity` (the largest share) with its provenance;
   - `opportunities` from `demo:lib/programs.ts` `PROGRAMS` (27 real-named programs around Ithaca and the Northeast): `name`, `org` (host), `url`, `description`, `eligibility`, `subject_tags` (topics), `program_type`, `duration`, `latitude` / `longitude` / `online` from `place`, `deadline` via `nextOccurrence`. `source_verified_at` stays null; verify before relying on them. They only help Northeast students.
   - Do **not** seed the list builder's extra 31-school `CATALOG` (`listBuilder.ts:147-179`): its figures are rounded fixtures. Expanding the college catalog is a data project (IPEDS HD for coordinates and locale, IPEDS EF for demographics, `college_admission_stats` with a cohort year). Until then the College List Builder filters the colleges that are in the catalog and says so when the result is thin.
5. Server helper `milesBetween(a, b)` (haversine) in `be:src/lib/geo.ts`.

### Step 7.4 [backend] Activities Build pipeline (TODOv6 Step 14)

**Demo reference.** `demo:lib/programs.ts` (`findPrograms`, `TOPIC_RULES`, `activitiesAnswer`), `ACTIVITY_MILES = { min: 10, max: 600, step: 10 }`, default 100.

**Do.** When `criteria.tool === "activities"` (student required):

1. Deterministic first: active `opportunities` within `miles` of the student's home (online programs always pass); subjects matched against `subject_tags` through a server port of `TOPIC_RULES`; `program_type` in `types`; `duration` in `durations`. When nothing matches, relax Duration, then Type, then Subjects, and say which was left out ("Nothing matched every filter, so duration is left out.").
2. Home missing: return online programs only with an `unavailableReason` ("Set {first}'s home ZIP to search by distance.").
3. Optional model pass for a one-line why-fit per row, constrained to catalog ids and verified (as `/ai/file-filing` verifies `folderId`). `FAST_MODEL` is enough for rank-and-annotate; `be:AGENTS.md` lists the concierge as Sonnet, so either keep `DEEP_MODEL` or document the change.
4. Persist `opportunity_requests` with `constraints = criteria`, and `opportunity_matches` with `opportunity_id` and status `counselor-review`.
5. Payload: lead "{N} programs within {X} miles of {home_label} for {subjects}." (empty: "Nothing within {X} miles of {home_label} yet. Drag the circle wider and ask again."), a group "Programs" (up to 8), each item `{ title, href: url, meta: "{host} · {City, ST, N mi | Online}", tags: [type, duration], note: "{description} Deadline: {deadline}.", action: { kind: "task", title: "Look into {name} ({host}) and tell me whether you want to apply. Deadline: {deadline}." } }`.
6. No web-search fallback (D30).

### Step 7.5 [backend] College List Builder pipeline (TODOv6 Step 14)

**Demo reference.** `demo:lib/listBuilder.ts` (`ListCriteria`, `SCHOOL_SIZES`, `LOCATION_TYPES`, `AID_OPTIONS`, `DIVERSITY_OPTIONS`, `LIST_MILES = { min: 50, max: 3000, step: 50 }`, default 500, `DIVERSE_MAX = 45`, `AID_FLOOR = { Lenient: 5, Limited: 8 }`, `RELAX_ORDER`).

**Do.** When `criteria.tool === "college-list"` (student required):

1. Deterministic over `colleges` joined with `college_majors` (field match through a server port of `FIELD_RULES`), `college_aid_ratings` (`kind = 'need-based'`, floor Lenient 5 / Limited 8, labelled "Meridies need-based rating"), `largest_group_pct` (Diversity "Yes" means 45% or less), `setting`, the size bands on `size`, and `test_policy in ('optional','blind')` when Test optional is Yes. Distance from the student's home (disabled with a reason when missing).
2. Relax in the demo's order: Diversity, Financial aid, Location type, School size, Test optional, Majors; say which were relaxed.
3. Fit: port the demo's formula (`odds = admit * exp(0.35 * satEdge + 0.35 * gpaEdge)`, clamped 0.5 to 94, SAT dropped when Test optional = Yes; reach when admit < 15 or odds < 35, target when odds < 70, else likely) over `college_admission_stats` where seeded, else `acceptance_rate` only. The result is **estimated**: label it as modelled, never as a statistic.
4. Optional why-fit pass with `DEEP_MODEL` ("college lists" is a named Sonnet exception), constrained to catalog ids.
5. Payload: lead "{relax note}{N} schools within {X} miles of {home_label} offer {majors} and fit the {constraints} you picked." (plus "Aid is read from the Meridies need-based rating ({n} or higher)." when aid was used); groups Reach / Target / Likely (up to 4 each; "{shown} of {total}" when truncated); items `meta: "City, ST · N mi"`, `tags: [size, setting, testing]`, `action: { kind: "add-to-list", college: { collegeId, name, initials, color, round: "RD", fit, deadline, major } }`.
6. The app writes "Add to list" through `POST /student-colleges` with `college_id` (Step 4.1); a 409 means "On the list".

### Step 7.6 [backend] College research, events, updates (TODOv6 Step 13)

**Demo reference.** `demo:lib/collegeResearch.ts` (`RESEARCH_TYPES`, `FIND_TYPES`, `research()`; `EVENTS` and `UPDATES` are invented fixtures).

**Do.**

1. Migration `20260929000019_college_events.sql` (D29):

   ```sql
   create table if not exists public.college_events (
     id                 uuid primary key default gen_random_uuid(),
     college_id         uuid not null references public.colleges(id) on delete cascade,
     kind               text not null check (kind in ('info-session','tour','open-house','workshop','deadline','other')),
     title              text not null check (length(title) <= 300),
     starts_at          timestamptz,
     ends_at            timestamptz,
     recurrence         text check (length(recurrence) <= 200),
     virtual            boolean,
     url                text,
     source_url         text not null,
     source_verified_at timestamptz,
     created_at         timestamptz not null default now()
   );
   alter table public.college_events enable row level security;
   create policy college_events_select on public.college_events for select to authenticated using (true);
   ```

   Updates reuse `policy_updates` (keyed by `college_id`, with `source_url`).
2. `GET /colleges/:id/events` and `GET /colleges/:id/updates` (new, `read()` limiter): plain reads for reuse on College Profiles.
3. When `criteria.tool === "college-research"` (no student): resolve the college by `collegeId`, or by server-side name and alias matching of `content` (an `aka text[]` column on `colleges` helps; add it if matching by name alone is too weak). No match: "Which college? Name one, like Stanford, UC Berkeley or Michigan."
   - Report, Presentation, Debate, Other: load the `GET /colleges/:id` data; `FAST_MODEL` arranges **only the supplied facts** into bullet sections (at most 240 characters each). Report: Overview, Admissions, Academics, Cost and aid, Student life. Presentation: "Slide 1: Why {name}" to "Slide 5: Life there". Debate: For, Against, "Where the two sides meet". Other: a focused answer keyed on the Other text. A cheap validator drops any bullet containing a number that is not in the source JSON. Curated ratings keep their Meridies label. `usedSources`: "College profile" plus the dataset names.
   - Events: `college_events` in the next 30 days plus `colleges.deadlines`; no model call. Nothing on file: "No events on file for {name}" (not the demo's invented "Nothing scheduled").
   - Updates: `policy_updates where college_id = $1 order by published_at desc`; no model call; nothing on file: say so.

### Step 7.7 [backend] Retire cut tools and tidy the registry

**Do.**

1. `POST /ai/school-reframing`: delete (SSR is cut). `students.ts:124` / `serialize` `schoolReframing` can stay as read-only history or go.
2. `POST /ai/essay-review`: return 410 (D31). Keep `essay_marks`, its CHECK and the marks read routes for history; consider making `PATCH /essay-marks/:id` read-only.
3. `POST /ai/college-list` (variant lists from model knowledge, never called by the app): delete, or keep the tables for history.
4. `POST /ai/narrative-coherence`: delete once Step 7.9 ships (the Review drawer still reads `narrative_flags`).
5. `POST /ai/concierge`: delete once Step 7.11 ships, or keep as a thin alias onto the Activities pipeline.
6. Chat tools `school-reframing` and `profile-review`: gone from the registry (aliases map old conversations to `general`).
7. Keep `/ai/essay-advice`, `/ai/draft-quality`, `/opportunities/*`.
8. Optional: `DEEP_MODEL` is `claude-sonnet-4-5` (`anthropic.ts:22`), a generation behind; moving it is a separate, documented decision.
9. `be:AGENTS.md`: the Sonnet list, the `/chat` criteria and payload protocol, the new tables, the retired routes; the essay-restriction paragraph (coherence is now the one tool that reads prose, enforced by `enforceNoProse` on its findings, no free-text streaming for guarded tools, and `ai_messages_coherence_is_bullets`).

### Step 7.8 [app] AxIS layout, panel, chats, composer, answers (TODOv6 Step 13)

**Demo reference.** `demo:app/dashboard/assistant/page.tsx`, `demo:components/assistant/AssistantWorkspace.tsx` (1220 lines), `AxisPanel.tsx`, `lib/llmTools.ts`, `lib/axisChats.ts`, `lib/assistant.ts:343-382`.

**Do.**

1. `app/dashboard/counselor/assistant/page.tsx`: `DashboardShell` with `bleed hideHeader autoCollapse` (Step 2.1), `searchPlaceholder="Search past AxIS conversations..."`; read `?student=` and `?prompt=`.
2. `lib/api.ts`:
   ```ts
   export type AxisToolKey = "coherence" | "activities" | "college-list" | "college-research";
   export type AxisAnswerItem = { id: string; title: string; href?: string; meta: string; tags?: string[]; note?: string;
     action?: { kind: "task"; title: string }
       | { kind: "add-to-list"; college: { collegeId: string | null; name: string; initials: string; color: string;
           round: "RD"; fit: CollegeFit; deadline: string; major?: string } } };
   export type AxisAnswerGroup = { heading: string; fit?: CollegeFit; total?: number; items: AxisAnswerItem[] };
   type Sections = { sections: { heading: string; points: string[] }[]; usedSources: string[] };
   // The guardrail as a type: a coherence answer cannot carry a lead or closing paragraph.
   export type AxisAnswer =
     | ({ tool: "coherence"; lead?: never; closing?: never; groups?: never } & Sections)
     | ({ tool: Exclude<AxisToolKey, "coherence"> | "general"; lead?: string; closing?: string; groups?: AxisAnswerGroup[] } & Sections);
   ```
   plus `ToolCriteria`, `CoherenceCriteria`, `ActivitiesCriteria`, `ListCriteria`, `ResearchCriteria` mirroring the zod. `ChatToolInfo` loses `badge`; `Conversation` gains `criteria`; `ChatMessage` gains `tool`, `payload`, `reasoning`; `createConversation` accepts `criteria` and `title`; `streamChatMessage` input gains `criteria` and `documentIds`, and its handlers gain `onAnswer(payload)`. New `setStudentHome`, `searchPlaces`, `getCollegeEvents`, `getCollegeUpdates`. `RosterStudent` gains `polygon`, `gpaWeighted`, `home`.
3. `lib/axis.ts` (new, replaces `components/assistant/tools.ts`): `STUDENT_TOOLS` (coherence "Coherence", guarded, ask "Check these documents against each other"; activities "Activities Build", ask "Find activities that fit"; college-list "College List Builder", ask "Build a balanced list from these"), `CHIP_LABEL` (Coherence / Activities / College list), `ESSAY_GUARDRAIL = "Diagnosis only: this tool marks what is wrong and where. It never drafts or rewrites."`, the option constants (`PROGRAM_TYPES`, `DURATIONS`, `ACTIVITY_MILES`, `SCHOOL_SIZES`, `LOCATION_TYPES`, `TEST_OPTIONAL_OPTIONS`, `AID_OPTIONS`, `DIVERSITY_OPTIONS`, `LIST_MILES`, `RESEARCH_TYPES`, `FIND_TYPES`), default criteria builders, and the one-line summaries for the docked panel (`coherenceSummary`, `activitiesSummary`, `listSummary`). Chat helpers: `relativeTime` with the demo's copy ("Just now", "N minutes ago", "N hours ago", "N days ago", then "Mon D"), `chatTitleFrom` (first message, capitalised, 56 characters), criteria-derived titles ("Full profile scan", "Programs in X within N miles", "Schools for X within N miles", "MIT: updates"), and `groupChats` (student groups in roster order, then "College research", then "Across the roster"; newest first inside a group).
4. `components/assistant/AxisPanel.tsx` (new), a 260 px `aside` (`lg:flex`; below `lg` a sheet opened by a header button, aria "Students, tools and chats"):
   - a segmented "Tools | Students" switch (aria group "Show"), Students by default;
   - Students: one row per roster student with the name button, a read-only mini polygon (a new small component drawing `StrengthProfileIcon` from roster `polygon` at 26 px; the existing `StudentShape` is unusable at that size) and a chevron (aria "Show/Hide {name}'s details") that expands **GPA**, **Major** (first intended major) and **Class of**, nothing more; the selected row gets `bg-muted`; the list caps at `max-h-[45%]` and scrolls;
   - Tools: one row, "College research" (`Library` icon);
   - below both: "Chats", grouped by `groupChats`, scrolling on its own; row tooltip "{title} · {relativeTime}"; hover delete.
5. Rewrite `AssistantWorkspace.tsx` on the demo layout, keeping the app's `streamChatMessage`, `useSpeechInput`, abort handling and `freshToken`:
   - header: when a student or College research is open, the first name or "College research" as an `h1` with an X (aria "Back to the AxIS home"); inside a thread, "New chat" (`SquarePen`);
   - nothing selected: `MeridiesMark` (30 px) and "{Morning|Afternoon|Evening}, {first}" on one line (`title="AxIS, Adaptive Experience Intelligence System"`), then the composer. No subtitle, no starter cards;
   - composer: textarea placeholder "How can I help?" (or the selected tool's ask), aria "Message AxIS"; Enter sends and Shift+Enter adds a line (keep the touch exception, D32); "+" on the left (aria "Add a file") uploads into the selected student's folder (Storage plus `registerDocument`) and attaches by `documentIds`, toast "{n} file(s) saved to {name}'s folder."; mic and send on the right;
   - student selected: the first name as the heading; "Let's get to work." with a 28 px mark; the three chips (Coherence, Activities, College list) above the composer (clicking the active chip turns it off); below the composer either the tool's panel in a bordered card or "Recents" (`max-h-[40vh]`, scrolling, hairlines, title left, relative time right, empty "Nothing yet");
   - thread: the user bubble shows the tool name; the assistant turn shows "Working..." then "Finished in N steps", the trace open while running and folded once answered (persisted `reasoning` reloads with the chat); `GuardrailNote` directly above every Coherence answer, including reopened chats; the composer docks at the bottom with the chips, and the tool panel folds into one line "{Tool name} {summary}" that expands;
   - answers render the typed `AxisAnswer`: `lead` at 15 px, headed bullet sections, row groups with "Send as task" (`ListPlus`, opens `TaskStudentModal` prefilled with the action's title) or "Add to list" / "On the list" (toast "{college} added to {first}'s college list."), tier headings coloured by `FIT_META`, "{shown} of {total}", and a final "Drawn from A · B" line; an answer without rows gets "Task {first} with this";
   - on first send create the conversation with the title and criteria; `?student=` opens into that student's group.
6. Delete `ConversationRail.tsx`, `ContextPicker.tsx`, `ToolSurface.tsx`, `Newsreel.tsx`, `EssayReviewSurface.tsx`, `components/assistant/tools.ts`, and the acronym pill, template chips, suggestions, "registry has no tool" warning and `backendKeys` aliasing inside the workspace. Keep `StudentShape.tsx` only if something else uses it.
7. `components/assistant/GuardrailNote.tsx`: drop the `extra` prop; use `ESSAY_GUARDRAIL`.

**Done when.**
- [ ] `rg -nw "NCE|POC|ICLB|ESSAY2D|SSR|IPT|ACRH" app components lib` finds nothing user-facing.
- [ ] On first load a counselor sees students with polygons, chats grouped by student, a greeting and a textbox, and nothing else.
- [ ] Selecting a student highlights the row and shows the first name, the three chips and that student's recent chats; leaving AxIS restores the sidebar to how it was.

### Step 7.9 [app] Coherence panel (TODOv6 Step 14)

**Demo reference.** `demo:components/assistant/CoherencePanel.tsx`.

**Do.** `components/assistant/CoherencePanel.tsx` (new, ported): `h2` "Narrative Coherence"; a "Documents" fieldset with `CheckRow`s **Personal statement**, **Supplements by school**, **Activities list**, **Awards**, **All documents** (hint "Full profile scan"); a kind with nothing on file is disabled with a `bg-muted/70` row (availability from the record context: essays by `essayKind` and `wordCount`, activity and award counts, colleges for grouping); "All documents" checks the rest; "Supplements by school" is tri-state with a trailing "Pick" or "{chosen} of {written}" button, and ticking it selects every written supplement and opens `SchoolPicker`, a right-edge portal sheet `w-[min(92vw,360px)]` titled "Supplements by school" with one tri-state row per school and each document nested ("{n} words" or "Not started", disabled at 0 words), a "Done" footer, Esc to close. The selection rides along as `criteria`. Delete `CoherenceSurface.tsx` (scope chips, college search, file list, uploads and links, "Use in query").

**Done when.**
- [ ] Missing documents are grayed out, "Supplements by school" opens the picker on the right, and the answer is bullets only with the guardrail line above it.

### Step 7.10 [app] BubbleGroup and RadiusMap

**Do.**

1. `components/assistant/BubbleGroup.tsx` (verbatim port, tokens only): `Bubble({ label, hint?, active, onClick })` (a `rounded-full` pill, active `bg-primary`) and `BubbleGroup({ label, options, hints?, value, onChange, multiple?, clearable?, other?, otherPlaceholder = "Other" })`, whose dashed "Other" input commits on Enter or blur and joins the group as a picked pill.
2. `components/assistant/RadiusMap.tsx` (port, generalised): props `{ center: { label, lat, lng } | null, miles, onChange, min, max, step, marks?: { name, lat, lng }[] }`; a static inline SVG (320 × 190 viewBox, no tiles, no network) projecting miles from `center` with flat lat/lng scales; the view half-width is `max(110, miles * 1.45)`, so the map zooms out and the centre shrinks as the circle grows; dragging scales the radius; the edge handle has `role="slider"`, arrow keys move by `step` (Shift for 5 steps); marks turn primary inside the circle; a caption "{N} miles". Replace the Northeast-only outlines with simplified lower-48 state outlines (static JSON). Replace the demo's hex fills with `globals.css` tokens. With `center === null`, render a disabled map with the reason and a "Set home ZIP" action (`setStudentHome`).

### Step 7.11 [app] Activities Build panel (TODOv6 Step 14)

`components/assistant/ActivitiesPanel.tsx` (new, port): `h2` "Activities Build"; `md:grid-cols-2` with a `divide-x` rule. Left: "Subjects" (multi, seeded from intended majors then activity categories, without "undecided", plus Other) and "Type" (multi, `PROGRAM_TYPES` Job, Internship, Summer program, Lab, Research, Volunteer, plus Other). Right: "Location" (`RadiusMap` centred on the student's home, 10 to 600 in steps of 10, label "Distance from {home_label}", marks from the answer's programs) and "Duration" (multi: Under 1 day, 1 day to 2 weeks, 2+ weeks, Ongoing). Defaults: subjects = intended majors, 100 miles. "Send as task" opens `TaskStudentModal` prefilled with the action title. Delete `ActivitiesBuild.tsx`; the existing batch review of opportunity matches can move to the student page later.

### Step 7.12 [app] College List Builder panel (TODOv6 Step 14)

`components/assistant/CollegeListPanel.tsx` (new, port): `h2` "College List Builder"; `lg:grid-cols-[176px_minmax(0,1.3fr)_minmax(0,1fr)]` with `divide-x`. Left: the student's polygon, read-only, 160 px. Middle: "Majors / fields of study" (multi, intended majors, Other placeholder "Add a major"), "School size" (Small "under 2,000", Medium "2,000 to 15,000", Large "15,000 to 30,000", Very large "30,000+"), "Location type" (Rural, Small city, Major city, Suburban, College town), "Test optional?" (Yes / No, clearable). Right: "Distance" (`RadiusMap`, 50 to 3000 in steps of 50, default 500), "Financial aid" (No preference, Lenient, Limited) and "Diversity" (No preference, Yes, No), per open question 7. "Add to list" calls `addStudentCollege` and updates the record context. Delete `CollegeListSurface.tsx` (its scattergram, BA/MD section, SAT/ACT fields, confirm gate and ranked list).

**Done when (7.11 and 7.12).**
- [ ] Each chip opens its panel under the textbox holding exactly the sketch's controls.
- [ ] Dragging either map grows the circle and shrinks the centre; with no home set, the map says why and offers to set it.
- [ ] The College List answer changes when the constraints change, and "Add to list" lands on the student's list.

### Step 7.13 [app] College research (TODOv6 Step 13)

Opened from Tools: the greeting and a textbox for the college or question, then two bubble groups under it, "Research types" (Report, Presentation, Debate, plus an "Other" pill input, aria "Other research type"; typing in it sets the mode to "other") and "Find" (Events, Updates). Default mode: `mode ?? (other ? "other" : "report")`. Results are real (Step 7.6). Chats file under the "College research" group with titles such as "MIT: updates".

### Step 7.14 [app] AxIS cleanup

1. `rg -n "Scattergram|EssayReview|SchoolReframing|Newsreel|ContextPicker|ConversationRail|ToolSurface" app components lib` returns nothing.
2. `lib/api.ts`: remove `generateSchoolReframing`, `SchoolReframingItem`, `Profile.schoolReframing`, `generateNarrativeCoherence` (after Step 7.9), `runConcierge` (after Step 7.11), `reviewEssay` and the essay-review section (keep the `EssayMark` union only if marks stay readable), `getEssayAdvice` and `checkDraftQuality` if still unused, `renameConversation` if unused.
3. The student page's Ask AxIS link (Step 3.5) opens into that student's group.
4. `app:AGENTS.md`: the essay-guardrail paragraph (Coherence is the only AI surface that reads prose; SSR and 2D are gone; enforcement lives in `enforceNoProse` on coherence findings, no free-text streaming for guarded tools, the `ai_messages` CHECK, the `AxisAnswer` union, and the printed `GuardrailNote`); the Information architecture line ("Meridies LLM" becomes AxIS); Key files for the new components.

---

## Phase 8: docs and the final walkthrough

### Step 8.1 [both] AGENTS.md, README, final walkthrough

**Do.**

1. `app:AGENTS.md`:
   - Information architecture: "Overview · College Profiles · Calendar · Files · Settings · AxIS" (Dashboard and Student Profiles merged; `/students` redirects; the student page is an info card, an icon row of popups, tasks, alerts and the work queue).
   - Naming: "Meridies" and the slogan in `font-brand`; AxIS wears `MeridiesMark`.
   - Do not: the caption rule (Step 1.3).
   - Design system: the font line; BrandProvider applies the practice accent only under `/dashboard`; the icon-tile styling decision (D1).
   - Connected apps: Connections is a popup on Files; Essays and Files import through `RemoteFilePicker`.
   - The essay guardrail paragraph (Step 7.14).
   - Key files: `lib/nav.ts`, `lib/useSidebar.ts`, `lib/topBar.ts`, `lib/forest.ts`, `lib/tasks.ts`, `lib/axis.ts`, `lib/composerSuggestions.ts`, `lib/student-record-context.tsx`, `lib/wordCount.ts`, `lib/readDocument.ts`, `lib/essays.ts`, `lib/collegeList.ts`, `lib/applicationSheets.ts`, `components/splash/*`, `components/overview/StudentProfiles.tsx`, `components/student/*`, `components/dashboard/{GlobalSearch,QuickIcon,MyWorkQueueCard,WorkQueueRows}.tsx`, `components/files/{FilingModal,ConnectionsModal}.tsx`, `components/assistant/{AxisPanel,CoherencePanel,ActivitiesPanel,CollegeListPanel,BubbleGroup,RadiusMap}.tsx`.
2. `be:AGENTS.md`: the tree (`routes/workItems.ts`, `routes/referrals.ts`, the messages routes, `lib/documentText.ts`, `lib/geo.ts`); "Three rules the schema encodes" gains `guardians`, `counselor_work_items`, `student_counselor_notes`, `referrals`; the scheduled jobs section gains the message dispatcher; the AI section (Step 7.7); the catalog seed paragraph (Step 4.4); the environment table (`MESSAGE_DISPATCH_INTERVAL_MINUTES`, `OUTBOUND_FROM_EMAIL`).
3. `app:README.md` is stale (it describes a mocked `localStorage` prototype with invite codes and `/reset`). Rewrite: stack, fonts, environment, and routes: `/` splash then role picker; `/dashboard/counselor` Overview; `/dashboard/counselor/students/[id]`; `/colleges`; `/calendar` (Calendar | Tasks); `/intake`; `/invitations`; `/data-hub` (Files); `/settings`; `/assistant` (AxIS); the student routes including `/flags`.
4. Walkthrough, desktop and 375 px, against a seeded counselor with at least one student in each state:
   - splash, sign up, log in (a stored practice accent does not tint the public pages);
   - Overview: banner, My Work Queue ticks persist, cards filter with counts, `/dashboard/counselor/students` redirects;
   - a student: info card fields and notes autosave; all ten popups (College list edits, Essays upload from computer and from Drive, Meeting notes, Strength profile Edit, Activities and Awards with the Common App / UC switch, Student aid with no FAFSA, Scholarship Rescan and Recommend, Communication send, schedule and file as report, Upload files with Exclude from AI); Assigned tasks; Alerts; My Work Queue;
   - College Profiles: compare two, then three schools;
   - Files: upload, paste a link, filing confirmation, Connections;
   - AxIS: pick a student, run Coherence, Activities Build and the College List Builder (Add to list), then College research (Report, Events, Updates);
   - Invitations: invite, resend, revoke, a referral from ask to Joined;
   - Calendar → Tasks.
5. Final greps in the app:
   ```bash
   rg -n -i "fafsa|efc\b|social security" app components lib        # only school aid-methodology labels
   rg -n "font-display|Instrument|Meridies LLM|workload" app components lib
   rg -nw "NCE|POC|ICLB|ESSAY2D|SSR|IPT|ACRH" app components lib
   rg -n "subtitle=|description=|detail=" app/dashboard components  # design kit and deliberate tips only
   rg -n "mockData|lib/storage|resetDemo|ResetDemo|DEMO_TODAY|Ithaca" app components lib
   ```

---

## Appendix A: migrations in order

All in `be:supabase/migrations/`. Apply in this order; each ships its own RLS.

| # | File | Step | What |
|---|---|---|---|
| 1 | `20260929000001_guardians_counselor_writes.sql` | 0.1 | Guardians counselor-only writes; unique email per student |
| 2 | `20260929000002_delete_fafsa.sql` | 0.3 | Drop FAFSA / EFC columns and the checklist item |
| 3 | `20260929000003_counselor_work_items.sql` | 2.2 | `counselor_work_items`, owner-only |
| 4 | `20260929000004_student_personal_details_and_notes.sql` | 3.1 | `student_personal_details` (student-scoped), `student_counselor_notes` (counselor-only) |
| 5 | `20260929000005_aid_v6.sql` | 3.2 | CSS `verified`, notes, numeric family inputs |
| 6 | `20260929000006_scholarship_recommendations.sql` | 3.3 | `recommended` status, timestamps, unique match per scholarship |
| 7 | `20260929000007_college_list_v6.sql` | 4.1 | Catalog fee, `flexible` test policy, `college_supplements`; `student_colleges` SCEA, v6 statuses, custom deadline, major, recs, testing, fee; counselor-only fit and custom deadline trigger |
| 8 | `20260929000008_application_sheets_v6.sql` | 4.2 | Nullable names, UC columns, award levels, value checks |
| 9 | `20260929000009_essays_v6.sql` | 4.3 | Essay kind, links to list row, prompt and document; DB word counts; same-student guard |
| 10 | `20260929000010_seed_v6_catalog.sql` | 4.4 | Generated: fees, supplements |
| 11 | `20260929000011_composer_messages.sql` | 5.1 | Composer prefs, `outbound_messages`, multi-guardian alerts, `composer-draft` module |
| 12 | `20260929000012_referrals_and_invitation_notes.sql` | 5.4 | `referrals` (counselor-only), invitation `note` and `audience` |
| 13 | `20260929000013_college_photos.sql` | 6.1 | Photo columns and licence checks, `college-photos` bucket |
| 14 | `20260929000014_seed_college_photos.sql` | 6.1 | Generated after Step 6.0 |
| 15 | `20260929000015_college_profile_facts.sql` | 6.2 | Net price bands, student life, application requirements |
| 16 | `20260929000016_seed_college_profile_facts.sql` | 6.2 | Generated |
| 17 | `20260929000017_axis_v6_chat.sql` | 7.1 | Conversation criteria, message tool / payload / reasoning, the coherence bullets CHECK |
| 18 | `20260929000018_axis_geography.sql` | 7.3 | Student home, ZCTA table, college and program geography, setting, diversity, type, duration |
| 19 | `20260929000019_college_events.sql` | 7.6 | `college_events` |

Also export the existing `student-documents` bucket and its `storage.objects` policies into a migration (Step 6.1); they are configured outside the repo today. Optional migrations mentioned along the way: a polygon-write guard trigger (0.2), `student_polygon_axes.hidden` (3.10 parity), a `deliverable_stages` status trigger (3.4), `college_admitted_profiles` (6.2), `colleges.aka` (7.6).

---

## Appendix B: routes added, changed and retired

**Added**

| Method and path | Step |
|---|---|
| `GET/POST/PATCH/DELETE /work-items` | 2.2 |
| `PUT /students/:id/personal`, `PUT /students/:id/note` | 3.1 |
| `GET /aid/checklist/grid`, `PUT /aid/checklist/cell` | 3.2 |
| `POST /aid/scholarships/scan`, `GET /aid/scholarships/feed`, `POST /aid/scholarships/:id/recommend` | 3.3 |
| `POST /essays/from-document`, `POST /essays/sync` | 4.3 |
| `POST /intake/apply` | 4.2 |
| `GET /messages/senders`, `POST /messages`, `GET /messages`, `POST /messages/:id/cancel` | 5.2 |
| `POST /internal/messages/dispatch` | 5.2 |
| `POST /ai/compose` | 5.3 |
| `GET/POST/PATCH/DELETE /referrals`, `POST /referrals/:id/invite`, optional `POST /invites/:id/resend` | 5.4 |
| `POST /reports/family` | 5.5 |
| optional `GET /files/documents/:id/text` | 6.4 |
| `PUT /students/:id/home`, `GET /places` | 7.3 |
| `GET /colleges/:id/events`, `GET /colleges/:id/updates` | 7.6 |

**Changed**

| Route | Step | Change |
|---|---|---|
| `/accountability/guardians` | 0.1 | Counselor-only writes, camelCase DTO, normalised email and phone |
| `PUT/PATCH/DELETE /polygon/axes*` | 0.2 | Counselor-only |
| `GET/PUT /aid/profile`, `/aid/checklist` | 0.3, 3.2 | No FAFSA / EFC; new fields |
| `POST /ai/narrative-coherence` | 0.4 | Returns stored rows (until retired) |
| `POST/PATCH /files/links`, `/files/documents` | 0.5 | `student_id` from the folder |
| `GET /high-schools/:id/rank` | 0.6 | Provenance-aware wording |
| `GET /students` | 2.2 | `polygon`, `gpaWeighted`, `nextMeeting` (and `home`, 7.3) |
| `GET /students/:id`, `PATCH /students/:id` | 3.1 | Personal details, guardians, note, phone, high school id |
| `PATCH /tasks/:id` | 3.4 | `stagesDone` |
| `/student-colleges`, `/activities`, `/awards`, `/essays` | 4.1-4.3 | Nullable v6 fields, embeds, serializers, no client `word_count` |
| `GET /colleges/:id` | 4.1, 6.3 | Supplements, photo, profile facts |
| `GET /colleges` | 6.3 | Photo, curated generosity, net price at the band, DB limiter |
| `POST /integrations/:provider/files/import` | 4.3, 6.4 | Optional `essay`; optional practice-folder import |
| `GET /files/documents` | 4.3 | `essayBudget` |
| `GET/PUT /accountability/alert-prefs` | 5.2 | Composer audience and channel |
| `POST /accountability/parent-alerts` | 5.2 | `guardianIds`, `sendAt`; delivered by the dispatcher when held |
| `POST /invites`, `GET /invites` | 5.4 | Note, audience, already-joined 409, `expired` |
| `POST /ai/file-filing` | 6.4 | Accepts `url` |
| `POST /chat/conversations`, `POST /chat/conversations/:id/messages` | 7.1 | Criteria, `answer` event, persisted payload and reasoning |

**Retired**

| Route | Step |
|---|---|
| `GET /colleges/:id/scattergram` | 6.3 |
| `POST /ai/school-reframing` | 7.7 |
| `POST /ai/essay-review` (410) | 7.7 |
| `POST /ai/college-list` | 7.7 |
| `POST /ai/narrative-coherence` (after 7.9) | 7.7 |
| `POST /ai/concierge` (after 7.11, or alias) | 7.7 |
| `GET /aid/checklist` (after 3.11) | 3.2 |

---

## Appendix C: demo file to app file map

| Demo | App action | Step |
|---|---|---|
| `components/MeridiesMark.tsx` | Replace | 1.1 |
| `components/Wordmark.tsx`, `app/layout.tsx`, `app/globals.css` | Modify | 0.8, 1.1 |
| `components/dashboard/DashboardUI.tsx` (`CountPill`, `Tooltip`, `InfoTip`, Modal `size`, `MODAL_STACK`) | Modify | 1.2 |
| `components/student/InlineEdit.tsx`, `lib/wordCount.ts` | Create | 1.2 |
| `components/AuthShell.tsx`, `TextField.tsx`, `Select.tsx`, `PrimaryButton.tsx`, `GoogleButton.tsx`, `RoleCards.tsx`, `app/login`, `app/signup` | Replace / modify | 1.4 |
| `components/splash/*`, `components/WelcomeLanding.tsx`, `app/page.tsx` | Create / replace | 1.5 |
| `components/branding/BrandProvider.tsx` | Replace | 0.8 |
| `lib/nav.ts`, `lib/useSidebar.ts`, `lib/topBar.ts`, `components/dashboard/QuickIcon.tsx`, `components/dashboard/GlobalSearch.tsx` | Create | 2.1 |
| `components/dashboard/DashboardShell.tsx`, `DashboardSidebar.tsx` | Rewrite | 2.1 |
| `components/branding/BrandBanner.tsx`, `lib/forest.ts` | Replace / create | 2.3 |
| `components/dashboard/MyWorkQueueCard.tsx`, `WorkQueueRows.tsx` | Create | 2.3 |
| `components/overview/StudentProfiles.tsx` | Create | 2.3 |
| `app/dashboard/counselor/page.tsx` | Rewrite (`OverviewClient.tsx` replaces `CounselorDashboardClient.tsx`) | 2.3 |
| `app/dashboard/counselor/students/page.tsx` | Delete (plus `StudentsPageClient.tsx`, `StatusOverridePanel.tsx`); redirect in `next.config.ts` | 2.3 |
| `app/dashboard/counselor/calendar/page.tsx` (Tasks mode) | Modify | 2.4 |
| `app/dashboard/counselor/invitations/page.tsx`, `lib/referrals.ts`, `lib/invitations.ts` | Create (API-backed) | 2.5, 5.7 |
| `app/dashboard/counselor/students/[id]/page.tsx` | Rewrite `StudentProfileClient.tsx` | 3.5 |
| `components/student/Detail.tsx`, `StudentTaskCard.tsx`, `StudentAlertsCard.tsx`, `StudentWorkQueueCard.tsx` | Create | 3.5-3.7 |
| `components/dashboard/HighSchoolProfileCard.tsx` | Create as `components/student/HighSchoolProfileBar.tsx` | 3.5 |
| `lib/studentNotes.ts` | API-backed `StudentNoteField.tsx` | 3.5 |
| `components/student/StudentIcons.tsx`, `OverviewTiles.tsx` | Create | 3.8 |
| `components/StatPolygonHistory.tsx`, `StatPolygonEditor.tsx`, `StatPolygonCard.tsx` | Modify history; rows into `PolygonAxisRows.tsx`; delete `PolygonEditor.tsx` | 3.10 |
| `components/student/StudentAidPanel.tsx`, `components/dashboard/AidChecklistTable.tsx` | Create (replaces `StudentAid.tsx`) | 3.11 |
| `components/student/ScholarshipPanel.tsx`, `components/dashboard/ScholarshipFeed.tsx` | Create / rework | 3.11 |
| `components/dashboard/StudentFiles.tsx` | Modify | 3.12 |
| `components/student/CollegeListSheet.tsx`, `lib/collegeList.ts` | Create | 4.6 |
| `components/student/ApplicationSheets.tsx`, `lib/applicationSheets.ts` | Create | 4.7 |
| `components/student/EssaysPanel.tsx`, `lib/essays.ts`, `lib/readDocument.ts` | Create | 4.8 |
| `components/dashboard/StudentCommunication.tsx`, `lib/composerDrafts.ts`, `lib/alertPrefs.ts`, `lib/familyContacts.ts` | Rewrite / `lib/composerSuggestions.ts` / API-backed | 5.6 |
| `components/dashboard/ParentAlertModal.tsx` (deleted in demo) | Delete | 5.6 |
| `components/dashboard/CollegeCard.tsx`, `components/college/CompareColumn.tsx`, `CompareCharts.tsx` | Create | 6.5 |
| `components/dashboard/CollegeCompare.tsx` | Rewrite | 6.5 |
| `components/dashboard/Scattergram.tsx` (deleted in demo) | Delete | 6.5 |
| `app/dashboard/counselor/data-hub/page.tsx`, `components/dashboard/LinkUploads.tsx`, `FolderBrowser.tsx` | Rewrite / modify | 6.6 |
| `components/files/FilingModal.tsx`, `ConnectionsModal.tsx`, `components/dashboard/FilePreview.tsx` | Create | 6.6 |
| `components/files/StudentUploadsBoard.tsx` (deleted in demo) | Never existed in the app | none |
| `components/assistant/AssistantWorkspace.tsx`, `AxisPanel.tsx`, `lib/llmTools.ts`, `lib/axisChats.ts` | Rewrite / create / `lib/axis.ts` / API-backed | 7.8 |
| `components/assistant/CoherencePanel.tsx`, `lib/coherence.ts` | Create (options and criteria only) | 7.9 |
| `components/assistant/BubbleGroup.tsx`, `RadiusMap.tsx`, `lib/geo.ts` | Create (map centred on the student's home) | 7.10 |
| `components/assistant/ActivitiesPanel.tsx`, `lib/programs.ts` | Create (options only; matching is server-side) | 7.11 |
| `components/assistant/CollegeListPanel.tsx`, `lib/listBuilder.ts` | Create (options only) | 7.12 |
| `lib/collegeResearch.ts` | Server-side (7.6); app keeps `RESEARCH_TYPES`, `FIND_TYPES` | 7.13 |
| app `ConversationRail.tsx`, `ContextPicker.tsx`, `ToolSurface.tsx`, `CoherenceSurface.tsx`, `ActivitiesBuild.tsx`, `CollegeListSurface.tsx`, `EssayReviewSurface.tsx`, `Newsreel.tsx`, `tools.ts`, `SchoolReframingPanel.tsx` | Delete | 0.9, 7.8-7.14 |

---

## Appendix D: never port

- `components/ResetDemo.tsx`, `lib/resetDemo.ts`, `app/reset`, "Reset demo" in the sidebar account menu, and every `reset*()` export.
- `lib/storage.ts` (`saveDraft`, `loadDraft`, `getUser`, `saveUser`), `lib/wiring.ts`, the demo's `useGuardedUser`, the mocked Google sign-in (`MOCK_GOOGLE_USER`, `MOCK_COUNSELOR_NAME`).
- `MOCK_*` constants and every `SEED` fixture: work items, invitations `inv1`-`inv7`, referrals `r1`/`r2`, meetings, tasks, `COUNSELOR_EVENTS`, `DEMO_TODAY`, `demoNow`; fixture fields `stage`, `grade`, `lastActive`, `applications`, `nextDeadlineDate`, `suggested`, "ED I".
- Invented defaults: `usCitizen: true`, `livingWithParent: true`, `maritalStatus: "Single"`, the placeholder parent, `(555) 555-0100`, `PRACTICE_PHONE`.
- Fictional prose: `DESCRIPTION_SEEDS`, `UC_SEEDS`, `HONOR_SEEDS`, essay `DRAFTS`, `SAME_AS_STATEMENT`. These must never reach production data.
- Simulated behaviour: fake timers (tracker scan, scholarship Rescan, link reading, AxIS trace `STEP_MS`), the backwards-modelled polygon history, `rankPercentile` extrapolation below the lowest band, `studentOdds` shown as fact, `findPrograms` / `buildList` / `research()` over fixtures, `suggestFiling` / `suggestLinkFiling` filename heuristics, the fake mic, `mailto:` / `sms:` sending, attachment chips that upload nothing.
- Demo geography: `ITHACA`, `milesFromIthaca`, "Distance from Ithaca, NY"; the list builder's 31-school rounded `CATALOG`; `collegeResearch` `EVENTS` and `UPDATES`.
- `applicantCloud` and the PRNG, `HIGH_SCHOOL_RANK_PROFILES`, `rankFromWeightedGPA`, `HIGH_SCHOOL_OPTIONS` (the backend's `lib/classRank.ts` is the real analogue).
- `SOURCE_URL` provider home pages for essay cards (the app opens the real document).
- Styling that breaks app rules: hex status colours where tokens exist, the gradient / green-shadow / lift glass tile, `hover:-translate-y-px` and coloured shadows on essay cards, `bg-[#fbf3de]` honors tint, RadiusMap hex fills, `AXIS_GREEN` hard-coded.
- The splash line "Interactive demo. Nothing you enter leaves this browser."
- The demo's `/dashboard/assistant` path (the app keeps `/dashboard/counselor/assistant`) and its student-role AxIS path (the app's AxIS is counselor-only until decided otherwise).
