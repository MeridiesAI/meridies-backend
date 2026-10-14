# Google connector: picked files only — design

Status: draft for review (2026-10-14). Microsoft/OneDrive is a separate
design, after a permission test (see §9).

## 1. Goal

A counselor connects Google once and brings in the files they choose, and
only those, from Drive into a student's folder. Meridies never holds a key
to the rest of their Drive.

**What Elvin asked for (10/14):**
- Google first; Microsoft later.
- No broad Drive access: a counselor's Drive holds families' tax returns,
  FAFSA paperwork and IEPs that Meridies has no reason to read.
- A file picker: the counselor chooses the files.

**What this design assumes (correct me):**
- The connector must work for real counselors at launch, so it has to pass
  Google's app verification. Until it does, Google allows 100 test users,
  and their sign-ins expire every 7 days.
- Picking files one at a time (or several at once) is enough for v1. Syncing
  whole folders, or a counselor's whole Drive, is not in v1 (§8).
- Meet links on Calendar events stay as they are.

**Success:**
1. Google asks for no restricted scope, so verification needs no paid
   security assessment (CASA).
2. A counselor can pick one or more Drive files, including files shared
   with them, and file them to a student.
3. Meridies cannot list or open any Drive file the counselor didn't pick or
   the app didn't create, enforced by Google, not just by our code.
4. The task tracker keeps working for picked files, and supplement Docs keep
   working.

## 2. What exists today (read 10/14)

- `src/lib/oauth.ts` asks Google for `openid`, `email`,
  **`drive.readonly`**, `drive.file`, **`gmail.send`**, `calendar.events`.
- `drive.readonly` (read every file) is a **restricted** scope: it needs
  verification plus a yearly third-party security assessment.
- **`gmail.send` is requested but nothing uses it.** No code calls the Gmail
  API (email goes through Resend). The same is true of Microsoft's
  `Mail.Send`.
- `GET /integrations/:provider/files` lists or searches the whole Drive;
  the app's `RemoteFilePicker` shows that list (used in `StudentFiles` and
  `EssaysPanel`).
- `POST /integrations/:provider/files/import` copies one file into the
  student's folder and keeps a pointer (`documents.external_*`).
- The tracker (`lib/liveDocuments.ts`) and the Application page re-read
  that pointer later (edit time, Google Doc text).
- Supplement Docs (`lib/supplementDocs.ts`) are created under `drive.file`
  but read back under `drive.readonly`.
- The connected account's email is stored (`integrations.account_email`).
- **Production has no Google connections, no imported Drive files and no
  supplement Docs** (checked 10/14), because the Google OAuth client was
  never set up. Nothing needs migrating.

## 3. Approaches considered

**A. `drive.file` + Google Picker, with a picker-only token in the browser
(recommended).** Google's own Picker shows the counselor's Drive in a Google
window. Each file they pick becomes reachable by our app, and only those.
The browser gets its own short-lived token with `drive.file` only, used for
the Picker and nothing else; the server keeps the long-lived grant and does
the import. No restricted scope, so no CASA. The cost: the Picker's
look is Google's, not ours, and folders can't be synced (§8).

**B. Keep `drive.readonly` and pay for CASA.** The current in-app list
keeps working, but Meridies holds read access to every family document in
every counselor's Drive, and pays for a security assessment every year
(usually several hundred to a few thousand dollars) plus weeks of
verification. It is the opposite of what Elvin asked for.

**C. `drive.file` + Picker, with the server handing the browser a token.**
Simpler to wire, but the token the server holds also carries
`calendar.events`, so the browser would hold a token that can change the
counselor's calendar. Rejected.

## 4. Design

### 4.1 Scopes

Google asks for exactly: `openid`, `email`, `drive.file`,
`calendar.events`.

- `drive.readonly` is removed (the reason for this work).
- `gmail.send` is removed: it is unused, and every scope we ask for is one
  more thing Google reviews and one more thing a counselor is asked to
  trust. (It is a sensitive scope, not restricted, so it can come back
  later without CASA if a feature needs it.)
- `calendar.events` is a sensitive scope: it needs verification (Google
  says up to about 10 days) but no security assessment. `drive.file` is
  listed by Google as the recommended narrow scope; confirm on the consent
  screen that Google marks it non-sensitive.

### 4.2 The picking flow

1. The counselor clicks **Google Drive** in `StudentFiles` or
   `EssaysPanel`. If Google isn't connected, the existing "Connect" path
   runs first (unchanged: server-side code + PKCE).
2. The app asks the API for the Picker settings
   (`GET /integrations/google/picker-config`, §4.3).
3. The app loads Google's scripts (`https://accounts.google.com/gsi/client`
   and `https://apis.google.com/js/api.js`) on that click, not on page
   load.
4. Google Identity Services asks for a token with scope `drive.file` only,
   with `login_hint` set to the connected account's email. Google shows a
   short popup; the counselor has already consented, so it usually closes
   by itself.
5. The Picker opens with three views: My Drive, Shared with me, and
   Recent. Multi-select is on; folders can be browsed but not selected.
   `setAppId(project number)` is set, which is what tells Google to give
   our app access to the picked files.
6. On **Select**, the app gets the file ids and imports each one with the
   existing `POST /integrations/google/files/import` (one call per file,
   at most 10 per pick, run 2 at a time), showing progress per file.
7. The browser token stays in memory, is never sent to our API, and is
   dropped when the Picker closes. It expires within an hour regardless.

**Wrong account.** If the counselor picks while signed in to a different
Google account than the one connected, the server can't open the file
(Google returns 404 to our grant). The import then answers: "That file was
picked with a different Google account. Pick it again with
{connected email}." `login_hint` makes this rare.

### 4.3 Backend changes (`meridies-backend`)

- `lib/oauth.ts`: the scope list in §4.1.
- `lib/suiteApi.ts`: Google calls check `drive.file`, not
  `drive.readonly`. `listRemoteFiles` for Google keeps working but now
  returns only files the app can already reach (earlier picks and
  supplement Docs). The app uses it as "Recently added from Drive", not as
  a Drive browser.
- `lib/supplementDocs.ts`: `exportDocText` checks `drive.file` (the Doc was
  created by the app, so it is reachable).
- `routes/integrations.ts`:
  - **New `GET /integrations/google/picker-config`** (counselor, signed in,
    rate-limited like the other reads): returns `{ clientId, apiKey, appId,
    accountEmail }`; 503 naming the missing setting when any is unset; 409
    "Connect Google first" when there is no grant.
  - The import answers the wrong-account message above on a provider 404,
    for Google only.
- A grant that lacks `drive.file` already gets the existing
  "reconnect" message from `requireScope`.
- `env.ts` / `.env.example`: `GOOGLE_PICKER_API_KEY`,
  `GOOGLE_PROJECT_NUMBER` (both optional; the Picker route says which is
  missing).
- `AGENTS.md`: the Connected apps section says Google is picked-files only
  and why, and the Environment table gains the two variables.
- No migration.

Why the Picker settings come from the API rather than Vercel environment
variables: all Google settings then live in one place (Railway), and the
app needs no new Vercel variables.

### 4.4 App changes (`meridies-app`)

- New `components/files/GoogleDrivePicker.tsx`: loads the two scripts,
  gets the picker-only token, opens the Picker, imports the picked files,
  reports per-file results (imported, too big, wrong account, failed).
- `RemoteFilePicker.tsx`: the Google branch renders `GoogleDrivePicker`
  plus the "Recently added from Drive" list; the Microsoft branch is
  unchanged.
- `lib/api.ts`: `getGooglePickerConfig`.
- If the app later adds a Content-Security-Policy, it must allow
  `accounts.google.com`, `apis.google.com` and `docs.google.com` (frames).
  There is none today.

### 4.5 What keeps working

- **Task tracker:** `drive.file` access to a picked file does not expire,
  so the tracker reads its edit time as before. A student's shared Doc is
  tracked once the counselor picks it from "Shared with me".
- **Supplement Docs:** created by the app, so always reachable.
- **Meet links:** unchanged (`calendar.events`).

### 4.6 Security notes

- Google enforces the limit: our tokens cannot open an unpicked file, even
  if our code had a bug or a token leaked.
- The API key is public by nature; it is restricted in Google Cloud to the
  Picker API and to referrers `https://app.meridiesai.com/*` (plus
  localhost on the dev key).
- File ids from the browser are already validated (`assertFileId`) and
  opened only with the counselor's own grant.
- The data-handling switches on documents (AI access, FERPA waiver) are
  unchanged; a picked tax form is still a document the counselor chose to
  file, and the counselor can keep it out of AI as today.

## 5. Setup (Elvin, in Google Cloud and Railway)

One Google Cloud project for production; a second OAuth client in it for
local development.

1. **Create the project** ("Meridies") and note its **project number**.
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
   - Add test users (up to 100) until verified.
5. **OAuth client (Web application), production:**
   - Authorized JavaScript origin: `https://app.meridiesai.com`
     (needed by the Picker's token popup).
   - Authorized redirect URI:
     `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/google`.
6. **OAuth client, development:** origin `http://localhost:3000`, redirect
   `http://localhost:3000/dashboard/counselor/data-hub/callback/google`.
7. **API key:** restrict to the Google Picker API; HTTP referrers
   `https://app.meridiesai.com/*`. (A second key for localhost.)
8. **Railway variables:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `INTEGRATION_TOKEN_KEY` (`openssl rand -base64 32`; never change it
   afterwards), `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`.
9. **Submit for verification** after the code ships: Google wants a short
   video showing the consent screen and each scope in use (picking a file,
   creating a Meet link), and the privacy policy must say what Drive and
   Calendar data is used for.

Steps 1–8 can start now; nothing in them depends on the code.

## 6. Failure handling

| Situation | What the counselor sees |
|---|---|
| Google settings missing on Railway | "Google Drive isn't set up yet" (from the 503) |
| Not connected | The existing Connect prompt |
| Popup blocked | "Allow pop-ups for Meridies to pick from Drive" |
| Counselor closes the Picker | Nothing happens |
| Picked with another account | The wrong-account message (§4.2) |
| File over 25 MB | The existing size message, per file; the other files still import |
| Grant revoked at Google | The existing "reconnect" message |
| Google rate-limits | The existing 429 message |

## 7. Testing

- **Backend unit tests:** the Google scope list holds exactly the four
  scopes (a test fails if `drive.readonly` or `gmail.send` comes back);
  Google file calls require `drive.file`; `picker-config` answers 503 per
  missing setting and 409 without a grant; the wrong-account mapping.
- **Integration (persona suite):** `picker-config` refuses a student and an
  unapproved counselor.
- **App:** typecheck, build, lint.
- **By hand, on localhost with a test user** (Google's popups can't run in
  CI): connect; pick 3 files including one from "Shared with me" and one
  Google Doc; all import; the tracker shows the Doc's edit time; a
  supplement Doc creates and reads back; pick with a second Google account
  and see the wrong-account message; confirm with a script that the
  server's token gets 404 on a file that was never picked.

## 8. Not in this design

- **Microsoft / OneDrive.** Waiting on the permission test of
  `Files.ReadWrite.Selected` (preview) with the OneDrive picker; otherwise
  `Files.Read` with the picker. Its unused `Mail.Send` should go then too.
- **Folder sync and onboarding sync.** `drive.file` does not give access
  to the files inside a picked folder. Bringing a counselor's existing
  records in is the import pipeline's job (step 2); Drive can become one
  of its sources later by picking files.
- **Reading Gmail or Outlook.** Restricted scopes; would need CASA.
- **RAG / vector search.**

## 9. Delivery

1. **Backend PR:** scopes, `picker-config`, supplement read scope, the
   wrong-account message, env and AGENTS.md, tests. Ships first
   (cross-repo rule).
2. **App PR:** `GoogleDrivePicker`, the `RemoteFilePicker` change,
   `lib/api.ts`.
3. **Setup (§5)** in parallel; then the manual test; then submit for
   verification.

## 10. Open questions for Elvin

1. Drop `gmail.send` now? Nothing uses it; sending from the counselor's
   own Gmail would be a new feature with its own design.
2. Files only in v1 (no folders)?
3. Is 10 files per pick a sensible cap?
