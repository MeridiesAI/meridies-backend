# OneDrive picker (Microsoft connector PR B) — design

Status: reviewed once (2026-11-01), ready to build · branch `feat/onedrive-picker`

## 1. Goal

Counselors pick files from their own OneDrive with Microsoft's own file picker, and Meridies asks Microsoft for the narrowest access that works. Today the app shows its own OneDrive list and search, fed by the backend with `Files.Read.All` (every file the counselor can see, including other people's shared files). That scope is why Microsoft is off in production. After this change, Microsoft can be turned on in prod.

## 2. Decided (not reopened here)

- **Scope `Files.Read`** (Elvin, 10/25). It reads the counselor's own OneDrive only. `Files.ReadWrite.Selected` was ruled out: it is work/school only and not meant for picker apps. The review confirmed one more reason this choice is right: Microsoft's default consent policy for work tenants (since August 2025) stops staff consenting to `Files.Read.All` themselves, but not to `Files.Read`.
- **Shared files and SharePoint are not importable.** A counselor who wants a file someone shared with them saves a copy to their own OneDrive first, then picks the copy.
- Personal and work/school accounts are both supported (`MICROSOFT_TENANT=common`).
- Calendar stays as it is: `Calendars.ReadWrite`, asked only when the counselor turns Calendar on.

## 3. How it works

```
Counselor clicks "Pick from OneDrive"
  app opens an empty popup at once (still inside the click, so the browser allows it)
  app → GET /integrations/microsoft/picker-session
        backend: account type, OneDrive address, a short-lived picker token, max files
  app loads Microsoft's picker into the popup, token in a POST form field (never the URL)
  counselor picks files → picker returns { id, driveId } per file
  app → POST /integrations/microsoft/files/import   (backend downloads with its own stored Files.Read grant)
```

**Who gets the picker's token: the backend issues it.** Microsoft's picker accepts only OneDrive/SharePoint tokens, not the Graph token the backend uses for imports. The backend already holds the counselor's refresh token (a long-lived key Microsoft issues at Connect), and Microsoft lets that key be exchanged for a token for another Microsoft service the counselor has agreed to. So `picker-session` asks Microsoft for a OneDrive token and hands it to the counselor's browser:
- **Personal accounts:** authority `consumers`, scope `OneDrive.ReadOnly` (Microsoft's documented picker setup; a Microsoft Q&A thread confirms a backend-issued token works this way).
- **Work accounts:** authority `<tenantId>`, scope `<OneDrive address>/.default`.

Why this is safe enough:
- The token only works against OneDrive/SharePoint. It can't read mail or calendars or call Graph.
- It reaches exactly what the backend's own `Files.Read` grant reaches, no more.
- It lasts about an hour, is never stored or logged, and the response is `Cache-Control: no-store`.

The exchange uses the refresh token, and Microsoft replaces the refresh token every time it is used. So it must go through the same per-grant lock and compare-and-swap save as every other refresh in `accessTokenFor()`, or a picker open racing an import would spend a dead key. The picker token is not saved over the stored Graph access token.

**Runner-up: the browser signs in itself with MSAL** (Microsoft's browser sign-in library). It lost on three problems this app would hit:
- It adds a second Microsoft sign-in popup, which browsers block when it isn't opened directly from a click.
- The app sends `X-Frame-Options: DENY` on every page, which breaks MSAL's silent sign-in.
- The app's middleware redirects pages, which can swallow the sign-in response MSAL is waiting for.

It needs a dedicated blank redirect page and a new library to work. It stays the fallback if the work-account exchange in §8 fails.

The Google picker gets its token in the browser because there the browser's token (`drive.file`) is narrower than anything the server could hand over. Here the two would be equally wide, so that reason doesn't carry over.

## 4. Backend changes (`meridies-backend`)

1. **Scope.** `MICROSOFT_SCOPE.files` becomes `Files.Read` in `src/lib/oauth.ts`; rewrite the comment above it. `MS_FILES_SCOPE` and `hasScope` (exact match, so `Files.Read.All` doesn't count as `Files.Read`) follow automatically. The dev Entra app is new, so no grant holds the old scope.
2. **`GET /integrations/microsoft/picker-session`** (counselor only, 20 a minute, `no-store`). The backend reads `GET /me/drive` with the stored grant, then exchanges the refresh token (§3). It returns:
   - `accountType`: `personal` or `work`, from the drive's `driveType`
   - `baseUrl`: `https://onedrive.live.com/picker` for personal accounts; for work accounts, the origin of the drive's `webUrl`, accepted only when it matches `https://<name>-my.sharepoint.com`. Anything else (government clouds, an odd host) answers 409 `onedrive_unsupported`, so the token is never sent to an unexpected host.
   - `token`, `expiresAt`, `maxFiles` (`MICROSOFT_PICKER_MAX_FILES`)

   Errors: `picker_not_configured` (503), `microsoft_disconnected` / `microsoft_reconnect` (409), `files_not_granted` (409) when the grant lacks `Files.Read`, `picker_consent_needed` (409) when Microsoft refuses the exchange for lack of consent (see §8).
3. **Import: own drive only, by path.** `POST /integrations/microsoft/files/import` keeps its body. For Microsoft it reads the item at `/me/drive/items/{fileId}` and ignores the client's `driveId`, rather than comparing drive ids (personal-account drive ids aren't always written the same way). A 403 or 404 there answers 422 `shared_not_supported`: "This file is shared with you, so Meridies can't open it. Save a copy to your OneDrive, then pick the copy." The stored `external_drive_id` is the counselor's own drive id from that read.
4. **Remove the OneDrive list and search.** Drop the Microsoft half of `GET /:provider/files` (it answers 410 `use_picker`) and `graphSearchUrl`. *Build-time correction:* Google still uses the route for its "Recently added from Drive" list, so it stays for Google (`listGoogleFiles`).
5. **Live tracker.** No code change. With `Files.Read` it checks only files in the counselor's own OneDrive. That still covers the useful case: the counselor owns the essay file and shares it with the student, so the student's edits show on the counselor's file. A student-owned file can't be imported, so it can't be tracked either.
6. **Docs.** Update the "Connected apps" section of `AGENTS.md` (it still says `Files.Read.All` and "PR B") and the Microsoft lines of `LAUNCH_CHECKLIST.md`.

## 5. App changes (`meridies-app`)

1. **`lib/oneDrivePicker.ts`.** No new library.
   - In the click handler, before any `await`, open the popup: `window.open("", "Picker", "width=1080,height=680")`. If it comes back null, show "Allow pop-ups for Meridies, then try again."
   - Fetch `picker-session`, then write a POST form into the popup that targets `{baseUrl}/_layouts/15/FilePicker.aspx?…` for work accounts or `https://onedrive.live.com/picker?…` for personal ones. The token goes in a hidden `access_token` field, never in the URL.
   - Picker options: `sdk: "8.0"`, `entry: { oneDrive: {} }`, `authentication: {}`, files only, multiple selection capped at `maxFiles`, `messaging.origin` set to the app's own origin, and a fresh random channel id per open. Hide the "Shared" view if the v8 options allow it, so counselors aren't offered files that will be refused. Check the v8 options reference during the build.
   - Messaging:
     - Accept the `initialize` message only when `event.source` is the popup this click opened, `event.origin` is the session's `pickerOrigin` (`https://onedrive.live.com`, or the validated `-my.sharepoint.com` origin), and the channel id matches; then use the message port it hands over. (Elvin, 11/1.)
     - Acknowledge every command. On `authenticate`, reply with the session token while it has more than 5 minutes left, otherwise fetch a new session. On `pick`, check each item has string `id` and `parentReference.driveId`, drop duplicates, cap at `maxFiles`, then import. On `close`, close the popup. Answer any other command with an error.
   - When the popup closes, or the component unmounts, remove the listener and close the port. Watch for the counselor closing the popup by hand.
   - Keep the token in memory only. Never log it or file names.
2. **`components/files/OneDrivePicker.tsx`.** Mirrors `GoogleDrivePicker.tsx`: same student and folder target, the same "readable by the assistant" switch, the same per-file results and `ImportFailure` handling. Add copy for `shared_not_supported`, `onedrive_unsupported` and a blocked popup.
3. **`RemoteFilePicker.tsx` / `lib/api.ts`.** The Microsoft branch renders `OneDrivePicker`. Remove the list, the search box and `listRemoteFiles`. Add `getMicrosoftPickerSession`.
4. **Security headers.** No change. The app's `frame-ancestors 'none'` and `X-Frame-Options: DENY` only stop others framing Meridies, and the popup is a separate window. The app sets no `Cross-Origin-Opener-Policy` (checked 11/1); `same-origin` there would cut the popup off, so a test fails if any page gets a COOP other than none or `same-origin-allow-popups` (Elvin, 11/1).
5. **Connect errors.** On the Microsoft callback page, a `consent_required` or admin-approval answer from Microsoft gets a clear message: "Your school or company needs to approve Meridies. Ask your IT admin, or connect a personal Microsoft account." This matters most for Calendar (§8).
6. **Wording.** Follow Microsoft's branding guidance: "OneDrive (personal)" and "OneDrive for work or school".

## 6. Testing

- **Backend unit tests:**
  - `picker-session` for personal and work accounts; not configured; disconnected; missing `Files.Read`; a `webUrl` that isn't `-my.sharepoint.com` refused; `no-store` set
  - the token never appears in a log line
  - a `picker-session` running at the same moment as an import refresh saves the rotated refresh token once and both succeed
  - the import ignores a foreign `driveId` and maps 403/404 to `shared_not_supported`
  - the Connect scope list is exactly `openid email offline_access User.Read Files.Read`, plus `Calendars.ReadWrite` with Calendar
- **App tests:** pure tests that `window.open` runs before any `await` in the click handler, and for the message handler (wrong source window, wrong origin, wrong channel, unknown command, an expired token refreshed, a pick turned into import calls); a header test that no page sets a popup-severing COOP. Add a mocked e2e like `e2e/auth/google-drive.spec.ts`.
- **Manual, local, first thing in the build (½ hour):** with a personal Microsoft account, connect, open `picker-session` and confirm Microsoft issues the OneDrive token. Then run end to end: pick 2 files, both land in the student folder, and a shared-with-me file gives the "save a copy" message.
- **Manual, work account:** the same, once a test account exists (§8). The token exchange is tested first; if Microsoft refuses it, add SharePoint `MyFiles.Read` in the build rather than shipping the consent-needed path untested (Elvin, 11/1).

## 7. Production steps (Elvin, after merge; not part of the build)

These will be written click by click at hand-over time. In short:
1. **Use a work account for the production app.** Microsoft can't verify the publisher of an app registered by a personal Microsoft account, and `team@meridiesai.com` was signed up as one.
   - In the Entra admin center, add `meridiesai.com` as a custom domain. This means adding a TXT record at the domain registrar.
   - Create a work user such as `admin@meridiesai.com`, with the Application Administrator role and multifactor sign-in.
   - Sign in as that user to do the rest.
2. **Register the production app**, named **Meridies** (counselors see this name on Microsoft's consent screen).
   - Publisher domain: `meridiesai.com`.
   - The same six permissions as the dev app.
   - Web redirect: `https://app.meridiesai.com/dashboard/counselor/data-hub/callback/microsoft`. No single-page application entry is needed.
3. **Railway:** set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT=common`. Nothing changes on Vercel.
4. **Publisher verification:** enroll in the free Microsoft AI Cloud Partner Program with the company's details, then link the Partner ID to the app.
5. **Privacy policy:** name Microsoft OneDrive and Outlook Calendar where Google Drive is named.

The dev app's single-page application entry (`http://localhost:3000`) is no longer used. It's harmless, so leave it or delete it.

## 8. Risks

- **Work-account token exchange (medium).** Microsoft's permission table says Graph `Files.Read` is enough for the picker, but its sample also adds the SharePoint permission `MyFiles.Read`. If the exchange for `<OneDrive address>/.default` comes back "consent required", `picker-session` answers `picker_consent_needed`. The fix: add SharePoint `MyFiles.Read` (also own files only) to both apps, plus one extra consent step the first time a counselor opens the picker. If that still fails, switch to the MSAL runner-up (§3). Personal accounts don't depend on this.
- **No work/school test account yet.** OneDrive for work needs a Microsoft 365 licence. Cheapest path: one Microsoft 365 Business Basic seat in the Meridies directory (about $6–7 a month, cancel after testing). Without it, work accounts ship untested and stay labelled beta.
- **Work tenants may still block consent.**
  - Many schools and companies turn off staff consent completely, so an IT admin must approve Meridies whatever it asks for. The callback message (§5.5) tells the counselor this.
  - Microsoft's default policy blocks staff consent to `Calendars.ReadWrite` (since November 2025), so turning on Calendar (Teams links) will often need IT approval at work. Personal accounts are unaffected.
  - Tenants with risk-based step-up consent block unverified multi-tenant apps, which is why §7.4 matters. It can take days; start it early.
- **Popup blockers.** Covered by opening the popup inside the click and showing a message when it is blocked.

## 9. Not in scope

- SharePoint sites, Teams files, "Shared with me" imports
- Uploading or writing to OneDrive
- Any change to Google or to Calendar scopes

## 10. Effort

About 2 days: backend ½–1 day, app 1 day, testing and fixes ½ day. Backend PR lands first, then the app PR (bcha merges the app).

## Sources (checked 2026-11-01)

- OneDrive File Picker v8 (setup, consumer scopes, SharePoint-token note, messaging): https://learn.microsoft.com/en-us/onedrive/developer/controls/file-pickers/
- Backend-issued picker token for personal accounts (authority `consumers` + OneDrive scope): https://learn.microsoft.com/en-us/answers/questions/5529850/onedrive-picker-v8-0-shows-grapherror-unauthentica
- Microsoft-managed default consent policy, blocked permissions by date: https://blog.topedia.com/posts/microsoft-managed-default-app-consent-policy-will-block-8-additional-permissions
- Publisher verification requirements (work account, custom domain, Partner ID): https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
- MSAL redirect-page and framing pitfalls (runner-up): https://learn.microsoft.com/en-us/entra/msal/javascript/browser/errors
