# Caseload transfer: design

Status: v1 built (backend). Temporary delegation specified, deferred (§13).
Migrations: `20261023030001_caseload_transfer.sql`,
`20261023030002_caseload_transfer_functions.sql`,
`20261023030003_remove_firm_member_caseload.sql`.
Code: `src/lib/caseloadTransfer.ts`, `src/routes/management.ts`,
`src/routes/firms.ts`, `src/routes/account.ts`, `src/lib/studentPage.ts`.

## 1. Problem

A consultant leaves a firm, or the firm rebalances who works with whom. Today
a student is tied to one counselor by `profiles.counselor_id`, and only
`accept_invitation` writes that column, so nobody can move a student. About
twenty counselor-owned tables hold a student's history under the counselor's
id with `ON DELETE CASCADE` (meetings, meeting notes, family reports, messages,
documents and their folder, research runs, alumni records...). When the old
counselor's account is later deleted, that history goes with it. And
`remove_firm_member` lets a consultant walk out of the firm with every family
the firm signed, silently.

## 2. Scope of v1

- Transfers inside one firm, run by an owner or admin of that firm.
- Two modes, one vocabulary everywhere (database, API, app):
  - `one_person`: every student of the consultant, active and archived, to one
    receiver;
  - `per_student`: the admin assigns each student; a partial transfer (some
    students only) is allowed.
- Out of v1: solo-to-anyone transfers, a family consent step, an AxIS
  operation (the catalog never moves a caseload), transfers between firms,
  firm ownership transfer (still its own backlog item), temporary delegation
  (§13).

## 3. Who may transfer

The caller must be an approved counselor and an owner/admin of the firm of the
consultant whose students move (`private.is_counselor(me)` and
`private.crm_firm_admin(firm, me)`). A consultant who is not an admin cannot
hand over their own students in v1 (the app says "Ask a firm owner or admin").
A solo counselor is told: "Caseload transfer is between consultants in a firm.
Start a firm and invite your colleague first." The family signed with a
practice, so the data stays inside one.

**The owner's caseload.** Only the firm owner may transfer the owner's
students. An admin may transfer any other member's students, their own
included. The owner's practice items never move (§6.5): the owner can't leave
the firm, and handing ownership over is a separate step.

## 4. From and to

**From** is any counselor-role profile that is a member of the firm
(`crm_firm_member` and `profiles.firm_id` = the firm): approved, pending or
revoked. Revocation is exactly when a transfer is needed, so the from side is
never gated on approval. A consultant who already left the firm is solo, and
their students can't be transferred by the firm; that is why removal now
refuses an untransferred caseload (§10).

**To** (every receiver, and the practice receiver) must pass the approval
gate: an approved counselor (`private.is_counselor`), a member of the same
firm, with `profiles.firm_id` = the firm, and not the from consultant. A
pending or revoked colleague is refused with "{name} can't receive students:
only an approved consultant in this firm can". Any seat may receive. A
receiver who was a collaborator on a student loses the now redundant
`student_collaborators` row.

## 5. The two calls

`public.caseload_transfer_preview(p_from)`: read-only, same authorization.
Returns the from consultant, their students (name, class, archived, alumni,
onboarding, upcoming meetings), the possible receivers (approved members
except the from consultant, with their caseload sizes), counts of what would
move, the "Needs attention" counts, the practice items, and the firm's
setting. No email address leaves it.

`public.transfer_caseload(p_from, p_all_to, p_assignments, p_practice_to,
p_include_practice, p_remove_after, p_notify_students)`: one SECURITY DEFINER
call, one transaction, all or nothing. Exactly one of `p_all_to` (one_person)
and `p_assignments` (per_student, `[{studentId, toId}]`) is given. It returns
ids and names only; the API resolves addresses itself for the emails (§9).

## 6. What moves

The rule: **the student's record follows the student.** Every row about a
moved student that is owned by the old counselor, and would cascade away with
their account, is re-pointed. Practice-level rows move only when the whole
caseload goes and the consultant is leaving (§6.5).

### 6.1 Re-pointed, every row of the moved student owned by the old counselor

`profiles.counselor_id`; `meeting_notes`, `family_reports`,
`opportunity_requests`, `student_messages` (all statuses), `research_runs`,
`alumni_records`, `admission_outcomes` (rows of the student, locked ones
included: a closed cycle's row changes owner, nothing else),
`library_resource_pins` (student pins), the per-student
`accountability_settings` row (if the receiver already has one for that
student, theirs wins and the old row is deleted), `referrals` (an open ask the
receiver already has for that student wins; the duplicate is deleted), the
student's accepted invitation(s) (so onboarding, Building profile and intake
requests continue with the receiver), `supplement_docs` (see below).

**Files.** The student folder moves with its whole subtree (custom subfolders
under it, found by a recursive walk on `parent_id`), with every document and
document link in that subtree or about the student that the old counselor
owns. If the receiver somehow already owns a student folder for that student,
the old folder's contents and subfolders move into it and the old folder is
deleted. A document imported from the old counselor's Google Drive or OneDrive
keeps its stored copy; its live pointer (`external_provider`,
`external_file_id`, `external_drive_id`) is cleared, because the receiver's
account can't read the old counselor's drive. It is counted under "Needs
attention".

**Meetings.** A meeting moves when every attendee (`meeting_attendees`, which
always includes the primary) is a moved student going to the same receiver.
Otherwise (a group meeting split across receivers, or with a student who
stays) it stays with the old counselor, attendees untouched, and is listed
under "Needs attention" so it can be rebooked. A moved upcoming meeting that
was booked on the old counselor's Google or Outlook calendar keeps its
`join_url`, but its calendar pointer is cleared (the receiver's edits must not
call another person's calendar) and it is listed: "rebook these from your
calendar".

**Supplement Docs.** The row moves to the receiver, so it survives the old
account and the per-school unique index never blocks the receiver. The Google
Doc itself still lives in the old counselor's Drive (`drive.file`), so word
count syncing reports it as failed until it is shared or recreated. Listed
under "Needs attention": "Ask {from} to share or transfer these Docs in Google
Drive before their account is closed". The receiver may delete the row and
create a new Doc for that school.

### 6.2 Moved only while open or upcoming

`calendar_events` about the student on or after today (owner to the receiver,
`type_id` cleared because event types are per owner), open
`counselor_work_items`, open `consultant_tasks` assigned to the old counselor
about the student (top-level tasks; their subtasks follow the task so a
subtask always belongs to its task's consultant), and firm Contact Pipeline
contacts linked to the student whose owner is the old counselor (owner to the
receiver). Past calendar entries, finished work items and done tasks are the
old counselor's own history and stay.

### 6.3 Cancelled, not moved silently

Scheduled `student_messages` from the old counselor (status `cancelled`,
`hold_reason` "Cancelled: the student moved to another counselor before this
went out"), and queued or scheduled `parent_alerts` (status `cancelled`,
`suppressed_reason` "The student's counselor changed"). Dispatch would refuse
them anyway (the roster changed); cancelling says why, and the receiver sees
them and can rewrite them.

### 6.4 Carried over unchanged (keyed on the student)

Tasks (`created_by` / `assigned_by` history kept), red flags, private notes,
status overrides, alert prefs, guardians, essays, the college list, aid, the
polygon, recommendations, profile updates. **Private notes and status
overrides carry over**: one row per student, already readable by
collaborators, the practice's professional record, and the transfer stays
inside the practice. Clearing them would destroy them for good.

### 6.5 Practice items: only with the whole caseload, only when leaving

A rebalance must not take a working consultant's imports, templates, pipeline
or pending invitations. So these move only when **both** hold: after the move
the consultant has no student left (one_person, or per_student naming every
remaining student), **and** the call says the consultant is leaving
(`removeAfter`) or asks for it (`includePracticeItems`). Asking for them on a
partial transfer is refused. They go to one **practice receiver**
(`practiceToId`, else the one_person receiver, else the firm owner), who must
pass the same approval gate:

- the old counselor's remaining invitations (pending and revoked; the
  invitation preview then names the new counselor, and held import data keyed
  to the invitation follows on acceptance);
- their imports (`roster_imports`, with `import_files` and
  `roster_import_rows`), solo-era ones included, stamped with the firm so the
  firm's admins see them too;
- their import templates; on a `(counselor_id, fingerprint)` clash the
  receiver's template wins, imports that used the old one point at it, and the
  old one is deleted;
- firm pipeline stages and contacts they created, and firm contacts they still
  own; solo-era pipeline rows (`firm_id` null) are their own workspace and stay;
- firm library resources they created, and firm admission outcomes rows of
  theirs that no moved student carried;
- the firm's default receiver setting, if it named them, is cleared.

Import statuses, when practice items move:

| Status | What happens |
|---|---|
| `committing`, `undoing` | The whole transfer is refused, whatever the mode: "An import is still saving. Try again in a few minutes." |
| `profiling`, `staging` (a job is running) | Refused when practice items move (same message); a plain transfer goes ahead |
| `draft`, `review`, `mapping`, `importing` (the legacy browser flow) | Move. A draft or a staged review is finished by the practice receiver |
| `committed`, `complete`, `failed`, `undone`, `expired` | Move |

### 6.6 Held import data follows the student

Data held for a student who accepted an invitation sits in the import that
made it (§5.8 of the import spec), and an import holds many students, so the
import can't simply follow one of them. When a moved student has held items
(`awaiting_counselor`) in one of the old counselor's imports, those items and
their staged changes are moved by UPDATE into a **carrier import** owned by
the student's receiver: a `roster_imports` row in the firm that copies the
original's status, source system, dates and undo window, named after the
original file. The receiver then sees the data in their own "Ready to apply"
queue through the ordinary per-import access, applies it with the ordinary
functions, and gets the hold-expiry warning. Nothing in the import functions
changes. This also covers imports the old counselor made while solo
(`firm_id` null), which no firm admin can see. An item that is being applied
right now (`applying`) refuses the transfer until the job finishes. Items that
were already applied stay in the original import, so undoing it still undoes
them.

### 6.7 Stays with the old counselor

AxIS chats, actions and attachments (personal working notes), email
templates, integrations and tokens, their notifications, their pins (their pins
on moved students are deleted), past calendar entries, finished work items and
done tasks, `essays.link_owner_id` (a link they set reads with their own
grant), closed-cycle summaries (`admission_cycles`), and mixed group meetings
(§6.1).

## 7. Atomicity, concurrency, limits

One transaction. The from profile is locked `for update` first (so a
concurrent removal or a second transfer of the same caseload waits), then
every moving student row; a student no longer on the from roster refuses the
whole call ("N students are no longer on {from}'s caseload. Refresh and try
again"). Receivers are locked `for share` so an approval can't be revoked
halfway. Every update is set-based over a temporary mapping table; no loop
runs per student. The cap is **500 students per call** (route schema and
function), measured against the authenticated statement timeout in
`test/integration/caseload-transfer-load.mjs`; a larger caseload goes in
several per_student calls.

## 8. Record of it

`caseload_transfers` (one row per call: firm, from with frozen name, who ran
it, mode, practice receiver, whether practice items moved, counts) and
`caseload_transfer_students` (one per student: frozen student name, receiver
and frozen receiver name). Both have RLS and the approval gate; no client
writes them. Readable by the firm's owners/admins, by the from consultant
(their own transfers), and by any approved counselor who can view the student
(so the student page can say "Transferred from {name} on {date}"). The
cross-table checks go through SECURITY DEFINER helpers to avoid policy
recursion. `audit_log`: one `caseload.transferred` row (actor, entity = the
from profile, counts) and one `caseload.student_transferred` row per student
(`student_id` set).

## 9. Who is told

- **Receiver:** a `notifications` row (kind `system`, link to Overview) and
  one email listing their students (first 50, then "and N more") and the
  "Needs attention" items.
- **Each student:** one email, "{receiver} is now your counselor at {firm}",
  on by default; `notifyStudents: false` turns it off for the transfer.
  Archived students and alumni are never emailed.
- **Guardians:** not emailed in v1. The receiver writes to them through the
  Communication composer.
- **The old counselor:** one summary email (best effort; they may be leaving).

Email addresses are never returned by the SQL. After the transfer commits,
`lib/caseloadTransfer.ts` reads the addresses of exactly the ids the function
returned, on the service client (outbound delivery, which the client rules
allow; listed in `service-callsites.test.ts`), and sends through
`lib/email.ts`, so every send is a `message_deliveries` row (templates
`caseload-transfer-receiver`, `caseload-transfer-student`,
`caseload-transfer-from`). Names go in as escaped text. A failed email never
fails the transfer; the response counts sent and failed.

## 10. Removing a member

`remove_firm_member(p_profile, p_release_students default false)` refuses
(P0001, hint and API code `caseload_not_transferred`) while the member has any
student, archived included, unless `p_release_students` is true and the
caller is an owner/admin other than the member. Releasing is today's
behaviour: the students leave with the counselor. A member leaving themselves
with students is refused: "Ask a firm owner or admin to transfer your
students or release them to you". Removal also deletes the member's
collaborator grants on the firm's students, and, when students are released,
the firm colleagues' grants on those students. It clears the firm's default
receiver if it named the member, and writes a `firm.member_removed` audit row.
The 1-argument function is dropped so PostgREST never sees two candidates; the
old call `{ p_profile }` resolves to the new one with release off. AxIS's
`firm.remove_member` never passes the flag, so AxIS can never release
students.

"Transfer and remove" (`removeAfter`) runs the removal inside the transfer's
own transaction: either both happen or neither does.

## 11. The firm setting

`practice_settings.caseload_transfer_mode` (`one_person` | `per_student`,
default `per_student`) and `caseload_default_receiver` (nullable). A trigger
keeps the receiver an approved member of the firm, and forces it null on a
solo row. It pre-selects the transfer popup and decides what Remove offers:
`one_person` with a default receiver is one step, "Transfer all N to
{receiver} and remove"; `per_student` opens the per-student assignment. Read
by any member (`GET /firms/mine/caseload-policy`), changed by an owner/admin
(`PATCH`).

## 12. Account deletion

`DELETE /account` keeps refusing a counselor with students. A firm member is
now refused for archived students too (their history would cascade), with
"Ask a firm owner or admin to transfer them (Management › Transfer
caseload)". A solo counselor is still refused only for active students; their
archived students' counselor-owned rows still cascade on deletion. That gap is
known and left for a later item.

## 13. Temporary delegation (v2, specified only)

`student_collaborators` gains `expires_at timestamptz` and `reason text`.
Every helper that reads it (`is_counselor_of`, `can_edit_student`,
`counselor_can_edit_student`, and `src/lib/guards.ts`) adds `and (expires_at
is null or expires_at > now())`. A firm admin grants "cover for {from} until
{date}" per student or for the whole caseload; nothing is re-pointed, and
expiry needs no job. Deferred because it changes the helpers behind about 130
policies and needs its own RLS test pass.

## 14. Failure handling

Every refusal is raised with a counselor-readable message and a CRM error code
(P0001 conflict, P0002 not found, 22023 bad request, 42501 forbidden), which
`crmError` passes through. Nothing partial is ever left: the function is one
transaction, and "Transfer and remove" is inside it. Emails are after the
commit and best effort. Before the migrations are applied, the transfer,
preview, history and policy routes answer `503 { code:
"caseload_transfer_unavailable" }` (PGRST200, PGRST202, PGRST204, PGRST205,
42P01, 42703 and 42883 all count as "not applied"), the student page's `transferredFrom`
reads null, and `DELETE /firms/mine/members/:id` falls back to the 1-argument
function (remembered for five minutes per process), so removal behaves exactly
as today.

## 15. Security

- Both functions are SECURITY DEFINER with `search_path = ''` and
  schema-qualified names, EXECUTE revoked from `public` and `anon`.
- Authorization is the first thing each does; every id the client sends is
  checked against the firm (from, every receiver, every student).
- The function returns no email address. A firm admin could already see
  names (`firm_consultant_students`), not addresses.
- No route takes a counselor id it doesn't check: the transfer route's
  `:id` is the from consultant, verified in SQL.
- `test/integration/caseload-transfer.test.mjs` scans `pg_constraint` for
  every cascading foreign key to `profiles` on a table with a student column,
  and fails unless the table is handled by the transfer or is on an explicit
  "stays" list. A new counselor-owned student table has to be decided.

## 16. Testing

- Unit (`test/unit/caseload-transfer.test.ts`): body schemas (strict,
  discriminated, duplicate students, the 500 cap), the response dropping
  every email, email copy escaping names, the degrade code mapping, the
  1-argument fallback memo for removal, and the `caseload_not_transferred`
  mapping.
- Integration (`test/integration/caseload-transfer.test.mjs`), as real
  accounts: owner, admin, plain counselor (refused), student (refused),
  pending counselor as receiver (refused), solo counselor (refused);
  one_person and per_student transfers; every per-student table follows; a
  stale assignment moves nothing; a solo-era pipeline contact; a template
  fingerprint clash; an import in `review`; a solo-era import with held data
  reaching the receiver's queue and applying; a group meeting split across
  receivers; a subfolder and a supplement Doc surviving the old account's
  deletion; a consultant with only archived students transferred, then
  removed; removal refused, released, and allowed after a transfer; the
  student page with the transfer tables absent.
- Load (`test/integration/caseload-transfer-load.mjs`): 500 students in one
  call inside the statement timeout.
- Existing: `imports-*.test.mjs`, `approval-db.test.mjs`, `hardening.test.mjs`.

## 17. Rollout

Apply the three migrations in order, then deploy (either order is safe, §14).
None of it goes in `REQUIRED_SCHEMA`: no request outside this feature reads
it. Applying the migrations changes one behaviour on its own: removing a firm
member who still has students is refused until they are transferred or
released (the intended rule), including AxIS's `firm.remove_member`.
