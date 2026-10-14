# Google connector: picked files only — design

Status: draft for review (2026-10-14, revision 2: Elvin's answers and
additions applied). Microsoft/OneDrive is a separate design, after a
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

**What this design assumes (correct me):**
- The connector must work for real counselors at launch, so it has to pass
  Google's app verification.
- Meet links on Calendar events keep working once Calendar is turned on.

**Success:**
1. Google asks for no restricted scope, so verification needs no paid
   security assessment (CASA).
2. A counselor can pick one or more Drive files, including files shared
   with them, and file them to a student.
3. Meridies cannot list or open any Drive file the counselor didn't pick or
   the app didn't create, enforced by Google, not just by our code.
4. The task tracker keeps working for picked files, and says plainly when
   Google is disconnected.
5. Supplement Docs and Meet links keep working.

## 2. What exists today (read 10/14)

- `src/lib/oauth.ts` asks Google for `openid`, `email`,
  **`drive.readonly`**, `drive.file`, **`gmail.send`**, `calendar.events`,
  all at once, on connect.
- `drive.readonly` (read every file) is a **restricted** scope: it needs
  verification plus a yearly third-party security assessment.
- **`gmail.send` is requested but nothing uses it.** No code calls the Gmail
  API (email goes through Resend). The same is true of Microsoft's
  `Mail.Send`.
- `GET /integrations/:provider/files` lists or searches the whole Drive;
  the app's `RemoteFilePicker` shows that list (used in `StudentFiles` and
  `EssaysPanel`).
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
    `available_to_llm` to true.**
- The tracker (`lib/liveDocuments.ts`, `POST /tasks/:id/tracker`) re-reads
  each linked file's edit time; a failed check becomes a caveat on the note
  (`liveProblems`), but a "no activity" verdict can still be saved while
  Google is unreachable.
- `DELETE /integrations/google` already revokes the token at Google and
  deletes it from our database.
- `integrations.account_email` holds the connected account's email.
- **Production has no Google connections, no imported Drive files and no
  supplement Docs** (checked 10/14). Nothing needs migrating.

## 3. Approaches considered

**A. `drive.file` + Google Picker, with a picker-only token in the browser
(chosen).** Google's own Picker shows the counselor's Drive in a Google
window. Each file they pick becomes reachable by our app, and only those.
The browser gets its own short-lived token with `drive.file` only, used for
the Picker and nothing else; the server keeps the long-lived grant and does
the import. No restricted scope, so no CASA.

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
| Connect | Counselor clicks Connect Google | `openid`, `email`, `drive.file` | non-sensitive (confirm on the consent screen) |
| Calendar | Counselor turns on Google Calendar (§4.4) | adds `calendar.events` | sensitive: verification, no CASA |

- `drive.readonly` and `gmail.send` are removed.
- Google's `include_granted_scopes=true` (already sent) makes the second
  consent add to the first grant rather than replace it; the grant row
  records the scopes Google actually returned, as today.
- `GET /integrations/google/authorize` gains an optional `?add=calendar`.
  Without it the consent asks for the Connect scopes; with it, the Connect
  scopes plus `calendar.events`. The list of allowed add-ons is fixed in
  code; nothing from the client becomes a scope string.
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
4. Google Identity Services asks for a token with scope `drive.file` only,
   with `login_hint` set to the connected account's email. The counselor
   has already consented, so the popup usually closes by itself.
5. The Picker opens with My Drive, Shared with me and Recent. Multi-select
   is on, capped at `maxFiles` from the config (default 10); folders can be
   opened but not selected. **`setAppId(<Cloud project number>)` is set**:
   that is what makes Google grant the picked files to our OAuth client,
   so the server's token can open them. Without it the pick appears to
   work and every import then fails.
6. On **Select**, the app imports each file with
   `POST /integrations/google/files/import`, two at a time, showing each
   file's result.
7. After the imports, the app asks the counselor what each file is (§4.4).
8. The browser token stays in memory, is never sent to our API, and is
   dropped when the Picker closes. It expires within an hour regardless.

**Wrong account.** If the counselor picks while signed in to a different
Google account than the one connected, the server can't open the file
(Google answers 404 to our grant). The import then answers 409 with code
`picked_with_other_account`: "That file was picked with a different Google
account. Pick it again with {connected email}." `login_hint` makes this
rare.

### 4.3 Backend changes (`meridies-backend`)

- **`lib/oauth.ts`:** the two scope steps in §4.1; `beginAuthorization`
  takes the fixed add-on; errors from a missing grant and a broken grant
  carry codes (`google_disconnected`, `google_reconnect`) on the existing
  `HttpError.code`.
- **`lib/suiteApi.ts`:** Google file calls check `drive.file`, not
  `drive.readonly`. `listRemoteFiles` for Google now returns only files the
  app can already reach (earlier picks and supplement Docs); the app shows
  it as "Recently added from Drive". The 409 for a missing
  `calendar.events` gets its code.
- **`lib/supplementDocs.ts`:** `exportDocText` checks `drive.file` (the Doc
  was created by the app, so it is reachable).
- **`routes/integrations.ts`:**
  - **New `GET /integrations/google/picker-config`** (approved counselor,
    rate-limited like the other reads): `{ clientId, apiKey, appId,
    accountEmail, maxFiles }`. 503 naming the missing setting when one is
    unset; 409 `google_disconnected` when there is no grant.
  - **Import, for Google:** the checks in §2 stay as they are. Two
    changes:
    - Treat the file id as untrusted all the way: shape-checked, path-encoded,
      opened only with the caller's own grant, and never used to build
      anything but a fixed `googleapis.com` URL (already true; the tests
      pin it).
    - **Uncategorized on arrival:** when the request names no `kind`, a
      Google import is filed as `other`, never guessed as `essay`.
      `documentAiDecision` already treats an `other` file as
      `not-categorized`, so it stays out of AI until the counselor picks a
      type. A request that names a kind keeps it (the Essays panel sends
      `essay`).
    - The wrong-account 409 (§4.2).
  - Disconnect is unchanged: it already revokes at Google first.
- **`lib/liveDocuments.ts` and the tracker (`routes/tasks.ts`):**
  - Each `LiveFileCheck` gains `errorCode` (`google_disconnected`,
    `google_reconnect`, `not_found`, `unavailable`, or null), taken from
    the `HttpError` code.
  - The tracker response carries `liveStatus`: `ok`, or
    `disconnected` / `reconnect` when any linked Google file failed for
    that reason, with the count of files affected.
  - **A disconnected or broken grant never produces a "no activity"
    verdict on its own.** When a task's only activity signal is linked
    files that can't be checked because Google is disconnected, the
    tracker saves nothing and answers 409 `google_disconnected`: "Google
    is disconnected, so Meridies can't see edits to {files}. Reconnect
    Google to check this task." Otherwise a stale verdict could reach a
    family through the escalation sweep.
- **Config:** `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`,
  `GOOGLE_PICKER_MAX_FILES` (default 10, allowed 1–50) in `env.ts` and
  `.env.example`.
- **`AGENTS.md`:** the Connected apps section says Google is picked files
  only and why, describes the two consent steps, and the Environment table
  gains the three variables.
- No migration.

Why the Picker settings come from the API rather than Vercel environment
variables: all Google settings live in one place (Railway), and the app
needs no new Vercel variables.

### 4.4 App changes (`meridies-app`)

- **New `components/files/GoogleDrivePicker.tsx`:** loads the two scripts,
  gets the picker-only token, opens the Picker with `setAppId` and the cap,
  imports the picked files, reports each result (imported, too big, can't
  be imported, wrong account, failed).
- **"What is this file?" step:** after a pick, each imported file is listed
  with a type menu (transcript, resume, test report, activity list, award
  letter, financial, recommendation letter, IEP/504, counselor-only, other)
  and a "Skip" that leaves it uncategorized. Choosing a type saves it with
  the existing document update route (`PATCH /files/documents/:id`). The
  copy says why: "Uncategorized files stay out of AxIS until you choose a
  type." Skipped files show the same prompt on the file's row later.
- **`RemoteFilePicker.tsx`:** the Google branch renders `GoogleDrivePicker`
  and the "Recently added from Drive" list; the Microsoft branch is
  unchanged.
- **Drag and drop from the computer is unchanged** and stays beside the
  Drive button wherever files come in. Both end the same way: a document
  in the student's folder.
- **Connections card (Google):** shows the connected email, "Drive: picked
  files only", and a **Google Calendar** row with **Turn on** (starts
  `authorize?add=calendar`) or "On". The Meet-link checkbox on a meeting
  offers the same Turn on when the API answers `calendar_not_enabled`.
- **Tracker:** when `liveStatus` is `disconnected` or `reconnect` (or the
  409 above), the task shows "Google disconnected: can't see edits to N
  files" with a **Reconnect** button, instead of an error line.
- **`lib/api.ts`:** `getGooglePickerConfig`; `startIntegrationConnect`
  takes the optional `add`.
- If the app later adds a Content-Security-Policy, it must allow
  `accounts.google.com`, `apis.google.com` and `docs.google.com` (frames).
  There is none today.

### 4.5 What keeps working

- **Task tracker:** `drive.file` access to a picked file doesn't expire, so
  the tracker reads its edit time as before. A student's shared Doc is
  tracked once the counselor picks it from "Shared with me".
- **Supplement Docs:** created by the app, so always reachable.
- **Meet links:** once Calendar is turned on.
- **Drag and drop, and the import pipeline:** untouched.

### 4.6 Security notes

- Google enforces the limit: our tokens can't open an unpicked file, even
  if our code had a bug or a token leaked.
- The browser's token is `drive.file` only, short-lived, kept in memory and
  never sent to us.
- The Picker API key is public by nature. It is restricted in Google Cloud
  to the **Google Picker API only** and to HTTP referrers
  `https://app.meridiesai.com/*` and `https://meridiesai.com/*` (the dev key:
  `http://localhost:3000/*`).
- File ids from the browser are untrusted input (§4.3).
- New Drive files are uncategorized, so a picked tax form or IEP never
  reaches AI by default. Existing switches (keep out of AI, FERPA waiver)
  are unchanged.
- Disconnect revokes at Google, then deletes our copy of the token.

## 5. Setup (Elvin, in Google Cloud and Railway)

One Google Cloud project for production; a second OAuth client and API key
in it for local development.

1. **Create the project** ("Meridies") and note its **project number** (the
   Picker's `appId`).
2. **Enable APIs:** Google Drive API, Google Picker API, Google Calendar
   API.
3. **Verify the domain** `meridiesai.com` in Google Search Console (DNS
   record), with the same Google account that owns the project.
4. **OAuth consent screen** (Google Auth Platform → Branding / Audience /
   Data access):
   - External; app name "Meridies"; support email; logo; homepage
     `https://meridiesai.com`; privacy policy and terms URLs; authorized
     domain `meridiesai.com`.
   - Scopes: `openid`, `email`, `.../auth/drive.file`,
     `.../auth/calendar.events`. Check that none shows as restricted.
   - **Testing vs. In production.** While the app's status is Testing, only
     listed test users (up to 100) can connect, and **Google expires their
     refresh tokens after 7 days**, so every pilot counselor would have to
     reconnect weekly. Plan: publish to "In production" as early as
     possible. The Connect step asks only for non-sensitive scopes, so it
     shouldn't need review; `calendar.events` does, and until Google
     approves it, counselors who turn Calendar on see Google's "unverified
     app" warning. Confirm both in the console when publishing. If we
     can't publish before pilots start, tell pilot counselors to expect a
     weekly reconnect (the app's "reconnect" state covers it).
5. **OAuth client (Web application), production:**
   - Authorized JavaScript origin: `https://app.meridiesai.com`
     (the Picker's token popup needs it).
   - Authorized redirect URI:
     `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/google`.
6. **OAuth client, development:** origin `http://localhost:3000`, redirect
   `http://localhost:3000/dashboard/counselor/data-hub/callback/google`.
7. **API keys:** production key restricted to the Google Picker API and
   referrers `https://app.meridiesai.com/*`, `https://meridiesai.com/*`;
   development key restricted to the Picker API and
   `http://localhost:3000/*`.
8. **Railway variables:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `INTEGRATION_TOKEN_KEY` (`openssl rand -base64 32`; never change it
   afterwards), `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`, and
   optionally `GOOGLE_PICKER_MAX_FILES`.
9. **Submit `calendar.events` for verification** after the code ships:
   Google wants a short video showing the consent screen and the scope in
   use (turning Calendar on, creating a Meet link), and the privacy policy
   must say what Drive and Calendar data is used for.

Steps 1–8 can start now; nothing in them depends on the code.

## 6. Failure handling

| Situation | What the counselor sees |
|---|---|
| Google settings missing on Railway | "Google Drive isn't set up yet" (from the 503) |
| Not connected | The existing Connect prompt |
| Popup blocked | "Allow pop-ups for Meridies to pick from Drive" |
| Counselor closes the Picker | Nothing happens |
| Picked with another account | The wrong-account message (§4.2) |
| File over 25 MB, or a type that can't be exported | That file's message; the other files still import |
| Calendar not turned on | "Turn on Google Calendar to add Meet links" with the switch |
| Google disconnected or grant broken | "Google disconnected" / "Reconnect Google", on the Connections card and on tracked tasks |
| Testing-mode token expired (7 days) | The same "Reconnect Google" state |
| Google rate-limits | The existing 429 message |

## 7. Testing

- **Backend unit tests:**
  - the Connect scopes are exactly `openid`, `email`, `drive.file`, and
    `?add=calendar` adds exactly `calendar.events` (a test fails if
    `drive.readonly` or `gmail.send` comes back, or if a client string can
    become a scope);
  - Google file calls require `drive.file`; Meet calls without
    `calendar.events` give `calendar_not_enabled`;
  - `picker-config`: 503 per missing setting, 409 without a grant,
    `maxFiles` from config and bounded;
  - import: a Google import with no kind is `other`; a named kind is kept;
    the wrong-account mapping; an unsafe file id is refused before any
    request;
  - tracker: a disconnected grant gives `liveStatus: "disconnected"` and
    never a saved "no activity" verdict.
- **Integration (persona suite):** `picker-config` refuses a student and an
  unapproved counselor; import refuses a student the counselor can't edit.
- **App:** typecheck, build, lint.
- **End-to-end check, by hand on localhost with a test user** (Google's
  popups can't run in CI), written up as `scripts/smoke/google-picker.md`
  with a small script for the server-side half:
  1. Connect Google (Connect scopes only). Confirm the consent screen lists
     no Calendar and no Gmail.
  2. Pick 3 files in the browser: one from My Drive, one from "Shared with
     me", one Google Doc.
  3. **Confirm the server can open each picked file**
     (`scripts/smoke/google-picker.ts <documentId>`: reads the file's
     metadata with the stored grant). Then confirm it gets 404 on a file
     id that was never picked. This proves `setAppId` is right.
  4. Each file arrives uncategorized; choose a type for one; check
     `GET /students/:id/ai-context` shows only that one.
  5. The tracker shows the Doc's edit time after the student edits it.
  6. Create and read back a supplement Doc.
  7. Turn on Calendar; create a Meet link.
  8. Pick with a second Google account: the wrong-account message.
  9. Disconnect Google: the token is revoked at Google (the API's
     `revokedAtProvider: true`), and the tracked task shows "Google
     disconnected" rather than a verdict.

## 8. Not in this design

- **Microsoft / OneDrive.** Waiting on the permission test of
  `Files.ReadWrite.Selected` (preview) with the OneDrive picker; otherwise
  `Files.Read` with the picker.
- **Folder sync and onboarding sync.** `drive.file` doesn't give access
  to the files inside a picked folder. Bringing a counselor's existing
  records in is the import pipeline's job (step 2); Drive can become one
  of its sources later by picking files.
- **Reading Gmail or Outlook.** Restricted scopes; would need CASA.
- **RAG / vector search.**

## 9. Delivery

1. **Backend PR:** scopes in two steps, `picker-config`, the Calendar
   code, the supplement read scope, import changes (uncategorized, wrong
   account), tracker `errorCode` / `liveStatus` and the no-verdict rule,
   env and AGENTS.md, tests. Ships first (cross-repo rule).
2. **App PR:** `GoogleDrivePicker`, the "What is this file?" step, the
   `RemoteFilePicker` change, the Connections card's Calendar switch, the
   tracker's disconnected state, `lib/api.ts`.
3. **Follow-up backend PR:** drop Microsoft's unused `Mail.Send` from
   `MICROSOFT_SCOPES` (one line plus its test; Microsoft connections made
   before it keep the permission until they reconnect).
4. **Setup (§5)** in parallel; then the end-to-end check (§7); then
   publish and submit Calendar for verification.

## 10. Decisions (Elvin, 10/14)

1. Drop `gmail.send`: yes; drop Microsoft's `Mail.Send` in a follow-up.
2. Files only in v1; folders browsable, not pickable.
3. 10 files per pick, as `GOOGLE_PICKER_MAX_FILES`.
