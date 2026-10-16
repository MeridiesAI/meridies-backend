# Google Connector (app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Counselors pick files from Google Drive with Google's own Picker (only those files become reachable), confirm every picked file's type in one batch list, watch text extraction progress ("Reading 3 of 10…"), link essays by picking their Doc, and turn Calendar on separately. Connections, meetings and tasks say plainly what Google can and can't do.

**Architecture:** `lib/googlePicker.ts` wraps Google's scripts: it loads them on click, gets a browser token with `drive.file` only (`include_granted_scopes: false`), checks the browser is signed in to the connected account, and opens the Picker with `setAppId`. `lib/googleDrive.ts` holds the pure rules: type-list rows and payload, progress text, Meet gating, the "Google disconnected" count, preview hosts and Doc URLs. These are unit-tested in `e2e/pure.spec.ts`. Two new components, `GoogleDrivePicker` and `TypeList`, call the API from the browser through `lib/api.ts`, never through Server Actions, so Playwright can stub every call. They are mounted where Drive files really come in: the Files page (`FolderBrowser`, student folders) and the Essays panel (through `RemoteFilePicker`).

**Tech Stack:** Next.js 15 (App Router, client components), React 19, TypeScript strict, Tailwind v4, lucide-react, Playwright 1.56 (`public` project for pure checks, `signed-in` project for stubbed UI flows).

**Spec:** `meridies-backend` `docs/superpowers/specs/2026-10-14-google-connector-design.md`, revision 5 (backend PR #55), §4.2, §4.4, §6, §7. Addition from Elvin (10/15): the server queues extractions beyond 2 at once, and the UI shows progress ("Reading 3 of 10…") by polling, never by timing out. The backend plan is `docs/superpowers/plans/2026-10-15-google-connector-backend.md`. **If this plan and the spec disagree, the spec wins; stop and ask.**

## Global Constraints

- Repo `meridies-app`. Worktree `/Users/elvinojuan/Meridies AI/meridies-app-gpicker` from `origin/main`, branch `feat/google-drive-picker`. **Open the PR only. Never merge**: Elvin wants PRs, not merges by Claude. **This PR ships after the backend PR is live** (cross-repo rule: backend routes first).
- New Google code calls the API from the browser with the session token (`apiFetch` functions in `lib/api.ts`), never through a Server Action, so `page.route` can stub it. Existing Server Actions elsewhere stay as they are.
- Google script URLs, exactly: `https://accounts.google.com/gsi/client` and `https://apis.google.com/js/api.js`. They load on the click, never on page load.
- The picker token request is exactly `{ client_id, scope: "https://www.googleapis.com/auth/drive.file", include_granted_scopes: false, login_hint: accountEmail }`. The token stays in memory, is never sent to our API, and is dropped when the Picker closes.
- The Picker always sets `setAppId(appId)`, `setOAuthToken`, `setDeveloperKey(apiKey)`. File mode: multiselect with `setMaxItems(maxFiles)`; views for My Drive, Shared with me, Shared drives (`setEnableDrives(true)`) and Recent; folders browsable, not selectable. Doc mode (essays): Google Docs only, one file.
- The Picker only runs on `app.meridiesai.com` and `localhost`. Any other host shows "Google Drive isn't available on preview builds".
- Two imports at a time. A failed file never stops the others.
- Type-list rules (spec §4.4, 10/15 conditions):
  - Every row starts from the server's guess.
  - "Please check" shows when `basis !== "text"` or `textFound === false`.
  - "Keep out of AI" is pre-ticked when the guess has `keepOut` or the kind is `financial` / `iep-504`.
  - Unknown rows ("Choose a type") are left out of the **Looks right** payload.
  - **Not now** confirms nothing.
- Progress text, exactly: `Reading ${k} of ${n}…`, where k = finished + 1, capped at n. When everything is finished: `Text ready for ${x} files` (or `1 file`), plus ` · ${y} had no readable text` when y > 0, plus ` · ${z} couldn't be read` when z > 0. Poll every 2 s while the list is open. No client timeout. Closing the list stops polling; the server keeps going.
- Copy, exactly:
  - Connections: Google description "Files you pick from Drive, and Calendar if you turn it on"; `drive.file` label "Drive: files you pick".
  - Type list: "AxIS doesn't read these files until you confirm their types. Financial documents, IEP/504 plans, award letters, recommendation letters and counselor-only files stay out of AxIS even then."
  - Same account: "You're signed in to Google as {email}. Pick with {connected email}."
  - Popup blocked: "Allow pop-ups for Meridies to pick from Drive".
  - Essay sync: "Pick this Doc to keep it in sync".
  - Tasks: "Google disconnected: can't see edits to {N} files".
  - Meetings: "Turn on Google Calendar to add Meet links".
- TypeScript strict, no `any`. Match the surrounding component style (DashboardUI `Button`, `Modal`, `Badge`; lucide icons; Tailwind tokens, no raw hex outside existing tint maps).
- Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### Running things (every task)

```bash
cd "/Users/elvinojuan/Meridies AI/meridies-app-gpicker"
npm run typecheck && npm run lint
npx playwright test e2e/pure.spec.ts --project=public          # pure rules, no backend
# Signed-in specs need the E2E accounts in .env.local (see AGENTS.md "E2E"); each spec skips itself otherwise.
npx playwright test e2e/auth/google-drive.spec.ts --project=signed-in
npm run build                                                   # before the last commit of a task
```

## Review Focus

1. **The counselor closes the type list while extraction is still running, or it runs a long time** (10 large PDFs queued 2 at a time). Polling must keep going without an error or timeout while the list is open. Closing the list must stop polling, and nothing may claim failure. Task 3 test: "status stays reading for many polls without an error, and closing stops the requests".
2. **The token popup is blocked or closed.** Show the pop-up message, import nothing, and leave no spinner behind. Task 2 test: "a blocked popup says so and imports nothing".
3. **One of several picked files fails** (`409 picked_file_unavailable`, `400` too big). The others still import, each failure shows its own message, and the type list holds only the successes. Task 2 test: "one unavailable file doesn't stop the rest".
4. **`confirm-types` refuses some rows.** Refused rows stay in the list with the server's reason, confirmed rows leave, and a double click on **Looks right** sends one request. Task 3 test: "a refused row stays with its reason; one request per click".
5. **The browser is signed in to a different Google account than the connected one.** Stop before the Picker opens, with the same-account message, and import nothing. Task 2 test: "another signed-in account stops before the Picker".

---

### Task 1: API contract and pure rules

**Files:**
- Modify: `lib/api.ts` (types near `DocumentKind` ~1449, `StoredDocument` ~1488, `TaskDocument` ~1149, integrations ~3030–3120, `syncEssayDocs` ~4912)
- Modify: `app/actions.ts:129-138` (`startIntegrationConnectAction` takes `add`), `app/actions.ts:615-624` (`syncEssayDocsAction` type)
- Create: `lib/googleDrive.ts`
- Test: `e2e/pure.spec.ts` (append)

**Interfaces:**
- Produces, in `lib/api.ts`:
  - `DocumentKind` gains `"recommendation-letter" | "activity-list" | "iep-504" | "counselor-only"`.
  - `KindGuess`.
  - `StoredDocument.kindConfirmed: boolean`, `StoredDocument.kindGuess: KindGuess | null`, `StoredDocument.aiAccess`, `StoredDocument.ferpaWaived`.
  - `TaskDocument.externalProvider`.
  - `IntegrationProviderInfo.calendarEnabled: boolean`, `IntegrationProviderInfo.driveGranted: boolean`.
  - `GooglePickerConfig`, `getGooglePickerConfig(token)`.
  - `ConfirmTypeItem`, `ConfirmTypeResult`, `confirmDocumentTypes(token, items)`.
  - `ExtractionState`, `getExtractionStatus(token, ids)`.
  - `getIntegrationAuthorizeUrl(token, provider, add?)`.
  - `syncEssayDocs(...)` returns `notPicked: string[]`.
- Produces, in `lib/googleDrive.ts`:
  - `KIND_LABELS`, `TypeRow`, `typeRows(docs)`, `confirmPayload(rows)`.
  - `progressText(states)`, `isTerminal(state)`.
  - `canAddMeet(provider, info)`, `driveLinkedCount(task)`, `googleNeedsReconnect(info, grantStatus)`.
  - `isPickerHost(hostname)`, `isGoogleDocUrl(url)`.

- [ ] **Step 1: Write the failing pure tests** (append to `e2e/pure.spec.ts`)

```ts
import {
  confirmPayload,
  driveLinkedCount,
  googleNeedsReconnect,
  isGoogleDocUrl,
  isPickerHost,
  progressText,
  typeRows,
  canAddMeet,
  KIND_LABELS,
} from "../lib/googleDrive";
import type { StoredDocument, Task, IntegrationProviderInfo } from "../lib/api";

function doc(over: Partial<StoredDocument>): StoredDocument {
  return {
    id: "d1", studentId: "s1", folderId: "f1", filename: "file.pdf", title: null, description: null,
    bucket: "student-documents", storagePath: "s1/file.pdf", mimeType: "application/pdf", sizeBytes: 10,
    kind: "other", source: "integration", parseStatus: "pending", availableToLlm: false,
    aiAccess: "default", ferpaWaived: false, kindConfirmed: false, kindGuess: null,
    externalProvider: "google", externalWebUrl: null, externalModifiedAt: null, createdAt: null, updatedAt: null,
    ...over,
  };
}

test.describe("Google Drive type list", () => {
  test("rows start from the guess; non-text guesses say Please check; sensitive guesses are kept out", () => {
    const rows = typeRows([
      doc({ id: "a", kindGuess: { kind: "transcript", basis: "text", matched: "Official Transcript", textFound: true, keepOut: false } }),
      doc({ id: "b", kindGuess: { kind: "resume", basis: "filename", matched: "resume", textFound: false, keepOut: false } }),
      doc({ id: "c", kindGuess: { kind: "financial", basis: "text", matched: "Form 1040", textFound: true, keepOut: true } }),
      doc({ id: "d", kindGuess: { kind: "iep-504", basis: "filename", matched: "iep", textFound: true, keepOut: false } }),
      doc({ id: "e", kindGuess: { kind: null, basis: null, matched: null, textFound: false, keepOut: false } }),
      doc({ id: "f", kindGuess: { kind: "transcript", basis: "text", matched: "x", textFound: false, keepOut: false } }),
    ]);
    expect(rows.map((r) => [r.documentId, r.kind, r.pleaseCheck, r.keepOut])).toEqual([
      ["a", "transcript", false, false],
      ["b", "resume", true, false],
      ["c", "financial", false, true],
      ["d", "iep-504", true, true],
      ["e", null, true, false],
      ["f", "transcript", true, false],
    ]);
  });

  test("Looks right sends every row with a type and leaves unknown rows out", () => {
    const rows = typeRows([
      doc({ id: "a", kindGuess: { kind: "transcript", basis: "text", matched: "x", textFound: true, keepOut: false } }),
      doc({ id: "e", kindGuess: null }),
    ]);
    expect(confirmPayload(rows)).toEqual([{ documentId: "a", kind: "transcript", keepOut: false }]);
    expect(confirmPayload([{ ...rows[1], kind: "resume" }])).toEqual([{ documentId: "e", kind: "resume", keepOut: false }]);
  });

  test("every document kind has a label", () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([
      "activity-list", "award-letter", "common-app", "counselor-only", "essay", "financial",
      "iep-504", "other", "recommendation-letter", "resume", "test-report", "transcript",
    ]);
  });
});

test.describe("extraction progress", () => {
  test("reads k of n while anything is queued or reading", () => {
    expect(progressText(["done", "done", "reading", "queued", "queued", "queued", "queued", "queued", "queued", "queued"]))
      .toBe("Reading 3 of 10…");
    expect(progressText(["queued"])).toBe("Reading 1 of 1…");
  });
  test("summarises when everything finished", () => {
    expect(progressText(["done", "done", "empty", "failed"])).toBe("Text ready for 2 files · 1 had no readable text · 1 couldn't be read");
    expect(progressText(["done"])).toBe("Text ready for 1 file");
    expect(progressText([])).toBe("");
  });
});

test.describe("Google rules", () => {
  const info = (over: Partial<IntegrationProviderInfo>): IntegrationProviderInfo => ({
    provider: "google", available: true, unavailableReason: null, tokensHeld: true, accountEmail: "c@example.com",
    connectedAt: null, calendarEnabled: false, driveGranted: true, ...over,
  });
  test("a Meet link needs Calendar on; Teams needs Microsoft tokens", () => {
    expect(canAddMeet("google", info({ calendarEnabled: false }))).toBe(false);
    expect(canAddMeet("google", info({ calendarEnabled: true }))).toBe(true);
    expect(canAddMeet("google", null)).toBe(false);
    expect(canAddMeet("microsoft", info({ provider: "microsoft", calendarEnabled: false }))).toBe(true);
  });
  test("disconnected Google is counted per task by its Drive-linked files", () => {
    const task = { documents: [{ externalProvider: "google" }, { externalProvider: null }, { externalProvider: "google" }] } as unknown as Task;
    expect(driveLinkedCount(task)).toBe(2);
    expect(googleNeedsReconnect(info({ tokensHeld: false }), "connected")).toBe(true);
    expect(googleNeedsReconnect(info({}), "error")).toBe(true);
    expect(googleNeedsReconnect(info({}), "connected")).toBe(false);
    expect(googleNeedsReconnect(null, null)).toBe(false);
  });
  test("the Picker runs on the app and localhost only; Doc URLs are recognised", () => {
    expect(isPickerHost("app.meridiesai.com")).toBe(true);
    expect(isPickerHost("localhost")).toBe(true);
    expect(isPickerHost("127.0.0.1")).toBe(true);
    expect(isPickerHost("meridies-app-git-x.vercel.app")).toBe(false);
    expect(isGoogleDocUrl("https://docs.google.com/document/d/abcDEF12345/edit")).toBe(true);
    expect(isGoogleDocUrl("https://docs.google.com/spreadsheets/d/abc/edit")).toBe(false);
    expect(isGoogleDocUrl("https://example.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx playwright test e2e/pure.spec.ts --project=public`
Expected: FAIL. `Cannot find module '../lib/googleDrive'`. After a stub module exists, typecheck also fails on the missing `StoredDocument` fields.

- [ ] **Step 3: Extend `lib/api.ts`**

Replace the `DocumentKind` union:

```ts
export type DocumentKind =
  | "transcript"
  | "resume"
  | "essay"
  | "test-report"
  | "award-letter"
  | "financial"
  | "common-app"
  | "other"
  | "recommendation-letter"
  | "activity-list"
  | "iep-504"
  | "counselor-only";

/** The server's type guess for a picked file (no AI). `matched` is a keyword from its list, never file text. */
export type KindGuess = {
  kind: DocumentKind | null;
  basis: "text" | "filename" | "type" | null;
  matched: string | null;
  textFound: boolean;
  keepOut: boolean;
};
```

In `StoredDocument`, after `availableToLlm: boolean;`, add:

```ts
  aiAccess: "default" | "allowed" | "excluded";
  ferpaWaived: boolean;
  /** False for a Drive file whose type the counselor hasn't confirmed: AxIS reads nothing from it. */
  kindConfirmed: boolean;
  kindGuess: KindGuess | null;
```

In `TaskDocument`, after `availableToLlm: boolean | null;`, add:

```ts
  /** Set when the file was picked from Drive / OneDrive; the tracker watches it. */
  externalProvider: SuiteProvider | null;
```

In `IntegrationProviderInfo`, add:

```ts
  /** Google: `calendar.events` is in the grant. Microsoft: Calendars.ReadWrite. */
  calendarEnabled: boolean;
  /** Google: `drive.file` is in the grant. */
  driveGranted: boolean;
```

Replace `getIntegrationAuthorizeUrl`:

```ts
/** The provider consent URL. Navigate the whole window there. `add: "calendar"` asks for Calendar on top of the grant. */
export function getIntegrationAuthorizeUrl(
  token: string,
  provider: SuiteProvider,
  add?: "calendar"
): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(`/integrations/${provider}/authorize${toQuery({ add })}`, { token });
}
```

After `importRemoteFile`, add:

```ts
/** What the browser needs to open Google's Picker. Never a secret: the key is referrer- and API-restricted. */
export type GooglePickerConfig = {
  clientId: string;
  apiKey: string;
  appId: string;
  accountEmail: string;
  maxFiles: number;
};

export function getGooglePickerConfig(token: string): Promise<GooglePickerConfig> {
  return apiFetch<GooglePickerConfig>("/integrations/google/picker-config", { token });
}
```

After `updateDocument`, add:

```ts
export type ConfirmTypeItem = { documentId: string; kind: DocumentKind; keepOut: boolean };

export type ConfirmTypeResult = {
  documentId: string;
  status: "confirmed" | "refused";
  reason: string | null;
  document: StoredDocument | null;
};

/** One call confirms the whole list; each item answers for itself. */
export function confirmDocumentTypes(
  token: string,
  items: ConfirmTypeItem[]
): Promise<{ results: ConfirmTypeResult[] }> {
  return apiFetch("/files/documents/confirm-types", { method: "POST", token, body: { items } });
}

export type ExtractionState = "queued" | "reading" | "done" | "empty" | "failed" | "kept-out" | "unconfirmed" | "none";

/** Where each confirmed file's text extraction is. The server reads two at a time; the rest wait. */
export function getExtractionStatus(
  token: string,
  ids: string[]
): Promise<{ documentId: string; state: ExtractionState }[]> {
  return apiFetch(`/files/documents/extraction-status${toQuery({ ids: ids.slice(0, 50).join(",") })}`, { token });
}
```

Change `syncEssayDocs`'s return type to `Promise<{ updated: number; failed: number; notPicked: string[]; essays: EssayDoc[] }>`. In `app/actions.ts`, change `syncEssayDocsAction`'s `ActionResult<…>` the same way. Change `startIntegrationConnectAction`:

```ts
export async function startIntegrationConnectAction(
  provider: api.SuiteProvider,
  add?: "calendar"
): Promise<ActionResult<{ url: string }>> {
  try {
    const token = requireToken(await getServerToken());
    return { ok: true, data: await api.getIntegrationAuthorizeUrl(token, provider, add) };
  } catch (err) {
    return failure(err, "Couldn't start the sign-in. Try again.");
  }
}
```

- [ ] **Step 4: Fix every `Record<DocumentKind, …>` the new kinds broke**

Run: `npm run typecheck`. Every map keyed by `DocumentKind` now misses four keys (for example `KIND_META` in `components/dashboard/StudentFiles.tsx:83`). Add these entries to each:

```ts
  "recommendation-letter": { label: "Recommendation", tint: "#7a5c2e" },
  "activity-list": { label: "Activities", tint: "#3f6b8a" },
  "iep-504": { label: "IEP / 504", tint: "#8a3f5c" },
  "counselor-only": { label: "Counselor only", tint: "#5c5c5c" },
```

Find the rest with `git grep -n "Record<DocumentKind" -- '*.ts' '*.tsx'`, and keep each map's own value shape.

- [ ] **Step 5: Write `lib/googleDrive.ts`**

```ts
/**
 * The pure rules behind picking from Google Drive: the type list, extraction
 * progress, when a Meet link can be offered, when a task says Google is
 * disconnected, and where the Picker can run. No network, no React: tested in
 * e2e/pure.spec.ts.
 */
import type {
  ConfirmTypeItem,
  DocumentKind,
  ExtractionState,
  IntegrationProviderInfo,
  IntegrationStatus,
  StoredDocument,
  SuiteProvider,
  Task,
} from "./api";

export const KIND_LABELS: Record<DocumentKind, string> = {
  transcript: "Transcript",
  resume: "Resume",
  essay: "Essay",
  "test-report": "Test report",
  "activity-list": "Activity list",
  "common-app": "Common App",
  "award-letter": "Award letter",
  financial: "Financial",
  "recommendation-letter": "Recommendation letter",
  "iep-504": "IEP / 504",
  "counselor-only": "Counselor only",
  other: "Other",
};

/** Guesses that come pre-ticked as kept out of AI, whatever the kind defaults say. */
const SENSITIVE: readonly DocumentKind[] = ["financial", "iep-504"];

export type TypeRow = {
  documentId: string;
  name: string;
  /** Null: unknown ("Choose a type"); left out of Looks right until the counselor picks one. */
  kind: DocumentKind | null;
  keepOut: boolean;
  pleaseCheck: boolean;
  basis: "text" | "filename" | "type" | null;
};

export function typeRows(docs: StoredDocument[]): TypeRow[] {
  return docs.map((d) => {
    const g = d.kindGuess;
    const kind = g?.kind ?? null;
    return {
      documentId: d.id,
      name: d.title ?? d.filename,
      kind,
      keepOut: Boolean(g?.keepOut) || (kind !== null && SENSITIVE.includes(kind)),
      pleaseCheck: !g || g.basis !== "text" || !g.textFound,
      basis: g?.basis ?? null,
    };
  });
}

export function confirmPayload(rows: TypeRow[]): ConfirmTypeItem[] {
  return rows
    .filter((r): r is TypeRow & { kind: DocumentKind } => r.kind !== null)
    .map((r) => ({ documentId: r.documentId, kind: r.kind, keepOut: r.keepOut }));
}

export const BASIS_LABEL: Record<"text" | "filename" | "type", string> = {
  text: "from the file's text",
  filename: "from the file name",
  type: "from the file type",
};

const UNFINISHED: readonly ExtractionState[] = ["queued", "reading"];

export function isTerminal(state: ExtractionState): boolean {
  return !UNFINISHED.includes(state);
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** "Reading 3 of 10…" while anything waits; a summary once nothing does. */
export function progressText(states: ExtractionState[]): string {
  const n = states.length;
  if (n === 0) return "";
  const finished = states.filter(isTerminal).length;
  if (finished < n) return `Reading ${Math.min(finished + 1, n)} of ${n}…`;
  const ready = states.filter((s) => s === "done").length;
  const empty = states.filter((s) => s === "empty").length;
  const failed = states.filter((s) => s === "failed").length;
  return [
    `Text ready for ${files(ready)}`,
    empty > 0 ? `${empty} had no readable text` : null,
    failed > 0 ? `${failed} couldn't be read` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Whether Meridies can create the conference link itself. */
export function canAddMeet(provider: SuiteProvider, info: IntegrationProviderInfo | null): boolean {
  if (!info || !info.tokensHeld) return false;
  return provider === "google" ? info.calendarEnabled : true;
}

export function driveLinkedCount(task: Task): number {
  return task.documents.filter((d) => d.externalProvider === "google").length;
}

export function googleNeedsReconnect(
  info: IntegrationProviderInfo | null,
  grantStatus: IntegrationStatus | null
): boolean {
  if (!info) return false;
  return !info.tokensHeld || grantStatus === "error";
}

/** Origins registered for the OAuth client and the Picker key. */
export function isPickerHost(hostname: string): boolean {
  return hostname === "app.meridiesai.com" || hostname === "localhost" || hostname === "127.0.0.1";
}

export function isGoogleDocUrl(url: string): boolean {
  return /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/[A-Za-z0-9_-]{5,}/.test(url);
}
```

`googleNeedsReconnect` reads the `integrations` row status from `getIntegrations`. Callers that only hold providers info pass `null`.

- [ ] **Step 6: Run the checks**

Run: `npm run typecheck && npm run lint && npx playwright test e2e/pure.spec.ts --project=public`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/api.ts lib/googleDrive.ts app/actions.ts e2e/pure.spec.ts components
git commit -m "Google Drive: API contract for picker, type confirmation and extraction status; pure rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/googlePicker.ts` and `GoogleDrivePicker`

**Files:**
- Create: `lib/googlePicker.ts`
- Create: `components/files/GoogleDrivePicker.tsx`
- Create: `e2e/auth/google-drive.spec.ts` (its stubs are reused by Tasks 3–5)
- Create: `e2e/googleStubs.ts`

**Interfaces:**
- Consumes: `getGooglePickerConfig`, `importRemoteFile`, `StoredDocument`, `DocumentKind`, `isPickerHost` (Task 1).
- Produces:
  - `loadGoogleScripts(): Promise<void>`
  - `pickerToken(cfg: { clientId: string; accountEmail: string }): Promise<string>`, which rejects with `PickerError("popup" | "denied")`
  - `signedInEmail(token: string): Promise<string | null>`
  - `openPicker(o: { token: string; apiKey: string; appId: string; mode: "files" | "doc"; maxFiles: number }): Promise<PickedFile[]>`
  - `type PickedFile = { id: string; name: string; mimeType: string; url: string }`
  - `<GoogleDrivePicker token studentId folderId? kind? mode? onImported(docs: StoredDocument[]) onPickedDoc?(file: PickedFile) />`

- [ ] **Step 1: Write the shared stubs** (`e2e/googleStubs.ts`)

```ts
import type { Page, Route } from "@playwright/test";

export type FakePick = { id: string; name: string; mimeType: string; url: string };

/**
 * Google's scripts answer empty and a fake `window.google` / `window.gapi` stand in.
 * The fakes record what they were called with on `window.__g`, so a test can assert
 * the token request and the Picker build.
 */
export async function stubGoogle(
  page: Page,
  opts: { picks: FakePick[]; tokenError?: "popup_failed_to_open" | "popup_closed"; signedInAs?: string }
): Promise<void> {
  await page.route("https://accounts.google.com/gsi/client", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("https://apis.google.com/js/api.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("https://www.googleapis.com/drive/v3/about*", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { emailAddress: opts.signedInAs ?? "counselor@example.com" } }) })
  );
  await page.addInitScript(({ picks, tokenError }) => {
    type Rec = { token?: Record<string, unknown>; picker: string[]; views: string[] };
    const rec: Rec = { picker: [], views: [] };
    (window as unknown as { __g: Rec }).__g = rec;
    let callback: ((d: { action: string; docs?: unknown[] }) => void) | null = null;
    class DocsView {
      constructor(id?: string) { rec.views.push(`view:${id ?? "default"}`); }
      setIncludeFolders(b: boolean) { rec.views.push(`folders:${b}`); return this; }
      setSelectFolderEnabled(b: boolean) { rec.views.push(`selectFolder:${b}`); return this; }
      setOwnedByMe(b: boolean) { rec.views.push(`ownedByMe:${b}`); return this; }
      setEnableDrives(b: boolean) { rec.views.push(`drives:${b}`); return this; }
      setMimeTypes(m: string) { rec.views.push(`mime:${m}`); return this; }
    }
    class PickerBuilder {
      setAppId(v: string) { rec.picker.push(`appId:${v}`); return this; }
      setOAuthToken(v: string) { rec.picker.push(`token:${v}`); return this; }
      setDeveloperKey(v: string) { rec.picker.push(`key:${v}`); return this; }
      addView() { return this; }
      enableFeature(f: string) { rec.picker.push(`feature:${f}`); return this; }
      setMaxItems(n: number) { rec.picker.push(`max:${n}`); return this; }
      setCallback(cb: (d: { action: string; docs?: unknown[] }) => void) { callback = cb; return this; }
      build() {
        return { setVisible: () => setTimeout(() => callback?.(picks.length ? { action: "picked", docs: picks } : { action: "cancel" }), 0) };
      }
    }
    (window as unknown as Record<string, unknown>).google = {
      accounts: {
        oauth2: {
          initTokenClient(cfg: Record<string, unknown> & { callback: (r: unknown) => void; error_callback?: (e: unknown) => void }) {
            rec.token = { ...cfg, callback: undefined, error_callback: undefined };
            return {
              requestAccessToken() {
                setTimeout(() => {
                  if (tokenError) cfg.error_callback?.({ type: tokenError });
                  else cfg.callback({ access_token: "picker-token" });
                }, 0);
              },
            };
          },
        },
      },
      picker: {
        PickerBuilder,
        DocsView,
        ViewId: { DOCS: "docs", DOCUMENTS: "documents", RECENTLY_PICKED: "recently-picked" },
        Feature: { MULTISELECT_ENABLED: "multiselect" },
        Action: { PICKED: "picked", CANCEL: "cancel" },
      },
    };
    (window as unknown as Record<string, unknown>).gapi = { load: (_n: string, cb: () => void) => cb() };
  }, { picks: opts.picks, tokenError: opts.tokenError ?? null });
}

export const PICKER_CONFIG = {
  clientId: "client-123.apps.googleusercontent.com",
  apiKey: "picker-key",
  appId: "356256797701",
  accountEmail: "counselor@example.com",
  maxFiles: 10,
};

export async function stubPickerConfig(page: Page, answer?: (route: Route) => Promise<void>): Promise<void> {
  await page.route("**/integrations/google/picker-config", (route) =>
    answer ? answer(route) : route.fulfill({ contentType: "application/json", body: JSON.stringify(PICKER_CONFIG) })
  );
}

export function storedDoc(over: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(), studentId: null, folderId: null, filename: "file.pdf", title: null, description: null,
    bucket: "student-documents", storagePath: "x/file.pdf", mimeType: "application/pdf", sizeBytes: 1000,
    kind: "other", source: "integration", parseStatus: "pending", availableToLlm: false, aiAccess: "default",
    ferpaWaived: false, kindConfirmed: false,
    kindGuess: { kind: "transcript", basis: "text", matched: "Official Transcript", textFound: true, keepOut: false },
    externalProvider: "google", externalWebUrl: null, externalModifiedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing UI spec** (`e2e/auth/google-drive.spec.ts`)

The picker is reached from the Files page (Task 4 mounts it there). Until Task 4 lands, this spec opens a student folder and clicks **Google Drive**. Add the spec now and expect it to fail.

```ts
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP, signedInAs } from "../helpers";
import { PICKER_CONFIG, storedDoc, stubGoogle, stubPickerConfig } from "../googleStubs";

/**
 * Picking from Google Drive, signed in as a real counselor. Google's scripts,
 * the Picker and every new API call are stubbed: nothing reaches Google, and no
 * file is imported for real (unstubbed import / confirm calls abort).
 */
signedInAs("counselor");

const IMPORT = "**/integrations/google/files/import";

async function openStudentFolder(page: Page): Promise<boolean> {
  await page.goto("/dashboard/counselor/data-hub");
  await page.waitForLoadState("networkidle");
  const folder = page.locator('[data-folder-kind="student"]').first();
  if ((await folder.count()) === 0) return false;
  await folder.click();
  return true;
}

test.describe("Google Drive picker", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(IMPORT, (r) => r.abort());
    await page.route("**/files/documents/confirm-types", (r) => r.abort());
    await page.setViewportSize(DESKTOP);
  });

  test("asks for drive.file only, without folding in other permissions, and builds the Picker with the app id", async ({ page }) => {
    const picks = [{ id: "file-a1234", name: "Transcript.pdf", mimeType: "application/pdf", url: "https://drive.google.com/file/d/file-a1234/view" }];
    await stubGoogle(page, { picks });
    await stubPickerConfig(page);
    await page.route(IMPORT, (r) => r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(storedDoc({ filename: "Transcript.pdf" })) }));
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    await expect(page.getByText("Transcript.pdf")).toBeVisible();
    const g = await page.evaluate(() => (window as unknown as { __g: { token: Record<string, unknown>; picker: string[]; views: string[] } }).__g);
    expect(g.token).toMatchObject({
      client_id: PICKER_CONFIG.clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      include_granted_scopes: false,
      login_hint: PICKER_CONFIG.accountEmail,
    });
    expect(g.picker).toEqual(expect.arrayContaining([`appId:${PICKER_CONFIG.appId}`, "token:picker-token", "key:picker-key", "feature:multiselect", "max:10"]));
    expect(g.views).toEqual(expect.arrayContaining(["drives:true", "selectFolder:false"]));
    const imported = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/files/import")).length);
    expect(imported).toBe(1);
  });

  test("a blocked popup says so and imports nothing", async ({ page }) => {
    await stubGoogle(page, { picks: [], tokenError: "popup_failed_to_open" });
    await stubPickerConfig(page);
    let imports = 0;
    await page.route(IMPORT, (r) => { imports++; return r.abort(); });
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    await expect(page.getByText("Allow pop-ups for Meridies to pick from Drive")).toBeVisible();
    await expect(page.locator(".animate-spin")).toHaveCount(0);
    expect(imports).toBe(0);
  });

  test("another signed-in account stops before the Picker", async ({ page }) => {
    await stubGoogle(page, { picks: [{ id: "file-a1234", name: "A.pdf", mimeType: "application/pdf", url: "https://x" }], signedInAs: "someone@else.com" });
    await stubPickerConfig(page);
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    await expect(page.getByText(`You're signed in to Google as someone@else.com. Pick with ${PICKER_CONFIG.accountEmail}.`)).toBeVisible();
    const g = await page.evaluate(() => (window as unknown as { __g: { picker: string[] } }).__g);
    expect(g.picker).toHaveLength(0);
  });

  test("one unavailable file doesn't stop the rest", async ({ page }) => {
    const picks = ["a", "b", "c"].map((x) => ({ id: `file-${x}1234`, name: `${x.toUpperCase()}.pdf`, mimeType: "application/pdf", url: "https://x" }));
    await stubGoogle(page, { picks });
    await stubPickerConfig(page);
    await page.route(IMPORT, async (r) => {
      const body = r.request().postDataJSON() as { fileId: string };
      if (body.fileId === "file-b1234") {
        return r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Conflict", code: "picked_file_unavailable", message: "Meridies can't open that file. It may have been picked with a different Google account, or it's no longer available. Pick it again with counselor@example.com." }) });
      }
      return r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(storedDoc({ filename: body.fileId === "file-a1234" ? "A.pdf" : "C.pdf" })) });
    });
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    await expect(page.getByText(/Meridies can't open that file/)).toBeVisible();
    await expect(page.getByRole("dialog").getByText("A.pdf")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("C.pdf")).toBeVisible();
  });

  test("Google settings missing on the server says it isn't set up yet", async ({ page }) => {
    await stubGoogle(page, { picks: [] });
    await stubPickerConfig(page, (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "GOOGLE_PICKER_API_KEY is not set" }) }));
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    await expect(page.getByText("Google Drive isn't set up yet")).toBeVisible();
  });
});
```

Run: `npx playwright test e2e/auth/google-drive.spec.ts --project=signed-in`
Expected: FAIL. There is no `[data-folder-kind]` and no **Google Drive** button yet. Every test skips when the E2E accounts aren't set; then run it again once Task 4 is done.

- [ ] **Step 3: Write `lib/googlePicker.ts`**

```ts
/**
 * Google's Picker, in the browser.
 *
 * Scripts load on the click (never on page load). The token the Picker uses is
 * the browser's own, asked with drive.file ONLY and include_granted_scopes:
 * false, so a counselor who turned Calendar on still gets a token that can't
 * touch their calendar (spec §3 A). It stays in memory and is never sent to
 * our API. setAppId(project number) is what grants the picked files to our
 * OAuth client, so the server's token can open them; without it every import
 * would fail after a pick that looked fine.
 */

const GSI = "https://accounts.google.com/gsi/client";
const GAPI = "https://apis.google.com/js/api.js";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DOC = "application/vnd.google-apps.document";

type TokenResponse = { access_token?: string; error?: string };
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
type TokenClientConfig = {
  client_id: string;
  scope: string;
  include_granted_scopes: boolean;
  login_hint?: string;
  callback: (r: TokenResponse) => void;
  error_callback?: (e: { type?: string }) => void;
};
type PickerDoc = { id: string; name: string; mimeType: string; url: string };
type PickerData = { action: string; docs?: PickerDoc[] };
type DocsView = {
  setIncludeFolders(b: boolean): DocsView;
  setSelectFolderEnabled(b: boolean): DocsView;
  setOwnedByMe(b: boolean): DocsView;
  setEnableDrives(b: boolean): DocsView;
  setMimeTypes(m: string): DocsView;
};
type PickerBuilder = {
  setAppId(id: string): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  addView(v: DocsView | string): PickerBuilder;
  enableFeature(f: string): PickerBuilder;
  setMaxItems(n: number): PickerBuilder;
  setCallback(cb: (d: PickerData) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
};
type PickerNamespace = {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: string) => DocsView;
  ViewId: { DOCS: string; DOCUMENTS: string; RECENTLY_PICKED: string };
  Feature: { MULTISELECT_ENABLED: string };
  Action: { PICKED: string; CANCEL: string };
};

declare global {
  interface Window {
    google?: { accounts?: { oauth2: { initTokenClient(c: TokenClientConfig): TokenClient } }; picker?: PickerNamespace };
    gapi?: { load(name: string, cb: () => void): void };
  }
}

export type PickedFile = { id: string; name: string; mimeType: string; url: string };

export class PickerError extends Error {
  constructor(public reason: "popup" | "denied" | "unavailable") {
    super(reason);
    this.name = "PickerError";
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded === "true") return resolve();
    const el = existing ?? document.createElement("script");
    el.addEventListener("load", () => {
      el.dataset.loaded = "true";
      resolve();
    });
    el.addEventListener("error", () => reject(new PickerError("unavailable")));
    if (!existing) {
      el.src = src;
      el.async = true;
      document.head.appendChild(el);
    }
  });
}

export async function loadGoogleScripts(): Promise<void> {
  await Promise.all([loadScript(GSI), loadScript(GAPI)]);
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) return reject(new PickerError("unavailable"));
    window.gapi.load("picker", () => resolve());
  });
  if (!window.google?.accounts || !window.google.picker) throw new PickerError("unavailable");
}

export function pickerToken(cfg: { clientId: string; accountEmail: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) return reject(new PickerError("unavailable"));
    const client = oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: DRIVE_FILE_SCOPE,
      include_granted_scopes: false,
      login_hint: cfg.accountEmail,
      callback: (r) => (r.access_token ? resolve(r.access_token) : reject(new PickerError("denied"))),
      error_callback: (e) =>
        reject(new PickerError(e.type === "popup_failed_to_open" || e.type === "popup_closed" ? "popup" : "denied")),
    });
    client.requestAccessToken();
  });
}

/** The Google account the browser token belongs to (Drive about.get works under drive.file). */
export async function signedInEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { emailAddress?: string } };
    return body.user?.emailAddress ?? null;
  } catch {
    return null;
  }
}

export function openPicker(o: {
  token: string;
  apiKey: string;
  appId: string;
  mode: "files" | "doc";
  maxFiles: number;
}): Promise<PickedFile[]> {
  const p = window.google?.picker;
  if (!p) return Promise.reject(new PickerError("unavailable"));
  return new Promise((resolve) => {
    const builder = new p.PickerBuilder()
      .setAppId(o.appId)
      .setOAuthToken(o.token)
      .setDeveloperKey(o.apiKey)
      .setCallback((data) => {
        if (data.action === p.Action.PICKED) {
          resolve((data.docs ?? []).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType, url: d.url })));
        } else if (data.action === p.Action.CANCEL) {
          resolve([]);
        }
      });
    if (o.mode === "doc") {
      builder.addView(new p.DocsView(p.ViewId.DOCUMENTS).setMimeTypes(GOOGLE_DOC).setOwnedByMe(true));
      builder.addView(new p.DocsView(p.ViewId.DOCUMENTS).setMimeTypes(GOOGLE_DOC).setOwnedByMe(false));
    } else {
      builder.addView(new p.DocsView(p.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setOwnedByMe(true));
      builder.addView(new p.DocsView(p.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setOwnedByMe(false));
      builder.addView(new p.DocsView(p.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setEnableDrives(true));
      builder.addView(p.ViewId.RECENTLY_PICKED);
      builder.enableFeature(p.Feature.MULTISELECT_ENABLED).setMaxItems(o.maxFiles);
    }
    builder.build().setVisible(true);
  });
}
```

- [ ] **Step 4: Write `components/files/GoogleDrivePicker.tsx`**

```tsx
"use client";

/**
 * "Google Drive": pick files with Google's own Picker, then import each one.
 *
 * Only what the counselor picks becomes reachable to Meridies (drive.file),
 * and Google enforces that, not this code. Imports run two at a time and
 * each file reports its own result, so one unavailable file never hides the
 * rest. A pick from Essays names its kind (`essay`) and is confirmed at once;
 * any other pick arrives unconfirmed with the server's type guess, for the
 * type list (TypeList.tsx).
 */

import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/dashboard/DashboardUI";
import {
  ApiError,
  getGooglePickerConfig,
  importRemoteFile,
  type DocumentKind,
  type StoredDocument,
} from "@/lib/api";
import { isPickerHost } from "@/lib/googleDrive";
import { loadGoogleScripts, openPicker, pickerToken, PickerError, signedInEmail, type PickedFile } from "@/lib/googlePicker";

type FileResult = { name: string; ok: boolean; message: string | null };

function failureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) return "Google Drive isn't set up yet";
    return err.message;
  }
  return "Couldn't import that file. Try again.";
}

export default function GoogleDrivePicker({
  token,
  studentId,
  folderId = null,
  kind,
  mode = "files",
  label = "Google Drive",
  onImported,
  onPickedDoc,
}: {
  token: string | null;
  studentId: string;
  folderId?: string | null;
  /** Set where the type is implied (Essays): the files skip the type list. */
  kind?: DocumentKind;
  /** "doc": one Google Doc, not imported, handed to `onPickedDoc` (essay links). */
  mode?: "files" | "doc";
  label?: string;
  onImported?: (docs: StoredDocument[]) => void;
  onPickedDoc?: (file: PickedFile) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);

  if (typeof window !== "undefined" && !isPickerHost(window.location.hostname)) {
    return <p className="font-sans text-[12px] text-muted-foreground">Google Drive isn&apos;t available on preview builds.</p>;
  }

  async function start() {
    if (!token) return;
    setError(null);
    setResults([]);
    setBusy("Opening Google Drive…");
    try {
      const cfg = await getGooglePickerConfig(token);
      await loadGoogleScripts();
      const pickerAccess = await pickerToken({ clientId: cfg.clientId, accountEmail: cfg.accountEmail });
      const signedIn = await signedInEmail(pickerAccess);
      if (signedIn && signedIn.toLowerCase() !== cfg.accountEmail.toLowerCase()) {
        setError(`You're signed in to Google as ${signedIn}. Pick with ${cfg.accountEmail}.`);
        return;
      }
      const picked = await openPicker({ token: pickerAccess, apiKey: cfg.apiKey, appId: cfg.appId, mode, maxFiles: cfg.maxFiles });
      if (picked.length === 0) return;
      if (mode === "doc") {
        onPickedDoc?.(picked[0]);
        return;
      }
      await importAll(token, picked);
    } catch (err) {
      if (err instanceof PickerError) {
        setError(err.reason === "popup" ? "Allow pop-ups for Meridies to pick from Drive" : "Google didn't open the picker. Try again.");
      } else {
        setError(failureMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function importAll(t: string, picked: PickedFile[]) {
    const done: StoredDocument[] = [];
    const out: FileResult[] = [];
    for (let i = 0; i < picked.length; i += 2) {
      setBusy(`Importing ${Math.min(i + 2, picked.length)} of ${picked.length}…`);
      const pair = await Promise.all(
        picked.slice(i, i + 2).map(async (f): Promise<FileResult> => {
          try {
            const doc = await importRemoteFile(t, "google", { fileId: f.id, studentId, folderId, ...(kind ? { kind } : {}) });
            done.push(doc);
            return { name: f.name, ok: true, message: null };
          } catch (err) {
            return { name: f.name, ok: false, message: failureMessage(err) };
          }
        })
      );
      out.push(...pair);
      setResults([...out]);
    }
    if (done.length > 0) onImported?.(done);
  }

  return (
    <div>
      <Button size="sm" onClick={() => void start()} disabled={!token || busy !== null}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {label}
      </Button>
      {busy && <p className="mt-1.5 font-sans text-[12px] text-muted-foreground">{busy}</p>}
      {error && (
        <p className="mt-2 inline-flex items-start gap-1.5 font-sans text-[12px] leading-snug text-danger">
          <TriangleAlert className="mt-[2px] h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {results.some((r) => !r.ok) && (
        <ul className="mt-2 space-y-1">
          {results.filter((r) => !r.ok).map((r) => (
            <li key={r.name} className="font-sans text-[12px] leading-snug text-danger">
              {r.name}: {r.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Checks**

Run: `npm run typecheck && npm run lint`
Expected: PASS. The UI spec stays failing until Task 4 mounts the button.

- [ ] **Step 6: Commit**

```bash
git add lib/googlePicker.ts components/files/GoogleDrivePicker.tsx e2e/googleStubs.ts e2e/auth/google-drive.spec.ts
git commit -m "Google Drive picker: drive.file-only browser token, same-account check, Picker with app id, imports two at a time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The type list (`TypeList`) with extraction progress

**Files:**
- Create: `components/files/TypeList.tsx`
- Create: `lib/useExtractionProgress.ts`
- Test: `e2e/auth/google-drive.spec.ts` (append the "type list" describe)

**Interfaces:**
- Consumes: `typeRows`, `confirmPayload`, `progressText`, `isTerminal`, `KIND_LABELS`, `BASIS_LABEL`, `TypeRow` (Task 1); `confirmDocumentTypes`, `getExtractionStatus`, `StoredDocument`, `ExtractionState`.
- Produces:
  - `<TypeList token docs onConfirmed(docs: StoredDocument[]) onClose() />`, rendered inside a `Modal` by the caller.
  - `useExtractionProgress(token: string | null, ids: string[]): ExtractionState[]`, which polls every 2 s until every state is terminal or the component unmounts.

- [ ] **Step 1: Write the failing UI tests** (append to `e2e/auth/google-drive.spec.ts`)

```ts
test.describe("type list", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(IMPORT, (r) => r.abort());
    await page.route("**/files/documents/confirm-types", (r) => r.abort());
    await page.setViewportSize(DESKTOP);
  });

  async function pickThree(page: Page) {
    const docs = [
      storedDoc({ id: "00000000-0000-4000-8000-00000000000a", filename: "Transcript.pdf" }),
      storedDoc({ id: "00000000-0000-4000-8000-00000000000b", filename: "Scan.pdf", kindGuess: { kind: "resume", basis: "filename", matched: "resume", textFound: false, keepOut: false } }),
      storedDoc({ id: "00000000-0000-4000-8000-00000000000c", filename: "Mystery.pdf", kindGuess: { kind: null, basis: null, matched: null, textFound: false, keepOut: false } }),
    ];
    await stubGoogle(page, { picks: docs.map((d, i) => ({ id: `file-${i}12345`, name: d.filename, mimeType: "application/pdf", url: "https://x" })) });
    await stubPickerConfig(page);
    let n = 0;
    await page.route(IMPORT, (r) => r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(docs[n++]) }));
    return docs;
  }

  test("guesses are filled in, filename-only guesses say Please check, and Looks right confirms every typed row in one request", async ({ page }) => {
    const docs = await pickThree(page);
    let requests = 0;
    let sent: { items: { documentId: string; kind: string; keepOut: boolean }[] } | null = null;
    await page.route("**/files/documents/confirm-types", async (r) => {
      requests++;
      sent = r.request().postDataJSON();
      await new Promise((res) => setTimeout(res, 300));
      return r.fulfill({ contentType: "application/json", body: JSON.stringify({ results: sent!.items.map((i) => ({ documentId: i.documentId, status: "confirmed", reason: null, document: { ...docs.find((d) => d.id === i.documentId), kind: i.kind, kindConfirmed: true } })) }) });
    });
    await page.route("**/files/documents/extraction-status*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify([{ documentId: docs[0].id, state: "done" }, { documentId: docs[1].id, state: "empty" }]) }));
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    const list = page.getByRole("dialog", { name: /what are these files/i });
    await expect(list.getByText("Please check")).toHaveCount(2);
    await expect(list.getByText("Choose a type")).toBeVisible();
    const looksRight = list.getByRole("button", { name: "Looks right" });
    await looksRight.click();
    await looksRight.click({ force: true }).catch(() => undefined);
    await expect(list.getByText("Text ready for 1 file · 1 had no readable text")).toBeVisible();
    expect(requests).toBe(1);
    expect(sent!.items.map((i) => i.documentId)).toEqual([docs[0].id, docs[1].id]);
    await expect(list.getByText("Mystery.pdf")).toBeVisible();
  });

  test("a refused row stays with its reason; one request per click", async ({ page }) => {
    const docs = await pickThree(page);
    let requests = 0;
    await page.route("**/files/documents/confirm-types", (r) => {
      requests++;
      return r.fulfill({ contentType: "application/json", body: JSON.stringify({ results: [
        { documentId: docs[0].id, status: "confirmed", reason: null, document: { ...docs[0], kindConfirmed: true } },
        { documentId: docs[1].id, status: "refused", reason: "You can't edit that student's files.", document: null },
      ] }) });
    });
    await page.route("**/files/documents/extraction-status*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify([{ documentId: docs[0].id, state: "done" }]) }));
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    const list = page.getByRole("dialog", { name: /what are these files/i });
    await list.getByRole("button", { name: "Looks right" }).click();
    await expect(list.getByText("You can't edit that student's files.")).toBeVisible();
    await expect(list.getByText("Scan.pdf")).toBeVisible();
    await expect(list.getByText("Transcript.pdf")).toHaveCount(0);
    expect(requests).toBe(1);
  });

  test("status stays reading for many polls without an error, and closing stops the requests", async ({ page }) => {
    const docs = await pickThree(page);
    await page.route("**/files/documents/confirm-types", (r) => {
      const body = r.request().postDataJSON() as { items: { documentId: string }[] };
      return r.fulfill({ contentType: "application/json", body: JSON.stringify({ results: body.items.map((i) => ({ documentId: i.documentId, status: "confirmed", reason: null, document: { ...docs.find((d) => d.id === i.documentId), kindConfirmed: true } })) }) });
    });
    let polls = 0;
    await page.route("**/files/documents/extraction-status*", (r) => {
      polls++;
      return r.fulfill({ contentType: "application/json", body: JSON.stringify([{ documentId: docs[0].id, state: "reading" }, { documentId: docs[1].id, state: "queued" }]) });
    });
    await page.clock.install();
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    const list = page.getByRole("dialog", { name: /what are these files/i });
    await list.getByRole("button", { name: "Looks right" }).click();
    await page.clock.runFor(60_000);
    await expect(list.getByText("Reading 1 of 2…")).toBeVisible();
    await expect(list.getByText(/couldn't|timed out|failed/i)).toHaveCount(0);
    expect(polls).toBeGreaterThanOrEqual(20);
    await list.getByRole("button", { name: "Close" }).click();
    const after = polls;
    await page.clock.runFor(20_000);
    expect(polls).toBe(after);
  });

  test("Not now confirms nothing", async ({ page }) => {
    await pickThree(page);
    let requests = 0;
    await page.route("**/files/documents/confirm-types", (r) => { requests++; return r.abort(); });
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    await page.getByRole("button", { name: "Google Drive" }).click();
    await page.getByRole("dialog", { name: /what are these files/i }).getByRole("button", { name: "Not now" }).click();
    expect(requests).toBe(0);
    await expect(page.getByText("Not categorized").first()).toBeVisible();
  });
});
```

Run: `npx playwright test e2e/auth/google-drive.spec.ts --project=signed-in -g "type list"`
Expected: FAIL. The list doesn't exist yet.

- [ ] **Step 2: Write `lib/useExtractionProgress.ts`**

```ts
"use client";

import { useEffect, useState } from "react";
import { getExtractionStatus, type ExtractionState } from "./api";
import { isTerminal } from "./googleDrive";

const POLL_MS = 2000;

/**
 * Where each confirmed file's text extraction is. Polls every 2 s while the
 * caller is mounted and anything is unfinished. There is no timeout: the
 * server reads two at a time and the rest wait their turn. Unmounting stops
 * polling; the server carries on.
 */
export function useExtractionProgress(token: string | null, ids: string[]): ExtractionState[] {
  const [states, setStates] = useState<ExtractionState[]>(() => ids.map(() => "queued"));
  const key = ids.join(",");

  useEffect(() => {
    const list = key ? key.split(",") : [];
    setStates(list.map(() => "queued"));
    if (!token || list.length === 0) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const rows = await getExtractionStatus(token, list);
        if (!live) return;
        const byId = new Map(rows.map((r) => [r.documentId, r.state]));
        const next = list.map((id) => byId.get(id) ?? "queued");
        setStates(next);
        if (next.every(isTerminal)) return;
      } catch {
        // A failed poll is not a failed extraction: try again next tick.
      }
      if (live) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [token, key]);

  return states;
}
```

- [ ] **Step 3: Write `components/files/TypeList.tsx`**

```tsx
"use client";

/**
 * What are these files? One list for a whole pick.
 *
 * Every row starts from the server's guess (no AI): filename, Google file type
 * and text patterns. One Looks right confirms every row that has a type; the
 * counselor edits only the wrong or unknown ones. Unknown rows stay out of the
 * request and stay unconfirmed. A guess not read from the text carries Please
 * check. Financial and IEP/504 guesses come kept out of AI. After confirming,
 * the server extracts text for AxIS two files at a time, and this list shows
 * where that is ("Reading 3 of 10…") for as long as it stays open.
 */

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge, Button } from "@/components/dashboard/DashboardUI";
import { confirmDocumentTypes, type DocumentKind, type StoredDocument } from "@/lib/api";
import { BASIS_LABEL, confirmPayload, KIND_LABELS, progressText, typeRows, type TypeRow } from "@/lib/googleDrive";
import { useExtractionProgress } from "@/lib/useExtractionProgress";

const KINDS = Object.keys(KIND_LABELS) as DocumentKind[];

export default function TypeList({
  token,
  docs,
  onConfirmed,
  onClose,
}: {
  token: string | null;
  docs: StoredDocument[];
  onConfirmed: (docs: StoredDocument[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TypeRow[]>(() => typeRows(docs));
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<string[]>([]);
  const states = useExtractionProgress(token, reading);
  const progress = useMemo(() => progressText(states), [states]);

  const set = (id: string, patch: Partial<TypeRow>) =>
    setRows((list) => list.map((r) => (r.documentId === id ? { ...r, ...patch, pleaseCheck: patch.kind !== undefined ? false : r.pleaseCheck } : r)));

  async function looksRight() {
    const items = confirmPayload(rows);
    if (!token || sending || items.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const { results } = await confirmDocumentTypes(token, items);
      const confirmed = results.filter((r) => r.status === "confirmed" && r.document).map((r) => r.document as StoredDocument);
      const nope = Object.fromEntries(results.filter((r) => r.status === "refused").map((r) => [r.documentId, r.reason ?? "Couldn't confirm this one."]));
      setRefused(nope);
      setRows((list) => list.filter((r) => !confirmed.some((d) => d.id === r.documentId)));
      setReading(confirmed.filter((d) => d.availableToLlm).map((d) => d.id));
      onConfirmed(confirmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't confirm these. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <p className="font-sans text-[12.5px] leading-snug text-muted-foreground">
        AxIS doesn&apos;t read these files until you confirm their types. Financial documents, IEP/504 plans,
        award letters, recommendation letters and counselor-only files stay out of AxIS even then.
      </p>

      {rows.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => (
            <li key={r.documentId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-sans text-[13px] font-medium text-foreground">{r.name}</p>
                <p className="mt-0.5 font-sans text-[11.5px] text-muted-foreground">
                  {r.kind === null ? "Choose a type" : r.basis ? `Guessed ${BASIS_LABEL[r.basis]}` : "Your choice"}
                </p>
                {refused[r.documentId] && <p className="mt-0.5 font-sans text-[11.5px] text-danger">{refused[r.documentId]}</p>}
              </div>
              {r.pleaseCheck && <Badge label="Please check" text="var(--warning)" bg="var(--warning-bg)" />}
              <select
                aria-label={`Type of ${r.name}`}
                value={r.kind ?? ""}
                onChange={(e) => set(r.documentId, { kind: (e.target.value || null) as DocumentKind | null })}
                className="h-8 rounded-md border border-border bg-card px-2 font-sans text-[12.5px]"
              >
                <option value="">Choose a type</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 font-sans text-[12px] text-foreground">
                <input
                  type="checkbox"
                  checked={r.keepOut}
                  onChange={(e) => set(r.documentId, { keepOut: e.target.checked })}
                  className="h-4 w-4 rounded border-border-strong accent-[var(--primary)]"
                />
                Keep out of AI
              </label>
            </li>
          ))}
        </ul>
      )}

      {progress && <p className="mt-3 font-sans text-[12.5px] text-foreground" aria-live="polite">{progress}</p>}
      {error && <p className="mt-2 font-sans text-[12px] text-danger">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        {rows.length > 0 ? (
          <>
            <Button onClick={onClose}>Not now</Button>
            <Button variant="primary" disabled={sending || confirmPayload(rows).length === 0} onClick={() => void looksRight()}>
              {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Looks right
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>Close</Button>
        )}
      </div>
    </div>
  );
}
```

If `Badge`'s `text` and `bg` props take hex strings rather than CSS variables, use the warning tint pair already used by `PARSE_TONE` in `components/dashboard/FolderBrowser.tsx`. Check `Badge` in `components/dashboard/DashboardUI.tsx:262` first.

- [ ] **Step 4: Checks**

Run: `npm run typecheck && npm run lint`
Expected: PASS. The UI tests pass once Task 4 mounts the list.

- [ ] **Step 5: Commit**

```bash
git add components/files/TypeList.tsx lib/useExtractionProgress.ts e2e/auth/google-drive.spec.ts
git commit -m "Type list: server guesses pre-filled, one Looks right, Please check, kept-out sensitive guesses, extraction progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mount Drive picking on the Files page (`FolderBrowser`) and in `RemoteFilePicker`

`StudentFiles`' default export is not mounted anywhere on `main` (checked 10/15: only its named exports `uploadStudentDocument` and `kindFromFilename` are imported). The live counselor Files page is `app/dashboard/counselor/data-hub/page.tsx` → `components/dashboard/FolderBrowser.tsx`. Spec §4.2's entry "next to the drop zone in StudentFiles" therefore lives in `FolderBrowser` when a student folder is open. `StudentFiles` only needs to keep compiling.

**Files:**
- Modify: `components/dashboard/FolderBrowser.tsx` (toolbar ~655–682, document rows ~704–760, the student folder list items)
- Modify: `components/files/RemoteFilePicker.tsx` (Google branch)
- Modify: `components/dashboard/StudentFiles.tsx:435-446` (stop passing `kindFor` for Google)
- Test: `e2e/auth/google-drive.spec.ts` (the Task 2 and 3 specs now run); append a "Categorize" test

**Interfaces:**
- Consumes: `GoogleDrivePicker` (Task 2), `TypeList` (Task 3), `StoredDocument.kindConfirmed`.
- Produces:
  - `data-folder-kind={folder.kind}` on each folder button in the left pane (tests select by it).
  - `RemoteFilePicker` gains `kind?: DocumentKind` (fixed kind for the Google branch) and `onImportedMany?(docs)`.

- [ ] **Step 1: Write the failing "Categorize" test** (append to the "type list" describe)

```ts
  test("unconfirmed files carry Not categorized and Categorize N files opens the same list", async ({ page }) => {
    test.skip(!(await openStudentFolder(page)), "No student folder for this counselor");
    const folderId = await page.locator('[data-folder-kind="student"]').first().getAttribute("data-folder-id");
    await page.route("**/files/documents", (r) =>
      r.request().method() === "GET"
        ? r.fulfill({ contentType: "application/json", body: JSON.stringify([storedDoc({ folderId, filename: "Old.pdf" }), storedDoc({ folderId, filename: "Older.pdf" })]) })
        : r.fallback()
    );
    await page.reload();
    await page.locator(`[data-folder-id="${folderId}"]`).click();
    await expect(page.getByText("Not categorized")).toHaveCount(2);
    await page.getByRole("button", { name: "Categorize 2 files" }).click();
    await expect(page.getByRole("dialog", { name: /what are these files/i }).getByText("Old.pdf")).toBeVisible();
  });
```

Run: `npx playwright test e2e/auth/google-drive.spec.ts --project=signed-in`
Expected: FAIL. There is no `data-folder-kind`, no **Google Drive** button and no list.

- [ ] **Step 2: `FolderBrowser`: folder markers, Drive button, type list, Not categorized**

On the element that renders each folder in the left pane (the `studentFolders.map` and `ownFolders.map` buttons), add `data-folder-kind={f.kind}` and `data-folder-id={f.id}`. Then add state beside `staged`:

```tsx
  const [typing, setTyping] = useState<StoredDocument[] | null>(null);
```

Add the imports:

```tsx
import GoogleDrivePicker from "@/components/files/GoogleDrivePicker";
import TypeList from "@/components/files/TypeList";
```

After `folderDocuments`, add:

```tsx
  const uncategorized = folderDocuments.filter((d) => d.kindConfirmed === false);
```

In the toolbar's button group (before the **Choose files** `Button`), add:

```tsx
                {active?.kind === "student" && active.studentId && (
                  <GoogleDrivePicker
                    token={token}
                    studentId={active.studentId}
                    folderId={active.id}
                    onImported={(docs) => {
                      setDocuments((d) => [...docs, ...d.filter((x) => !docs.some((n) => n.id === x.id))]);
                      const needTypes = docs.filter((d) => d.kindConfirmed === false);
                      if (needTypes.length > 0) setTyping(needTypes);
                      onToast?.(`${docs.length === 1 ? docs[0].filename : `${docs.length} files`} filed from Google Drive.`);
                    }}
                  />
                )}
                {uncategorized.length > 0 && (
                  <Button size="sm" onClick={() => setTyping(uncategorized)}>
                    Categorize {uncategorized.length} {uncategorized.length === 1 ? "file" : "files"}
                  </Button>
                )}
```

In each document row's meta line, after `{formatDate(doc.createdAt)}`, add:

```tsx
                          {doc.kindConfirmed === false && (
                            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 font-medium text-foreground">Not categorized</span>
                          )}
```

At the end of the component's JSX (next to the existing staging popup), add:

```tsx
      <Modal open={typing !== null} onClose={() => setTyping(null)} title="What are these files?" size="lg">
        {typing && (
          <TypeList
            token={token}
            docs={typing}
            onConfirmed={(confirmed) =>
              setDocuments((list) => list.map((d) => confirmed.find((c) => c.id === d.id) ?? d))
            }
            onClose={() => setTyping(null)}
          />
        )}
      </Modal>
```

Import `Modal` from `@/components/dashboard/DashboardUI` if it isn't already imported. If `Modal`'s prop is `width` rather than `size` in this file's existing usage, use the same prop the staging popup uses.

- [ ] **Step 3: `RemoteFilePicker`: the Google branch**

Add the props `kind?: DocumentKind` and `onImportedMany?: (docs: StoredDocument[]) => void`. Then, just before the final `return (` of the connected state, add:

```tsx
  if (provider === "google") {
    return (
      <div className="mt-3 rounded-xl border border-border p-3">
        <GoogleDrivePicker
          token={token}
          studentId={studentId}
          folderId={folderId ?? null}
          kind={kind}
          label="Pick from Google Drive"
          onImported={(docs) => {
            docs.forEach(onImported);
            onImportedMany?.(docs);
          }}
        />
        {files && files.length > 0 && (
          <>
            <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Recently added from Drive
            </p>
            <ul className="mt-1 max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {files.map((file) => (
                <li key={file.id} className="flex items-center gap-3 px-3 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="min-w-0 flex-1 truncate font-sans text-[13px] text-foreground">{file.name}</p>
                  <Button size="sm" disabled={!file.importable || importing !== null || !token} onClick={() => void importFile(file)}>
                    {importing === file.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {`File to ${studentFirstName}`}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <p className="mt-2 font-sans text-[12px] text-danger">{error}</p>}
      </div>
    );
  }
```

In `importFile`, for Google send the fixed `kind` (or none) and leave `availableToLlm` to the server:

```tsx
        kind: provider === "google" ? kind : kindFor?.(file.name),
        ...(provider === "google" ? {} : { availableToLlm: readable }),
```

`listRemoteFiles` for Google now returns only files the app can already reach (spec §4.3), so the existing list call is the "Recently added" list. Import `GoogleDrivePicker`.

- [ ] **Step 4: `StudentFiles`: no filename guess for Google**

At `components/dashboard/StudentFiles.tsx:441`, change `kindFor={kindFromFilename}` to `kindFor={source === "microsoft" ? kindFromFilename : undefined}`. Nothing mounts this component today; the change keeps it consistent with spec §4.2 step 7.

- [ ] **Step 5: Run the checks and the Drive spec**

Run:

```bash
npm run typecheck && npm run lint
npx playwright test e2e/auth/google-drive.spec.ts --project=signed-in
```

Expected: PASS, or skipped when the E2E counselor isn't set.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/FolderBrowser.tsx components/files/RemoteFilePicker.tsx components/dashboard/StudentFiles.tsx e2e/auth/google-drive.spec.ts
git commit -m "Files: Google Drive picking in student folders, the type list after a pick, Categorize N files, Not categorized tags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Essays: Pick a Google Doc

**Files:**
- Modify: `components/student/EssaysPanel.tsx` (state ~297, `edited` ~476–505, row menu ~585–610, picker modal ~625–645, sync effect ~308–318)
- Test: create `e2e/auth/essay-doc.spec.ts`

**Interfaces:**
- Consumes: `GoogleDrivePicker` in `mode="doc"` (Task 2), `isGoogleDocUrl` (Task 1), `syncEssayDocsAction` returning `notPicked`.
- Produces: the row menu item "Pick a Google Doc" (counselor viewer). The paste field stays, labelled "Paste a link". A row shows "Pick this Doc to keep it in sync" when its id is in `notPicked` or its pasted URL is a Google Doc that didn't sync.

- [ ] **Step 1: Write the failing spec** (`e2e/auth/essay-doc.spec.ts`)

```ts
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP, signedInAs } from "../helpers";
import { stubGoogle, stubPickerConfig } from "../googleStubs";

/** Linking an essay to a Google Doc by picking it. Google and the essay save are stubbed. */
signedInAs("counselor");

let studentId: string | null = process.env.E2E_STUDENT_ID ?? null;
async function findStudent(page: Page): Promise<string | null> {
  if (studentId) return studentId;
  await page.goto("/dashboard/counselor");
  await page.waitForLoadState("networkidle");
  const hrefs = await page.locator('a[href^="/dashboard/counselor/students/"]').evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
  studentId = hrefs.map((h) => h.match(/^\/dashboard\/counselor\/students\/([0-9a-f-]{36})(?:[/?#]|$)/)?.[1]).find(Boolean) ?? null;
  return studentId;
}

test("Pick a Google Doc saves the picked Doc's link and re-syncs", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const url = "https://docs.google.com/document/d/doc-abc12345/edit";
  await stubGoogle(page, { picks: [{ id: "doc-abc12345", name: "Why us", mimeType: "application/vnd.google-apps.document", url }] });
  await stubPickerConfig(page);
  const id = await findStudent(page);
  test.skip(!id, "No student on this counselor's roster (set E2E_STUDENT_ID)");
  await page.goto(`/dashboard/counselor/students/${id}/application`);
  await page.waitForLoadState("networkidle");
  const more = page.getByRole("button", { name: /More actions for/ }).first();
  test.skip((await more.count()) === 0, "No essay rows for this student");
  await more.click();
  await page.getByRole("menuitem", { name: "Pick a Google Doc" }).click();
  const g = await page.evaluate(() => (window as unknown as { __g: { views: string[]; picker: string[] } }).__g);
  expect(g.views).toContain("mime:application/vnd.google-apps.document");
  expect(g.picker).not.toContain("feature:multiselect");
});
```

The save itself goes through `updateEssayDocAction`, a Server Action that can't be stubbed. This spec asserts the Picker request only, and the save is checked by hand in Step 4. The `notPicked` prompt is checked by the pure helper plus a manual step.

Run: `npx playwright test e2e/auth/essay-doc.spec.ts --project=signed-in`
Expected: FAIL. There is no "Pick a Google Doc" item.

- [ ] **Step 2: Implement it in `EssaysPanel`**

Add state:

```tsx
  const [pickingDoc, setPickingDoc] = useState<EssayDoc | null>(null);
  const [notPicked, setNotPicked] = useState<string[]>([]);
```

In the sync effect and after the sync inside `edited`, keep the not-picked list:

```tsx
    void syncEssayDocsAction(studentId).then((res) => {
      if (!live || !res.ok) return;
      setNotPicked(res.data.notPicked ?? []);
      if (res.data.updated > 0) setEssays(res.data.essays);
    });
```

```tsx
    const sync = await syncEssayDocsAction(studentId);
    if (sync.ok) {
      setEssays(sync.data.essays);
      setNotPicked(sync.data.notPicked ?? []);
      if (isGoogleDocUrl(next) && (sync.data.notPicked ?? []).includes(doc.id)) onToast("Pick this Doc to keep it in sync");
    }
```

Add a handler:

```tsx
  async function linkPicked(doc: EssayDoc, url: string) {
    setPickingDoc(null);
    const res = await updateEssayDocAction(doc.id, { externalUrl: url });
    if (!res.ok) {
      onToast(res.message);
      return;
    }
    setEssays((rows) => rows.map((r) => (r.id === doc.id ? res.data : r)));
    const sync = await syncEssayDocsAction(studentId);
    if (sync.ok) {
      setEssays(sync.data.essays);
      setNotPicked(sync.data.notPicked ?? []);
    }
    onToast(`${doc.title} is linked to its Google Doc.`);
  }
```

In the row menu's items, replace the single link entry with:

```tsx
              ...(!rowMenu.doc.file && !rowMenu.doc.supplementDocId && !self
                ? [{ key: "pick", label: "Pick a Google Doc", icon: Link2 }]
                : []),
              ...(!rowMenu.doc.file && !rowMenu.doc.supplementDocId
                ? [{ key: "link", label: rowMenu.doc.url ? "Change link" : "Paste a link", icon: Link2 }]
                : []),
```

In the click handler, add `else if (item.key === "pick") setPickingDoc(doc);` before the `link` branch.

Under each row whose id is in `notPicked`, render a one-line prompt. In the list that maps `EssayRow`s, wrap each row:

```tsx
                {notPicked.includes(doc.id) && !self && (
                  <li className="px-1 pb-2">
                    <button type="button" onClick={() => setPickingDoc(doc)} className="font-sans text-[12px] font-medium text-primary hover:text-primary-hover">
                      Pick this Doc to keep it in sync
                    </button>
                  </li>
                )}
```

Next to the existing Drive `Modal`, add the Doc picker modal:

```tsx
      <Modal open={pickingDoc !== null} onClose={() => setPickingDoc(null)} title="Pick the essay's Google Doc" size="lg">
        {pickingDoc && (
          <GoogleDrivePicker
            token={token}
            studentId={studentId}
            mode="doc"
            label="Pick a Google Doc"
            onPickedDoc={(file) => void linkPicked(pickingDoc, file.url)}
          />
        )}
      </Modal>
```

For the existing Drive modal, pass `kind="essay"` to `RemoteFilePicker` (in place of `kindFor={() => "essay"}`), so Essays picks skip the type list (spec §4.4).

Import `GoogleDrivePicker` and `isGoogleDocUrl`.

- [ ] **Step 3: Checks**

Run:

```bash
npm run typecheck && npm run lint
npx playwright test e2e/auth/essay-doc.spec.ts --project=signed-in
```

Expected: PASS, or skipped.

- [ ] **Step 4: Manual check on the local stack** (record the result in the PR body)

1. Pick a Doc through the menu.
2. Confirm the essay's word count fills in after the sync.
3. Paste a Doc URL that was never picked, and confirm "Pick this Doc to keep it in sync" appears under the row.

- [ ] **Step 5: Commit**

```bash
git add components/student/EssaysPanel.tsx e2e/auth/essay-doc.spec.ts
git commit -m "Essays: link a Google Doc by picking it; unpicked Doc links ask to be picked to keep syncing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Connections card, Meet links, and "Google disconnected" on tasks

**Files:**
- Modify: `components/files/IntegrationsPanel.tsx` (`SUITE_SCOPE_LABELS` 70–86, Google `CATALOG` entry 108–123, `signIn` 270–285, the suite card body ~445–470)
- Modify: `app/dashboard/counselor/data-hub/callback/[provider]/page.tsx` (failure text)
- Modify: `components/dashboard/MeetingModal.tsx` (providers effect 132–149, `canCreateConference` 211, the not-connected copy ~488–492, `submit` catch)
- Modify: `components/calendar/MeetingBooker.tsx` (providers effect 190–203, `canConference` 214, `confirm` 220–243)
- Modify: `components/dashboard/StudentTaskList.tsx` (props 118–139, task card ~360) and `app/dashboard/counselor/calendar/page.tsx:669`
- Test: create `e2e/auth/google-connections.spec.ts`

**Interfaces:**
- Consumes: `canAddMeet`, `driveLinkedCount`, `googleNeedsReconnect` (Task 1); `IntegrationProviderInfo.calendarEnabled`; `startIntegrationConnectAction(provider, "calendar")`.
- Produces: `StudentTaskList` gains the prop `googleReconnect?: boolean`.

- [ ] **Step 1: Write the failing spec** (`e2e/auth/google-connections.spec.ts`)

```ts
import { expect, test } from "@playwright/test";
import { DESKTOP, signedInAs } from "../helpers";

/** Connections and meetings with the providers answer stubbed (the browser reads it directly). */
signedInAs("counselor");

const provider = (over: Record<string, unknown>) => ({
  provider: "google", available: true, unavailableReason: null, tokensHeld: true,
  accountEmail: "counselor@example.com", connectedAt: new Date().toISOString(),
  calendarEnabled: false, driveGranted: true, ...over,
});

test("the Google card says files you pick, no Gmail, and offers Calendar", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.route("**/integrations/providers", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify([provider({}), provider({ provider: "microsoft", tokensHeld: false })]) }));
  await page.route("**/integrations", (r) => r.request().method() === "GET"
    ? r.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: "g", provider: "google", status: "connected", scopes: ["openid", "https://www.googleapis.com/auth/drive.file"], lastSyncedAt: null, lastError: null, updatedAt: null }]) })
    : r.fallback());
  await page.goto("/dashboard/counselor/data-hub#apps");
  await expect(page.getByText("Files you pick from Drive, and Calendar if you turn it on")).toBeVisible();
  await expect(page.getByText("Drive: files you pick")).toBeVisible();
  await expect(page.getByText(/Gmail/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Turn on Google Calendar" })).toBeVisible();
});

test("Calendar shows On only when the grant has it", async ({ page }) => {
  await page.route("**/integrations/providers", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify([provider({ calendarEnabled: true })]) }));
  await page.route("**/integrations", (r) => r.request().method() === "GET"
    ? r.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: "g", provider: "google", status: "connected", scopes: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/calendar.events"], lastSyncedAt: null, lastError: null, updatedAt: null }]) })
    : r.fallback());
  await page.goto("/dashboard/counselor/data-hub#apps");
  await expect(page.getByText("Google Calendar: On")).toBeVisible();
});

test("the meeting form offers Turn on Google Calendar instead of a Meet link while Calendar is off", async ({ page }) => {
  await page.route("**/integrations/providers", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify([provider({ calendarEnabled: false })]) }));
  await page.goto("/dashboard/counselor/calendar");
  await page.getByRole("button", { name: /new meeting|add meeting/i }).first().click();
  await expect(page.getByText("Turn on Google Calendar to add Meet links")).toBeVisible();
  await expect(page.getByLabel(/Create the Meet link/)).toHaveCount(0);
});
```

Run: `npx playwright test e2e/auth/google-connections.spec.ts --project=signed-in`
Expected: FAIL.

The calendar page's "new meeting" button name must be checked against `app/dashboard/counselor/calendar/page.tsx` before running. Use the button that opens `MeetingModal` (line ~462), and fix the regex to its real label.

- [ ] **Step 2: `IntegrationsPanel`**

Replace the Google `CATALOG` entry:

```tsx
  {
    provider: "google",
    name: "Google",
    suite: true,
    icon: HardDrive,
    description: "Files you pick from Drive, and Calendar if you turn it on",
    covers: ["Files you pick from Drive", "Docs, Sheets, Slides you pick", "Calendar (when you turn it on)"],
    scopes: [],
  },
```

In `SUITE_SCOPE_LABELS`:
- delete the `"drive.readonly"` and `"gmail.send"` entries;
- add `"drive.file": "Drive: files you pick"`;
- change `"calendar.events"` to `"Create and change the events you schedule through Meridies, with Meet links"`.

Change `signIn` to take `add?: "calendar"`. Pass it to `startIntegrationConnectAction(entry.provider, add)`, and before `window.location.assign` record it:

```tsx
      try {
        if (add) sessionStorage.setItem("meridies.pendingAdd", add);
      } catch {
        // Private mode: the "wasn't allowed" note is a convenience.
      }
```

In the suite card body, for `entry.provider === "google"` with `suite?.tokensHeld`, render under "Signed in as":

```tsx
                    {entry.provider === "google" && suite?.tokensHeld && (
                      suite.calendarEnabled ? (
                        <p className="mt-2 text-[12px] text-foreground">Google Calendar: On</p>
                      ) : (
                        <div className="mt-2">
                          <Button size="sm" onClick={() => void signIn(entry, "calendar")} disabled={working}>
                            Turn on Google Calendar
                          </Button>
                          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
                            To turn Calendar off later, disconnect Google: Google removes access as a whole.
                          </p>
                        </div>
                      )
                    )}
```

Where the panel reads `/integrations/providers` after a return (`?integration=google&result=connected`), check the pending add once:

```tsx
    let pendingAdd: string | null = null;
    try {
      pendingAdd = sessionStorage.getItem("meridies.pendingAdd");
      sessionStorage.removeItem("meridies.pendingAdd");
    } catch {
      pendingAdd = null;
    }
    const google = list.find((p) => p.provider === "google");
    if (pendingAdd === "calendar" && google && !google.calendarEnabled) {
      setActionError("Calendar wasn't allowed. Turn it on again and leave Calendar ticked.");
    }
```

- [ ] **Step 3: The callback page shows the backend's sentence**

In `app/dashboard/counselor/data-hub/callback/[provider]/page.tsx`, the failure branch already calls `setFailure(result.message)`. Make sure the failure card renders `failure` verbatim, and offers a "Back to Connected apps" link to `/dashboard/counselor/data-hub#apps`. That way the `google_other_account` sentence ("You signed in as …") and the `google_reconnect` sentence reach the counselor unchanged. If the card already renders `failure`, nothing changes here. Record that in the commit.

- [ ] **Step 4: `MeetingModal` and `MeetingBooker`**

`MeetingModal`: keep the providers list, not just a set:

```tsx
  const [providers, setProviders] = useState<IntegrationProviderInfo[]>([]);
  // in the effect, after reading `list`:
        setProviders(list);
        const google = list.find((p) => p.provider === "google") ?? null;
        if (!meeting) setCreateConference(canAddMeet("google", google));
```

Replace `canCreateConference`:

```tsx
  const suiteInfo = suite ? providers.find((p) => p.provider === suite) ?? null : null;
  const canCreateConference = Boolean(suite && canAddMeet(suite, suiteInfo)) && !onCalendar;
```

Keep `connected` derived for the Teams mode filter: `const connected = useMemo(() => new Set(providers.filter((p) => p.tokensHeld).map((p) => p.provider)), [providers]);`. Remove the old `connected` state. Replace the "Connect … under Files" copy branch:

```tsx
            ) : suite === "google" && suiteInfo?.tokensHeld ? (
              <p className="text-[12px] leading-snug text-muted-foreground">
                Turn on Google Calendar to add Meet links.{" "}
                <Link href="/dashboard/counselor/data-hub#apps" className="font-medium text-primary hover:text-primary-hover">
                  Turn on Google Calendar
                </Link>
              </p>
            ) : (
```

In `submit`, the existing `catch` sets `error` and leaves every field as typed. Add the coded case at the top of the `catch` body:

```tsx
      if (err instanceof ApiError && err.code === "calendar_not_enabled") {
        setCreateConference(false);
        setError("Turn on Google Calendar to add Meet links. Your meeting details are still here.");
        return;
      }
```

Make sure nothing in the `catch` resets title, date, times, agenda or attendees.

`MeetingBooker`: the same providers list, `canConference = suite !== null && canAddMeet(suite, providers.find((p) => p.provider === suite) ?? null)`, and in `confirm` when `result.code === "calendar_not_enabled"` (check `ActionResult`'s shape for `code`; if it carries only `message`, match the message) set `setConference(false)` and keep the form. When Google is connected but Calendar is off, show the same "Turn on Google Calendar to add Meet links." line.

- [ ] **Step 5: "Google disconnected" on tasks**

In `StudentTaskList`, add the prop `googleReconnect = false` (`googleReconnect?: boolean`, documented "Google needs reconnecting: tasks with Drive-linked files say so"). After the tracker note in the task card:

```tsx
                                {googleReconnect && driveLinkedCount(task) > 0 && (
                                  <p className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] leading-snug text-danger">
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                    Google disconnected: can&apos;t see edits to {driveLinkedCount(task)} files
                                    <Link href="/dashboard/counselor/data-hub#apps" className="font-medium text-primary hover:text-primary-hover">
                                      Reconnect
                                    </Link>
                                  </p>
                                )}
```

In `app/dashboard/counselor/calendar/page.tsx`, read the providers and the grant beside the tasks fetch:

```tsx
  const [googleReconnect, setGoogleReconnect] = useState(false);
  useEffect(() => {
    if (!token) return;
    void Promise.all([getIntegrationProviders(token), getIntegrations(token)])
      .then(([providers, grants]) => {
        const info = providers.find((p) => p.provider === "google") ?? null;
        const grant = grants.find((g) => g.provider === "google") ?? null;
        setGoogleReconnect(Boolean(grant) && googleNeedsReconnect(info, grant?.status ?? null));
      })
      .catch(() => setGoogleReconnect(false));
  }, [token]);
```

Pass `googleReconnect={googleReconnect}` to `<StudentTaskList …/>` at line 669.

- [ ] **Step 6: Checks**

Run:

```bash
npm run typecheck && npm run lint
npx playwright test e2e/pure.spec.ts --project=public
npx playwright test e2e/auth/google-connections.spec.ts --project=signed-in
```

Expected: PASS, or skipped.

- [ ] **Step 7: Commit**

```bash
git add components/files/IntegrationsPanel.tsx "app/dashboard/counselor/data-hub/callback/[provider]/page.tsx" components/dashboard/MeetingModal.tsx components/calendar/MeetingBooker.tsx components/dashboard/StudentTaskList.tsx app/dashboard/counselor/calendar/page.tsx e2e/auth/google-connections.spec.ts
git commit -m "Connections: files you pick, Calendar switch; Meet only with Calendar on; tasks say when Google is disconnected

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: AGENTS.md, full verification, PR

**Files:**
- Modify: `AGENTS.md` (connected apps / files sections; the E2E list gains the three new specs)

- [ ] **Step 1: Update `AGENTS.md`**

In the connected apps section, replace the Google description with:

> **Google is picked files only (drive.file).** Counselors pick files with Google's Picker (`components/files/GoogleDrivePicker.tsx`, `lib/googlePicker.ts`). The browser asks Google for its own token with `drive.file` only and `include_granted_scopes: false`, keeps it in memory, never sends it to the API, and sets `setAppId(appId)` so picked files are granted to our OAuth client. Settings come from `GET /integrations/google/picker-config`; there are no Vercel variables. The Picker runs only on `app.meridiesai.com` and `localhost`; preview builds say so. Calendar is a separate switch (`authorize?add=calendar`), shown On only when `calendarEnabled`. Meet links are offered only then.
>
> **Picked files arrive unconfirmed.** The server guesses each type without AI. `components/files/TypeList.tsx` shows one list with the guesses, "Please check" on guesses not read from the text, and Financial / IEP-504 kept out of AI. One **Looks right** sends `POST /files/documents/confirm-types`. After confirming, the server extracts text two files at a time; the list polls `GET /files/documents/extraction-status` every 2 s and shows "Reading k of n…", with no client timeout. Essays picks send `kind: "essay"` and skip the list. Essays link a Google Doc by picking it (**Pick a Google Doc**). The Files page (`FolderBrowser`) is where Drive picking lives for student folders; `StudentFiles`' default export is not mounted.
>
> New Google code calls the API from the browser (`lib/api.ts`), not through Server Actions, so `e2e/auth/google-drive.spec.ts`, `essay-doc.spec.ts` and `google-connections.spec.ts` can stub Google and the API with `page.route` (`e2e/googleStubs.ts`).

- [ ] **Step 2: Full verification**

Run:

```bash
npm run typecheck && npm run lint && npm run build
npx playwright test --project=public
npx playwright test e2e/auth/google-drive.spec.ts e2e/auth/essay-doc.spec.ts e2e/auth/google-connections.spec.ts --project=signed-in
```

Expected: every command passes. Signed-in specs pass, or skip with their reason when the E2E accounts aren't set; say which in the PR.

- [ ] **Step 3: Commit and open the PR (do not merge)**

```bash
git add AGENTS.md
git commit -m "AGENTS.md: Google picked files only, the type list and extraction progress, where Drive picking lives

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/google-drive-picker
gh pr create --repo MeridiesAI/meridies-app --base main --title "Google Drive: picked files only, one-list type confirmation, extraction progress, Calendar switch" --body-file - <<'EOF'
## What

Counselors pick files with Google's Picker (drive.file only). They confirm every picked file's type in one list (server guesses, one Looks right) and see text extraction progress ("Reading 3 of 10…"). Essays link a Google Doc by picking it. Connections offers Calendar separately; Meet links appear only with Calendar on; tasks say when Google is disconnected.

## Why

Spec: meridies-backend `docs/superpowers/specs/2026-10-14-google-connector-design.md` rev 5 (PR #55). Meridies stops asking for access to a counselor's whole Drive.

**Ships after the backend PR is live** (it calls `picker-config`, `confirm-types`, `extraction-status` and the new fields).

## Repos affected

- [x] meridies-app
- [ ] meridies-backend (its PR ships first)

## How I tested

- typecheck, lint, build
- `e2e/pure.spec.ts`: the type-list rules, progress text, Meet gating, disconnected count, preview hosts
- Signed-in specs with Google and the API stubbed: google-drive, essay-doc, google-connections (results / skips listed below)
- Manual: Pick a Google Doc word count; an unpicked Doc link asks to be picked

## Notes

- Drive picking lives on the Files page (`FolderBrowser`, student folders). `StudentFiles`' default export isn't mounted on main.
- Railway's `GOOGLE_*` variables go on only after this PR is live (spec §9).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Self-review (done while writing)

- **Spec coverage:**
  - §4.2 steps 1–9 → Tasks 2 and 4. Step 5's same-account check is in Task 2, the shared-drives view in Task 2, step 7's "no kind from file picks" in Task 4, step 8's type list in Tasks 3 and 4.
  - §4.4: GoogleDrivePicker → Task 2; type list and Categorize → Tasks 3 and 4; Essays → Task 5; RemoteFilePicker → Task 4; Connections → Task 6; Meet → Task 6; Tracker → Task 6 (task-card line); `lib/api.ts` → Task 1; preview builds → Tasks 1 and 2.
  - §6 rows: not set up (503) → Task 2 test; popup blocked → Task 2; same account → Task 2; unavailable → Task 2; type list closed → Task 3 "Not now"; Calendar not on → Task 6; disconnected → Task 6; preview → Task 1.
  - The 10/15 conditions: "Please check" on filename-only guesses (Task 1 and 3 tests).
  - The progress addition: Task 1 pure text and Task 3 polling test.
- **Placeholder scan:** two steps tell the executor to read one thing before editing: `Badge`'s prop shape (Task 3) and the calendar page's new-meeting button label (Task 6). Both name the exact file and line and the exact choice to make. Nothing is left as TBD.
- **Type consistency:**
  - `KindGuess`, `StoredDocument.kindConfirmed`, `ConfirmTypeItem` / `ConfirmTypeResult` and `ExtractionState` are defined in Task 1 and used unchanged in Tasks 2–6.
  - `TypeRow` is defined in `lib/googleDrive.ts` and used by `TypeList`.
  - `PickedFile` is defined in `lib/googlePicker.ts` and used by `GoogleDrivePicker` and `EssaysPanel`.
- **Review Focus:** each of the five items has its test in Task 2 or 3.
