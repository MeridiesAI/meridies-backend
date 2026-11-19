# Draft a contract in Meridies, sign it, and send it with the invoice — design

Status: approved by Brandon 2026-11-18. Plan: `docs/superpowers/plans/2026-11-18-contract-drafting.md`.

## Why

Today the Payment Tracker's **Contracts** panel only takes files the consultant already has (PDF/DOCX upload). A consultant with no contract file has to leave Meridies to write one. Brandon wants them to **draft a contract inside Meridies** from a basic outline (prerequisites, clauses, fees…), **sign it digitally**, and **send it to the family by attaching it to the invoice**.

## What already exists (all live; `AGREEMENTS_ENABLED=true`, migrations …03–05 applied 11/14)

Read from `origin/main` (the local checkouts are on stale branches: build in fresh worktrees off `origin/main`).

- Attaching an agreement to an invoice: backend `src/lib/invoiceAgreement.ts` (`invoiceAgreementInput` = `{agreementId} | {title, bodyText} | {contractId}`, `saveInlineAgreement`, `issueInvoiceAgreement`); app `components/pipeline/InvoiceAgreement.tsx` (picker, `PickedAgreement` union in `lib/agreementRules.ts`), mounted in `invoice/InvoiceComposer.tsx`.
- Family side, server-rendered by the backend: `/agree/:token` (typed full name + consent checkbox), immutable `agreement_acceptances` row (name, IP, UA, `body_sha256`, certificate), certificate emailed to both. Tables `agreements`, `agreement_tokens`, `agreement_acceptances` (`20261111000010`).
- The DB guard `private.agreements_guard()`: `body_text` is hashed in the database and **frozen once the agreement is `sent`**. A drafted contract that is rendered to text before it is sent gets all of this for free.
- Uploaded contracts: `contract_files` + private `contracts` bucket (`20261124000005`), admin-write / member-read, `private.attach_approval_gate` on the table. `ContractsPanel.tsx` in the Payment Tracker.
- No rich-text editor, no PDF writer, no signature pad anywhere. Only `<textarea>`s.
- Demo (`meridies-demo`) is the UI source and mocks everything in localStorage (`lib/agreements.ts`, `lib/invoiceStore.ts`, `ContractsPanel.tsx`).

## Goals

1. **Draft contract** button beside "Upload contract". Opens an editor with a fixed outline the consultant fills in: Title · Services · Prerequisites (list) · Fees & payment terms · Clauses (list of heading + text, starter clauses pre-filled, add/remove/reorder) · Signature.
2. Drafts are saved in the Contracts library, listed under "Drafted in Meridies" next to uploaded files (Edit, Duplicate, Archive).
3. **One saved signature per consultant**, set once (Settings, and inline from the editor when none exists). Drawn on a canvas **or** typed.
4. The invoice composer's attach menu gets a "Drafted contracts" group. Sending the invoice **signs and freezes** that contract for that family (family/student names and date merged in), and the family gets it exactly as they get any agreement today: "Agreement to review" block, accept on the existing sign page.
5. The family sees the consultant's signature on the sign page and in the certificate text.

## Non-goals (v1)

- PDF generation / PDF attachment (approach 2, next phase). No new dependency.
- Certified e-signature, a vendor, or a drawn signature for the family. The family keeps typed-name acceptance; every certificate still says "not a certified electronic signature".
- Rich-text formatting, clause library shared across practices, auto-filling fees from the family's package.
- Per-family fill-in blanks at attach time (e.g. `{{fee}}`). **Brandon's decision (11/18):** a family with different fees gets a duplicated draft with the fee text changed. Only the four automatic merge fields exist in v1. The editor's **Duplicate** action is therefore required, not optional.
- Editing a contract after it was sent (void it and send a new one: existing behavior).
- Offering drafts in the contact card's "New agreement" modal (stays freeform).
- Text-message invoices (existing rule: an agreement needs the email path).

## Anti-goals (a failure even if it "works")

- A contract whose text changes after the family could have seen it, or after the consultant signed.
- A consultant's old contracts changing because they later replaced their saved signature.
- A merge field like `{{student_name}}` left unresolved in a sent contract.
- The signature image reachable without the family's link token.
- Any change to how uploaded-file contracts and existing agreements behave.

## Approaches

1. **Text-first (chosen by Brandon, 11/18).** Drafts are stored as structured sections and rendered to plain text; the rendered text becomes a normal inline agreement, so signing, hashing, freezing and the sign page are reused unchanged. No PDF.
2. **PDF-first (later).** Render a real PDF with the signature image and attach it (the 5 MB PDF-attach path already exists for uploaded contracts). Needs a backend PDF dependency and layout work. Not now; the design below must not block it (drafts stay structured, so a PDF renderer can be added over the same data).

Signature choice: Brandon picked "the consultant signs once in settings (drawn or typed); stamped on each contract at send; the family still types their name".

## Design

### Data (one additive migration, after `20261124000005`)

- `contract_drafts` — practice-scoped exactly like `contract_files` (firm_id, counselor_id, practice_id, scope check, RLS members-read / `crm_can_admin` write, no delete, `archived_at`, `private.attach_approval_gate`). Columns: `title` (≤160), `sections jsonb` (ordered, validated by zod in the API; size capped so rendered text stays under the 60,000-char agreement limit).
- `counselor_signatures` — one row per consultant (`counselor_id` pk): `signer_name`, `kind` typed|drawn, `image_png` (≤ ~60 KB, null when typed), `image_sha256`, `updated_at`. Owner-only read/write. **Replaceable** — contracts never read it after signing.
- `agreement_signatures` — the **frozen snapshot** taken when a contract is signed: `agreement_id` (pk, fk), `signer_name`, `kind`, `image_png`, `image_sha256`, `signed_at`. Insert-only, immutable by trigger (same pattern as `agreement_acceptances`), no client update/delete.
- `agreement_signatures.agreement_id` is `on delete cascade` from `agreements`; its immutability trigger blocks UPDATE and any delete that isn't the parent agreement being removed. A signed (accepted) agreement stays undeletable through the acceptance row's `restrict`, exactly as today; a sent-but-unaccepted drafted contract keeps today's behavior (contact deletable, restorable from the AxIS trash). So `contract_drafts` and `agreement_signatures` need `axis_trash_rules` entries like `agreements` has (see the end of `20261111000010`). *(Builder-check call.)*
- **No change to `agreements` or its guard.** The rendered text carries the signature block, so `body_sha256` covers it.
- The new migration is numbered after the latest on `main` (`20261127000003` at last look), not after `20261124000005`.

### Rendering (one server function, the single source of truth)

`renderContractText(draft, mergeFields, signature, signedAt)` → `{ title, bodyText }`. Plain text: numbered headings, prerequisites as a list, clauses, then a block like `Signed for <practice> by <name>, <date>` plus, for a drawn signature, `Signature image SHA-256: <hash>` (binds the family's accepted hash to the exact image). Deterministic: same inputs, same text. Merge fields: `{{family_name}}` = the contact's `parent_name` when it has a parent email, else `student_name` (the same rule `POST /agreements/:id/send` uses for the recipient), used verbatim, no surname guessing; `{{student_name}}`, `{{counselor_name}}`, `{{date}}`. An unresolved or empty field **blocks the attach** with a message naming which field on the family's card to fill. *(Builder-check call.)*

### Sign-and-send path

New 4th variant `{ draftId }` in `invoiceAgreementInput`. On invoice send: require a saved signature (else 409 `signature_needed`, the UI offers to create one) → render → `saveInlineAgreement` with the rendered text → insert `agreement_signatures` snapshot → existing `mintAgreementLink` (draft→sent freezes it). Preview does the same render without writing. Agreement `counselor_id` is the sender, so the signer is the person who pressed Send.

### Family page

`/agree/:token` unchanged for typed signatures (the name is in the text). For a drawn one, show the image under the text from a new token-gated route `GET /agree/:token/signature` (streams `agreement_signatures.image_png` after re-checking its sha against the text, like `/agree/:token/file`). The certificate email repeats the signature line from the text; the image is not embedded in email in v1.

### App / demo UI

- `ContractsPanel`: "Draft contract" button; "Drafted in Meridies" list.
- New `ContractDraftEditor` (Modal): the outline above, "Preview as the family", note "Starter wording is a starting point: have your attorney review it" (UI only, not in the contract).
- New `SignatureSetup` (signature pad: hand-rolled canvas with pointer events, no dependency; typed alternative) in Settings and inline in the editor/attach flow.
- `InvoiceAgreement` picker: optgroup "Drafted contracts"; `PickedAgreement` gains kind `draft`; composer preview shows the contract it would send.
- Same UI in `meridies-demo` against mocks, **demo first** (it is the UI source).

### Gating and rollout

Behind `AGREEMENTS_ENABLED` (already on). Without the migration the new routes answer 503 `contract_drafts_unavailable` (mirror `contractsUnavailable`) and nothing else changes. Three PRs: demo, backend, app. Merge backend, apply the migration (Apply migrations workflow, approval gate), then app, then demo. Starter-clause wording: short, plain, no guarantees of admission, flagged for legal review.

## Calls made (mine, not Brandon's — check these)

- Drafts are practice-shared (like packages); the **signature is personal** to whoever presses Send.
- Fixed outline: Services, Prerequisites, Fees & terms, Clauses; starter clauses pre-filled, reviewed by an attorney before real use.
- Drafts are saved in the Contracts library and each family gets its own frozen copy at send.
- `{{family_name}}` = parent name (when a parent email exists) else student name; empty field blocks the send.
- Deleting a contact with a sent-but-unaccepted drafted contract works as it does today; signed contracts stay protected.
- Signature pad is hand-rolled (no new dependency); the drawn image appears on the sign page, not inside emails.
- Build order: demo, then backend, then app; merge backend, apply the migration, then app, then demo.

## Left to the builder

- Section JSON shape, exact starter clauses/headings, editor layout, reorder mechanics.
- Signature pad details (stroke smoothing, size cap, clear/undo).
- **Scheduled invoices** (cron path, `invoiceDispatch.ts`, `pipeline_invoice_drafts`): constraint only — the signature date must be the day the consultant pressed Schedule/Send and the text must not change after they pressed it. Pick whether to freeze+sign at schedule time (cron sends by `agreementId`) or at send time.
- Whether a firm non-admin can attach but not create drafts (mirror `contract_files`: yes).
- Rate/size limits and error copy.

## Verification

- Backend integration tests (`test/integration`): render determinism and merge-field blocking; attach `{draftId}` end to end (agreement saved, signature snapshot written, link minted, status `sent`, text/hash frozen); replacing the saved signature does not change an earlier contract; snapshot rows immutable; `/agree/:token/signature` needs the token and 404s otherwise; family acceptance still records the hash of the signed text; uploaded-file contract and `{title, bodyText}` paths unchanged; flag off → 404, migration missing → 503.
- App: Playwright e2e on the isolated local stack (see memory `local-verification-stack-recipe`): create signature → draft contract → attach to an invoice → send → open the `/agree` link → accept. Demo: same flow by hand in the browser.
- `npm run build` + lint + typecheck in all three repos. A real prod click-through is **not** claimable until done after deploy.
