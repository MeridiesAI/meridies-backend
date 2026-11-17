# Drafted student profile: edit a not-yet-joined student like a real one

Design doc. Written in the plan file because plan mode allows no other writes; copy to `docs/superpowers/specs/2026-11-17-drafted-student-profile-design.md` in the backend and app repos when building.

## Context

A "Drafted Student" is the dashed **Building profile** card on the counselor Overview: an invited student who has not accepted yet. It is one row in `invitations` (email, name, grade, grad year, timezone, note, requested items, CSV extras, staged documents). Today the card body does nothing; the name links to the invitations list, and only the Documents button works. There is nowhere to record a phone number, parent, GPA or a note before the student joins.

Intent (Brandon): clicking a drafted student's card opens a profile the consultant can fill in like a real student's. The only difference is that the student hasn't accepted yet. When they accept, that information becomes their profile.

## Goals

- Clicking a Building profile card opens a full page, `/dashboard/counselor/invitations/[id]` (my call on the path), that looks and edits like the real student Overview's info card: Contact (email, phone, address, parent name/email/phone), Personal details (gender, birthday, citizenship, grad year, high school, first-gen, living with parent, marital status), Academics (GPA weighted/unweighted and scale, class rank, rigor, SAT, ACT, intended majors), plus the consultant's private note.
- Every field saves the way the real card does (text saves ~600 ms after typing stops, choices save on pick), and survives reload.
- **On accept, copy into the student's real profile, filling blanks only.** Anything the student already answered wins. Brandon chose this over "hold for review" and "consultant-only".
- Resending the invitation, or re-inviting the same address, keeps what was entered.
- Demo gets the same page with mock data.

## Non-goals

- College list, tasks, strength profile, communication and application sections for a drafted student. They need a real account.
- Syncing with Contact Pipeline contacts, which hold the same facts in `pipeline_contacts.info`. Possible follow-up: prefill `info` when a pipeline contact is invited.
- Per-field "added by your consultant" tags. The copy fills blanks only, so values just appear. I mentioned a tag when asking, and I'm leaving it out of v1 for size. Brandon can ask for it.
- Moving the Documents button onto the new page, and fixing `GET /invites/building` ignoring expiry.
- Demo simulating the accept-time copy.

## Anti-goals (a failure even if it technically works)

- The student's own onboarding answers get overwritten.
- Counselor-private data (the note) becomes visible to the student.
- One sibling's data lands on another's account (the reason import data is held). Info is bound to the invitation id, never matched by email.

## Constraints found in the code

- Checked-out `meridies-app` and `meridies-backend` are on stale branch `feat/pipeline-email-sequences`. **Build in fresh worktrees off `origin/main`** (backend ff2bc92, app 58988b9 at last fetch, demo e5a17c0). Never `git add -A` in shared checkouts.
- `profiles.id` references `auth.users`, so a drafted student cannot have a profile row. All detail tables (`student_personal_details`, `student_academics`, `guardians`, `student_private_notes`) key off `profiles(id)`. The real student page and `PATCH /student-page/:id/info` cannot be reused as-is.
- Counselor writes to `invitations` go through `request.db` (RLS client). Since migration `20261024000023_invitation_accept_state.sql` (grant at line 41, guard trigger at 47-89) the client may update only `status, full_name, grade_level, grad_year, timezone, intake_requests, dismissed_at, confirmed_at, submitted_at`. A new `info` column must be added to that grant and the guard's allowed list.
- `accept_invitation` (`20261024000062_accept_invitation_same_student.sql:40-122`) is SECURITY DEFINER and copies only `grad_year` and `timezone` if blank. Import data is deliberately held, not copied. This feature adds a *separate* accept-time copy for `info`, which Brandon chose.
- Resend revokes the old row and inserts a new one, so anything keyed to an invitation must move (`moveStagedDocuments`, `lib/invitationDocuments.ts:131`).
- A joined-but-unconfirmed student has `studentId` set. The card already links to the real student page in that case; keep that.
- Prod hardening: new tables need the approval gate (`private.attach_approval_gate`). A new column on an existing table does not.

## Approaches considered

1. **`info` JSON column on `invitations` (chosen).** Same idea as `pipeline_contacts.info`. One migration, one validator, API-only writes, small resend change, accept trigger copies blanks. Trade-off: the values are untyped until they reach the real tables, so the validator must be strict.
2. **Typed `invitation_profiles` table** mirroring personal details, academics and guardian. Cleaner types, but about four tables of duplicated columns kept in sync, plus an approval-gate step.
3. **Reuse `pipeline_contacts` as the store.** Rejected: drafts created via New student have no pipeline contact.
4. **Create a placeholder profile row.** Impossible (`profiles.id` references `auth.users`).

Surface: **full page (chosen)** over a modal on the card. Room for three columns, working back button, and it avoids stacking a second modal on the card that already has the Documents modal.

## Design

### Backend (`meridies-backend`)

1. **Migration** `2026112x…_invitation_info.sql`:
   - `alter table invitations add column info jsonb not null default '{}'` with a size check.
   - Add `info` to the client-writable grant and the guard trigger's allowed list.
   - `private.invitation_info_on_accepted()` trigger, SECURITY DEFINER, pinned `search_path`, `revoke … from public, anon, authenticated`, modeled on `invitation_documents_on_accepted` in `20261124000008_invitation_documents.sql:121-158`. On `status` going to `accepted` it copies from `new.info`, filling only where the destination is null/blank:
     - `profiles`: `phone`, `high_school`.
     - `student_personal_details` (insert if missing): `contact_email`, `address`, `gender`, `birthday`, `citizenship`, `first_gen`, `living_with_parent`, `marital_status`, `colleges_planned`, `intended_majors`.
     - `student_academics` (insert if missing): GPA fields, scale, rank, SAT/ACT, rigor.
     - `guardians`: create the primary guardian from parentName/parentEmail/parentPhone only if the student has none. The table requires an email or phone, so a parent name alone is not copied (shortcut: the name stays in the invitation's `info` and is lost at accept; upgrade if consultants hit it).
     - `student_private_notes`: `privateNote` only if there is no note yet.
   - Must run in the same transaction as `accept_invitation`, after `counselor_id` is set, and must not break if a destination row is missing. Check trigger ordering against the existing `profiles` counselor_id triggers.
2. **Routes** in `src/routes/invites.ts` (same `requireRole("counselor")` and `limit` style as `PATCH /:id`):
   - `GET /invites/:id/info`: returns the info in `StudentInfo` shape plus `{ invitation: { email, fullName, status, studentId } }`.
   - `PATCH /invites/:id/info`: body is `infoPatchSchema` (`lib/studentPage.ts:227-260`, reused as the validator) plus `privateNote` (max 4000, the `student_private_notes` limit). `gradYear` maps to the existing `invitations.grad_year` column, so the existing accept copy covers it. Everything else merges into `info`, and null/"" removes the key. Returns the merged info.
   - Errors: 404 for another counselor's invitation, 409 `invitation_accepted` / `invitation_closed` (same codes as documents) so the page can redirect to the real student page.
3. **Resend and re-invite** (Brandon chose "only if it's the same student"): `insertInvitation` carries `info` from the pending invitation it revokes only when (a) the call is the card's Resend (`POST /:id/resend`, same invitation id), or (b) the old and new full names are non-blank and equal, using the existing same-student rule (`sameStudentName` in `src/lib/invites.ts`, `private.invitation_same_student` in SQL). Otherwise the info stays on the revoked row and is not copied. A nameless draft re-invited from New student therefore loses its info; Resend keeps it. A dismissed (`dismissed_at`) draft's info follows the same rule, so it never leaks to an unrelated invite. Add `info` to `INVITATION_COLUMNS` handling as needed. Test: sibling at the same address does not receive the other's info; Resend and same-name re-invite do.
4. Backend `AGENTS.md`: document the new endpoints, the accept copy rule, and the "fill blanks only" guarantee.

### App (`meridies-app`)

- `lib/api.ts`: `getInvitationInfo` and `patchInvitationInfo` wrappers (next to the staged-documents ones, ~4829-4895). `app/actions.ts`: `patchInvitationInfoAction` (next to `updateInvitationAction`, line 299).
- New page `app/dashboard/counselor/invitations/[id]/page.tsx` plus a client component. It loads `GET /invites/:id/info`; if the invitation is accepted and has `studentId`, it redirects to `studentHref`. Layout: header (name or email, a "Hasn't joined yet" badge), a one-line banner ("What you add here fills in their profile when they accept"), then the existing `components/student/StudentInfoCard.tsx` with `onPatch` wired to `patchInvitationInfoAction`, then the private-note textarea (reuse the one in `StudentOverviewClient.tsx`).
- Check which `StudentInfoCard` props are optional (`transferredFrom`, `fromQuestionnaire`, high school profile). Pass empty values rather than forking the card.
- `components/overview/BuildingCard.tsx:62`: for a not-joined card, `href` becomes the new page. Apply the same rule in the list-view row (`StudentProfiles.tsx:438`) and the request rows (`BuildingCard.tsx:151`). Make the whole card clickable without nesting interactive controls (Documents, remove X, request rows): use the existing stretched-link pattern. Do not add axe nested-interactive violations.
- App `AGENTS.md`: note the new route and the card's click target.

### Demo (`meridies-demo`)

- Port the same page at `app/dashboard/counselor/invitations/[id]/page.tsx`, rendering `components/student/StudentInfoCard.tsx` with `useStudentInfo(id)` from `lib/profileEdits.ts` (keyed `profile:<id>`; falls back to `EMPTY_INFO` for `new-*` ids), plus a notes box.
- `components/overview/NewStudentCard.tsx:80`: the name (and card) link to it.
- Demo `AGENTS.md`: record that accept-time copy is not simulated.

## Verification

- **Backend integration test** `test/integration/invitation-info.test.mjs`, in the style of `invitation-documents.test.mjs`:
  - PATCH then GET round trip.
  - Refusals: bad email, SAT out of range, unknown key.
  - Another counselor gets 404.
  - 409 after accept.
  - Resend keeps `info`.
  - **Accept copies into blanks and leaves pre-filled values alone.** Pre-fill the student's phone or GPA first, then check it wins.
  - Guardian created only when none exists; the note is not overwritten.
  - The student cannot read the private note.
- **App Playwright stack spec** `e2e/stack/invitation-info.spec.ts`, mirroring `invitation-documents.spec.ts`: create a student, click the card, edit phone, GPA and parent, reload and confirm they persist, then accept as the student and confirm the values on their profile and the card gone.
- Use the isolated local stack from the "Local verification recipe" memory (Supabase on 563xx, psql wrapper, Playwright on system Chrome). The :3000/:4000 dev servers hit **prod**, so do not use them.
- Demo has no e2e directory: typecheck and build, then click through manually.
- Run `npm run check:invitation-documents` and `check:drafted-folders` to confirm no regression.
- **Order:** backend migration applied to prod first, then backend, app, demo. Brandon merges. Until the migration is applied the new routes return 503 and the card keeps its old behaviour (feature-detect like `documentCount !== undefined`).

## Calls I made (Brandon can overrule)

- Storage: `info` JSON column on `invitations`, not a new table.
- Route path `/dashboard/counselor/invitations/[id]`.
- `gradYear` lives in the existing column, everything else in `info`.
- No per-field provenance tag in v1.
- Private note copied only if the student has none; capped at 4000 characters.
- Parent name alone (no email or phone) is not copied, because `guardians` requires one of them.
- Re-invite carries info only on Resend or an exact same-name match (Brandon's pick).
- Whole card clickable, with joined students still going to the real page.
- Demo does not simulate the accept-time copy.

## Left to the builder

Exact migration timestamp and trigger ordering, jsonb key naming inside `info`, the stretched-link implementation, whether `StudentInfoCard` needs optional-prop tweaks, and test fixtures.
