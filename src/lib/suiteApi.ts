/**
 * The Drive / OneDrive and Calendar calls the connected suites are used for.
 *
 * Every request here goes to a fixed provider host (googleapis.com,
 * graph.microsoft.com) with an id the provider itself issued — never to an
 * address a user chose — so this is not the SSRF surface lib/links.ts guards.
 * Ids are still pattern-checked and path-encoded before they reach a URL.
 *
 * Tokens come from lib/oauth.ts; a 401 gets one forced refresh and a retry.
 */

import { randomUUID } from "node:crypto";
import { badRequest, conflict, HttpError, unavailable } from "./errors.js";
import { wallTimeToInstant, type BusyInterval } from "./bookingSlots.js";
import { detectContentType } from "./fileSniff.js";
import { enforceRateLimit } from "./limits.js";
import {
  accessTokenFor,
  GOOGLE_SCOPE,
  MICROSOFT_SCOPE,
  MSA_TENANT_ID,
  ONEDRIVE_UNSUPPORTED,
  providerLabel,
  requireScope,
  WORK_ONEDRIVE_ORIGIN,
  type LiveToken,
  type PickerTarget,
  type SuiteProvider,
} from "./oauth.js";

const HTTP_TIMEOUT_MS = 20_000;
/** Largest file an import will copy into Storage. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** drive.file: only files the counselor picked in Google Picker, or files this app created. */
export const GOOGLE_FILE_SCOPE = GOOGLE_SCOPE.driveFile;
export const GOOGLE_CALENDAR_SCOPE = GOOGLE_SCOPE.calendarEvents;
const GOOGLE_FILES = { name: GOOGLE_FILE_SCOPE, what: "reading the files you picked", code: "drive_not_granted" };
const GOOGLE_CALENDAR = { name: GOOGLE_CALENDAR_SCOPE, what: "writing to Calendar", code: "calendar_not_enabled" };
const MS_FILES_SCOPE = MICROSOFT_SCOPE.files;
const MS_CALENDAR_SCOPE = MICROSOFT_SCOPE.calendar;
const MS_FILES = { name: MS_FILES_SCOPE, what: "reading OneDrive", code: "files_not_granted" };

const GOOGLE_ID = /^[A-Za-z0-9_-]{5,300}$/;
// Not "." or "..": encodeURIComponent keeps dots, and URL parsing would resolve them as path segments.
const GRAPH_ID = /^(?!\.{1,2}$)[A-Za-z0-9!_.=-]{1,300}$/;

export function assertFileId(provider: SuiteProvider, id: string, driveId?: string | null) {
  const re = provider === "google" ? GOOGLE_ID : GRAPH_ID;
  if (!re.test(id)) throw badRequest("That file id isn't valid");
  if (driveId != null && !GRAPH_ID.test(driveId)) throw badRequest("That drive id isn't valid");
}

type Log = { warn: (obj: object, msg: string) => void };

/** Longest Retry-After a request waits out before giving up with 429. */
const MAX_RETRY_WAIT_MS = 10_000;
const RATE_LIMIT_RETRIES = 2;

/**
 * Milliseconds a 429's Retry-After asks for (seconds or an HTTP date), or null
 * when absent or unreadable. `now` is injectable for tests.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const v = header.trim();
  if (/^\d{1,6}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** The wait before retry `attempt` (0-based): Retry-After when given, else 1s, 2s, ... */
export function backoffMs(attempt: number, retryAfter: number | null): number {
  return retryAfter ?? 1000 * 2 ** attempt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const __sleep = { fn: sleep };

/**
 * A fetch that fails (DNS, reset, timeout) never carries its URL into an error
 * or a log line: a Graph search URL holds the counselor's search words.
 */
async function quietFetch(provider: SuiteProvider, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw unavailable(`${providerLabel(provider)} didn't answer. Try again shortly.`);
  }
}

/**
 * Authorized fetch against a provider API, with one refresh-and-retry on 401.
 * A 429 is waited out per Retry-After (at most `RATE_LIMIT_RETRIES` times,
 * each wait at most `MAX_RETRY_WAIT_MS`); past that the 429 is returned.
 */
async function call(
  ownerId: string,
  provider: SuiteProvider,
  url: string,
  init: RequestInit,
  scope: { name: string; what: string; code?: string }
): Promise<{ res: Response; token: LiveToken }> {
  let token = await accessTokenFor(ownerId, provider);
  requireScope(token, provider, scope.name, scope.what, scope.code);

  const go = (t: LiveToken) =>
    quietFetch(provider, url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t.accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

  let res = await go(token);
  if (res.status === 401) {
    token = await accessTokenFor(ownerId, provider, { force: true });
    res = await go(token);
  }
  for (let attempt = 0; res.status === 429 && attempt < RATE_LIMIT_RETRIES; attempt++) {
    const wait = backoffMs(attempt, retryAfterMs(res.headers.get("retry-after")));
    if (wait > MAX_RETRY_WAIT_MS) break;
    await res.body?.cancel().catch(() => undefined);
    await __sleep.fn(wait);
    res = await go(token);
  }
  return { res, token };
}

/**
 * Under drive.file, Drive answers an unpicked file with 404 or with 403 (appNotAuthorizedToFile):
 * both mean "Meridies can't see that file", so a file read maps both to not_found.
 */
export function googleFileFailureCode(status: number): string | null {
  return status === 404 || status === 403 ? "not_found" : null;
}

const FILE_READS = new Set(["file", "file download"]);

/** Map a provider failure to something safe to show. Bodies are never echoed. */
export function providerFailure(provider: SuiteProvider, res: Response, log: Log, what: string): HttpError {
  log.warn({ provider, status: res.status, what }, "provider request failed");
  const label = providerLabel(provider);
  const unpicked = provider === "google" && res.status === 403 && FILE_READS.has(what);
  if (res.status === 404 || unpicked) {
    return new HttpError(
      404,
      `${label} couldn't find that ${what}, or it isn't shared with you.`,
      "not_found"
    );
  }
  if (res.status === 403) return conflict(`${label} refused access to that ${what}.`);
  if (res.status === 429) {
    return new HttpError(429, `${label} is rate-limiting requests — try again shortly.`, "provider_rate_limited");
  }
  return unavailable(`${label} didn't answer the ${what} request.`);
}

// ---- Files ------------------------------------------------------------------

export type RemoteFile = {
  id: string;
  driveId: string | null;
  name: string;
  mimeType: string | null;
  kind: "document" | "spreadsheet" | "presentation" | "pdf" | "other";
  modifiedAt: string | null;
  sizeBytes: number | null;
  webUrl: string | null;
  lastModifiedBy: string | null;
  /** Whether the last edit was made by the connected account itself. Null when the provider didn't say. */
  lastModifiedByOwner: boolean | null;
  importable: boolean;
};

/** Google-native types are exported, not downloaded. */
const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string; kind: RemoteFile["kind"] }> = {
  "application/vnd.google-apps.document": { mime: "application/pdf", ext: "pdf", kind: "document" },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
    kind: "spreadsheet",
  },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: "pdf", kind: "presentation" },
  "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: "pdf", kind: "other" },
};

function kindOf(name: string, mime: string | null): RemoteFile["kind"] {
  const m = (mime ?? "").toLowerCase();
  const n = name.toLowerCase();
  if (m.includes("wordprocessingml") || m === "application/msword" || /\.(docx?|odt|rtf)$/.test(n)) return "document";
  if (m.includes("spreadsheetml") || m.includes("ms-excel") || /\.(xlsx?|csv|ods)$/.test(n)) return "spreadsheet";
  if (m.includes("presentationml") || m.includes("ms-powerpoint") || /\.(pptx?|odp)$/.test(n)) return "presentation";
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  return "other";
}

type GoogleFile = {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  lastModifyingUser?: { displayName?: string; me?: boolean };
};

const GOOGLE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,lastModifyingUser(displayName,me)";

function fromGoogle(f: GoogleFile): RemoteFile {
  const exp = f.mimeType ? GOOGLE_EXPORTS[f.mimeType] : undefined;
  const native = (f.mimeType ?? "").startsWith("application/vnd.google-apps.");
  return {
    id: f.id,
    driveId: null,
    name: f.name,
    mimeType: f.mimeType ?? null,
    kind: exp?.kind ?? kindOf(f.name, f.mimeType ?? null),
    modifiedAt: f.modifiedTime ?? null,
    sizeBytes: f.size ? Number(f.size) : null,
    webUrl: f.webViewLink && f.webViewLink.startsWith("https://") ? f.webViewLink : null,
    lastModifiedBy: f.lastModifyingUser?.displayName ?? null,
    lastModifiedByOwner: typeof f.lastModifyingUser?.me === "boolean" ? f.lastModifyingUser.me : null,
    // Folders, forms, shortcuts and the like have nothing to copy.
    importable: native ? Boolean(exp) : true,
  };
}

type GraphItem = {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  package?: unknown;
  parentReference?: { driveId?: string };
  lastModifiedBy?: { user?: { id?: string; displayName?: string } };
  remoteItem?: GraphItem;
};

function fromGraph(item: GraphItem, accountId: string | null): RemoteFile | null {
  const it = item.remoteItem ? { ...item.remoteItem, name: item.remoteItem.name ?? item.name } : item;
  if (it.folder || it.package || !it.file) return null;
  const modifier = it.lastModifiedBy?.user;
  return {
    id: it.id,
    driveId: it.parentReference?.driveId ?? null,
    name: it.name,
    mimeType: it.file.mimeType ?? null,
    kind: kindOf(it.name, it.file.mimeType ?? null),
    modifiedAt: it.lastModifiedDateTime ?? null,
    sizeBytes: typeof it.size === "number" ? it.size : null,
    webUrl: it.webUrl && it.webUrl.startsWith("https://") ? it.webUrl : null,
    lastModifiedBy: modifier?.displayName ?? null,
    lastModifiedByOwner: modifier?.id && accountId ? modifier.id === accountId : null,
    importable: true,
  };
}

const GRAPH_SELECT =
  "id,name,size,webUrl,lastModifiedDateTime,file,folder,package,parentReference,lastModifiedBy,remoteItem";

/**
 * A OneDrive item, always in the counselor's own drive. `Files.Read` reaches
 * nothing else, so the client's drive id is never used to build the URL:
 * a file from someone else's drive simply isn't found there.
 */
function graphItemUrl(fileId: string): string {
  return `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}`;
}

export const SHARED_NOT_SUPPORTED =
  "This file is shared with you, so Meridies can't open it. Save a copy to your OneDrive, then pick the copy.";

/** What Microsoft's picker needs to know about the counselor's OneDrive. */
export type OneDriveInfo = { driveId: string; driveType: string; webUrl: string | null };

export async function oneDriveInfo(ownerId: string, log: Log): Promise<OneDriveInfo> {
  const { res } = await call(
    ownerId,
    "microsoft",
    "https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType,webUrl",
    {},
    MS_FILES
  );
  if (!res.ok) throw providerFailure("microsoft", res, log, "OneDrive");
  const body = (await res.json()) as { id?: unknown; driveType?: unknown; webUrl?: unknown };
  if (typeof body.id !== "string" || typeof body.driveType !== "string") {
    throw unavailable("OneDrive didn't say which drive is yours. Try again shortly.");
  }
  return { driveId: body.id, driveType: body.driveType, webUrl: typeof body.webUrl === "string" ? body.webUrl : null };
}

/**
 * Google Drive files the app can already reach, newest first; `q` filters by
 * name. Under drive.file, files.list returns only earlier picks and supplement
 * Docs: the app's "Recently added from Drive". OneDrive has no list here:
 * counselors choose OneDrive files in Microsoft's picker.
 */
export async function listGoogleFiles(ownerId: string, q: string | undefined, log: Log): Promise<RemoteFile[]> {
  const clauses = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"];
  if (q) clauses.push(`name contains '${q.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: "50",
    orderBy: "modifiedTime desc",
    fields: `files(${GOOGLE_FIELDS})`,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const { res } = await call(ownerId, "google", `https://www.googleapis.com/drive/v3/files?${params.toString()}`, {}, GOOGLE_FILES);
  if (!res.ok) throw providerFailure("google", res, log, "file list");
  const body = (await res.json()) as { files?: GoogleFile[] };
  return (body.files ?? []).map(fromGoogle);
}

/** Current metadata for one file — what the tracker reads for activity. */
export async function getRemoteFile(
  ownerId: string,
  provider: SuiteProvider,
  fileId: string,
  driveId: string | null,
  log: Log
): Promise<RemoteFile> {
  assertFileId(provider, fileId, driveId);
  if (provider === "google") {
    const { res } = await call(
      ownerId,
      provider,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(GOOGLE_FIELDS)}&supportsAllDrives=true`,
      {},
      GOOGLE_FILES
    );
    if (!res.ok) throw providerFailure(provider, res, log, "file");
    return fromGoogle((await res.json()) as GoogleFile);
  }
  const { res, token } = await call(ownerId, provider, `${graphItemUrl(fileId)}?$select=${GRAPH_SELECT}`, {}, MS_FILES);
  if (!res.ok) throw providerFailure(provider, res, log, "file");
  const file = fromGraph((await res.json()) as GraphItem, token.accountId);
  if (!file) throw badRequest("That item is a folder, not a file");
  return file;
}

/**
 * A file the counselor picked to import from OneDrive: it must be in their own
 * drive. Anything else (a file shared with them, a shortcut to one) answers
 * 422 `shared_not_supported` with the way round: save a copy and pick that.
 */
export async function getOwnOneDriveFile(ownerId: string, fileId: string, log: Log): Promise<RemoteFile> {
  assertFileId("microsoft", fileId, null);
  const { res, token } = await call(ownerId, "microsoft", `${graphItemUrl(fileId)}?$select=${GRAPH_SELECT}`, {}, MS_FILES);
  if (res.status === 403 || res.status === 404) {
    log.warn({ provider: "microsoft", status: res.status, what: "picked file" }, "picked file isn't in the counselor's own drive");
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(422, SHARED_NOT_SUPPORTED, "shared_not_supported");
  }
  if (!res.ok) throw providerFailure("microsoft", res, log, "file");
  const item = (await res.json()) as GraphItem;
  if (item.remoteItem) throw new HttpError(422, SHARED_NOT_SUPPORTED, "shared_not_supported");
  const file = fromGraph(item, token.accountId);
  if (!file) throw badRequest("That item is a folder, not a file");
  return file;
}

async function readCapped(res: Response, provider: SuiteProvider): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IMPORT_BYTES) throw badRequest("That file is larger than 25 MB");
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch {
      // The body stalled past HTTP_TIMEOUT_MS or the connection dropped mid-file.
      throw unavailable(`${providerLabel(provider)} stopped sending the file. Try again shortly.`);
    }
    const { done, value } = step;
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMPORT_BYTES) {
      await reader.cancel();
      throw badRequest("That file is larger than 25 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The bytes to store, plus the filename/type they should be stored under. */
export async function downloadRemoteFile(
  ownerId: string,
  provider: SuiteProvider,
  file: RemoteFile,
  log: Log
): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
  if (!file.importable) throw badRequest("That kind of file can't be imported");
  if (file.sizeBytes != null && file.sizeBytes > MAX_IMPORT_BYTES) {
    throw badRequest("That file is larger than 25 MB");
  }

  if (provider === "google") {
    const exp = file.mimeType ? GOOGLE_EXPORTS[file.mimeType] : undefined;
    const url = exp
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
    const { res } = await call(ownerId, provider, url, {}, GOOGLE_FILES);
    if (!res.ok) throw providerFailure(provider, res, log, "file download");
    const bytes = await readCapped(res, provider);
    if (exp) {
      // A Docs/Sheets/Slides export: Google rendered these bytes itself.
      const filename = file.name.toLowerCase().endsWith(`.${exp.ext}`) ? file.name : `${file.name}.${exp.ext}`;
      return { bytes, mimeType: exp.mime, filename };
    }
    // An uploaded file (PDF, Word, Excel, ...): its bytes are whatever was uploaded.
    return checkImportContent(provider, bytes, file.name, file.mimeType);
  }

  // Graph answers /content with a redirect to a short-lived pre-authenticated
  // download URL on Microsoft's own storage. The redirect is followed by hand
  // (followDownload): only to Microsoft download hosts, over HTTPS, at most
  // twice, and never with the Authorization header.
  const { res } = await call(
    ownerId,
    provider,
    `${graphItemUrl(file.id)}/content`,
    { redirect: "manual" },
    MS_FILES
  );
  const final = await followDownload(res);
  if (!final.ok) throw providerFailure(provider, final, log, "file download");
  const bytes = await readCapped(final, provider);
  return checkImportContent(provider, bytes, file.name, file.mimeType);
}

/**
 * Where a OneDrive / SharePoint download may be fetched from: the host itself
 * or a subdomain of it (a dot boundary, so `evil-sharepoint.com` is not
 * `sharepoint.com`). Commercial cloud only; sovereign clouds aren't supported. Personal
 * OneDrive serves its downloads from my.microsoftpersonalcontent.com.
 */
export const MICROSOFT_DOWNLOAD_HOSTS = ["sharepoint.com", "1drv.com", "livefilestore.com", "onedrive.live.com", "microsoftpersonalcontent.com"] as const;
export const MAX_DOWNLOAD_REDIRECTS = 2;

export function isMicrosoftDownloadUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host.endsWith(".")) return false;
  return MICROSOFT_DOWNLOAD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Follow a download's redirects by hand. `first` is Graph's answer to the
 * authorized request; every later request is plain (no Authorization), to an
 * allowed host, and there are at most `MAX_DOWNLOAD_REDIRECTS` of them.
 */
export async function followDownload(first: Response): Promise<Response> {
  let res = first;
  for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (hops >= MAX_DOWNLOAD_REDIRECTS) throw unavailable("OneDrive redirected the download too many times.");
    if (!location || !isMicrosoftDownloadUrl(location)) {
      throw unavailable("OneDrive sent the download somewhere Meridies doesn't fetch from.");
    }
    res = await quietFetch("microsoft", location, {
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }
  return res;
}

/**
 * The file's bytes must be what its name and type say (PDF, Word, Excel,
 * PowerPoint, images), and bytes that are one of those must not arrive under
 * another name. Returns what to store: the type, the name (its extension
 * corrected when the type was) and the bytes (UTF-16 text re-encoded as UTF-8,
 * which every reader downstream expects).
 */
export function checkImportContent(
  provider: SuiteProvider,
  bytes: Uint8Array,
  name: string,
  declaredMime: string | null
): { bytes: Buffer; mimeType: string; filename: string } {
  const verdict = detectContentType(bytes, name, declaredMime);
  if (!verdict.ok) {
    const where = provider === "google" ? "Google Drive" : "OneDrive";
    throw badRequest(`That file's contents don't match its type, so it wasn't imported. Open it in ${where}, save a fresh copy and try again.`);
  }
  const trimmed = name.trim();
  const filename = verdict.extension ? `${trimmed.slice(0, trimmed.lastIndexOf("."))}.${verdict.extension}` : name;
  return { bytes: utf16ToUtf8(bytes), mimeType: verdict.mimeType ?? declaredMime ?? "application/octet-stream", filename };
}

/** UTF-16 text (by its BOM) as UTF-8 bytes; anything else unchanged. */
function utf16ToUtf8(bytes: Uint8Array): Buffer {
  const le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const be = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!le && !be) return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return Buffer.from(new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes), "utf8");
}

/**
 * Plain text of a Google Doc, for `parsed_data.text` — the field the task
 * tracker compares against the assignment. Only called for documents left
 * available to AI. Null for anything that isn't a Google Doc: there is no
 * dependency-free way to read a .docx here, and a guess is worse than nothing.
 */
export async function exportGoogleDocText(
  ownerId: string,
  file: RemoteFile,
  log: Log
): Promise<string | null> {
  if (file.mimeType !== "application/vnd.google-apps.document") return null;
  const { res } = await call(
    ownerId,
    "google",
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text%2Fplain`,
    {},
    GOOGLE_FILES
  );
  if (!res.ok) {
    log.warn({ status: res.status }, "google doc text export failed");
    return null;
  }
  const bytes = await readCapped(res, "google");
  return bytes.toString("utf8").slice(0, 200_000);
}

// ---- Calendar ---------------------------------------------------------------

export type CalendarEventInput = {
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string | null;
};

const graphDateTime = (iso: string) => ({
  dateTime: new Date(iso).toISOString().replace(/Z$/, ""),
  timeZone: "UTC",
});

const httpsOrNull = (u: unknown) =>
  typeof u === "string" && u.startsWith("https://") && u.length <= 2000 ? u : null;

type GoogleEvent = {
  id?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
};

function googleJoinUrl(ev: GoogleEvent): string | null {
  return (
    httpsOrNull(ev.hangoutLink) ??
    httpsOrNull(ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri)
  );
}

/**
 * Put the meeting on the counselor's own calendar with a real conference:
 * Google Meet via conferenceData, Teams via an online meeting on the Outlook
 * event. No attendees are added and no invitation is sent by this API — the
 * counselor shares the link, which keeps outbound mail on the audited path.
 */
export async function createConferenceEvent(
  ownerId: string,
  provider: SuiteProvider,
  input: CalendarEventInput,
  log: Log
): Promise<{ eventId: string; joinUrl: string }> {
  if (provider === "google") {
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    const { res } = await call(
      ownerId,
      provider,
      `${base}?conferenceDataVersion=1&sendUpdates=none`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: input.title,
          description: input.description ?? undefined,
          start: { dateTime: new Date(input.startsAt).toISOString() },
          end: { dateTime: new Date(input.endsAt).toISOString() },
          conferenceData: {
            createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
          },
        }),
      },
      GOOGLE_CALENDAR
    );
    if (!res.ok) throw providerFailure(provider, res, log, "calendar event");
    let ev = (await res.json()) as GoogleEvent;
    const eventId = ev.id;
    if (!eventId) throw unavailable("Google didn't return the new event");

    // Conference creation is occasionally asynchronous; read the event back once.
    let joinUrl = googleJoinUrl(ev);
    if (!joinUrl) {
      await new Promise((r) => setTimeout(r, 1200));
      const again = await call(
        ownerId,
        provider,
        `${base}/${encodeURIComponent(eventId)}`,
        {},
        GOOGLE_CALENDAR
      );
      if (again.res.ok) {
        ev = { ...ev, ...((await again.res.json()) as GoogleEvent) };
        joinUrl = googleJoinUrl(ev);
      }
    }
    if (!joinUrl) {
      await deleteCalendarEvent(ownerId, provider, eventId, log).catch(() => undefined);
      throw unavailable("Google created the event but no Meet link. Nothing was saved — try again.");
    }
    return { eventId, joinUrl };
  }

  const { res } = await call(
    ownerId,
    provider,
    "https://graph.microsoft.com/v1.0/me/events",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: input.title,
        body: { contentType: "text", content: input.description ?? "" },
        start: graphDateTime(input.startsAt),
        end: graphDateTime(input.endsAt),
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      }),
    },
    { name: MS_CALENDAR_SCOPE, what: "writing to your Outlook calendar" }
  );
  if (!res.ok) throw providerFailure(provider, res, log, "calendar event");
  const ev = (await res.json()) as { id?: string; onlineMeeting?: { joinUrl?: string } | null };
  if (!ev.id) throw unavailable("Microsoft didn't return the new event");
  const joinUrl = httpsOrNull(ev.onlineMeeting?.joinUrl);
  if (!joinUrl) {
    // Personal Microsoft accounts can't host Teams meetings; don't leave a
    // link-less event behind on their calendar.
    await deleteCalendarEvent(ownerId, provider, ev.id, log).catch(() => undefined);
    throw conflict(
      "This Microsoft account can't create Teams meetings — that needs a work or school account with Teams. Nothing was saved."
    );
  }
  return { eventId: ev.id, joinUrl };
}

export async function updateCalendarEvent(
  ownerId: string,
  provider: SuiteProvider,
  eventId: string,
  patch: Partial<CalendarEventInput>,
  log: Log
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (provider === "google") {
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.description !== undefined) body.description = patch.description ?? "";
    if (patch.startsAt) body.start = { dateTime: new Date(patch.startsAt).toISOString() };
    if (patch.endsAt) body.end = { dateTime: new Date(patch.endsAt).toISOString() };
  } else {
    if (patch.title !== undefined) body.subject = patch.title;
    if (patch.description !== undefined) body.body = { contentType: "text", content: patch.description ?? "" };
    if (patch.startsAt) body.start = graphDateTime(patch.startsAt);
    if (patch.endsAt) body.end = graphDateTime(patch.endsAt);
  }
  if (Object.keys(body).length === 0) return;

  const url =
    provider === "google"
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`
      : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`;
  const { res } = await call(
    ownerId,
    provider,
    url,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    provider === "google"
      ? GOOGLE_CALENDAR
      : { name: MS_CALENDAR_SCOPE, what: "writing to your Outlook calendar" }
  );
  if (!res.ok) throw providerFailure(provider, res, log, "calendar event");
}

export async function deleteCalendarEvent(
  ownerId: string,
  provider: SuiteProvider,
  eventId: string,
  log: Log
): Promise<void> {
  const url =
    provider === "google"
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`
      : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`;
  const { res } = await call(
    ownerId,
    provider,
    url,
    { method: "DELETE" },
    provider === "google"
      ? GOOGLE_CALENDAR
      : { name: MS_CALENDAR_SCOPE, what: "writing to your Outlook calendar" }
  );
  // Already gone (404/410) is the outcome we wanted.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw providerFailure(provider, res, log, "calendar event");
  }
}

// ---- Busy time (student booking) ----------------------------------------------

/**
 * The counselor's busy time between two instants, from their own connected
 * calendar, for student booking (lib/bookingSlots.ts). Only the scopes the
 * counselor already granted: Google `events.list` on `primary` (calendar.events
 * allows it), Microsoft `GET /me/calendarView` (Calendars.ReadWrite). Never
 * `freebusy.query` (needs calendar.freebusy or readonly: re-consent and Google
 * verification) or `getSchedule` (not available to personal Microsoft
 * accounts). Nothing about an event is kept but its start and end.
 *
 * Skipped: Google events marked free (`transparency: transparent`) or
 * cancelled; Outlook events shown as free or cancelled. An all-day event is
 * busy for that whole day in the counselor's booking zone.
 *
 * A counselor with no grant for `provider`, or a grant without Calendar, has no
 * busy time there ([]). Any other failure throws (a 503 or the refresh's 409),
 * so slots are never offered over busy time we couldn't read. Answers are
 * cached for 60 s per counselor, provider, window and zone; a miss is rate
 * limited per counselor (`busy:<counselorId>`).
 */
export type { BusyInterval };

type BusyScope = { name: string; what: string; code?: string };
const BUSY_GOOGLE: BusyScope = { name: GOOGLE_CALENDAR_SCOPE, what: "reading your calendar", code: "busy_scope_missing" };
const BUSY_MICROSOFT: BusyScope = { name: MS_CALENDAR_SCOPE, what: "reading your calendar", code: "busy_scope_missing" };
const BUSY_TTL_MS = 60_000;
const BUSY_CACHE_MAX = 500;
const BUSY_MAX_PAGES = 5;
export const BUSY_RATE_LIMIT = { max: 30, windowSeconds: 60 };

const busyCache = new Map<string, { at: number; value: BusyInterval[] }>();

/** Test seam: the provider request (default: `call`), the clock, and a cache reset. */
export const __busy = {
  request: async (ownerId: string, provider: SuiteProvider, url: string, init: RequestInit, scope: BusyScope): Promise<Response> =>
    (await call(ownerId, provider, url, init, scope)).res,
  now: () => Date.now(),
  reset() {
    busyCache.clear();
    __busy.request = async (ownerId, provider, url, init, scope) => (await call(ownerId, provider, url, init, scope)).res;
    __busy.now = () => Date.now();
  },
};

function notConnected(e: unknown, provider: SuiteProvider): boolean {
  return (
    e instanceof HttpError &&
    e.statusCode === 409 &&
    (e.code === `${provider}_disconnected` || e.code === "busy_scope_missing")
  );
}

function isoOrNull(v: unknown, assumeUtc = false): string | null {
  if (typeof v !== "string" || !v) return null;
  const s = assumeUtc && !/(Z|[+-]\d\d:?\d\d)$/.test(v) ? `${v}Z` : v;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function wholeLocalDays(startDate: string, endDate: string, timeZone: string): BusyInterval | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  const start = wallTimeToInstant(startDate, "00:00", timeZone);
  const end = wallTimeToInstant(endDate, "00:00", timeZone);
  return end > start ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() } : null;
}

type GoogleBusyEvent = {
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};
type GraphBusyEvent = {
  showAs?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
};

async function googleBusy(ownerId: string, from: string, to: string, timeZone: string, log: Log): Promise<BusyInterval[]> {
  const out: BusyInterval[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < BUSY_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin: from,
      timeMax: to,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      fields: "items(status,transparency,start,end),nextPageToken",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await __busy.request(
      ownerId,
      "google",
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      {},
      BUSY_GOOGLE
    );
    if (!res.ok) throw providerFailure("google", res, log, "calendar");
    const body = (await res.json()) as { items?: GoogleBusyEvent[]; nextPageToken?: string };
    for (const ev of body.items ?? []) {
      if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
      if (ev.start?.date && ev.end?.date) {
        const day = wholeLocalDays(ev.start.date, ev.end.date, timeZone);
        if (day) out.push(day);
        continue;
      }
      const start = isoOrNull(ev.start?.dateTime);
      const end = isoOrNull(ev.end?.dateTime);
      if (start && end && end > start) out.push({ start, end });
    }
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
    if (!pageToken) break;
  }
  return out;
}

async function microsoftBusy(ownerId: string, from: string, to: string, timeZone: string, log: Log): Promise<BusyInterval[]> {
  const out: BusyInterval[] = [];
  const params = new URLSearchParams({
    startDateTime: from,
    endDateTime: to,
    $select: "showAs,isCancelled,isAllDay,start,end",
    $top: "250",
  });
  let url: string | null = `https://graph.microsoft.com/v1.0/me/calendarView?${params.toString()}`;
  for (let page = 0; page < BUSY_MAX_PAGES && url; page++) {
    const res = await __busy.request(ownerId, "microsoft", url, { headers: { Prefer: 'outlook.timezone="UTC"' } }, BUSY_MICROSOFT);
    if (!res.ok) throw providerFailure("microsoft", res, log, "calendar");
    const body = (await res.json()) as { value?: GraphBusyEvent[]; "@odata.nextLink"?: string };
    for (const ev of body.value ?? []) {
      if (ev.isCancelled || ev.showAs === "free") continue;
      if (ev.isAllDay) {
        const day = wholeLocalDays(String(ev.start?.dateTime ?? "").slice(0, 10), String(ev.end?.dateTime ?? "").slice(0, 10), timeZone);
        if (day) out.push(day);
        continue;
      }
      const start = isoOrNull(ev.start?.dateTime, true);
      const end = isoOrNull(ev.end?.dateTime, true);
      if (start && end && end > start) out.push({ start, end });
    }
    const next = body["@odata.nextLink"];
    // Only ever back to Graph itself: the token goes wherever this points.
    url = typeof next === "string" && next.startsWith("https://graph.microsoft.com/") ? next : null;
  }
  return out;
}

export async function listBusy(
  ownerId: string,
  provider: SuiteProvider,
  from: string,
  to: string,
  timeZone: string,
  log: Log
): Promise<BusyInterval[]> {
  const key = `${ownerId}|${provider}|${from}|${to}|${timeZone}`;
  const now = __busy.now();
  const hit = busyCache.get(key);
  if (hit && now - hit.at < BUSY_TTL_MS) return hit.value;

  await enforceRateLimit(
    `busy:${ownerId}`,
    BUSY_RATE_LIMIT.max,
    BUSY_RATE_LIMIT.windowSeconds,
    "Too many availability checks for this counselor. Try again in a minute."
  );

  let value: BusyInterval[];
  try {
    value =
      provider === "google"
        ? await googleBusy(ownerId, from, to, timeZone, log)
        : await microsoftBusy(ownerId, from, to, timeZone, log);
  } catch (e) {
    if (notConnected(e, provider)) value = [];
    else throw e;
  }
  value.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  if (busyCache.size >= BUSY_CACHE_MAX) {
    for (const [k, v] of busyCache) if (now - v.at >= BUSY_TTL_MS) busyCache.delete(k);
    if (busyCache.size >= BUSY_CACHE_MAX) busyCache.clear();
  }
  busyCache.set(key, { at: now, value });
  return value;
}

// ---- OneDrive picker ------------------------------------------------------------------

export type PickerSetup = {
  accountType: "personal" | "work";
  /** Where the picker page is posted: Microsoft's documented address for each account type. */
  baseUrl: string;
  /** The origin the picker's messages must come from. */
  pickerOrigin: string;
  target: PickerTarget;
};

/**
 * Which picker the counselor's OneDrive uses, from the drive Graph reported and
 * the directory kept at Connect. A work account's OneDrive must be on a standard
 * `<name>-my.sharepoint.com` host, the only host a picker token is ever asked
 * for; anything else (a government cloud, a document library) is refused.
 */
export function pickerSetup(drive: OneDriveInfo, tenantId: string | null): PickerSetup {
  const unsupported = () => new HttpError(409, ONEDRIVE_UNSUPPORTED, "onedrive_unsupported");
  if (drive.driveType === "personal") {
    if (tenantId && tenantId.toLowerCase() !== MSA_TENANT_ID) throw unsupported();
    return {
      accountType: "personal",
      baseUrl: "https://onedrive.live.com/picker",
      pickerOrigin: "https://onedrive.live.com",
      target: { kind: "personal" },
    };
  }
  if (drive.driveType !== "business") throw unsupported();
  let origin: string;
  try {
    origin = new URL(drive.webUrl ?? "").origin;
  } catch {
    throw unsupported();
  }
  if (!WORK_ONEDRIVE_ORIGIN.test(origin)) throw unsupported();
  if (!tenantId || tenantId.toLowerCase() === MSA_TENANT_ID) {
    throw new HttpError(409, "Microsoft needs reconnecting before OneDrive can open. Reconnect it under Files.", "microsoft_reconnect");
  }
  return { accountType: "work", baseUrl: origin, pickerOrigin: origin, target: { kind: "work", tenantId, resource: origin } };
}
