# Draft a Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A consultant drafts a contract from a fixed outline inside Meridies, signs it once with a saved signature, and sends it to a family by attaching it to an invoice.

**Architecture:** A draft is structured sections (jsonb). One pure file, `contractDraft.ts`, renders it to plain text with merge fields and a signature block. That text becomes an ordinary inline `agreements` row, so the existing guard (freezes `body_text` once sent), `/agree/:token` page, typed-name acceptance and certificate are reused unchanged. A frozen `agreement_signatures` snapshot backs the drawn-signature image, served on a token-gated route. No PDF.

**Tech Stack:** Backend: Fastify + zod + Supabase (Postgres RLS), `node:test` (+ `harness.mjs` integration). App/demo: Next.js, hand-rolled `<canvas>` signature pad, Playwright. Demo is mock-backed (autosave keys).

**Spec:** `docs/superpowers/specs/2026-11-18-contract-drafting-design.md` (this repo). Read it first.

## Global Constraints

- Three repos, three PRs, **Brandon merges**. Build in worktrees off `origin/main` (local checkouts are on stale branches): `wt-contract-draft-be` (exists, `feat/contract-drafting`), `wt-contract-draft-demo`, `wt-contract-draft-app`. Stage explicit files, never `git add -A`.
- Merge/deploy order: backend → apply migration (Apply migrations workflow, approval gate) → app → demo. Demo is built first as the UI source, but must not merge before the app.
- Text-first only. **No PDF, no new dependency** (the signature pad is a hand-rolled canvas).
- Merge fields, exactly: `{{family_name}}`, `{{student_name}}`, `{{counselor_name}}`, `{{date}}`. Anything else in `{{…}}` is an error.
- `{{family_name}}` = contact `parent_name` when the contact has a `parent_email`, else `student_name`; used verbatim; empty blocks the send.
- Limits: title ≤ 160; rendered `bodyText` ≤ 60,000 (`.length`, the same limit as `agreementBodyText`); signature image PNG ≤ 61,440 bytes; ≤ 40 sections; ≤ 100 unarchived drafts per practice.
- Error codes (exact): 503 `contract_drafts_unavailable`, 409 `signature_needed`, 400 `contract_fields_missing`, 400 `contract_too_long`, 409 `draft_contract_send_now`.
- Behind `AGREEMENTS_ENABLED` like every agreements route. Consent version stays `v1-2026-11-11`; every certificate keeps its "not a certified electronic signature" line. Uploaded-file contracts and `{agreementId}` / `{title, bodyText}` attaches behave exactly as before.
- UI words: button **Draft contract**; list **Drafted in Meridies**; picker group **Drafted contracts**; editor note **Starter wording is a starting point: have your attorney review it**.
- Drafts: practice-shared, members read, `crm_can_admin` writes (mirror `contract_files`). Signature: personal to the sender.
- `src/lib/contractDraft.ts` is **pure TypeScript with zero imports and only erasable syntax** (no enums, no parameter properties), and is copied **byte-for-byte** to `meridies-demo/lib/contractDraft.ts` and `meridies-app/lib/contractDraft.ts`, so the repos' plain-Node `check:*` scripts can import it. Change all three together.

## Review Focus

1. A typo'd or unknown field (`{{fee}}`, `{{ family_name }}`) or an empty card name must stop the send with a message naming the field, never reach the family. (Task 1, 4)
2. A very long draft, or emoji/accents, near the 60,000 cap must refuse cleanly, not truncate or error in SQL. (Task 1, 3)
3. A signature "image" that is not a PNG, is oversized, or a signature route called without a valid token must be refused / 404. (Task 3, 5)
4. "Send again" on an invoice that carries a drafted contract, and editing/archiving a draft after attaching it, must not re-sign or change the contract the family already has. (Task 4)
5. A sender with no saved signature, or a firm member who is not an admin, gets a clear path (409 `signature_needed` / can attach but not create), not a 500. (Task 3, 4)

---

### Task 0: Worktrees and local stack

**Files:** none (environment).

- [ ] **Step 1:** Create the two missing worktrees from `/Users/brandoncha/Meridies`: `git -C meridies-demo worktree add ../wt-contract-draft-demo -b feat/contract-drafting origin/main`, same for `meridies-app` → `../wt-contract-draft-app`. Run `npm ci` in all three.
- [ ] **Step 2:** Bring up the isolated local stack (Supabase on 563xx, API on :4100) per the memory note `local-verification-stack-recipe`. The `:3000`/`:4000` dev servers hit PROD: never use them. Verify `curl :4100/health` returns ok.

---

## Backend (`wt-contract-draft-be`)

### Task 1: The pure contract model

**Files:**
- Create: `src/lib/contractDraft.ts`
- Test: `test/unit/contract-draft.test.ts`

**Interfaces — Produces** (every later task, and the demo/app copies, use these exact names):
```ts
export type ContractSection =
  | { id: string; kind: "text"; heading: string; body: string }
  | { id: string; kind: "list"; heading: string; items: string[] }
  | { id: string; kind: "clause"; heading: string; body: string };
export const MERGE_FIELDS: readonly ["family_name", "student_name", "counselor_name", "date"];
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string>>;
export type SignatureBlock = { signerName: string; practiceName: string; signedOn: string; imageSha256: string | null };
export const CONTRACT_BODY_MAX = 60000;
export const STARTER_SECTIONS: ContractSection[];            // Services, Prerequisites, Fees and payment terms, then 5 clauses
export type RenderResult =
  | { ok: true; title: string; bodyText: string }
  | { ok: false; reason: "unresolved"; fields: string[] }
  | { ok: false; reason: "too_long" };
export function unresolvedFields(title: string, sections: ContractSection[], values: MergeValues): string[];
export function renderContractText(input: { title: string; sections: ContractSection[]; values: MergeValues; signature: SignatureBlock }): RenderResult;
export function addClause(sections: ContractSection[], id: string): ContractSection[];
export function removeClause(sections: ContractSection[], id: string): ContractSection[];   // only kind "clause" is removable
export function moveClause(sections: ContractSection[], id: string, delta: -1 | 1): ContractSection[]; // clauses reorder among clauses; the first three never move
export function copyTitle(title: string): string;            // `${title} (copy)`, cut to 160
```

- [ ] **Step 1: Write the failing tests** in `test/unit/contract-draft.test.ts` (style of `test/unit/contracts.test.ts`):
  - `renders the exact text` — title `Consulting agreement`; sections: text `Services` body `We will help {{student_name}} apply.`, list `Prerequisites` items `["Transcript shared","Intake form"]`, clause `Refunds` body `Fees are refundable within 3 days.`; values `{student_name:"Ava Lee", family_name:"Pat Lee", counselor_name:"Jane Roe", date:"November 18, 2026"}`; signature `{signerName:"Jane Roe", practiceName:"Roe College Consulting", signedOn:"November 18, 2026", imageSha256:null}`. Assert `bodyText === "Consulting agreement\n\n1. Services\nWe will help Ava Lee apply.\n\n2. Prerequisites\n- Transcript shared\n- Intake form\n\n3. Refunds\nFees are refundable within 3 days.\n\nSigned for Roe College Consulting by Jane Roe, November 18, 2026."`. With `imageSha256` set to 64 `a`s the text ends `…November 18, 2026.\nSignature image SHA-256: aaaa…`.
  - `is deterministic` (two renders equal).
  - `reports unknown and empty fields` — body with `{{fee}}` and `{{ family_name }}` → `unresolvedFields` returns `["fee","family_name"]`-style names (the token text trimmed, de-duplicated, in first-seen order); an empty `family_name` value → `["family_name"]`; `render` returns `{ok:false, reason:"unresolved", fields}`.
  - `does not expand a value that looks like a field` — `student_name: "{{date}}"` renders literally `{{date}}` (single pass).
  - `caps the rendered text` — a body that renders to 60,000 chars is ok; 60,001 → `{ok:false, reason:"too_long"}`; `"é😀"` repeated counts by `.length`.
  - `edit helpers` — `removeClause` ignores a `text`/`list` id; `moveClause` never moves a clause above the third section or off the end; `addClause` appends a `clause` with the given id and heading `New clause`; `copyTitle("x".repeat(160))` is 160 long and ends `(copy)`.
- [ ] **Step 2:** Run `node --import tsx --import ./test/env.ts --test test/unit/contract-draft.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/lib/contractDraft.ts` to the signatures above. Rendering rules the tests do not fully fix: headings are numbered `1.`, `2.`… in section order; blocks are joined by one blank line; a `list` renders `- item` per line; merge replacement is one `replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, …)` pass over title, headings, bodies and items; any `{{…}}` whose trimmed name is not in `MERGE_FIELDS`, or whose value is empty/missing, is unresolved. `STARTER_SECTIONS`: short plain wording, no admissions guarantee, clauses: Cancellation and refunds, No guarantee of admission, Confidentiality, Communication, Ending this agreement; Services text uses `{{counselor_name}}`, `{{student_name}}`, `{{family_name}}`.
- [ ] **Step 4:** Re-run the test. Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 5: Commit** `git add src/lib/contractDraft.ts test/unit/contract-draft.test.ts docs/superpowers && git commit -m "feat: contract draft model and renderer"`.

### Task 2: Migration

**Files:**
- Create: `supabase/migrations/20261129000001_contract_drafts.sql` (confirm it sorts after the newest on `origin/main`, currently `20261128000001`; bump if not)
- Modify: none (not in `REQUIRED_SCHEMA`)
- Test: `test/integration/approval-db.test.mjs` (existing; must still pass), `test/integration/contract-drafts.test.mjs` (Task 3 adds the behavior checks)

**Interfaces — Produces** (tables the routes use): `public.contract_drafts(id, firm_id, counselor_id, practice_id, title, sections jsonb, archived_at, created_by, created_at, updated_at)`, `public.counselor_signatures(counselor_id pk, signer_name, kind, image_png bytea, image_sha256, updated_at)`, `public.agreement_signatures(agreement_id pk, signer_name, kind, image_png, image_sha256, signed_at)`.

- [ ] **Step 1: Write the migration**, modelled on `20261124000005_contracts.sql` (header comment in the same style: what, deploy order "after 20261128000001; code degrades to 503 without it", additive, re-runnable):
  - `contract_drafts`: same scope check and RLS shape as `contract_files` (select `crm_can_access`; insert/update `crm_can_admin` + `crm_is_own_workspace` + `created_by = auth.uid()`); `title` 1–160; `sections` `jsonb_typeof = 'array'`; no delete; `grant update (title, sections, archived_at, updated_at)`; a before-update trigger sets `updated_at = now()`.
  - `counselor_signatures`: owner-only select/insert/update (`counselor_id = auth.uid()`); `signer_name` 1–120; `kind in ('typed','drawn')`; check `(kind = 'drawn') = (image_png is not null)`; `length(image_png) <= 61440`; `image_sha256 ~ '^[0-9a-f]{64}$'` when drawn.
  - `agreement_signatures`: `agreement_id` pk `references agreements(id) on delete cascade`; same column checks; select via `crm_can_bill` of the agreement's contact; insert policy only where the agreement's `counselor_id = auth.uid()` and `status = 'draft'`; no update/delete grants; a before-update trigger always raises, a before-delete trigger raises unless `pg_trigger_depth() > 1` (the parent's cascade), and a before-truncate trigger raises (pattern of `agreement_acceptances` in `20261111000010`).
  - `select private.attach_approval_gate('public.<table>')` on all three; RLS enabled on all three; `axis_trash_rules` + `attach_axis_trash` for `contract_drafts` and `agreement_signatures`, guarded by `to_regclass`/`to_regprocedure` exactly as at the end of `20261111000010` (read how it lists `agreements` and its columns).
- [ ] **Step 2:** Apply to the local stack (the recipe's psql wrapper) twice (re-runnable). Expected: no errors.
- [ ] **Step 3:** Run `node --import tsx --test test/integration/approval-db.test.mjs`. Expected: PASS (no table without RLS or the gate).
- [ ] **Step 4: Commit** the migration.

### Task 3: Draft and signature API

**Files:**
- Create: `src/lib/contractDraftApi.ts`, `src/routes/contractDrafts.ts`
- Modify: `src/app.ts` (register `contractDraftRoutes` with `{ prefix: "/pipeline" }` next to `contractRoutes`)
- Test: `test/integration/contract-drafts.test.mjs`, `test/unit/contract-draft-api.test.ts`

**Interfaces — Consumes:** Task 1 (`ContractSection`, `CONTRACT_BODY_MAX`), Task 2 tables. **Produces:**
```ts
// src/lib/contractDraftApi.ts
export const contractDraftsUnavailable: () => HttpError;           // 503 contract_drafts_unavailable
export const contractDraftBody: z.ZodType<{ title: string; sections: ContractSection[] }>;   // strict; title 1..160; sections 1..40; section ids uuid-or-short string 1..64; strings capped so title+headings+bodies+items <= 50000
export const signatureBody: z.ZodType<{ kind: "typed"; signerName: string } | { kind: "drawn"; signerName: string; imagePngBase64: string }>;
export function sniffPng(bytes: Uint8Array): { width: number; height: number } | null;   // PNG magic + IHDR; null otherwise
export const SIGNATURE_MAX_BYTES = 61440;
export type ContractDraftDTO = { id: string; title: string; sections: ContractSection[]; archivedAt: string | null; createdAt: string; updatedAt: string };
export type SignatureDTO = { signerName: string; kind: "typed" | "drawn"; imageDataUrl: string | null; updatedAt: string };
export const toContractDraftDTO: (r: Record<string, unknown>) => ContractDraftDTO;
export const toSignatureDTO: (r: Record<string, unknown>) => SignatureDTO;
```
Routes (all `counselor` + `limit(...)`, like `routes/contracts.ts`; DB-missing errors map through `isResultsNotApplied` → 503):
`GET /pipeline/contract-drafts?includeArchived` → `{ drafts, canEdit }`; `POST /pipeline/contract-drafts` → 201 draft (admin only, cap 100); `PUT /pipeline/contract-drafts/:id` → draft; `POST /pipeline/contract-drafts/:id/duplicate` → 201 draft titled `copyTitle(...)`; `DELETE /pipeline/contract-drafts/:id` → archived draft; `GET /pipeline/signature` → `{ signature: SignatureDTO | null }`; `PUT /pipeline/signature` → `SignatureDTO`.

- [ ] **Step 1: Write failing unit tests** (`test/unit/contract-draft-api.test.ts`): `sniffPng` accepts a real 1×1 PNG (build the bytes inline) and rejects a JPEG, an SVG, `<html>`, and a truncated PNG; `contractDraftBody` rejects 41 sections, an unknown key, a 161-char title, and an over-50,000-char total; `signatureBody` rejects `drawn` without an image and `typed` with one.
- [ ] **Step 2: Write failing integration tests** (`test/integration/contract-drafts.test.mjs`, harness style of `contracts.test.mjs`; one solo counselor `S`, one firm owner + one non-admin member, one outsider): create → list → edit → duplicate → archive round trip; member can list but gets 403 on create; outsider sees none and gets 404 on `PUT`; `PUT /pipeline/signature` typed round trip; drawn with a real PNG round trip returns a `data:image/png;base64,` URL whose bytes hash to the stored `image_sha256`; drawn with a JPEG body, a >61,440-byte PNG, and bad base64 → 400; replacing the signature updates the row (one row per consultant); 101st draft → 409; with the migration absent the routes answer 503 (skip this check when the stack has it; assert by calling `isResultsNotApplied` path in the unit test instead).
- [ ] **Step 3:** Run both; expected FAIL.
- [ ] **Step 4: Implement** the lib and routes. Draft routes mirror `routes/contracts.ts` (`loadWorkspace`, `ws.isAdmin`, `request.db` for RLS reads/writes). Signature routes use `request.db` (owner-only RLS), compute `image_sha256` from the decoded bytes server-side, and never trust a client hash.
- [ ] **Step 5:** Run both again; expected PASS. `npm run typecheck`.
- [ ] **Step 6: Commit** (explicit files).

### Task 4: Attach `{ draftId }` to an invoice

**Files:**
- Modify: `src/lib/invoiceAgreement.ts` (read the whole file first), the invoice routes in `src/routes/pipeline.ts` (preview ~1227, create/send ~1296, send-again ~1512) only where they call `resolveInvoiceAgreement`/`issueInvoiceAgreement`, `src/routes/invoiceDrafts.ts` + `src/lib/invoiceDrafts.ts` (scheduled-send refusal), `src/lib/invoiceDispatch.ts` only if it must also refuse.
- Test: `test/integration/contract-draft-invoice.test.mjs`, `test/unit/invoice-agreement.test.ts` (extend)

**Interfaces — Consumes:** Tasks 1–3. **Produces:**
```ts
// invoiceAgreementInput gains a 4th strict variant:
z.object({ draftId: z.string().uuid() }).strict()
// resolveInvoiceAgreement(db, contactId, input, sender?: { counselorId: string; counselorName: string; practiceName: string })
//   ResolvedAgreement gains: draft?: { id: string; title: string; sections: ContractSection[]; contact: { parentName: string; parentEmail: string; studentName: string } }
// issueInvoiceAgreement(...) for a draft: render -> saveInlineAgreement -> insert agreement_signatures -> mintAgreementLink
```

- [ ] **Step 1: Write failing integration tests** (`contract-draft-invoice.test.mjs`; reuse `contracts.test.mjs`'s `pub`, `mailWith`, Mailpit helpers):
  - Happy path: family has `parentName` + `parentEmail`; counselor has a typed signature; `POST /pipeline/contacts/:id/invoices` with `agreement: { draftId }` and `send: true` → 200; the agreement exists, `status === "sent"`, its `body_text` contains the parent's name, the student's name, today's date, and `Signed for <practice> by <signerName>`; an `agreement_signatures` row exists; the email's link opens `/agree/<token>` showing that text; accepting with a typed name records `body_sha256` equal to the sha of that text.
  - Drawn signature: text contains `Signature image SHA-256: <hash>` and the hash equals the snapshot's `image_sha256`.
  - **Replace the saved signature, then re-fetch the earlier agreement:** its text and snapshot are unchanged.
  - **Edit then archive the draft after sending:** the sent agreement's text is unchanged; attaching the archived draft again → 404.
  - **Send again** (`POST /pipeline/invoices/:id/send` with `agreement: { agreementId }`): still one snapshot row, same text, a new link.
  - No saved signature → 409 `signature_needed`, nothing written (no agreement row). Contact with no parent or student name → 400 `contract_fields_missing` naming `family_name`; a draft containing `{{fee}}` → 400 `contract_fields_missing` naming `fee`; a draft rendering over 60,000 → 400 `contract_too_long`.
  - `send: false` with a draft → 400 `agreement_needs_send` (existing guard); a text invoice → 400 `text_no_agreement`; flag off → 404 `agreements_off`.
  - Firm non-admin member can attach a draft with their own saved signature; the signature recorded is theirs.
  - Scheduled invoice draft (`pipeline_invoice_drafts` saved with a send time) carrying `{ draftId }` → 409 `draft_contract_send_now`; saving it unscheduled succeeds, and the composer's later "Send now" path signs.
  - Failure safety: simulate the snapshot insert failing (an archived/other-owner row is not enough; use a unit test with a stub client) and assert the new agreement is voided and the error rethrown.
  - Uploaded-contract (`{ contractId }`), inline (`{ title, bodyText }`) and `{ agreementId }` attaches still pass `contracts.test.mjs` / `invoice-agreement.test.mjs` unchanged.
- [ ] **Step 2:** Run the new file; expected FAIL.
- [ ] **Step 3: Implement.** In `resolveInvoiceAgreement` the draft branch loads the unarchived draft (404 `That contract draft isn't in your library` otherwise) and the contact's three name fields; it does **not** render. In `issueInvoiceAgreement` the draft branch: load the sender's signature (409 `signature_needed` before anything is written), compute `values` per the Global Constraints, `renderContractText` with `signedOn` = long UTC date (`November 18, 2026`) and `imageSha256` from the saved row, map `unresolved` → 400 `contract_fields_missing` (message: `Fill in <fields> on the family's card first` / `…the draft uses an unknown field: {{fee}}`) and `too_long` → 400 `contract_too_long`, call `saveInlineAgreement`, insert the `agreement_signatures` snapshot copying the saved row, then `mintAgreementLink`. If the snapshot insert or the mint fails, void the new agreement (`status` draft→void) and rethrow. The signer is the sender (`counselorId`), never the draft's creator. Callers pass `sender` (profile name via the same lookup `POST /agreements/:id/send` uses; practice name as `acceptanceEmails` already derives it). Preview (`/invoices/preview`) validates the draft and signature exist and renders **without writing**, returning the same errors.
- [ ] **Step 4:** In `routes/invoiceDrafts.ts`, reject a scheduled draft whose `agreement` is `{ draftId }` with 409 `draft_contract_send_now` ("A drafted contract is signed when you send it, so it can't be scheduled"); read the file to find where the send time is validated and put the check there; if `invoiceDispatch.ts` re-resolves a stored agreement, make it refuse the same input as a backstop.
- [ ] **Step 5:** Run the new file, `contracts.test.mjs`, `invoice-agreement.test.mjs`, `agreements.test.mjs`, and the unit tests. Expected: PASS. `npm run typecheck`.
- [ ] **Step 6: Commit.**

### Task 5: The family's page shows the signature

**Files:**
- Modify: `src/routes/agreements.ts` (new `GET /agree/:token/signature`; pass `signature` to the page builders), `src/lib/agreements.ts` (`agreementPageBody` gains `signature?: { href: string; name: string } | null`)
- Test: `test/integration/contract-draft-invoice.test.mjs` (extend), `test/unit/agreements.test.ts` (extend)

**Interfaces — Consumes:** Task 4's snapshot rows. **Produces:** `GET /agree/:token/signature` → `image/png` bytes.

- [ ] **Step 1: Write failing tests.** Unit: `agreementPageBody({…, signature: {href:"/agree/t/signature", name:"Jane <b>"}})` contains `<img src="/agree/t/signature"` with an escaped `alt`, and nothing when `signature` is null. Integration: for a drawn-signature contract, `GET /agree/<token>` (open and accepted states) contains the `<img>`; `GET /agree/<token>/signature` returns 200 `image/png` whose bytes hash to `image_sha256`, with headers `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`; a wrong token, a void/expired link, and a typed-signature agreement → 404/410 like `/file`; if the stored bytes' hash is not the one named in the agreement text → 503 and nothing served; an agreement with no snapshot (older ones) renders the page exactly as before.
- [ ] **Step 2:** Run; expected FAIL.
- [ ] **Step 3: Implement** by mirroring `/agree/:token/file` (same `withinLimits`, `open`, lookup states, security headers). Add a tolerant `signatureOf(svc, agreementId)` like `contractOf` (a database without the migration yields null). Read `page()`'s Content-Security-Policy; allow `img-src 'self'` only if it blocks the image, and assert in the integration test that the page's CSP permits it.
- [ ] **Step 4:** Run the tests plus `agreements.test.mjs`; expected PASS.
- [ ] **Step 5: Commit.**

### Task 6: Backend docs and PR

**Files:** Modify `AGENTS.md` (the Agreements section, ~l.660-690: add a **Drafted contracts** bullet in the house style: files, tables, error codes, deploy order, the scheduled-send refusal, the byte-identical `contractDraft.ts` rule, tests list).

- [ ] **Step 1:** Write the AGENTS.md entry. **Step 2:** `npm run typecheck && npm test`, then the integration files touched above against the local stack. **Step 3:** Push `feat/contract-drafting`, open the PR (do not merge), body names the migration and the apply step; tell Brandon to apply it after merge via the Apply migrations workflow.

---

## Demo (`wt-contract-draft-demo`): the UI source, mock-backed

### Task 7: Model, mock store, seed

**Files:**
- Create: `lib/contractDraft.ts` (copy of Task 1's file, byte-for-byte), `lib/contractDraftStore.ts`, `scripts/contract-draft-check.mjs`
- Modify: `package.json` (`"check:contract-draft": "node --no-warnings --test scripts/contract-draft-check.mjs"`), `.github/workflows/ci.yml` (add `- run: npm run check:contract-draft` beside `check:invoice-schedule`), `lib/agreements.ts` (`Agreement` gains `signature?: { name: string; imageDataUrl: string | null }`)

**Interfaces — Produces:**
```ts
// lib/contractDraftStore.ts (autosave keys invoice:contract-drafts, invoice:signature; reset clears them)
export type DraftRecord = { id: string; title: string; sections: ContractSection[]; archived: boolean; updatedOn: string };
export type MockSignature = { signerName: string; kind: "typed" | "drawn"; imageDataUrl: string | null };
export function useContractDrafts(): DraftRecord[];
export function saveContractDraft(d: { id?: string; title: string; sections: ContractSection[] }): DraftRecord;
export function duplicateContractDraft(id: string): DraftRecord | null;
export function archiveContractDraft(id: string): void;
export function useSignature(): MockSignature | null;
export function saveSignature(s: MockSignature): void;
export function signAndAttach(draftId: string, contactId: string, contact: { parentName: string; parentEmail: string; studentName: string }, counselorName: string): { ok: true; agreementId: string } | { ok: false; reason: "signature_needed" | "fields_missing" | "too_long"; fields?: string[] };
```
`signAndAttach` renders with `renderContractText` and calls the existing `createAgreement(contactId, title, bodyText)` then `sendAgreement`, stamping `signature` on the agreement. One seeded draft "College counseling agreement" (the starter sections).

- [ ] **Step 1: Write the failing check** `scripts/contract-draft-check.mjs` (style of `scripts/invoice-schedule-check.mjs`): the Task 1 render/edit-helper assertions against the copied file; `signAndAttach` refuses with `signature_needed` and `fields_missing` and succeeds with a typed signature (stub localStorage as the other checks do, or test only the pure parts if the store can't run under plain Node: then keep `signAndAttach`'s rule logic in `contractDraft.ts`-style pure helpers inside the check's scope).
- [ ] **Step 2:** `npm run check:contract-draft`; expected FAIL. **Step 3:** Implement. **Step 4:** Expected PASS; `npm run typecheck`. **Step 5: Commit.**

### Task 8: Signature pad and setup (shared UI)

**Files:**
- Create: `components/pipeline/invoice/SignaturePad.tsx`, `components/pipeline/invoice/SignatureSetup.tsx`
- Modify: the demo's Settings page (`components/settings/…`, find where Branding or Alerts panels mount) to add a **Signature** card

**Interfaces — Produces:**
```tsx
export default function SignaturePad(p: { value: string | null; onChange: (pngDataUrl: string | null) => void; disabled?: boolean }): JSX.Element
// 600x200 canvas exported as image/png; pointer events (mouse, touch, pen); Clear button; empty canvas -> onChange(null)
export default function SignatureSetup(p: { signature: { signerName: string; kind: "typed" | "drawn"; imageDataUrl: string | null } | null; defaultName: string; onSave: (s: { signerName: string; kind: "typed" | "drawn"; imageDataUrl: string | null }) => Promise<string | null> | string | null; onToast: (m: string) => void }): JSX.Element
// Typed | Drawn toggle (typed is the keyboard route), name field (1..120), live preview, Save; onSave returns an error message or null
```
Typed signature renders in a script font via CSS (`font-family` stack, no web-font download).

- [ ] **Step 1:** Write a Playwright check (`e2e/…`, pattern of existing demo specs) or, if the demo has none for pipeline, a manual script in the task notes: draw a stroke with `page.mouse` on the canvas, assert Save is enabled and `onChange` yields a `data:image/png;base64,` string under 61,440 bytes decoded; Clear → null; typed mode works with the keyboard only.
- [ ] **Step 2:** Run; expected FAIL. **Step 3:** Implement (size the canvas by CSS, scale for `devicePixelRatio`, `touch-action: none`, `aria-label`; the pad has a visible "Prefer to type it? Switch to Typed" note for keyboard users). **Step 4:** Run; expected PASS. **Step 5: Commit.**

### Task 9: Draft editor, Contracts panel, attach, family view

**Files:**
- Create: `components/pipeline/invoice/ContractDraftEditor.tsx`
- Modify: `components/pipeline/invoice/ContractsPanel.tsx`, the composer's picker (`components/pipeline/InvoiceAgreement.tsx` / `invoice/InvoiceComposer.tsx`, find the demo's "Attach to invoice" picker), `components/pipeline/ContactAgreements.tsx` ("Preview as the family" shows the signature), `lib/invoiceStore.ts` only if `InvoiceDraft` needs a field for a picked draft

**Interfaces — Consumes:** Tasks 7–8. **Produces:** `ContractDraftEditor(p: { draft: DraftRecord | null; signature: MockSignature | null; onSaved: (d: DraftRecord) => void; onClose: () => void; onToast: (m: string) => void })` in a `Modal`.

- [ ] **Step 1: Write the failing browser test** (Playwright, demo's e2e setup): open Payment Tracker → Contracts → **Draft contract** → editor shows Services, Prerequisites, Fees and payment terms and the 5 starter clauses; add a prerequisite, add and move a clause, remove a clause; the attorney note is visible; **Save to library** → it appears under **Drafted in Meridies** with Edit / Duplicate / Archive; Duplicate makes `… (copy)`; Archive hides it. Open a family's **Send invoice** → the attach picker has a **Drafted contracts** group → choose it with no saved signature → the composer shows a **Set up your signature** prompt (the `SignatureSetup` inline) and blocks Send; save a typed signature; Send → the family's History lists the agreement as Sent, **Preview as the family** shows the full text with `Signed for … by …` (and the drawn image when drawn). Picking a drafted contract disables the Schedule choice with the message from Task 4.
- [ ] **Step 2:** Run; expected FAIL. **Step 3: Implement.** Editor: title field; the three fixed sections (heading editable, body/list editable, not removable); Clauses with add/remove/move up/down via the Task 1 helpers; a "Preview as the family" toggle rendering `renderContractText` with sample values (`family_name` "Pat Lee" etc., `signedOn` today, signature = saved one); a one-line `{{family_name}} {{student_name}} {{counselor_name}} {{date}}` fields hint. Panel: **Draft contract** button beside Upload; the **Drafted in Meridies** list above/below uploads (match the existing row style). Picker: optgroup **Drafted contracts**; sending calls `signAndAttach`.
- [ ] **Step 4:** Run; expected PASS; `npm run typecheck && npm run lint`; open the demo in the browser at 390px and 1280px and check the editor and pad (screenshots). **Step 5: Commit.**

### Task 10: Demo docs and PR

**Files:** Modify `AGENTS.md` (new row in the table, like the `invoiceStore` row: files, behavior, "Not ported"), `lib/changelog.ts` (a release at the top of `CHANGELOG`, counselor audience, plain words, date `2026-11-18`).

- [ ] **Step 1:** Write both. **Step 2:** `npm run build && npm run check:contract-draft`. **Step 3:** Push, open the PR (do not merge).

---

## App (`wt-contract-draft-app`)

### Task 11: Model, API client, rules

**Files:**
- Create: `lib/contractDraft.ts` (byte-identical copy), `scripts/contract-draft-check.mjs` (copy of the demo's pure assertions only), `app/` Server Actions below
- Modify: `lib/api.ts` (near `listContracts`, l.~9313), `app/actions.ts` (near `archiveContractAction`, l.~2118), `lib/agreementRules.ts` (`PickedAgreement`, `pickedInput`, `pickedProblem`), `scripts/agreements-check.mjs`, `package.json` (`check:contract-draft`), `.github/workflows/ci.yml` if `check:agreements` is listed there

**Interfaces — Produces:**
```ts
// lib/api.ts
export type ContractDraft = { id: string; title: string; sections: ContractSection[]; archivedAt: string | null; createdAt: string; updatedAt: string };
export type SavedSignature = { signerName: string; kind: "typed" | "drawn"; imageDataUrl: string | null; updatedAt: string };
export type InvoiceAgreementInput = … | { draftId: string };
listContractDrafts(token): Promise<{ drafts: ContractDraft[]; canEdit: boolean }>;
createContractDraft(token, input: { title: string; sections: ContractSection[] }): Promise<ContractDraft>;
updateContractDraft(token, id: string, input: { title: string; sections: ContractSection[] }): Promise<ContractDraft>;
duplicateContractDraft(token, id: string): Promise<ContractDraft>;
archiveContractDraft(token, id: string): Promise<ContractDraft>;
getSignature(token): Promise<{ signature: SavedSignature | null }>;
saveSignature(token, input: { kind: "typed"; signerName: string } | { kind: "drawn"; signerName: string; imagePngBase64: string }): Promise<SavedSignature>;
// app/actions.ts: same names + "Action", each `withToken(<message>, ...)` returning ActionResult<T>
// lib/agreementRules.ts
PickedAgreement = … | { kind: "draft"; id: string };   // pickedInput -> { draftId }
```

- [ ] **Step 1: Write failing checks.** Extend `scripts/agreements-check.mjs`: `pickedInput({kind:"draft", id:"d1"})` equals `{ draftId: "d1" }`, `pickedProblem` is null, `NO_AGREEMENT` unchanged, existing kinds unchanged. `scripts/contract-draft-check.mjs`: the render/edit assertions (as the demo's).
- [ ] **Step 2:** `npm run check:agreements && npm run check:contract-draft`; expected FAIL. **Step 3:** Implement (the actions return `{ ok:false, message }`, never throw: `AGENTS.md` rule). **Step 4:** Expected PASS; `npm run typecheck`. **Step 5: Commit.**

### Task 12: Signature pad and setup in the app

**Files:** Create `components/pipeline/invoice/SignaturePad.tsx`, `SignatureSetup.tsx` (copy of the demo's, with the data-flow adapted: `onSave` calls `saveSignatureAction`, stripping the `data:image/png;base64,` prefix into `imagePngBase64`); add a **Signature** card to the counselor Settings page (`app/dashboard/counselor/settings/page.tsx`, panels in `components/settings/`).

- [ ] **Step 1:** Playwright spec `e2e/stack/contract-signature.spec.ts` (signed-in stack project): sign in as the stack's counselor, open Settings, save a typed signature → reload → still shown; draw and save → reload → the drawn image shows; a 100 KB scribble image is refused with the API's message (use a test hook or a canvas stroke count that exceeds the cap).
- [ ] **Step 2:** Run (`npx playwright test --project=signed-in e2e/stack/contract-signature.spec.ts` against the local stack); expected FAIL. **Step 3:** Implement. **Step 4:** Expected PASS. **Step 5: Commit.**

### Task 13: Draft editor, panel, attach in the app

**Files:** Create `components/pipeline/invoice/ContractDraftEditor.tsx` (port of the demo's, data via the Task 11 actions); modify `ContractsPanel.tsx` (props gain `drafts: Loaded<{ drafts: ContractDraft[]; canEdit: boolean }>` and `signature: Loaded<{ signature: SavedSignature | null }>`), `invoice/useInvoiceSettings.ts` (load both beside contracts), `PaymentTracker.tsx` (pass them, ~l.1015), `InvoiceAgreement.tsx` (`InvoiceAgreementPicker` prop `drafts?: { id: string; title: string }[]`, optgroup **Drafted contracts**, `kind: "draft"`; the preview block renders the contract text with `renderContractText` and the contact's real names), `invoice/InvoiceComposer.tsx` (map `signature_needed` → open `SignatureSetup` inline; map `contract_fields_missing` / `contract_too_long` to their message; disable Schedule while a drafted contract is picked, text "A drafted contract is signed when you send it, so it can't be scheduled.").

- [ ] **Step 1: Write the failing e2e** `e2e/stack/contract-draft.spec.ts` (pattern of `payment-tracker-add.spec.ts`): counselor with a family (parent name + email): Contracts → **Draft contract** → edit → Save → listed under **Drafted in Meridies** (reload: still there); Duplicate; Archive; a firm non-admin sees the list, no Draft button; Send invoice → pick the draft with no signature → inline signature prompt → save → Send → the email in Mailpit has the agreement link → open `/agree/<token>`: text names the parent and student, shows `Signed for`, and (drawn) the `<img>` loads; type a name + consent → accepted; the contact moves to "Contract signed". A draft containing `{{fee}}` → the composer shows the `contract_fields_missing` message and sends nothing.
- [ ] **Step 2:** Run; expected FAIL. **Step 3:** Implement. **Step 4:** Run; expected PASS; also rerun `e2e/stack/payment-tracker-add.spec.ts` and the existing contracts/agreements specs to confirm no regression. **Step 5:** `npm run typecheck && npm run lint && npm run build`. **Step 6: Commit.**

### Task 14: App docs and PR

**Files:** Modify `AGENTS.md` (an entry next to the contracts/agreements one), `lib/changelog.ts` if the app has one (check; the demo says "the app's changelog": add the same counselor-audience release).

- [ ] **Step 1:** Write both. **Step 2:** Push, open the PR (do not merge). **Step 3:** Report to Brandon: three PR links, the order (backend → apply migration → app → demo), and what was **not** verified (real prod click-through, a real email to a real family, the CSP on the deployed API).

---

## Self-review

- **Spec coverage:** Draft button + editor (T9, T13); library + Duplicate/Archive (T3, T9, T13); one saved signature, drawn/typed (T3, T8, T12); attach group + sign-and-freeze at send (T4, T9, T13); family sees signature (T5); migration, trash rules, cascade, immutability (T2); scheduled sends constraint → refused (T4, T13); merge-field rules (T1, T4); gating/503 (T2, T3); build order and PRs (T6, T10, T14); verification (each task's tests, T13 e2e). No gap found.
- **Type consistency:** `ContractSection`, `MergeValues`, `SignatureBlock`, `RenderResult`, `renderContractText`, `addClause/removeClause/moveClause/copyTitle` are defined once (T1) and reused by name; DTO names (`ContractDraftDTO`/`ContractDraft`, `SignatureDTO`/`SavedSignature`) differ deliberately by repo (backend vs client) and match field-for-field; error codes are the Global Constraints list.
- **Left as the builder's reading:** exact file/line for the scheduled-send check (T4), where demo/app mount Settings cards and the demo's attach picker (T8, T9), `page()` CSP detail (T5): each task says what to read and what must hold.
- **Decision recorded:** scheduled invoices refuse a drafted contract (`draft_contract_send_now`) instead of freezing at schedule time; it satisfies the spec's constraint with the least unread code touched. Revisit if consultants ask to schedule contracts.
