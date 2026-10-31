# AxIS security PR C: app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app stops "Confirm all" from deleting or acting on flagged cards, shows Restore on AxIS deletes, explains flagged chats, shows hand-in values as unverified with a Confirm, and tells the counselor plainly when AI is paused.

**Architecture:** Small pure helpers in `lib/` (so the node:test check scripts can import them) used by the existing AxIS card and hand-in components. No new pages.

**Tech Stack:** Next.js (App Router), React, TypeScript, Tailwind; checks are `scripts/*-check.mjs` run with Node 22.18+ type stripping (`node --no-warnings --test`).

**Spec:** `docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md` in meridies-backend (2.1, 2.4, 3.3 card text, 4, 1.5 `ai_paused`). Backend fields come from PR B (`restoreUntil`, undo's `restored`/`paused`, `values`, the confirm route) and PR A2 (`ai_paused`, `ai_budget_unavailable`).

## Global Constraints

- New worktree `meridies-app-axissec`, branch `axis-security-app`, off `origin/main` of meridies-app. PR left open for bcha to merge; it goes live after PR B.
- Exact copy: outside-content reason "AxIS read a document or other text someone else wrote in this chat, so it asks before changing anything. Start a new chat to change things at once."; Restore button "Restore", with "until <Mon D>" beside it; hand-in value labels "Unverified, from the student's file" and "Confirmed by <name>, <Mon D>"; the button "Confirm and add to profile".
- Sends stay out of "Confirm all" (unchanged). The button shows only when two or more cards qualify, and never in the danger colour (nothing destructive qualifies any more).
- `ai_paused` (429) and `ai_budget_unavailable` (503) never fall back to `/chat`; the counselor sees the API's message.
- Before PR B is live the app must still work: a payload without `restoreUntil` shows today's Undo; a check without `values` shows today's findings and today's "Apply to profile".
- `npm run typecheck`, `npm run lint` and every `check:*` script pass.

## Review Focus

1. A turn with one plain card and one delete card: "Confirm all" disappears (only one qualifies) and the delete waits for its own click. Test in Task 1.
2. A Restore the API refuses (409 with a sentence): the card keeps Restore available state off, shows the sentence, and doesn't mark the card undone. Test in Task 2 (helper for the result state).
3. A hand-in check from before PR B (findings with the "(unverified, from the student's file)" infix, no `values`): "Apply to profile" still finds the figures. Test in Task 3.
4. A confirmed value shown to a different counselor on the same student (collaborator): it reads "Confirmed by <the confirmer's name>", never "you". Test in Task 3.
5. A 503 from `/axis` with code `axis_unavailable` still falls back to `/chat` as today; the two new codes don't. Test in Task 4.

---

### Task 1: "Confirm all" leaves out deletes and flagged cards

**Files:**
- Create: `lib/axisConfirm.ts`, `scripts/axis-confirm-check.mjs`
- Modify: `components/assistant/AxisAnswer.tsx` (move `isDestructiveOp`, `isSendOp` and their sets to `lib/axisConfirm.ts` and re-export; `ConfirmAllButton` uses the helper and drops the danger styling), `components/assistant/AssistantWorkspace.tsx` (`confirmAll` uses the helper), `package.json` (`"check:axis-confirm": "node --no-warnings --test scripts/axis-confirm-check.mjs"`)

**Interfaces:**
- Produces: `confirmAllEligible(a: { type: string; state: string; payload?: { op: string; reason?: string | null } }): boolean` = a pending operation that isn't a send, isn't destructive and whose reason isn't `outside-content`.

- [ ] **Step 1: Write the failing check**

```js
test("a plain pending change qualifies", ...)
test("deletes and every danger-colour verb are left out", ...)   // delete, remove, archive, revoke, void, cancel, close
test("an outside-content card is left out", ...)
test("sends stay out", ...)
test("one plain card plus one delete: only one qualifies", ...) // Review Focus 1
```

- [ ] **Step 2: Run** `npm run check:axis-confirm` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `fix(axis): Confirm all skips deletes and flagged cards`

---

### Task 2: Restore on AxIS deletes, and the flagged-chat sentence

**Files:**
- Modify: `lib/api.ts` (`AxisOperationPayload.restoreUntil?: string`; the undo call returns `{ restored?: number; paused?: string[] }` or the API's error sentence), `components/assistant/AxisAnswer.tsx` (`REASON_TEXT["outside-content"]`; the done row shows "Restore" and "until <Mon D>" when `restoreUntil` is set, else today's Undo), `components/assistant/AssistantWorkspace.tsx` (the undo handler shows a toast for paused rows: "Restored. The family email sequence came back paused." per paused table, and shows a refusal sentence on the card), `lib/axisConfirm.ts` (`restoreLabel(restoreUntil: string, now: Date): string | null`, null once past)
- Modify: `scripts/axis-confirm-check.mjs`

- [ ] **Step 1: Write the failing checks**

```js
test("restoreLabel shows the end date, and nothing once it has passed", ...)
test("a refused restore leaves the card's state as it was", ...)   // Review Focus 2, via the state helper the workspace uses
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(axis): Restore on deletes; say why a chat asks first`

---

### Task 3: Hand-in values: Unverified, Confirm and add to profile

**Files:**
- Create: `lib/handInValues.ts`, `scripts/hand-in-values-check.mjs`
- Modify: `lib/api.ts` (`HandInValue`, `TrackerCheck.values: HandInValue[] | null`, the building item's `axis.values`, `confirmHandInValues(taskId, checkId, keys)` calling `POST /tasks/:id/checks/:checkId/values/confirm`, plus a server action beside `patchStudentInfoAction` following its pattern), `lib/axisFigures.ts` (the regex also accepts the infix `(unverified, from the student's file)`), `components/student/TaskHandIn.tsx` (with `values`: a list of each value and its label, and "Confirm and add to profile" for the unconfirmed ones; without `values`: today's findings and "Apply to profile"), `components/overview/BuildingCard.tsx` (values with their labels), `package.json` (`check:hand-in-values`)

**Interfaces:**
- Produces: `valueLabel(v: HandInValue, fmt?: (iso: string) => string): string`.

- [ ] **Step 1: Write the failing checks**

```js
test("an unconfirmed value reads Unverified, from the student's file", ...)
test("a confirmed value names the confirmer and the date", ...)       // Review Focus 4: never "you"
test("old findings with the unverified infix still give figures", ...) // Review Focus 3
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat(hand-ins): values unverified until the counselor confirms them`

---

### Task 4: AI paused and budget errors don't fall back

**Files:**
- Create: `lib/axisErrors.ts`
- Modify: `lib/api.ts` (`attemptAxisStream` uses it; error text from `message` or `error` in the body), `scripts/axis-confirm-check.mjs`

**Interfaces:**
- Produces: `axisFallsBack(status: number, code: string | undefined): boolean` (today's rule, read from `attemptAxisStream`, minus `ai_paused` and `ai_budget_unavailable`).

- [ ] **Step 1: Write the failing checks**

```js
test("axis_unavailable still falls back", ...)              // Review Focus 5
test("ai_paused and ai_budget_unavailable don't", ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(axis): show the pause message instead of falling back`

---

### Task 5: Whole-branch check and PR

- [ ] **Step 1:** `npm run typecheck && npm run lint` and every `npm run check:*` → PASS.
- [ ] **Step 2:** Against a local backend on PR B's branch (`npm run dev` in both), click through once: a delete card shows Restore after Confirm; Confirm all skips it; a hand-in with a GPA shows Unverified, then Confirmed after the button. Screenshots in the PR.
- [ ] **Step 3:** Push and open the PR, left for bcha; the description says it goes live after backend PR B.
