# Google connector: picked files only — design

Status: draft for review (revision 4, 2026-10-15: Elvin's feedback on the
type step applied: server-side type guess, one batch confirm). Revision 3
(same day) applied the review round, re-checked against `main` at 5dac8cd
after PR #54. Revision 2 (10/14) applied Elvin's answers. Microsoft/OneDrive is a separate design, after a
permission test (see §8).

## 1. Goal

A counselor connects Google once and brings in the files they choose, and
only those, from Drive into a student's folder. Meridies never holds a key
to the rest of their Drive.

**What Elvin asked for (10/14):**
- Google first; Microsoft later.
- No broad Drive access: a counselor's Drive holds families' tax returns,
  FAFSA paperwork and IEPs that Meridies has no reason to read.
- A file picker: the counselor chooses the files. Drag and drop from the
  computer stays beside it; to the counselor they are one "add files"
  feature.
- Files only in v1; folders can be browsed in the picker but not picked.
- 10 files per pick, as a config value.
- `gmail.send` dropped; Microsoft's unused `Mail.Send` dropped in a small
  follow-up PR.
- Calendar asked for only when the counselor turns it on (incremental
  authorization).
- Drive imports arrive uncategorized, so they stay out of AI until the
  counselor says what they are.
- Disconnecting is clear everywhere, including the task tracker.

**Added 10/15 (type step):**
- Saying what each file is must not be file-by-file work. The server
  guesses each type without AI (filename, Google file type, text patterns
  from local extraction); the counselor sees one list with the guesses
  filled in and confirms it with one **Looks right**, editing only wrong or
  unknown rows.
- Files picked where the type is implied (Essays) skip the question.
- The step can be skipped. Unconfirmed files stay out of AI, and what AxIS
  leaves out says "N files aren't categorized".
- Sensitive guesses (financial, IEP/504) come pre-filled as kept out of AI;
  unknown files stay out.
- Once a type is confirmed, the file's text is extracted for AI use, so an
  unlocked file actually has text for AxIS.

**What this design assumes (correct me):**
- The connector must work for real counselors at launch, so it has to pass
  Google's app verification.
- Meet links on Calendar events keep working once Calendar is turned on.

**Success:**
1. Google asks for no restricted scope, so verification needs no paid
   security assessment (CASA).
2. A counselor can pick one or more Drive files, including files shared
   with them and files on shared drives, and file them to a student.
3. Meridies cannot list or open any Drive file the counselor didn't pick or
   the app didn't create, enforced by Google, not just by our code.
4. No picked file reaches a model until the counselor has said what it is,
   on every path that reads documents, not only the context layer.
5. The task tracker keeps working for picked files, and says plainly when
   Google is disconnected.
6. Supplement Docs, essays linked to a Google Doc, and Meet links keep
   working.

## 2. What exists today (read 10/14, re-checked 10/15 at 5dac8cd)

- `src/lib/oauth.ts` asks Google for `openid`, `email`,
  **`drive.readonly`**, `drive.file`, **`gmail.send`**, `calendar.events`,
  all at once, on connect, with `prompt=consent` and
  `include_granted_scopes=true` (`:104-106`). The callback upserts the grant
  keyed on owner and provider and records the id token's `sub` as
  `account_id` (`:301-333`), but nothing compares it on a later consent.
- `drive.readonly` (read every file) is a **restricted** scope: it needs
  verification plus a yearly third-party security assessment.
- **`gmail.send` is requested but nothing uses it.** No code calls the Gmail
  API (email goes through Resend). The same is true of Microsoft's
  `Mail.Send`.
- `GET /integrations/:provider/files` lists or searches the whole Drive;
  the app's `RemoteFilePicker` shows that list (used in `StudentFiles` and
  `EssaysPanel`). `StudentFiles` passes `kindFor={kindFromFilename}`
  (`components/dashboard/StudentFiles.tsx:441`), and `RemoteFilePicker`
  sends that guessed kind with the import (`RemoteFilePicker.tsx:123`).
- `POST /integrations/:provider/files/import` already:
  - requires edit access to the student (`resolveStudentId(..., "edit")`)
    and checks the target folder belongs to that student;
  - validates the file id's shape (`assertFileId`) and opens it only with
    the counselor's own grant;
  - refuses files over 25 MB (declared size and streamed size) and Google
    types it can't export (`importable`);
  - exports Google-native files to fixed formats: Docs, Slides and Drawings
    to PDF, Sheets to .xlsx (`GOOGLE_EXPORTS`);
  - **defaults the kind to `essay` for documents and `other` otherwise, and
    `available_to_llm` to true**, and when `available_to_llm` is true
    exports a Google Doc's text into `parsed_data` at import
    (`routes/integrations.ts:280-291`).
- **Paths that read documents into a model without the context layer's
  rule.** `documentAiDecision` (`lib/context/documentAi.ts`) is used only by
  the context layer. The tracker's model call reads every attached document
  whose `available_to_llm` isn't false (`routes/tasks.ts:1032`), so an
  `other` file reaches the model there. `lib/liveDocuments.ts:68` re-exports
  a Doc's text into `parsed_data` whenever its edit time changes and
  `available_to_llm` isn't false. Submission review
  (`lib/submissionReview.ts:274`) also checks only `available_to_llm`.
- **Text the server can read today:** Google-native files through Drive's
  text export (`exportGoogleDocText`), and stored .txt, .md and .docx
  (`lib/documentText.ts`, used for word counts). **There is no PDF text
  extraction**, so an uploaded or imported PDF never gets `parsed_data`, and
  the context layer reports it as `empty`. Submission review reads PDFs by
  attaching them to the model, which is not a text extraction.
- Document kinds: transcript, resume, essay, test-report, award-letter,
  financial, common-app, other, recommendation-letter, activity-list,
  iep-504, counselor-only. The AI reads transcript, resume, test-report
  and activity-list by default (`AI_DEFAULT_DOCUMENT_KINDS`); every other
  kind is out unless `ai_access = 'allowed'`.
- The tracker (`lib/liveDocuments.ts`, `POST /tasks/:id/tracker`) re-reads
  each linked file's edit time; a failed check becomes a caveat on the note
  (`liveProblems`), but a "no activity" verdict can still be saved while
  Google is unreachable.
- **Essays linked to a Google Doc by URL.** An essay's `external_url`, when
  it is a Google Doc, has its text and word count synced from the Doc
  (`routes/application.ts:919-923`) through `exportDocText`, which requires
  `drive.readonly` (`lib/supplementDocs.ts:24,170`). The app triggers it from
  `components/student/EssaysPanel.tsx:496-500`. Under `drive.file` a pasted
  Doc URL is unreadable unless the Doc was picked.
- **Caseload transfer (PR #54).** `20261023030002_caseload_transfer_functions.sql`
  clears `external_*` on moved documents (`:504-516`) and moves
  `supplement_docs.owner_id` to the receiving counselor (`:621-629`), while
  the Doc itself stays in the departing counselor's Drive.
- **Calendar invites (PR #54)** are `.ics` emails and are separate from the
  Google event: the Google event still has no attendees and
  `sendUpdates=none` (`lib/suiteApi.ts:393-410`). Nothing here conflicts.
- The app's Connections card says Google connects "Drive, Docs, Sheets and
  Slides, Gmail and Calendar" (`components/files/IntegrationsPanel.tsx:113-117`)
  and has no label for `drive.file` (`:71-84`). The Meet-link checkbox is
  offered whenever Google is connected (`MeetingModal.tsx:211`,
  `MeetingBooker.tsx:215`).
- `DELETE /integrations/google` already revokes the token at Google and
  deletes it from our database.
- `integrations.account_email` holds the connected account's email.
- **Production has no Google connections, no imported Drive files, no
  supplement Docs and no essays with a link** (re-checked 10/15). Nothing
  needs migrating.

## 3. Approaches considered

**A. `drive.file` + Google Picker, with a picker-only token in the browser
(chosen).** Google's own Picker shows the counselor's Drive in a Google
window. Each file they pick becomes reachable by our app, and only those.
The browser gets its own short-lived token with `drive.file` only, used for
the Picker and nothing else; the server keeps the long-lived grant and does
the import. No restricted scope, so no CASA. The browser token must be
requested with `include_granted_scopes: false` (§4.2): Google Identity
Services defaults it to true, which would fold `calendar.events` into the
picker token once Calendar is on, the exact thing C is rejected for.

**B. Keep `drive.readonly` and pay for CASA.** Rejected: Meridies would hold
read access to every family document in every counselor's Drive, and pay
for a security assessment every year.

**C. `drive.file` + Picker, with the server handing the browser a token.**
Rejected: the server's token can also carry `calendar.events`, so the
browser would hold a token that can change the counselor's calendar.

## 4. Design

### 4.1 Scopes, asked for in two steps

| Step | When | Scopes | Google's class |
|---|---|---|---|
| Connect | Counselor clicks Connect Google | `openid`, `email`, `drive.file` | non-sensitive |
| Calendar | Counselor turns on Google Calendar (§4.4) | adds `calendar.events` | sensitive: verification, no CASA |

- `drive.readonly` and `gmail.send` are removed.
- Google's `include_granted_scopes=true` (already sent on the server's
  consent) makes the Calendar consent add to the first grant rather than
  replace it; the grant row records the scopes Google actually returned, as
  today.
- **Only allowlisted scopes are kept.** The allowlist is `openid`, `email`
  (and Google's `userinfo.email` spelling of it), `drive.file` and
  `calendar.events`. If Google returns anything else, for example
  `drive.readonly` folded back in for an account that consented under the
  old code, the callback stores nothing, revokes the token at Google, and
  answers 409 `google_reconnect`: "Your Google connection had permissions
  Meridies no longer uses. Connect Google again." The next Connect starts
  from a clean grant.
- `GET /integrations/google/authorize` gains an optional `?add=calendar`.
  Without it the consent asks for the Connect scopes; with it, the Connect
  scopes plus `calendar.events`. The list of allowed add-ons is fixed in
  code; nothing from the client becomes a scope string.
- **The Calendar consent must be the same account.** `?add=calendar` sends
  `login_hint` with the stored `account_email`. On completion, if the id
  token's `sub` differs from the grant's `account_id`, the callback stores
  nothing and answers 409 `google_other_account`: "You signed in as
  {email}. Turn on Calendar with {connected email}, or disconnect Google
  and connect the other account." A plain Connect while a grant exists is
  held to the same rule; switching accounts means disconnecting first.
- **Granular consent.** Google lets a user untick a scope on the consent
  screen. The grant's stored scopes are the truth: `picker-config` answers
  409 `drive_not_granted` when they lack `drive.file` ("Meridies needs
  access to the files you pick. Connect Google again and leave Drive
  ticked."), and Calendar shows "On" only when they include
  `calendar.events`. A Calendar consent that comes back without it leaves
  Calendar off and says so.
- Creating or moving a Meet event without `calendar.events` answers
  409 with code `calendar_not_enabled` ("Turn on Google Calendar to add Meet
  links"), so the app can offer the switch instead of a generic
  "reconnect".
- There is no "turn off Calendar only": Google revokes a grant as a whole.
  Turning Calendar off means disconnecting Google (the app says so).

### 4.2 The picking flow

1. The counselor clicks **Google Drive** next to the drop zone in
   `StudentFiles` or `EssaysPanel`. If Google isn't connected, the existing
   Connect path runs first (server-side code + PKCE).
2. The app asks the API for the Picker settings
   (`GET /integrations/google/picker-config`, §4.3).
3. The app loads Google's scripts (`https://accounts.google.com/gsi/client`
   and `https://apis.google.com/js/api.js`) on that click, not on page
   load.
4. Google Identity Services asks for a token (`initTokenClient`) with scope
   `drive.file` only, **`include_granted_scopes: false`**, and `login_hint`
   set to the connected account's email. The counselor has already
   consented, so the popup usually closes by itself.
5. **Same account check.** The app calls Drive `about.get`
   (`fields=user(emailAddress)`) with the picker token and compares the
   address with `accountEmail`. If they differ, it stops before the Picker
   opens: "You're signed in to Google as {email}. Pick with {connected
   email}." (§7 smoke step 8 confirms `about.get` answers under
   `drive.file`; if it doesn't, this step is dropped and the server-side
   message below is the only check.)
6. The Picker opens with My Drive, Shared with me, Shared drives
   (`DocsView` with `setEnableDrives(true)`) and Recent. Multi-select is
   on, capped at `maxFiles` from the config (default 10); folders can be
   opened but not selected. **`setAppId(<Cloud project number>)` is set**:
   that is what makes Google grant the picked files to our OAuth client,
   so the server's token can open them. Without it the pick appears to
   work and every import then fails.
7. On **Select**, the app imports each file with
   `POST /integrations/google/files/import`, two at a time, showing each
   file's result. **From `StudentFiles` the request carries no `kind`**
   (no filename guess); only `EssaysPanel` sends `essay`.
8. After the imports, the app shows the type list with the server's
   guesses (§4.4); one **Looks right** confirms them. A pick from Essays
   skips this.
9. The browser token stays in memory, is never sent to our API, and is
   dropped when the Picker closes. It expires within an hour regardless.

**Server can't open a picked file.** Google answers 404 to our grant when
the file was picked with a different account, but also when it was trashed,
deleted or unshared since. The import answers 409 with code
`picked_file_unavailable`: "Meridies can't open that file. It may have been
picked with a different Google account, or it's no longer available. Pick
it again with {connected email}." Step 5 and `login_hint` make the
wrong-account case rare.

### 4.3 Backend changes (`meridies-backend`)

- **`lib/oauth.ts`:** the two scope steps, the scope allowlist, the
  same-account rule and the granular-consent handling in §4.1;
  `beginAuthorization` takes the fixed add-on and the `login_hint`; errors
  from a missing grant and a broken grant carry codes
  (`google_disconnected`, `google_reconnect`) on the existing
  `HttpError.code`.
- **`lib/suiteApi.ts`:** Google file calls check `drive.file`, not
  `drive.readonly`. `listRemoteFiles` for Google now returns only files the
  app can already reach (earlier picks and supplement Docs); the app shows
  it as "Recently added from Drive". The 409 for a missing
  `calendar.events` gets its code.
- **`lib/supplementDocs.ts`:** `exportDocText` checks `drive.file`. That
  covers supplement Docs (created by the app) and essay Docs the counselor
  picked (§4.4).
- **`routes/integrations.ts`:**
  - **New `GET /integrations/google/picker-config`** (approved counselor,
    rate-limited like the other reads): `{ clientId, apiKey, appId,
    accountEmail, maxFiles }`. 503 naming the missing setting when one is
    unset; 409 `google_disconnected` when there is no grant; 409
    `drive_not_granted` when the grant lacks `drive.file`.
  - **Import, for Google:** the checks in §2 stay as they are, and:
    - Treat the file id as untrusted all the way: shape-checked,
      path-encoded, opened only with the caller's own grant, and never used
      to build anything but a fixed `googleapis.com` URL (already true; the
      tests pin it).
    - **Unconfirmed on arrival, kept out of AI, with a guess.** When the
      request names no `kind`, the file is filed as `other` with
      **`kind_confirmed = false`, `available_to_llm = false`, no
      `parsed_data`, `parse_status` `pending`**, and the server's guess in
      `kind_guess` (§4.3.1). The response carries the guess. A request that
      names a kind is confirmed at once and keeps today's behaviour (the
      Essays panel sends `essay`).
    - The `picked_file_unavailable` 409 (§4.2).
  - Disconnect is unchanged: it already revokes at Google first.
- **Confirming types: `POST /files/documents/confirm-types`** (approved
  counselor, edit access to each document's student, rate-limited like the
  other writes). Body `{ items: [{ documentId, kind, keepOut }] }`, 1 to 50
  items, strict. One call confirms the whole list: for each item it sets
  `kind`, `kind_confirmed = true`, `available_to_llm = !keepOut`, and
  answers per item (`confirmed`, or `refused` with a reason). Items are
  independent: a refused one doesn't stop the others. `PATCH
  /files/documents/:id` with a `kind` also confirms (one file edited from
  its row).
- **Text for AI after confirming.** For each confirmed document with
  `available_to_llm` true, the server extracts its text after the response
  (like submission review) and writes `parsed_data` and `parse_status`
  (`parsed`, or `empty` when there is no text: a scan, an image). The
  extractor by type, all local, no AI:
  - Google Docs and Slides: Drive's text export (`exportGoogleDocText`);
    Google Sheets: Drive's CSV export (first sheet);
  - PDF (including Docs stored as PDF): **a new PDF text extractor**
    (`unpdf`, the serverless build of Mozilla's pdf.js, pure JavaScript),
    on the stored copy, capped at 25 MB, 50 pages, 200,000 characters and
    10 seconds; a failure leaves `parse_status` `failed` and AxIS reports
    the file as `empty`;
  - .docx, .txt, .md: `lib/documentText.ts` on the stored copy.
  A file kept out of AI gets no extraction. Whether a model may read the
  result is still `documentAiDecision`'s call: financial, IEP/504, award
  letters, recommendation letters and counselor-only stay out by kind.
  This also gives drag-and-drop PDFs text when their type is set, which
  they never had.
- **Every path that puts a document into a prompt applies
  `documentAiDecision`**, not `available_to_llm` alone. The decision gains
  one first rule: **`kind_confirmed = false` is `not-categorized`**, before
  keep-out, so an unconfirmed file is refused and reported for the right
  reason. The paths:
  - the tracker (`routes/tasks.ts:1032`): `readable` keeps only documents
    the decision allows, with the practice's document-reading setting;
  - submission review (`lib/submissionReview.ts:274`): refuses a document
    the decision refuses, with the decision's reason (an uncategorized file
    says "Choose a type for this file first");
  - `lib/liveDocuments.ts:68` keeps exporting text only when
    `available_to_llm` isn't false. Exporting isn't sending to a model; the
    readers above decide that.
  A shared helper (`documentReadable(doc, practiceReadsDocuments)`) keeps
  the three calls identical. AGENTS.md "Documents and AI context" says that
  any new reader must use it.
- **What AxIS leaves out.** The context layer reports unconfirmed files as
  one `omitted` entry, `{ reason: "not-categorized", count, message: "N
  files aren't categorized." }`, instead of one line per file, and
  `GET /students/:id/ai-context` shows it. The app links that line to the
  student's type list (§4.4). The tracker's note says the same when a
  task's attached files are unconfirmed.
- **Essays linked to a Google Doc (`routes/application.ts`).** The sync at
  `:919-923` is unchanged in shape and now works under `drive.file` for a
  Doc the counselor picked. A Doc URL that was not picked (pasted, or set
  by an AxIS op) can't be read: the sync reports it with the code
  `doc_not_picked` instead of a bare failure, so the app can offer "Pick
  this Doc to keep it in sync".
- **`lib/liveDocuments.ts` and the tracker (`routes/tasks.ts`):**
  - Each `LiveFileCheck` gains `errorCode` (`google_disconnected`,
    `google_reconnect`, `not_found`, `unavailable`, or null), taken from
    the `HttpError` code.
  - The tracker response carries `liveStatus`: `ok`, or
    `disconnected` / `reconnect` when any linked Google file failed for
    that reason, with the count of files affected.
  - **The rule:** if the verdict would be `no-activity` and any live check
    failed with `google_disconnected` or `google_reconnect`, the tracker
    saves nothing and answers 409 `google_disconnected`: "Google is
    disconnected, so Meridies can't see edits to {files}. Reconnect Google
    to check this task." Otherwise it saves the verdict as today and
    answers 200 with `liveStatus`. The reason: don't show the counselor a
    false "no activity" verdict.
- **Config:** `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`,
  `GOOGLE_PICKER_MAX_FILES` (default 10, allowed 1–50) in `env.ts` and
  `.env.example`.
- **Docs in the same PR:**
  - `AGENTS.md`: Connected apps says Google is picked files only and why,
    the two consent steps, the allowlist and same-account rules, and drops
    the `drive.readonly` tracker wording; "Documents and AI context" gains
    the reader rule above; the Environment table gains the three variables.
  - `LAUNCH_CHECKLIST.md:130-140`: Google connects files and Calendar (no
    Gmail), no restricted scope, no CASA.
  - `DATABASE_MIGRATION_INSTRUCTIONS.md:234`: the reconnect note matches
    the new scopes.
- **One migration** (`documents_kind_confirmation`), additive:
  - `documents.kind_confirmed boolean not null default true`: every
    existing document counts as confirmed, so nothing that works today
    changes; only a Google import with no kind writes false;
  - `documents.kind_guess jsonb null`: `{ kind, basis, matched }` (§4.3.1);
  - an index on `(student_id) where kind_confirmed = false`, for the list
    of a student's unconfirmed files;
  - both columns added to `ai-allowlist.ts` where the documents loader
    reads them, and `kind_confirmed` to `REQUIRED_SCHEMA`, because the
    context layer's documents loader selects it on every AxIS read.
  - Students can't write either column (the existing
    `documents_guard_student_restricted` trigger is extended), and the
    column grants follow the existing `documents` pattern.
  **Deploy order:** apply the migration on production before the backend PR
  merges (Railway deploys `main` on merge; `REQUIRED_SCHEMA` holds the
  previous build if it is missed). The previous code ignores the new
  columns, so applying first is safe.

#### 4.3.1 The type guess (`lib/documentGuess.ts`)

A pure function, `guessKind({ filename, mimeType, text })`, returning
`{ kind, basis, matched }` or `{ kind: null }` for unknown. **No model is
ever called**: the module imports nothing from `lib/anthropic.ts` or
`lib/axis/`, and a unit test fails if it does.

- **Text for the guess** comes from the same local extractors as above, run
  at import on the bytes being imported, limited to the first 3 pages or
  20,000 characters. It is used only inside `guessKind`, then dropped:
  never stored, never logged, never sent anywhere. `matched` holds the
  keyword from our list that matched ("Form 1040"), never document text.
- **Signals, strongest first:**
  1. Text patterns, whole words, ignoring case unless noted:
     - financial: "Form 1040", "W-2", "1099", "Student Aid Report",
       "FAFSA", "CSS Profile", "tax return";
     - iep-504: "Individualized Education Program", "504 Plan",
       "Section 504", "IEP" (capitals only);
     - transcript: "Official Transcript", "Unofficial Transcript",
       "Academic Transcript", "Cumulative GPA";
     - test-report: "Score Report", "College Board", "SAT" and "ACT"
       (capitals only, next to "score"), "AP Scores";
     - award-letter: "Financial Aid Award", "Award Letter", "Offer of
       Financial Aid";
     - recommendation-letter: "Letter of Recommendation", "Recommendation
       for";
     - resume: "Resume", "Curriculum Vitae";
     - activity-list: "Activities List", "Extracurricular Activities".
  2. Filename keywords (`transcript`, `1040`, `w2`, `fafsa`, `iep`, `504`,
     `score`, `sat`, `act`, `resume`, `cv`, `recommendation`, `rec letter`,
     `award`, `activities`), split on separators so "act" never matches
     "contract".
  3. The Google file type, weakest: a Google Sheet named like a list leans
     activity-list; nothing else is guessed from type alone.
- **Ties and conflicts:** a sensitive signal (financial, iep-504) anywhere
  wins over any other, so a transcript that mentions FAFSA is guessed
  financial and kept out; otherwise the strongest signal wins, and two
  different kinds at the same strength give unknown.
- **Pre-filled "kept out of AI":** a financial or iep-504 guess comes with
  `keepOut: true`, so confirming it leaves the file out even if the
  counselor later allows the kind. Unknown files are `other`, unconfirmed,
  and out. (Award letters, recommendation letters and counselor-only are
  already out by kind.)
- `basis` is `text`, `filename` or `type`, shown to the counselor as "from
  the file's text", "from the file name" or "from the file type".
- Unit-tested against a table of filenames and short texts, including the
  false friends ("Contract.pdf", "Pact essay", an essay that mentions its
  IEP).

Why the Picker settings come from the API rather than Vercel environment
variables: all Google settings live in one place (Railway), and the app
needs no new Vercel variables.

### 4.4 App changes (`meridies-app`)

- **New `components/files/GoogleDrivePicker.tsx`:** loads the two scripts,
  gets the picker-only token (`include_granted_scopes: false`), runs the
  same-account check, opens the Picker with `setAppId`, the shared-drives
  view and the cap, imports the picked files, reports each result
  (imported, too big, can't be imported, unavailable, failed). From
  `StudentFiles` it sends no `kind`.
- **The type list (one step for the whole pick):** after a pick, one list
  shows every imported file with its type pre-filled from the server's
  guess and where the guess came from ("from the file name"), a "Keep out
  of AI" checkbox (pre-ticked for financial and IEP/504 guesses), and
  unknown rows marked "Choose a type". One **Looks right** button sends
  `POST /files/documents/confirm-types` with every row that has a type;
  the counselor edits only wrong or unknown rows first. Unknown rows left
  as they are stay unconfirmed. **Not now** closes the list without
  confirming anything. Type menu: transcript, resume, essay, test report,
  activity list, Common App, award letter, financial, recommendation
  letter, IEP/504, counselor-only, other. The copy: "AxIS doesn't read
  these files until you confirm their types. Financial documents, IEP/504
  plans, award letters, recommendation letters and counselor-only files
  stay out of AxIS even then."
- **Later:** unconfirmed files carry a "Not categorized" tag on their row,
  and the student's Files view has one **Categorize N files** button that
  opens the same list for all of them. The AI context's "N files aren't
  categorized" line opens it too.
- **Essays skip it:** a pick from `EssaysPanel` is sent as `essay` and
  confirmed at import.
- **Essays (`EssaysPanel`):** linking an essay to a Google Doc is **Pick a
  Google Doc**, which opens the Picker for one Doc (Docs only) and saves
  its link as `external_url`. Picking grants the Doc to Meridies, so word
  counts and text keep syncing. The paste box stays for other links; given
  a Google Doc URL, or when the sync reports `doc_not_picked`, it shows
  "Pick this Doc to keep it in sync" with the button.
- **`RemoteFilePicker.tsx`:** the Google branch renders `GoogleDrivePicker`
  and the "Recently added from Drive" list; the Microsoft branch is
  unchanged.
- **Drag and drop from the computer is unchanged** and stays beside the
  Drive button wherever files come in. Both end the same way: a document
  in the student's folder.
- **Connections card (`IntegrationsPanel.tsx`):** Google's line becomes
  "Files you pick from Drive, and Calendar if you turn it on" (no Gmail); a
  `drive.file` label ("Drive: files you pick"); the connected email; and a
  **Google Calendar** row with **Turn on** (starts `authorize?add=calendar`)
  or "On", shown on only when the stored scopes include `calendar.events`.
  The `google_other_account` and `google_reconnect` messages show here.
- **Meet links (`MeetingModal.tsx`, `MeetingBooker.tsx`):** the Meet
  checkbox is offered as "Add a Meet link" only when Calendar is on; when
  it isn't, the row offers **Turn on Google Calendar**. A
  `calendar_not_enabled` 409 keeps everything the counselor typed in the
  form (the conference is created before the save, so the save fails as a
  whole).
- **Tracker:** when `liveStatus` is `disconnected` or `reconnect` (or the
  409 above), the task shows "Google disconnected: can't see edits to N
  files" with a **Reconnect** button, instead of an error line.
- **`lib/api.ts`:** `getGooglePickerConfig`; `startIntegrationConnect`
  takes the optional `add`.
- If the app later adds a Content-Security-Policy, it must allow
  `accounts.google.com`, `apis.google.com` and `docs.google.com` (frames).
  There is none today.
- The Picker works only on origins registered for the OAuth client and the
  API key (`app.meridiesai.com`, `localhost:3000`), so Vercel preview URLs
  show "Google Drive isn't available on preview builds" instead of the
  button.

### 4.5 What keeps working

- **Task tracker:** `drive.file` access to a picked file doesn't expire, so
  the tracker reads its edit time as before. A student's shared Doc is
  tracked once the counselor picks it from "Shared with me".
- **Supplement Docs:** created by the app, so reachable by the counselor
  who created them.
- **Essays linked to a Doc:** once the counselor picks the Doc.
- **Meet links:** once Calendar is turned on.
- **Drag and drop, and the import pipeline:** untouched (import step 2 in
  PR #54 doesn't touch the integrations import route).
- **After a caseload transfer** (PR #54), tracking stops for moved files
  (their `external_*` pointers are cleared) and supplement-Doc sync stops,
  because the receiving counselor's `drive.file` grant can't read a Doc
  another account's grant created. Both resume when the receiver picks the
  file or Doc again; the app's existing "pick" paths cover it.

### 4.6 Security notes

- Google enforces the limit: our tokens can't open an unpicked file, even
  if our code had a bug or a token leaked.
- The browser's token is `drive.file` only (`include_granted_scopes:
  false`), short-lived, kept in memory and never sent to us.
- The server keeps only allowlisted scopes and only the account that first
  connected (§4.1).
- The Picker API key is public by nature. It is restricted in Google Cloud
  to the **Google Picker API only** and to the HTTP referrer
  `https://app.meridiesai.com/*` (the dev key: `http://localhost:3000/*`).
- File ids from the browser are untrusted input (§4.3).
- New Drive files arrive unconfirmed and kept out of AI
  (`kind_confirmed = false`, `available_to_llm = false`, no stored text),
  and every reader applies `documentAiDecision`, so a picked tax form or
  IEP never reaches a model by default, by two independent checks. The
  text read for the type guess never leaves the guess function.
- PDFs are untrusted input to the new extractor: it runs with the size,
  page, character and time caps in §4.3, on the server's stored copy, and
  its output is treated like any document text (wrapped as untrusted data
  wherever it enters a prompt).
  Existing switches (keep out of AI, FERPA waiver) are unchanged.
- Disconnect revokes at Google, then deletes our copy of the token.
- This matches the public privacy policy, section 4 (meridiesai.com/privacy):
  picked files only, calendar events only when turned on, tokens encrypted,
  disconnect deletes tokens and revokes at Google, Google Limited Use.

## 5. Setup (Elvin, in Google Cloud and Railway)

**Done (10/15):** Google Cloud project 356256797701 with the Drive, Picker
and Calendar APIs; `meridiesai.com` verified; consent screen External and
**published**, scopes `openid`, `email`, `drive.file`, `calendar.events`,
only `meridiesai.com` as authorized domain (the Supabase callback domain
was removed and Supabase "Continue with Google" still works); OAuth clients
for production and development with the redirects and JavaScript origins
below; production and development Picker keys, referrer- and API-restricted;
the rotated production client secret verified with Google.

- Production client: origin `https://app.meridiesai.com`; redirect
  `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/google`.
- Development client: origin `http://localhost:3000`; redirect
  `http://localhost:3000/dashboard/counselor/data-hub/callback/google`.

**Left:**
1. Optional tidy-up: the production Picker key's `https://meridiesai.com/*`
   referrer can go, since the Picker runs only on `app.`. Leaving it is
   harmless (the key reaches only the Picker API, and the Picker shows
   nothing without the counselor's own sign-in).
2. **Railway variables, only after both PRs are live (§9):**
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INTEGRATION_TOKEN_KEY`
   (new, `openssl rand -base64 32`; never change it afterwards),
   `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`, and optionally
   `GOOGLE_PICKER_MAX_FILES`.
3. **Submit `calendar.events` for verification** after the code ships:
   Google wants a short video showing the consent screen and the scope in
   use (turning Calendar on, creating a Meet link). Until it is approved,
   counselors who turn Calendar on see Google's "unverified app" warning.
   If the review asks to verify the Supabase sign-in callback's domain, the
   fix is a Supabase custom domain (`auth.meridiesai.com`, a Pro add-on;
   DNS is at Porkbun).

## 6. Failure handling

| Situation | What the counselor sees |
|---|---|
| Google settings missing on Railway | "Google Drive isn't set up yet" (from the 503) |
| Not connected | The existing Connect prompt |
| Drive unticked at consent | "Meridies needs access to the files you pick. Connect Google again and leave Drive ticked." |
| Old permissions came back at consent | "Your Google connection had permissions Meridies no longer uses. Connect Google again." |
| Calendar consent with another account | The `google_other_account` message (§4.1) |
| Calendar unticked at consent | Calendar stays off, with "Calendar wasn't allowed" |
| Signed in to Google as someone else when picking | The same-account message (§4.2 step 5) |
| Popup blocked | "Allow pop-ups for Meridies to pick from Drive" |
| Counselor closes the Picker | Nothing happens |
| Server can't open a picked file | The `picked_file_unavailable` message (§4.2) |
| File over 25 MB, or a type that can't be exported | That file's message; the other files still import |
| Essay Doc not picked | "Pick this Doc to keep it in sync" |
| Type list closed with **Not now** | Nothing confirmed; the files show "Not categorized" and AxIS says "N files aren't categorized" |
| A confirmed file has no readable text (a scan) | AxIS lists it as empty; the file itself is fine |
| Calendar not turned on | "Turn on Google Calendar to add Meet links" with the switch; the meeting form keeps its contents |
| Google disconnected or grant broken | "Google disconnected" / "Reconnect Google", on the Connections card and on tracked tasks |
| Google rate-limits | The existing 429 message |
| Vercel preview build | "Google Drive isn't available on preview builds" |

## 7. Testing

- **Backend unit tests:**
  - the Connect scopes are exactly `openid`, `email`, `drive.file`, and
    `?add=calendar` adds exactly `calendar.events` (a test fails if
    `drive.readonly` or `gmail.send` comes back, or if a client string can
    become a scope);
  - a callback whose returned scopes include `drive.readonly` stores
    nothing, revokes, and answers `google_reconnect`;
  - a Calendar consent whose `sub` differs from `account_id` stores nothing
    and answers `google_other_account`; `login_hint` is sent;
  - Google file calls require `drive.file`; Meet calls without
    `calendar.events` give `calendar_not_enabled`;
  - `picker-config`: 503 per missing setting, 409 without a grant, 409
    `drive_not_granted` without `drive.file`, `maxFiles` from config and
    bounded;
  - import: a Google import with no kind is `other`, `kind_confirmed`
    false, `available_to_llm` false, no `parsed_data`, with a `kind_guess`;
    a named kind is confirmed and kept; the `picked_file_unavailable`
    mapping; an unsafe file id is refused before any request;
  - **the guesser never calls the AI:** `documentGuess.ts` imports nothing
    from the Anthropic or AxIS modules (a test walks its imports), and an
    import runs with the Anthropic client stubbed to throw;
  - the guess table: each kind from text, from filename and from type;
    sensitive wins a conflict; false friends stay unknown; the text used
    for the guess is not stored or logged;
  - **confirm-all applies every row:** `confirm-types` with ten items sets
    kind, `kind_confirmed` and `available_to_llm` on all ten; a refused
    item (no edit access) doesn't stop the rest; `keepOut` leaves a file
    out; over 50 items or an unknown kind is refused;
  - **a skipped file is still excluded:** an unconfirmed file is refused by
    the context layer, the tracker and submission review, and the context
    layer reports one "N files aren't categorized" entry;
  - **text after confirming:** confirming a PDF, a Google Doc, a Sheet and a
    .docx (not kept out) writes `parsed_data` for each; a scanned PDF ends
    `empty`; a kept-out file gets no extraction; the PDF extractor's caps
    hold on an oversized file;
  - **readers:** an uncategorized import attached to a task is not in the
    tracker's prompt; the same file categorized as a transcript is;
    categorized as financial it is not; submission review refuses an
    uncategorized file with "Choose a type for this file first";
  - essay sync: an unpicked Doc URL reports `doc_not_picked`;
  - tracker: a disconnected grant with a would-be `no-activity` verdict
    saves nothing and answers 409; with any other verdict it saves and
    answers 200 with `liveStatus: "disconnected"`.
- **Integration (persona suite):** `picker-config` refuses a student and an
  unapproved counselor; import refuses a student the counselor can't edit.
- **App:** typecheck, build, lint; the type step sends no kind from
  `StudentFiles`; the Meet checkbox follows the stored scopes.
- **End-to-end check, by hand on localhost with a test user** (Google's
  popups can't run in CI), written up as `scripts/smoke/google-picker.md`
  with a small script for the server-side half:
  1. Connect Google (Connect scopes only). Confirm the consent screen lists
     no Calendar and no Gmail.
  2. Pick 4 files in the browser: one from My Drive, one from "Shared with
     me", one from a shared drive, one Google Doc. Also pick a Drive
     shortcut and record what happens.
  3. **Confirm the server can open each picked file**
     (`scripts/smoke/google-picker.ts <documentId>`: reads the file's
     metadata with the stored grant). Then confirm it gets 404 on a file
     id that was never picked. This proves `setAppId` is right.
  4. Each file arrives unconfirmed with a guess; the list shows the
     guesses; correct one row, leave one unknown, press **Looks right**.
     Check `GET /students/:id/ai-context` shows the confirmed files that
     the AI may read, with text, and "1 file isn't categorized"; check the
     tracker's prompt for a task with all four attached holds only those.
  5. The tracker shows the Doc's edit time after the student edits it.
  6. Create and read back a supplement Doc. Link an essay with **Pick a
     Google Doc** and see its word count sync.
  7. Turn on Calendar; create a Meet link. Call Google's tokeninfo on the
     picker token afterwards: its scope must be exactly `drive.file`.
  8. Sign the browser in to a second Google account and pick: the
     same-account message (and record whether `about.get` answers under
     `drive.file`). Turn on Calendar as the second account: the
     `google_other_account` message.
  9. Disconnect Google: the token is revoked at Google (the API's
     `revokedAtProvider: true`), and the tracked task shows "Google
     disconnected" rather than a verdict. Reconnect and record whether the
     earlier picks are reachable again.

## 8. Not in this design

- **Microsoft / OneDrive.** Waiting on the permission test of
  `Files.ReadWrite.Selected` (preview) with the OneDrive picker; otherwise
  `Files.Read` with the picker.
- **Folder sync and onboarding sync.** `drive.file` doesn't give access
  to the files inside a picked folder. Bringing a counselor's existing
  records in is the import pipeline's job; Drive can become one of its
  sources later by picking files.
- **Reading Gmail or Outlook.** Restricted scopes; would need CASA.
- **RAG / vector search.**

## 9. Delivery

0. **Migration on production first** (`documents_kind_confirmation`, §4.3):
   dry-run on the local stack, apply to production one file per
   transaction, verify, and only then merge the backend PR.
1. **Backend PR:** the migration file, scopes in two steps with the
   allowlist and same-account rules, `picker-config`, the Calendar code,
   the `drive.file` read scope, import changes (unconfirmed, kept out, the
   guess, unavailable file), `documentGuess.ts`, `confirm-types`, text
   extraction after confirming with the PDF extractor, the "not
   categorized" omitted entry, the shared reader rule (tracker, submission
   review),
   essay `doc_not_picked`, tracker `errorCode` / `liveStatus` and the
   no-verdict rule, env, AGENTS.md, LAUNCH_CHECKLIST.md and
   DATABASE_MIGRATION_INSTRUCTIONS.md, tests. Ships first (cross-repo
   rule). Safe to merge while Railway has no `GOOGLE_*` variables: every
   Google route answers 503 as today.
2. **App PR:** `GoogleDrivePicker`, the type list with **Looks right** and
   **Categorize N files**, Pick a Google Doc in `EssaysPanel`, the `RemoteFilePicker` change, the
   Connections card (copy, labels, Calendar switch), Meet gating in
   `MeetingModal` and `MeetingBooker`, the tracker's disconnected state,
   `lib/api.ts`.
3. **Follow-up backend PR:** drop Microsoft's unused `Mail.Send` from
   `MICROSOFT_SCOPES` (one line plus its test; Microsoft connections made
   before it keep the permission until they reconnect).
4. **Then the Railway variables (§5), only once both PRs are live**: set
   before the app PR deploys, counselors could connect through the old
   Connections card, which still offers Gmail and a whole-Drive list. Then
   the end-to-end check (§7) on production with a test account, then
   submit Calendar for verification.

## 10. Decisions (Elvin)

10/14:
1. Drop `gmail.send`: yes; drop Microsoft's `Mail.Send` in a follow-up.
2. Files only in v1; folders browsable, not pickable.
3. 10 files per pick, as `GOOGLE_PICKER_MAX_FILES`.

10/15 (review round):
4. Uncategorized imports are kept out of AI by both layers: imported with
   `available_to_llm = false` and no text until a type is chosen, and every
   reader applies `documentAiDecision`.
5. Essays link to a Google Doc by picking it; a pasted Doc URL asks to be
   picked to keep syncing.
6. Every other finding of the review round applied as written above.
7. The type step is a server-side guess (no AI) confirmed in one batch;
   Essays skip it; it can be skipped; sensitive guesses pre-fill as kept
   out; text for AI is extracted once a type is confirmed (§4.3, §4.3.1).
   **Open:** OK to add `unpdf` as the PDF text extractor (needed for both
   the text guess and AxIS reading confirmed PDFs)?
