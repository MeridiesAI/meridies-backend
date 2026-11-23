# Student Forums (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The table, row-level security and API behind Student Forums: students post, the author's assigned counselor approves or rejects, other students read approved posts.

**Architecture:** One table `forum_posts`. Clients get **select only**; every write goes through the API, which checks authorization in code and then writes with the service role (the Contract Hub pattern). Reads go through the caller's own RLS client, so the row-level policies are the read rule. The post rules are the demo's `lib/forumPosts.ts`, copied byte for byte. The feature answers 503 `forums_unavailable` until its migration is applied, so the code can ship first.

**Tech Stack:** Fastify, zod, Supabase (Postgres + RLS), `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-11-23-student-forums-design.md` (Phase 2, backend). The finished demo is `meridies-demo#127`: `lib/forumPosts.ts` is the rules source.

## Global Constraints

- Worktree `/Users/brandoncha/Meridies/wt-forums-backend`, branch `feat/student-forums`, cut from `origin/main` 83fb118. Stage explicit files, never `git add -A`. Commits stay local until Brandon says push. Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Migration: file name `20261201000001_student_forums.sql` (sorts after `20261130000002`; never `--include-all`). Additive only, re-runnable (`if not exists`, `drop policy/trigger if exists`, `create or replace`), header states the deploy order, **not in `REQUIRED_SCHEMA`**. A new table must call `select private.attach_approval_gate('public.forum_posts');` or CI fails. **Do not apply the migration anywhere but a local stack.** Applying it to production is the go-live and needs Brandon's explicit OK.
- Run tests only against an isolated local stack (memory `local-verification-stack-recipe`: ports 563xx, never :3000/:4000 or the 54xxx stacks, which belong to others). Unit tests need a clean env.
- Code rules (`AGENTS.md` "Safe coding standards"): zod `.strict()` on every body, ESM imports end in `.js`, thin handlers with logic in `src/lib/`, no `any`, never log a body, authenticate **and** authorize.
- The rules file `src/lib/forumPosts.ts` is a **byte-for-byte copy** of `meridies-demo/lib/forumPosts.ts` (`cmp` it); never edit the copy. Change all three repos together.
- API contract (below) is fixed: the app plan builds against it.
- Spec call 9: "the author's counselor" is the **assigned counselor only** (`profiles.counselor_id`, and an approved counselor). Never `private.can_view_student` and never `private.is_counselor_of` (both admit collaborators; the first admits the student).

## API contract

```ts
type ForumPostDto = {
  id: string;
  kind: "thought" | "video" | "creator" | "food";
  title: string;
  body: string;
  url: string | null;
  status: "pending" | "approved" | "rejected" | "reported";
  college: { id: string; slug: string; name: string };
  authorFirst: string;
  authorYear: string | null;
  mine: boolean;                 // the caller wrote it; no author id is ever sent
  reviewNote: string | null;     // only to the author and the assigned counselor, else null
  reportedAt: string | null;     // same
  createdAt: string;
  updatedAt: string;
};
```

| Route | Who | Body / query | Returns |
|---|---|---|---|
| `GET /me/forums` | student | `view=feed\|mine` (default feed), `collegeId` (uuid), `kind`, `limit` (default 100, max 200) | `{ posts: ForumPostDto[] }` |
| `POST /me/forums` | student | `{ kind, collegeId, title, body?, link? }` | 201 `ForumPostDto` |
| `PATCH /me/forums/:id` | author | partial of the same | `ForumPostDto` |
| `DELETE /me/forums/:id` | author | | 204 |
| `POST /me/forums/:id/report` | student, not the author | | `{ reported: true }` |
| `GET /forums/review` | counselor | `tab=review\|approved` (default review), `limit` (default 100, max 200) | `{ posts: ForumPostDto[]; counts: { review: number; approved: number } }` |
| `POST /forums/:id/review` | assigned counselor | `{ decision: "approve"\|"reject", note?, updatedAt }` | `ForumPostDto` |

Errors: 503 `forums_unavailable` (migration not applied); 400 with code `forum_title`, `forum_college`, `forum_body` or `forum_link` and the rules module's own message (the app puts it under that field); 404 for a post the caller can't see; 409 `forums_no_counselor` ("Connect with a counselor to post."), 409 `forums_counselor_unavailable` ("Your counselor can't review posts yet."), 409 `forum_post_changed` ("This post changed. Reload to see the latest.").

## Plan decisions the spec leaves open (flag at review)

1. **Display name is a snapshot** on the row (`author_first`, `author_year`), taken from the author's profile at create and edit. No cross-student profile read exists anywhere, and none is added.
2. **Notices reuse notification kind `system`** (the `essayNotice.ts` pattern, never throws, rate-limited), so `notifications_kind_check` is not redefined (another in-flight migration editing it would clobber this one).
3. **Review needs `updatedAt`** (what the counselor was shown). The write is `where updated_at = <that>`; a post edited since answers 409. This closes "approving something the author just changed".
4. `college_id references colleges(id) on delete cascade` (the spec said set null, but a post with no college is unusable).
5. A link's stored length is rechecked after normalization in the route (the shared rules check the raw text), so the DB's 2,000-character check can never be the first to refuse it.
6. The feed has `limit` but no cursor (`shortcut: newest 200 at most, add a keyset cursor when a college passes that`).
7. Editing is refused for a student with no counselor, the same as posting.
8. The allowlist is the shared rules' (`youtube.com`, `youtu.be`, `tiktok.com`, `instagram.com`, matched by host), so a redirector on an allowed host such as `l.instagram.com/?u=…` is accepted. Counselor review is the guard for v1; tightening it is a change to the shared file in all three repos (carried over from the demo's final review, still open).

## Review Focus

1. A student reads another student's `pending`, `rejected` or `reported` post (must not). [Task 2]
2. A read-only collaborator or the author approving a post (must not). [Task 2, Task 4]
3. A student writing straight to `/rest/v1/forum_posts`, including setting `status = 'approved'` (must be refused). [Task 2]
4. A counselor reviewing a post of a student who is not theirs, or whose counselor is unapproved. [Task 2, Task 4]
5. A video link on a lookalike host, and a 1,995-character link that grows past 2,000 once normalized. [Task 3]

---

### Task 1: Rules module copy

**Files:**
- Create: `src/lib/forumPosts.ts` (byte copy of `/Users/brandoncha/Meridies/wt-forums-demo/lib/forumPosts.ts`)
- Create: `test/unit/forum-posts.test.ts`

**Interfaces:**
- Produces (unchanged from the demo): `checkDraft(d: { kind; collegeId; title; body; link }): { ok: true; title; body; url } | { ok: false; field: "title" | "college" | "body" | "link"; message }`, `checkLink`, `newPost`, `editPost`, `reviewPost` (throws `RangeError("A rejection needs a note.")`), `reportPost`, `canReport(p, viewerId)`, `canPost(counselorName)`, `type ForumPost`, `type ForumKind`, `type ForumStatus`, `LINK_MAX`.

- [ ] **Step 1: Write the failing test** `test/unit/forum-posts.test.ts` (`node:test`, import from `../../src/lib/forumPosts.js`). Names and assertions:
  - `a video link must be on the allowlist, by host`: `checkLink("video","https://youtube.com.evil.example/x")` is `{ok:false, message:"Use a YouTube, TikTok or Instagram link."}`; `checkLink("video","youtu.be/abc")` is `{ok:true, url:"https://youtu.be/abc"}`.
  - `http and javascript links are refused`: both give `"Links have to start with https://."`.
  - `a draft reports the first problem with its field`: blank title → `{field:"title"}`; kind `thought` with blank body → `{field:"body", message:"Write your thought."}`.
  - `editing a reported post keeps the report`: `editPost(reportPost(approvedPost, t), {title:"x"}, t2)` has `status "pending"` and `reportedAt` equal to `t`.
  - `rejecting needs a note`: `assert.throws(() => reviewPost(post, "reject", " ", t), RangeError)`.
  - `only a live post by someone else can be reported`: `canReport` true for approved by another author, false for own and for non-approved.
- [ ] **Step 2: Run it and see it fail.** Run: `npx tsx --import ./test/env.ts --test test/unit/forum-posts.test.ts` (clean env). Expected: FAIL, cannot find module `forumPosts.js`.
- [ ] **Step 3: Copy the file.** `cp /Users/brandoncha/Meridies/wt-forums-demo/lib/forumPosts.ts src/lib/forumPosts.ts`, then `cmp` them. No import is needed (the file has none), so only `tsc` strictness can object; if it does, fix the shared file in the demo repo, never here.
- [ ] **Step 4: Run it and see it pass**, then `npm run typecheck`. Expected: 6 pass, no type errors.
- [ ] **Step 5: Commit** `src/lib/forumPosts.ts test/unit/forum-posts.test.ts`.

---

### Task 2: Migration and the database's own rules

**Files:**
- Create: `supabase/migrations/20261201000001_student_forums.sql`
- Create: `test/integration/forums-db.test.mjs`

**Interfaces:**
- Produces, in `public.forum_posts`: `id uuid pk default gen_random_uuid()`, `student_id uuid not null references profiles(id) on delete cascade`, `college_id uuid not null references colleges(id) on delete cascade`, `kind text not null check (kind in ('thought','video','creator','food'))`, `title text not null check (char_length(btrim(title)) between 1 and 80)`, `body text not null default '' check (char_length(body) <= 600)`, `url text check (url is null or (url ~ '^https://' and char_length(url) <= 2000))`, `status text not null default 'pending' check (status in ('pending','approved','rejected','reported'))`, `review_note text check (review_note is null or char_length(review_note) <= 500)`, `reviewed_by uuid references profiles(id) on delete set null`, `reviewed_at timestamptz`, `reported_by uuid references profiles(id) on delete set null`, `reported_at timestamptz`, `author_first text not null check (char_length(author_first) between 1 and 40)`, `author_year text check (author_year is null or author_year ~ '^\d{4}$')`, `created_at`, `updated_at timestamptz not null default now()`. Table checks: `kind <> 'thought' or char_length(btrim(body)) > 0` and `kind not in ('video','creator') or url is not null`.
- Produces: `private.forum_is_assigned_counselor(p_student uuid, p_viewer uuid) returns boolean` (`language sql stable security definer set search_path = ''`: the student's `profiles.counselor_id = p_viewer` **and** `private.is_counselor(p_viewer)`; revoke from public and anon, execute to authenticated and service_role; model `private.contract_hub_owns` in `20261130000001`).
- Policies (select only, all `to authenticated`, `(select auth.uid())` wrapped): `forum_posts_select_author` (`student_id = uid`), `forum_posts_select_students` (`status = 'approved' and private.user_role(uid) = 'student'`), `forum_posts_select_counselor` (`private.forum_is_assigned_counselor(student_id, uid)`). Grants: `revoke all … from public, anon, authenticated; grant select … to authenticated`. Triggers: `set_updated_at` (`public.set_updated_at()`). Indexes: `(student_id, created_at desc)`, partial `(college_id, created_at desc) where status = 'approved'`, `(status, created_at)`. Last statement: `select private.attach_approval_gate('public.forum_posts');`.

- [ ] **Step 1: Write the failing integration test** `test/integration/forums-db.test.mjs` with the harness (`user`, `rest`, `sql`, `check`; `studentOf` from `imports-helpers.mjs`). Personas: counselor A (approved) with students A1, A2; counselor B (approved) with student B1; an unapproved counselor C (`user(tag,"counselor",{approved:false})`) with a student; a college id from `select id from public.colleges limit 1`. Insert rows with `sql()` (as the service role would). Checks, each a `check("…", cond)`:
  - A1 reads own `pending`, `rejected` and `reported` rows; **A2 and B1 read none of A1's non-approved rows** and read A1's `approved` row (cross-firm).
  - Counselor A reads A1's and A2's pending rows; **counselor B reads none**; counselor C reads none.
  - A `student_collaborators` read-only collaborator row for counselor B on A1 does **not** let B read A1's pending post.
  - **A1 cannot write**: `rest(tokenA1,"POST","/rest/v1/forum_posts", {...})` and a `PATCH … {status:"approved"}` on A1's own row are refused (assert not 2xx and the row is unchanged); counselor A's `PATCH` is refused too.
  - A parent account reads nothing (create one via the repo's parent helper if the harness has one, else skip with a note).
  - Check constraints: `sql` inserting `kind 'video'` with null url fails; `url 'http://x'` fails; a 2,001-character url fails; a blank title fails; `kind 'thought'` with blank body fails.
  - `private.forum_is_assigned_counselor(A1, counselorA)` true, `(A1, A1)` false, `(A1, counselorB)` false.
- [ ] **Step 2: Run it and see it fail.** Start the isolated local stack (recipe above) with the migrations **without** the new one, then run `node --import tsx --test test/integration/forums-db.test.mjs` with the stack's env. Expected: FAIL (`relation "public.forum_posts" does not exist`).
- [ ] **Step 3: Write the migration.** Header (first non-dash comment line is the one-line summary the run summary prints; then what the tables hold, the read rule, "Deploy order: either. Without this file every `/me/forums` and `/forums` route answers 503 `forums_unavailable` … Additive only. Not in `REQUIRED_SCHEMA`. Re-runnable."), then the schema above.
- [ ] **Step 4: Apply it to the local stack only and see the test pass.** Expected: every check passes. Also run the repo's gate scripts on it: `node scripts/migrations/plan.mjs` (or the command `DATABASE_MIGRATION_INSTRUCTIONS.md` names) must report the table with RLS and the gate and flag nothing destructive; `node --import tsx --test test/integration/approval-db.test.mjs` must still pass.
- [ ] **Step 5: Commit** the migration and the test.

---

### Task 3: Student API

**Files:**
- Create: `src/lib/forums.ts`, `src/routes/forums.ts`
- Modify: `src/app.ts` (import and `app.register(forumRoutes);` beside `contractHubRoutes`, routes use absolute paths)
- Create: `test/unit/forum-dto.test.ts`, `test/integration/forums.test.mjs`

**Interfaces:**
- Consumes: Task 1 exports; `app.authenticate`, `requireRole` (`src/lib/guards.ts`); `limit` (`src/lib/limits.ts`); `HttpError`, `fromPostgrest`, `notFound` (`src/lib/errors.ts`); `serviceClient()` (`src/lib/supabase.ts`, may be null → 503); `firstNameOf` (`src/lib/inactivity.ts`); `request.profile` (`id`, `full_name`, `counselor_id`, `grad_year`); `isCounselorApproved(svc, counselorId)` (`src/lib/access.ts`).
- Produces in `src/lib/forums.ts`: `type ForumRow` (the columns above plus the embedded `college: { id; slug; name }`), `FORUM_COLUMNS` (the select string with `college:colleges(id, slug, name)`), `rowToPost(row: ForumRow): ForumPost` (camelCase for the rules module, `inCaseload: true`), `toDto(row: ForumRow, viewerId: string, opts: { seesPrivate: boolean }): ForumPostDto`, `forumsUnavailable(): HttpError` (503 `forums_unavailable`, "Forums isn't switched on yet"), `forumErr(e: PostgrestError | null): HttpError` (missing-table codes `42P01 42703 PGRST200 PGRST202 PGRST204 PGRST205` → `forumsUnavailable()`, else `fromPostgrest`), `authorSnapshot(profile): { author_first: string; author_year: string | null }` (`firstNameOf(full_name)` with fallback "A student"; `grad_year` only if `/^\d{4}$/`), `draftError(r: Extract<DraftResult,{ok:false}>): HttpError` (400, code `forum_${field}`, the rules module's message).
- Produces routes: the student half of the contract table.

- [ ] **Step 1: Write the failing unit test** `test/unit/forum-dto.test.ts`: `toDto` omits `reviewNote` and `reportedAt` (null) when `seesPrivate` is false and keeps them when true; `mine` is true only when `row.student_id === viewerId`; the DTO has no `student_id`, `reviewed_by` or `reported_by` keys; `authorSnapshot({full_name:"Maria Lopez Garcia", grad_year:"2027"})` is `{author_first:"Maria", author_year:"2027"}`, a blank name gives `"A student"`, and `grad_year:"soon"` gives `null`; `forumErr({code:"42P01"})` is a 503 with code `forums_unavailable`.
- [ ] **Step 2: Write the failing integration test** (student half of `test/integration/forums.test.mjs`, API via `call`): 
  - a student with a counselor posts a `thought` → 201, `status "pending"`, `mine true`; the same student's `GET /me/forums` (feed) does not list it and `?view=mine` does.
  - a student with **no counselor** → 409 `forums_no_counselor`; a student whose counselor is **unapproved** → 409 `forums_counselor_unavailable`.
  - `video` with `https://youtube.com.evil.example/x` → 400 code `forum_link` and the allowlist message; a link of 1,995 characters of `é` (normalizes past 2,000) → 400 code `forum_link`, "That link is too long."; blank title → `forum_title`; unknown `collegeId` → 400 `forum_college`; a body field in `PATCH` of an unknown key → 400 (strict).
  - PATCH own post → back to `pending`, `reviewNote` null; PATCH another student's post → 404; DELETE own → 204 then 404; DELETE another's → 404.
  - After a direct SQL `update … set status = 'approved'`: another student's feed lists it with `mine false`, `reviewNote null`, no author id in the JSON; a second student reports it → `{reported:true}` and it leaves every feed; the **author reporting their own** → 409; reporting a non-approved post → 404.
  - `limit("me:forums:create:hour")` is wired: the 11th create in an hour → 429.
- [ ] **Step 3: Run both and see them fail.** Expected: unit FAIL (module missing), integration FAIL (404 route).
- [ ] **Step 4: Implement `src/lib/forums.ts`**, then the student routes in `src/routes/forums.ts` with the guard `const student = [app.authenticate, requireRole("student")];`:
  - `GET /me/forums`: `request.db` select with `FORUM_COLUMNS`; feed = `.eq("status","approved")`, mine = `.eq("student_id", userId)`; optional `.eq("college_id")`, `.eq("kind")`; `.order("created_at",{ascending:false}).limit(n)`; `seesPrivate` is `row.student_id === userId`.
  - `POST /me/forums`: `limit("me:forums:create:hour", 10, 3600)` and `limit("me:forums:create:day", 30, 86400)`; body `z.object({ kind, collegeId: z.string().uuid(), title: z.string().max(200), body: z.string().max(2000).default(""), link: z.string().max(4000).default("") }).strict()`; refuse a student with no `request.profile.counselor_id` (409) or whose counselor is not approved (409); `checkDraft` → `draftError`; after it, if `url.length > LINK_MAX` throw `draftError` with "That link is too long."; confirm the college exists on `request.db`; insert with `serviceClient()` `{ student_id, college_id, kind, title, body, url, status: "pending", ...authorSnapshot(profile) }`; re-select with `FORUM_COLUMNS`; reply 201; then `noticeForumPost(...)` (Task 4, until then a no-op import is not allowed: leave the call out and add it in Task 4).
  - `PATCH /me/forums/:id`: partial strict body; read the post on `request.db` with `.eq("id").eq("student_id", userId)` (404 if none); same counselor checks; merge the patch over the stored row, `checkDraft` the merged draft, apply `editPost` (via `rowToPost`), write `{ ...fields, status:"pending", review_note:null, ...authorSnapshot }` with the service role (`reported_at` is kept), return the DTO.
  - `DELETE /me/forums/:id`: read-own check then service-role delete; 204.
  - `POST /me/forums/:id/report`: `limit("me:forums:report", 30, 3600)`; read the post on `request.db` (404 if not visible); `if (!canReport(rowToPost(row), userId))` → 409 "That post isn't live." (or "You can't report your own post."); service-role update `{ status:"reported", reported_by: userId, reported_at: now }`; `{ reported: true }`.
  - Every query error goes through `forumErr`; `serviceClient()` null → `forumsUnavailable()`.
- [ ] **Step 5: Run both and see them pass**, then `npm run typecheck` and `npm run lint`. Expected: all pass.
- [ ] **Step 6: Commit** `src/lib/forums.ts src/routes/forums.ts src/app.ts test/unit/forum-dto.test.ts test/integration/forums.test.mjs`.

---

### Task 4: Counselor review and notices

**Files:**
- Create: `src/lib/forumNotice.ts`
- Modify: `src/routes/forums.ts` (counselor routes; add the notice calls to Task 3's create, edit and report), `test/integration/forums.test.mjs`

**Interfaces:**
- Consumes: Task 3's `toDto`, `forumErr`, `rowToPost`; `reviewPost`, `RangeError` from Task 1; the `essayNotice.ts` pattern (`serviceClient()`, `isCounselorApproved`, `consumeRateLimit(key, max, windowSec, log)`, insert into `notifications`, never throws).
- Produces: `noticeForumPost(request: FastifyRequest, authorId: string, counselorId: string, what: "sent" | "reported"): Promise<void>` — inserts a notification `{ recipient_id: counselorId, student_id: authorId, kind: "system", urgency: what === "reported" ? "normal" : "low", title: "<first name> sent a Forums post for review" | "A post by <first name> was reported", body: null, href: "/dashboard/counselor/forums", action_items: [], created_by: authorId }`; rate limits `forum-notice:sent:<authorId>` 1 per hour and 20 per day, `forum-notice:reported:<postId>` 1 per day; skips silently when the counselor isn't approved.

- [ ] **Step 1: Write the failing integration tests** (counselor half of `forums.test.mjs`):
  - after a student posts, counselor A's `GET /notifications` has one `system` row linking `/dashboard/counselor/forums`; a second post within the hour adds none; counselor B has none.
  - `GET /forums/review` (counselor A) lists A1's and A2's `pending` posts oldest first with `counts.review == 2`; counselor B sees none; `?tab=approved` lists only approved; a student calling it → 403.
  - `POST /forums/:id/review` approve with the right `updatedAt` → `approved`, `reviewNote` null, `reportedAt` null; **with a stale `updatedAt` → 409 `forum_post_changed`**; reject with a blank note → 400; reject with a note → `rejected` and the author's `mine` view shows the note; counselor B reviewing A1's post → 404; the author's own token → 403; a read-only collaborator counselor → 404.
  - Remove: reject on an `approved` post takes it out of every student feed.
  - a reported post is back in counselor A's `tab=review` with `reportedAt` set; approving it clears `reportedAt` and puts it back in the feed; an **author edit of a reported post keeps `reportedAt`** and it stays in review.
  - the report creates one `normal` notice to the **author's** counselor, not the reporter's.
- [ ] **Step 2: Run it and see it fail.** Expected: 404 on `/forums/review`.
- [ ] **Step 3: Implement** `forumNotice.ts` and the counselor routes with `const counselor = [app.authenticate, requireRole("counselor")];`:
  - `GET /forums/review`: `request.db` select (RLS shows only the assigned counselor's students' rows; `status in ('pending','reported')` oldest first for `review`, `approved` newest first for `approved`), plus two `head` count queries for `counts`; `seesPrivate: true`.
  - `POST /forums/:id/review`: `limit("forums:review", 120, 60)`; strict body `{ decision: z.enum(["approve","reject"]), note: z.string().max(500).optional(), updatedAt: z.string() }`; read the post on `request.db` (404 if RLS hides it; this is also the assigned-counselor check, since the policy is `forum_is_assigned_counselor`); a `rejected` post → 409; apply `reviewPost` through `rowToPost` (`RangeError` → 400 "A rejection needs a note."); service-role update `{ status, review_note, reported_at: null, reviewed_by: userId, reviewed_at: now }` **with `.eq("updated_at", body.updatedAt)`**; zero rows updated → 409 `forum_post_changed`; return the DTO.
  - Add `noticeForumPost` calls: after create and after PATCH (`what: "sent"`), after a report (`"reported"`, counselor looked up with the service role from the post's author: `profiles.counselor_id` only), each in `void noticeForumPost(...).catch(() => {})`.
- [ ] **Step 4: Run it and see it pass**, then the whole integration file and `npm run typecheck && npm run lint && npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `src/lib/forumNotice.ts src/routes/forums.ts test/integration/forums.test.mjs`.

---

### Task 5: Docs and whole-repo gate

**Files:**
- Modify: `AGENTS.md` (the `src/routes` tree near the other routes: `forums.ts  # /me/forums, /forums/review (Student Forums)`; a `###` section or bullet in the style of Contract Hub: migration id, tables, the read rule and why it is the assigned counselor only, the contract table's routes with limits, the 503 code and deploy order, the byte-copy contract for `forumPosts.ts`, "Not done: video uploads, replies, likes, a dedicated notification kind, a feed cursor", tests)

- [ ] **Step 1: Write the AGENTS.md entry.**
- [ ] **Step 2: Run the repo gate on the whole tree.** Run: `npm run typecheck && npm run lint && npm run build && npm test` (clean env) and the full `test/integration/*.test.mjs` against the isolated stack. Expected: all pass, including `approval-db.test.mjs`.
- [ ] **Step 3: Commit** `AGENTS.md`.
- [ ] **Step 4: Stop and hand back.** Do not push, do not apply the migration anywhere but the local stack. Report the plan decisions that need confirming and that the production migration is held for Brandon's explicit OK.
