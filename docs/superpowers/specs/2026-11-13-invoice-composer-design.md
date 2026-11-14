# Invoice composer, payment methods, packages library, contracts: backend design and API contract

Date: 2026-11-13. Branch `feat/invoice-composer` (backend half). The app and demo build against this file.
Migrations: `20261124000003`, `20261124000004`, `20261124000005` (NOT applied to production; a human approves
them through `migrations.yml`). Every new route degrades calmly until its migration is in (503 with a stable
`code`), and an invoice sent with an old payload is byte for byte the invoice it always was.

## 1. Intent

Rebuild the Contact Pipeline "send an invoice" flow as an **Invoice composer** (form on the left, live Email / Text /
Style preview on the right) with:

- more ways to pay (Zelle, PayPal, "+ Add" custom ones) shown with the consultant's instructions;
- a customizable invoice look (accent colour, one of six email-safe fonts, header alignment, corners, button label,
  footer text, logo on/off);
- line items, a note, Cc, Email or Text, scheduled sends ("now / tomorrow / N days before due / pick a date", repeat
  every year) and reminders (days before/after the due date);
- a practice-level **packages library** (templates) that a family is set up from;
- a **contracts** library (PDF / DOCX) that attaches to an invoice and is accepted by the family with the existing
  typed-name flow, bound to the file's SHA-256;
- an optional, **off by default** card-fee pass-through.

## 2. Decisions (and where they differ from the plan)

1. **Drafts/scheduled sends are their own table** (`pipeline_invoice_drafts`). A real invoice row is made only when
   the draft is sent, so `deriveAccount` and the credit guards are untouched. States: `draft | scheduled | sent |
   cancelled | failed`. **Deviation:** `failed` is added to the plan's four (a scheduled send that gave up needs a
   state the counselor can see and fix; `PUT` with `state: "scheduled"` retries it).
2. **Manual payment methods** (Zelle, PayPal, Check, Bank transfer = `ach`, custom) show the consultant's
   instructions; the consultant uses **Record** when the money arrives. Only **Card** goes through Stripe Checkout.
3. **Custom methods** = a practice-level label + instructions. A recorded payment for one is stored as
   `method: "other"` with the label in the payment's `note` (the app does this; there is no server helper). `paypal`
   is added to the payment `method` enum everywhere (DB check, `PAYMENT_METHODS`). Until migration `…04` is applied,
   recording `paypal` is a 400 "That value isn't allowed".
4. **Invoice style** is per practice. The look is **snapshotted onto the invoice at send** (`style_snapshot`), so
   changing the style later never re-skins a sent invoice (Send again, reminders and the pay page all use the
   snapshot). The ways-to-pay list is *not* snapshotted: an invoice stores the accepted method **keys**, and the
   labels and instructions shown are the practice's current ones (a changed Zelle address applies to a resend).
5. **Packages** are a template library. Assigning one COPIES it into the family's `pipeline_packages` row. The
   deposit lives only on the template (there is no deposit column on a package): the from-template answer carries
   the `plan` (deposit, then even installments) so the composer can prefill the first invoice.
6. **Contracts** attach by `agreement: { contractId }` on the invoice routes. This creates a regular `agreements`
   row bound to the file: the database writes its `storage_path` and its text, `Contract file: <name>\nFile SHA-256:
   <hash>`, so `body_sha256` (and the certificate) binds the acceptance to the exact bytes. Because it is an agreement,
   contracts need `AGREEMENTS_ENABLED=true` (404 `agreements_off` otherwise).
7. **Card-fee pass-through** is behind `INVOICE_CARD_FEE_ENABLED` (default off) and a per-invoice `passCardFee`.
8. **Text (SMS)** reuses the consultant's own Twilio number (`consultant_phone_numbers`). Without one: 409
   `texting_unavailable` on create/draft, `textAvailable: false` on preview and `GET /pipeline/invoice-options`.
9. **Deviation (shared create path):** the counselor's Send and the cron do not call one function. They share the
   pure builders (`lib/invoiceSend.ts` `draftInvoice` → `planInvoice`, `invoiceEmail`; `lib/invoiceSettings.ts`
   `buildExtras`), and the cron (`lib/invoiceDispatch.ts`) re-checks everything itself with the service role
   (counselor still approved, still able to bill that family, amounts planned again). `deriveAccount` is still the
   only billing arithmetic.
10. **Deviation (migration split):** three files, not one: `…03` practice settings, `…04` invoice columns + drafts +
    reminders + heartbeats, `…05` contracts.

## 3. Who can do what

Everything is counselor-only. The practice is the firm (a firm member) or the solo counselor (`practice_id =
coalesce(firm_id, counselor_id)`). **Read**: anyone who works in the practice. **Write** the library/settings
(payment methods, style, package templates, contracts): a firm owner/admin or the solo counselor; anyone else gets
403 (`canEdit: false` in the GET answers tells the app). **Drafts and invoices**: whoever may bill the contact
(`private.crm_can_bill`). A student never sees any of it.

## 4. Tables

| Table | Notes |
|---|---|
| `practice_payment_methods` | `(practice_id, key)` unique. `key`: `card|ach|zelle|paypal|check` (built-in, `builtin: true`, seeded on an admin's first GET) or `custom-<8 hex>`. `label ≤60`, `instructions ≤500`, `enabled`, `sort`. A built-in can't be deleted. |
| `practice_invoice_style` | One row per practice (`practice_id` PK). `accent_color #RRGGBB|null`, `font_key serif|sans|modern|classic|humanist|mono`, `header_align left|center`, `corner square|rounded|pill`, `button_label ≤40`, `footer_text ≤300`, `show_logo`. No row = defaults. |
| `pipeline_package_templates` | `name`, `years_tag ≤40`, `total_cents`, `deposit_cents ≤ total`, `installments 1..60` (the deposit counts as the first), `duration_months`, `inclusions text[] ≤20`, `archived_at`. Archived, never deleted. |
| `pipeline_invoice_drafts` | `contact_id`, `payload jsonb` (§6.5), `state`, `send_at`, `repeat_yearly`, `sent_invoice_id`, `sent_at`, `attempts`, `last_error`, `claimed_at`, `created_by`. A client can only move a draft between `draft|scheduled|cancelled` and edit it. |
| `pipeline_invoices` (new nullable cols) | `line_items jsonb`, `accepted_methods text[]`, `pass_card_fee bool default false`, `note ≤1000`, `cc text[] ≤5`, `reminders int[] ≤5`, `reminders_sent jsonb` (`{"-3": "<iso>"}`), `style_snapshot jsonb`, `agreement_id uuid` (the one column a client may update, after the insert). All null/false on an invoice made without the composer. |
| `pipeline_payments.method` | Now also accepts `paypal`. |
| `contract_files` | `name ≤160`, `storage_path` (`<practice id>/<uuid>.<pdf|docx>`), `mime`, `size_bytes ≤10 MB`, `sha256`, `archived_at`. |
| `agreements` (changed) | `+ contract_file_id`; `storage_path` is now `null` or the contract's path (was always null). |
| Storage `contracts` | Private bucket, PDF/DOCX, 10 MB, no client policy. |

## 5. Environment variables and infra

| Name | Where | Meaning |
|---|---|---|
| `INVOICE_CARD_FEE_ENABLED` | API | `"true"` turns on the card-fee pass-through. Default off. With it off no fee is ever computed, shown or charged. |
| `AGREEMENTS_ENABLED` | API | Already exists. Contracts ride on agreements, so contracts need it `true`. |
| `PUBLIC_API_URL`, `CRON_SECRET` | API | Already exist; links in emails/texts and the crons need them. |
| Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, a consultant's number) | API | Already exist; the Text channel needs the consultant's own number. |

**Two new Railway cron services** (curl image + `sh -c`, like the others):

```
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$API_URL/internal/invoice-drafts/dispatch"     # every 10-15 minutes
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$API_URL/internal/invoice-reminders/dispatch"  # hourly
```

Both are idempotent, answer `{ ran: false, reason }` (200) before migration `…04`, and record a heartbeat
(`invoice-drafts`, `invoice-reminders`; `GET /internal/status`). Both routes are limited to 10 calls a minute.

## 6. API

All routes are under `/pipeline`, `Authorization: Bearer <jwt>`, JSON bodies are **strict** (an unknown key is a 400).
Money is integer cents. Dates are `YYYY-MM-DD`; timestamps ISO 8601 (Postgres may render `+00:00` instead of `Z`).
Errors are `{ "error": "<message>", "code"?: "<stable code>" }`.

### 6.1 Options

`GET /pipeline/invoice-options` → `{ composerReady: boolean, textAvailable: boolean, cardFeeEnabled: boolean, canEdit: boolean }`.
`composerReady` is false before migration `…03`. `textAvailable` is true when the caller has their own active
texting number. `cardFeeEnabled` mirrors `INVOICE_CARD_FEE_ENABLED` (hide the "Pass card fee" toggle when false).

### 6.2 Payment methods

```
GET    /pipeline/payment-methods           -> { methods: Method[], canEdit }
PUT    /pipeline/payment-methods           { methods: [{ key, label?, instructions?, enabled?, sort? }] }  -> { methods, canEdit: true }
POST   /pipeline/payment-methods           { label (1-60), instructions? (≤500) }  -> 201 Method
DELETE /pipeline/payment-methods/:key      -> { ok: true }
```

`Method = { key: string, label: string, instructions: string, enabled: boolean, builtin: boolean, sort: number }`.
The built-ins (`card` "Card", `ach` "Bank transfer", `zelle` "Zelle", `paypal` "PayPal", `check` "Check") are saved on an
admin's first GET; a non-admin who reads first sees them unsaved. `PUT` edits `instructions`, `enabled`, `sort` of
built-ins and customs and `label` of customs only (400 for a built-in's label, 400 for instructions on `card`, 404
for an unknown key); it changes only the keys sent. `POST` is 409 for a duplicate label (case-insensitive) or past 20
customs. `DELETE`: 409 `builtin_method` for a built-in. 403 for a non-admin on write. 503 `invoice_settings_unavailable`
before the migration.

### 6.3 Invoice style

```
GET /pipeline/invoice-style   -> { style: Style, fonts: Font[], canEdit }
PUT /pipeline/invoice-style   a partial Style  -> { style, fonts, canEdit: true }
```

```
Style = { accentColor: "#RRGGBB" | null, fontKey: "serif"|"sans"|"modern"|"classic"|"humanist"|"mono",
          headerAlign: "left"|"center", corner: "square"|"rounded"|"pill", buttonLabel: string (1-40),
          footerText: string (≤300), showLogo: boolean }
Font  = { key, label, stack }     // the six email-safe stacks, for the picker and the app's own preview
```

Defaults (no row): `accentColor: null` (the practice's branding accent), `serif`, `left`, `rounded`, `"Pay by card"`, `""`, `true`.
A `buttonLabel` of exactly `"Pay by card"` draws the original "Pay $X by card"; any other label is drawn as typed.

### 6.4 Package templates

```
GET    /pipeline/package-templates?includeArchived=true   -> { templates: Template[], canEdit }
POST   /pipeline/package-templates                         -> 201 Template
PUT    /pipeline/package-templates/:id                     -> Template      (also takes archived: boolean)
DELETE /pipeline/package-templates/:id                     -> Template      (archives it)
POST   /pipeline/contacts/:id/package/from-template        { templateId } -> { account, template: { id, name, depositCents }, plan }
```

Body (POST/PUT): `{ name (1-200), yearsTag? (≤40|null), totalCents, depositCents? (default 0, ≤ total), installments (1-60),
durationMonths? (1-120|null), inclusions? (≤20 strings ≤200), archived? }`. 400 if the deposit exceeds the total or covers
the whole of a package paid in several parts.

```
Template = { id, name, yearsTag, totalCents, depositCents, installments, durationMonths, inclusions: string[],
             archivedAt, createdAt, plan: [{ label, amountCents }], summary: string }
```

`plan` is the deposit (when there is one) then the rest split evenly (odd cents go one each to the earliest), adding up
to the total; labels are `"Deposit"`, `"Installment 2 of 3"` (`"Payment in full"` for one payment). `from-template` copies
name, total, installments and length into the family's package (it stays editable with `PUT /contacts/:id/package`) and
returns the account (the same shape as `PUT /contacts/:id/package`). 404 for an archived template or another practice's;
403 if the caller can't bill the family. Editing/archiving a template changes no family already set up.

### 6.5 Invoice preview, send, Send again

`POST /pipeline/contacts/:id/invoices/preview` and `POST /pipeline/contacts/:id/invoices` take their existing body plus
these **optional** fields (a payload without them is validated and behaves exactly as before):

```
{ label, amountCents, dueOn, send? (create only), agreement?,
  lines?: [{ description (1-200), detail? (≤200|null), amountCents (≥0) }]   // 1-20; must sum to amountCents -> 400 lines_sum_mismatch
  methods?: string[]            // accepted method keys. Absent = card only, as before. May include "card".
  passCardFee?: boolean
  note?: string (≤1000)
  cc?: string[]                 // ≤5 emails
  to?: string                   // email, instead of the card's parent/student address
  channel?: "email" | "text"    // default email
  reminders?: number[]          // day offsets from the due date, -30..30, ≤5, e.g. [-3, 0, 3]  -> 400 bad_reminders
  style?: Partial<Style>        // PREVIEW ONLY: a look to preview without saving it
}
agreement = { agreementId } | { title, bodyText } | { contractId }      // contractId: a library contract
```

**Preview** answers everything it did (`to, subject, text, grossCents, creditAppliedCents, alreadyPaidCents,
amountDueCents, practice, issuedOn, packageName, plan, payByCard, agreement?`) plus, additively:
`html` (the email as HTML), `sms` (the text-message body), `cc: string[]`, `style: Style | null` (null for a plain
invoice), `methods: Method[]` (the accepted, still-enabled ones, practice order), `lines: [{description, detail, amountCents}]`
(the lines, or the single package line), `feeCents` (0 unless the fee applies), `textAvailable: boolean`.
`payByCard` is false when `methods` is given without `card`. Nothing is saved or minted.

**Create** answers `201 { account, invoiceNumber, sentTo, emailSent, agreement?: { id, title } }`; for `channel: "text"`
`sentTo` is the phone number and `emailSent` means the text was handed to Twilio and accepted (`false` when Twilio isn't
configured: the text is recorded `queued`). Refusals happen **before** the invoice is numbered:

| Status / code | When |
|---|---|
| 400 `lines_sum_mismatch`, `bad_reminders`, `text_needs_send` | composer rules (`text_needs_send`: `channel: "text"` with `send: false`) |
| 400 `text_no_agreement` | a text can't carry an agreement/contract |
| 400 `contact_no_phone` / `contact_no_email` | nothing to send to |
| 409 `texting_unavailable` | `channel: "text"` and the caller has no texting number of their own |
| 404 `agreements_off` / 503 `agreements_unavailable` | an agreement/contract asked for while the switch is off / the migration is missing |
| 404 | a contract that isn't in the caller's library (another practice's, archived) |
| 503 `invoice_composer_unavailable` | composer fields sent but migration `…04` isn't applied (the app resends without them) |
| 409 `nothing_to_invoice`, `over_billable`, `already_covered`, `credit_changed` | as before |

What a composer invoice stores: `line_items`, `accepted_methods`, `pass_card_fee`, `note`, `cc`, `reminders` (sorted,
unique), `style_snapshot` (the practice's saved style at send). A request using **none** of the composer fields writes
none of these and sends the original email.

The invoice email/page: the lines (else the one package line), Subtotal/Credit/Already paid/Amount due as before, a
**Pay by card** button (label per the style) only when card is accepted **and** the practice takes cards; **Other ways to
pay** (non-card methods with their instructions) while something is owed; the note; the practice's footer text; the
card-fee sentence when it applies; and, when there is no card button, **"View this invoice online"** (a link to the
invoice's own `/pay/<token>` page; created for every composer invoice, view-only). A contract/agreement adds the existing
"Agreement to review" block and the PDF (≤5 MB, PDF only) as an attachment named `<contract name>.pdf`.

`POST /pipeline/invoices/:id/send` (Send again) takes the same optional `agreement` as before and re-renders a composer
invoice with what it was sent with (stored look, lines, methods, note, Cc).

### 6.6 Drafts and scheduled invoices

```
GET    /pipeline/invoice-drafts?contactId=<uuid>&state=<state>   -> { drafts: Draft[] }      (contactId is required)
POST   /pipeline/invoice-drafts   { contactId, payload, state?: "draft"|"scheduled" (default draft), repeatYearly? (default false) } -> 201 Draft
PUT    /pipeline/invoice-drafts/:id   { payload?, state?: "draft"|"scheduled", repeatYearly? } -> Draft      (409 draft_closed once sent/cancelled)
DELETE /pipeline/invoice-drafts/:id   -> Draft  (state "cancelled"; 409 draft_closed once sent)
```

```
payload = { label, amountCents, dueOn, agreement?, lines?, methods?, passCardFee?, note?, cc?, to?, channel?, reminders?,
            schedule?: { mode: "now" } | { mode: "tomorrow" } | { mode: "before_due", daysBefore: 0-120 } | { mode: "date", date } }
Draft   = { id, contactId, payload, state: "draft"|"scheduled"|"sent"|"cancelled"|"failed", sendAt: string | null,
            repeatYearly, sentInvoiceId, sentAt, attempts, lastError, createdAt, updatedAt }
```

`payload` is the invoice body above (no `send`, no `style`) plus the schedule. On save the server validates it like a
create (400 with the same codes, plus `due_passed` and `send_time_passed`) and, for `state: "scheduled"`, resolves
`sendAt` from the schedule **in the counselor's time zone (UTC when they have none)**, always at **9:00 local**:
`tomorrow` = tomorrow 9:00; `before_due` = `dueOn − daysBefore` 9:00; `date` = that day 9:00; `now` (or no schedule) =
due on the next cron run. A time already past is 400 `send_time_passed`. `repeatYearly` needs `state: "scheduled"`. A
`draft` has `sendAt: null` and is never sent by anything. A `failed` draft is rescheduled with `PUT { state: "scheduled" }`
(attempts reset). A client can't mark a draft `sent`.

### 6.7 Contracts

```
POST   /pipeline/contracts/upload-url   { contentType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes }
       -> { bucket, path, token, uploadUrl, expiresIn, maxBytes, contentType }
POST   /pipeline/contracts              { path, name (1-160) } -> 201 Contract
GET    /pipeline/contracts?includeArchived=true -> { contracts: Contract[], canEdit }
GET    /pipeline/contracts/:id/url      -> { url, expiresIn: 60 }
DELETE /pipeline/contracts/:id          -> Contract (archives it)
Contract = { id, name, mime, sizeBytes, sha256, archivedAt, createdAt }
```

Flow: `upload-url` → `PUT uploadUrl` the bytes (Supabase Storage signed upload: `multipart/form-data` with a `cacheControl`
field and the file under the empty field name, the way `uploadToSignedUrl` sends it) → `POST /pipeline/contracts { path, name }`.
Registering reads the object back: it must exist, be ≤10 MB and really be a PDF (`%PDF-`) or a Word `.docx` (a zip with
`word/document.xml`) of the type its path says, else 400 and the object is removed. Admin only (403); 409
`contracts_full` at 100 live contracts; 409 `contract_exists` for a path registered twice; 503 `contracts_unavailable`
before migration `…05`. Attach with `agreement: { contractId }` (§6.5/6.6).

### 6.8 What the family sees

- **Email**: §6.5. Reply-To, From name, `message_deliveries` record exactly as for any invoice email; a contract's private
  link is kept out of the record.
- **`GET /pay/:token`** (public): the invoice document with the stored look, lines, **Other ways to pay**, the note, the
  card-fee sentence, and a **contract block** ("Agreement to review" + a button) when the invoice has an open
  agreement/contract of the family's own. A composer invoice with no card on it (or no Stripe) shows no pay button.
  `POST /pay/:token/contract` (the button) mints a fresh private `/agree` link and 303-redirects to it; the email's link
  keeps working. Invoices from before the composer behave as before (503 "isn't available" with Stripe off).
- **`GET /agree/:token`** shows an **"Open the contract file"** link for a contract agreement; **`GET /agree/:token/file`**
  streams the exact file (PDF inline, DOCX as a download; `nosniff`, sandboxing CSP) for an open or accepted link. The
  accepted record and certificate carry the file's SHA-256 (in the agreement text and `body_sha256`).

### 6.9 Reminders (cron, not an API)

An invoice's `reminders` are day offsets from its due date (`-3` = three days before, `0` = the day, `3` = three days
after), sent at 9:00 in the sending counselor's zone, by email (or by text when the invoice was texted) while something is
still owed. Each is claimed once (`reminders_sent`); one that misses its day by more than 36 hours is dropped, not sent
late; a paid or voided invoice gets none. Subject `Reminder: Invoice INV-1005: $1,500 due 2026-11-20` (`Past due: …` after).

### 6.10 Cron endpoints

`POST /internal/invoice-drafts/dispatch` → `{ ran, sent, failed, retried, held, rolled, reason? }`;
`POST /internal/invoice-reminders/dispatch` → `{ ran, sent, skipped, held, failed, reason? }`. `Authorization: Bearer $CRON_SECRET`.
Dispatch: claims each due draft; the counselor must still be approved and able to bill the family; amounts are planned again;
the draft is spent the moment its invoice is numbered; a counselor sends at most 100 a day (the rest wait); a refusal
(`409`, no email address, a vanished family, a past due date) fails the draft with its reason in `lastError`; a transient
fault retries an hour later, three times. `repeat_yearly` writes next year's draft (same payload, due date a year later,
Feb 29 → 28) after the send.

## 7. Card-fee pass-through (flagged, droppable)

`lib/invoiceCardFee.ts`: with `INVOICE_CARD_FEE_ENABLED=true` and an invoice marked `passCardFee` that accepts card, a family
paying **by card** is asked for `gross = ceil((owed + 30) / (1 − 0.029))` cents (Stripe's US 2.9% + 30¢ grossed up so the
practice nets the invoice amount). The invoice, email and pay page show the fee as its own sentence ("Paying by card adds a $45.11
processing fee ($1,545.11 in all). Other ways to pay have no fee."); the Pay button asks for the total; **Amount due stays the
invoice amount**. Checkout charges `owed + fee` and puts the fee in the session metadata (`meridies_fee_cents`); the Stripe
webhook records the payment as `amount_total − fee`, so the recorded payment is the invoice amount, never the fee (a nonsense fee
value in metadata is ignored). With the flag off nothing is computed anywhere. To drop the feature: delete `lib/invoiceCardFee.ts`,
the `feeFor` calls in `lib/invoiceSettings.ts` and the `META_FEE` lines in `routes/pay.ts` / `lib/stripeConnect.ts`.

## 8. Deploy order and degradation

- Migrations `…03`, `…04`, `…05` are additive and safe for the serving build. Either order with the code.
- Before `…03`: settings routes 503 `invoice_settings_unavailable`; invoices read methods/style as defaults.
- Before `…04`: drafts 503 `invoice_drafts_unavailable`; composer fields on create 503 `invoice_composer_unavailable`;
  recording `paypal` is a 400; both crons answer `ran: false`.
- Before `…05`: contracts 503 `contracts_unavailable`; agreements are unchanged.
- App rule: treat any 503 with these codes as "not switched on yet" (`lib/apiErrors.ts`).

## 9. Tests

Unit: `invoice-schedule`, `invoice-composer`, `invoice-card-fee`, `invoice-drafts`, `contracts`, `invoice-document` (extended),
`stripe-webhook` (fee). Integration: `invoice-composer`, `invoice-drafts` (drafts → dispatch → invoice, reminders),
`contracts` (upload → register → attach → email attachment → family opens/accepts → pay-page button).
