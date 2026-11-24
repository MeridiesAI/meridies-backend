# Student Forums — design (2026-11-23)

## Context / intent
Meridies students are deciding where to apply and visit. They trust other students more than brochures. Forums is a new student-side tab where students post what they think of a campus: short thoughts, videos, links to creators from that college, and food spots worth visiting. Other Meridies students read them.

Today nothing a student writes reaches another student. This is the first student-to-student surface, so the risk is not the page. It is minors' content seen by minors, with no moderation anywhere in the product.

## Goals
- A student can post one of four kinds (`thought`, `video`, `creator`, `food`), each tied to one college.
- Every post is approved by the author's own counselor before any other student can see it.
- Students browse approved posts by college and kind.
- Phase 1 is a full click-through prototype in the demo. The real backend and app come after that is reviewed.

## Non-goals (v1)
- Uploading video files. Videos and creators are **links only**. Uploads need a new bucket, byte sniffing and playback.
- Replies, comments, likes, follows or notifications. (The `♥` in the earlier sketch was illustrative. **My call: it is out of v1.**)
- Third-party embeds or oEmbed link previews. A link card with "Watch on YouTube ↗" is enough. No iframe loads for minors, and the API never fetches the URL.
- Posting by anyone outside Meridies, such as current college students.
- Search, trending, or any ranking beyond newest-first.

## Anti-goals (a failure even if it works)
- Another student sees a post before the author's counselor approves it.
- The system itself adds any last name, date of birth, email, phone or school name to a post. (Text a student types is covered by counselor review and a hint in the form. See call 11.)
- A reported post stays visible until someone looks at it.
- A student with no counselor can post (nobody could approve it).

## Decisions the user made
- Authors: Meridies students. Readers: Meridies students, across all counselors and firms.
- Moderation: the author's counselor approves each post. No Meridies staff in the loop.
- Build order: prototype in the demo first, then backend and app.

## Calls I made (correct any of these)
1. **One table, `forum_posts`, with a `kind` column.** Not four tables.
2. **Display name is first name + class year.** The student's other fields are never exposed.
3. **A student with no counselor can read but not post.**
4. **Reporting hides the post immediately** and sends it back to the author's counselor's queue. Any student can report. A false report is cleared by the counselor approving again.
5. **Editing an approved post sends it back to pending.**
6. **A rejected post stays visible to its author** with the counselor's note, and the author can edit and resubmit.
7. **Link policy:** all links are `https` only, max 2000 chars. `video` and `creator` kinds are limited to an allowlist (`youtube.com`, `youtu.be`, `tiktok.com`, `instagram.com`). `thought` and `food` may carry an optional https link, such as a map.
8. **Counselors see a "Posts to review" list** with two tabs: **To review** (pending and reported) and **Approved** (so they can pull one back). They do not see the whole feed in v1.
9. **"The author's counselor" means the assigned counselor only** (`profiles.counselor_id`, who must also be an approved counselor). Do **not** use `private.can_view_student` as the review check. It also admits the student themself and any read-only collaborator in `student_collaborators`, and neither should approve a minor's post.
10. **Takedowns without a report:**
    - The author can delete their own post at any status. This is a hard delete.
    - The assigned counselor can pull back an approved post with a Remove button. That sets it to `rejected` with a note, so no fifth status is needed.
11. **Personal details typed into a post** (a phone number, a last name) are guarded by the counselor's review plus a one-line hint in the post form ("Don't include last names, phone numbers or emails"). No automatic text scanning in v1.
12. **Telling the counselor there's something to review:** reuse the existing in-app notification path that student updates already use (`NotificationBell`, and the student-update notifications from migration `20261126100001`). No new email and no cron job in v1. The builder confirms this path can carry the new event. The student sees "Waiting for your counselor" with the date submitted, with no escalation.
13. **Class year:** `profiles.grad_year` is nullable text that students can edit. When it is blank, show first name only.

## Approaches considered
1. **Demo first, then real stack (chosen).** The whole flow runs on mock data in the demo (student posts, counselor queue, reject, report). The user reviews it, and only then do tables, API and app get built.
   - Costs two rounds.
   - Design changes happen before any production migration.
2. **Real stack straight through, then port to the demo.** This is faster to a working feature. A redesign afterward means more migrations on prod data about minors.
3. Ruled out:
   - Reusing Events or Resources tables: only counselors and Meridies write them.
   - A third-party forum tool: separate logins for minors, and no counselor approval step.

## Constraints from the codebase
- **Which checkouts.** `meridies-app` and `meridies-backend` working trees are on old feature branches (the app is 239 commits behind `origin/main`). `meridies-app-cpp-import` is a broken worktree. Use fresh worktrees from `origin/main`, stage explicit files, never `git add -A`.
- **The demo leads on UI.** It has no backend and no API calls. Persistence is `lib/storage.ts` / `useAutosave` (localStorage). Reset-demo must clear forum state. `AGENTS.md` gets a Forums row.
- **Nav.** `lib/nav.ts`: add `"forums"` to `NavKey` and an entry to `STUDENT_NAV`, with `href: ${STUDENT_HOME}/forums` and icon `MessagesSquare`. The icon is already in the `ICONS` map in `components/dashboard/DashboardSidebar.tsx`. The phone bottom bar (`STUDENT_PHONE_KEYS`) is unchanged, so Forums shows in the More drawer.
- **`e2e/pure.spec.ts`** asserts the first two student nav keys and that hrefs are unique. The a11y and layout specs loop over `STUDENT_NAV`, so a new item is covered automatically.
- **Page pattern.** Copy `app/dashboard/student/events/page.tsx`: `requireUser("student")`, `DashboardShell`, `ToolBanner`, `ApiUnavailable`, then a client component.
- **Reusable UI:** the college picker in `components/events/EventFormModal.tsx` (`searchCollegesAction`, `CollegeSearchHit`), `CollegeLogo`, the `DashboardUI` exports (Card, Modal, Tabs, Segmented, Toast, EmptyState, Avatar), `components/events/EventCards.tsx` for card layout, and possibly `ReviewQueuePanel` (not yet read).
- **Mutations** are Server Actions in `app/actions.ts` returning `ActionResult<T>`. Reads happen in server components via `lib/api.ts` `apiFetch`.

## Phase 1: demo prototype (build this first)
Repo: `meridies-demo`, on a fresh worktree.
- `lib/forums.ts`: types, seed posts from "other students" (so the feed is not empty), a store on `useAutosave`.
- `app/dashboard/student/forums/page.tsx` plus `components/forums/*`: a feed with a college filter and kind tabs, a "New post" modal, a "My posts" view with pending/rejected state, and a Report action.
- Counselor side: a "Posts to review" list with a **To review** tab (Approve / Reject with a note) and an **Approved** tab (Remove). The student side also gets Delete on their own posts and the "Waiting for your counselor" state.
- Nav entry, `AGENTS.md` row, and Reset-demo coverage.
- Link validation matches the rules in call 7.

## Phase 2: real build (after the user reviews phase 1)
**Backend (`meridies-backend`):**
- One migration with a timestamp **after** the newest on `origin/main` (`20261130000001` was the newest seen). Never use `--include-all`. The header states deploy order.
- Table `forum_posts`:
  - `id`, `author_id`, `college_id` (FK to `colleges`, on delete set null);
  - `kind` check in (`thought`, `video`, `creator`, `food`), `title`, `body`;
  - `url` (check `~ '^https://'`, length at most 2000);
  - `status` check in (`pending`, `approved`, `rejected`, `reported`);
  - `reviewed_by`, `reviewed_at`, `review_note`, `reported_by`, `reported_at`;
  - `created_at`, `updated_at` (with the `set_updated_at` trigger).
- **Required:** `select private.attach_approval_gate('public.forum_posts');` plus RLS on. CI (`approval-db.test.mjs`, `scripts/migrations/plan.mjs`) fails any migration that creates a table without it.
- RLS:
  - An author reads their own rows in any status.
  - A student reads other students' rows only where `status = 'approved'`. This is the first cross-student read rule. The model is `hub_events_select_student`.
  - A counselor reads rows where the author's `profiles.counselor_id` is that counselor (call 9), not via `can_view_student`.
  - Clients never write directly. The API writes with the service role after checks, as in `20261130000001_contract_hub.sql`.
- Routes: new `src/routes/forums.ts`, registered in `src/app.ts`.
  - Student: `GET /me/forums` (approved feed, `college_id` and `kind` filters, paged), `POST`, `PATCH /:id` (back to pending), `DELETE /:id` (own posts only), `POST /:id/report`.
  - Counselor: `GET /forums/review?tab=pending|approved`, `POST /forums/:id/review` with `{decision: approve|reject, note}`. Reject also serves as Remove on an approved post. The route checks that the caller is the author's assigned counselor (call 9). It also fires the notification in call 12.
  - Use `limit()` for rate limits, zod bodies, and `requireRole`.
  - Return 503 `forums_unavailable` when the migration is missing, and keep it out of `REQUIRED_SCHEMA`, like other staged features.
- The API returns the display name (first name + class year) so `profiles` RLS does not need to open up.
- Update `AGENTS.md` in both repos.

**App (`meridies-app`):** the same pages as the demo, wired to `lib/api.ts` and Server Actions. The "isn't switched on yet" `EmptyState` comes from `isNotSwitchedOn` in `lib/apiErrors.ts`.

**Merge order:** migration applied to prod only after explicit approval and CI "plan", then backend, then app. The demo ships first, in phase 1.

## Left to the builder
- Where the demo's counselor review list lives, and whether `ReviewQueuePanel` fits.
- The relation that tells whether a student has a counselor.
- Confirming the notification path in call 12 can carry a "post to review" event, and what the student sees if the counselor never acts.
- Copy: empty states, rejection messages, the report confirmation.
- Exact visual design, reusing the existing events card layout.

## Risks to carry forward
- **Terms and guardian consent.** The terms page (§7) says counselors get parent or guardian permission for students under 18. It was not checked whether that permission covers posting for other students to read. This needs a human decision before launch, not code.
- **Counselor workload and responsibility.** Counselors become the moderators of content shown to other firms' students.
- **A single student can hide any post by reporting it.** The counselor clears it. This is acceptable at launch volume and is the first thing to revisit.
- **Cold start.** An empty feed for a given college. Not solved in v1.

## Verification
- **Phase 1:**
  - Run the demo. Click through as a student (post each kind, see pending, see a rejected post's note, edit and resubmit, report a seed post).
  - Switch to the counselor view and approve, reject and clear a report.
  - Confirm Reset-demo clears forum state.
  - Run lint, typecheck, `e2e/pure.spec.ts` and the a11y and layout specs, which pick up the new nav item.
- **Phase 2:**
  - Run against the isolated local Supabase stack (the 563xx ports). The :3000 and :4000 dev servers hit PROD.
  - DB tests: student A cannot read student B's pending or rejected post. An approved post is readable across firms. An unapproved counselor cannot review. A counselor cannot review another counselor's student's post. A read-only collaborator and the author cannot approve. An author can delete their own post and no one else's. A counselor's Remove makes an approved post invisible to other students. The approval-gate CI test passes.
  - API tests for each route, including the no-counselor case and the link allowlist.
  - Then a browser pass (Playwright on system Chrome).
