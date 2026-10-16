# Google Picker: by-hand end-to-end check

Google's popups can't run in CI, so this is done by hand on localhost with a test user (spec
`docs/superpowers/specs/2026-10-14-google-connector-design.md` §7, "End-to-end check"). Needs the local stack and API
running with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INTEGRATION_TOKEN_KEY`, `GOOGLE_PICKER_API_KEY` and
`GOOGLE_PROJECT_NUMBER` set, and the app pointed at it. The server-side half of step 3 is
`scripts/smoke/google-picker.ts`.

Record what you saw next to each step; anything that differs from "Expect" is a finding.

1. **Connect Google (Connect scopes only).** Confirm the consent screen lists no Calendar and no Gmail.
   Expect: the consent screen asks for sign-in, email and "see, edit, create and delete only the specific Google Drive
   files you use with this app". Nothing about Calendar or Gmail. `GET /integrations/providers` then reads
   `driveGranted: true`, `calendarEnabled: false`, `pickerReady: true`.
2. **Pick 4 files in the browser:** one from My Drive, one from "Shared with me", one from a shared drive, one Google
   Doc. Also pick a Drive shortcut and record what happens.
   Expect: four imports succeed. The shortcut: record whether it imports, is refused, or answers
   `picked_file_unavailable`.
3. **Confirm the server can open each picked file** (`npx tsx --env-file=.env scripts/smoke/google-picker.ts <documentId>`:
   reads the file's metadata with the stored grant). Then confirm it gets 404 on a file id that was never picked
   (`... <documentId> <unpickedFileId>`).
   Expect: `picked file readable: <name> <mimeType>` for each of the four, and `unpicked file refused as expected`
   for the never-picked id. This proves `setAppId` is right. `UNEXPECTED: an unpicked file was readable` means
   `setAppId` or the scope is wrong.
4. **Each file arrives unconfirmed with a guess;** the list shows the guesses; correct one row, leave one unknown,
   press **Looks right**. Check `GET /students/:id/ai-context` shows the confirmed files that the AI may read, with
   text, and "1 file isn't categorized"; check the tracker's prompt for a task with all four attached holds only those.
   Expect: `kind_confirmed = false` and `available_to_llm = false` before the press; after it, extraction reaches
   `ready` (or `empty` for a scan) in `GET /files/documents/extraction-status`; the unknown file stays out.
5. **The tracker shows the Doc's edit time** after the student edits it.
   Expect: `POST /tasks/:id/tracker` reports the new edit time and `liveStatus: "live"`.
6. **Create and read back a supplement Doc.** Link an essay with **Pick a Google Doc** and see its word count sync.
   Expect: the supplement Doc opens in the counselor's Drive; the picked essay Doc's word count matches Google's.
7. **Turn on Calendar; create a Meet link.** Call Google's tokeninfo on the picker token afterwards: its scope must be
   exactly `drive.file`.
   In the browser console after a pick, with `token` the picker's access token:
   `fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + token).then(r => r.json())`
   Expect: `scope` is exactly `https://www.googleapis.com/auth/drive.file`. The meeting has a real Meet link, and
   `calendarEnabled` is now `true`.
8. **Sign the browser in to a second Google account and pick:** the same-account message (and record whether
   `about.get` answers under `drive.file`). Turn on Calendar as the second account: the `google_other_account`
   message.
   Record whether `about.get` answered 200 under `drive.file`; if not, file it against the app's same-account step.
   Expect: the pick is refused with the same-account message; the Calendar consent as the second account answers
   409 `google_other_account`.
9. **Disconnect Google:** the token is revoked at Google (the API's `revokedAtProvider: true`), and the tracked task
   shows "Google disconnected" rather than a verdict. Reconnect and record whether the earlier picks are reachable
   again.
   Expect: `revokedAtProvider: true`; the tracker answers `liveStatus: "disconnected"` with no "no activity" verdict.
   After reconnecting, run `scripts/smoke/google-picker.ts` on an earlier document and record whether it reads.
