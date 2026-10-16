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
import {
  accessTokenFor,
  GOOGLE_SCOPE,
  providerLabel,
  requireScope,
  type LiveToken,
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
const MS_FILES_SCOPE = "Files.Read.All";
const MS_CALENDAR_SCOPE = "Calendars.ReadWrite";

const GOOGLE_ID = /^[A-Za-z0-9_-]{5,300}$/;
const GRAPH_ID = /^[A-Za-z0-9!_.=-]{1,300}$/;

export function assertFileId(provider: SuiteProvider, id: string, driveId?: string | null) {
  const re = provider === "google" ? GOOGLE_ID : GRAPH_ID;
  if (!re.test(id)) throw badRequest("That file id isn't valid");
  if (driveId != null && !GRAPH_ID.test(driveId)) throw badRequest("That drive id isn't valid");
}

type Log = { warn: (obj: object, msg: string) => void };

/** Authorized fetch against a provider API, with one refresh-and-retry on 401. */
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
    fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t.accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

  let res = await go(token);
  if (res.status === 401) {
    token = await accessTokenFor(ownerId, provider, { force: true });
    res = await go(token);
  }
  return { res, token };
}

export function googleFileFailureCode(status: number): string | null {
  return status === 404 ? "not_found" : null;
}

/** Map a provider failure to something safe to show. Bodies are never echoed. */
export function providerFailure(provider: SuiteProvider, res: Response, log: Log, what: string): HttpError {
  log.warn({ provider, status: res.status, what }, "provider request failed");
  const label = providerLabel(provider);
  if (res.status === 404) {
    return new HttpError(
      404,
      `${label} couldn't find that ${what}, or it isn't shared with you.`,
      googleFileFailureCode(404) ?? undefined
    );
  }
  if (res.status === 403) return conflict(`${label} refused access to that ${what}.`);
  if (res.status === 429) return new HttpError(429, `${label} is rate-limiting requests — try again shortly.`);
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

function graphItemUrl(fileId: string, driveId: string | null | undefined): string {
  const base = driveId
    ? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`
    : "https://graph.microsoft.com/v1.0/me/drive";
  return `${base}/items/${encodeURIComponent(fileId)}`;
}

/**
 * Files the connected account can see, newest first; `q` filters by name.
 * Under Google's drive.file, files.list returns only files the app can reach
 * (earlier picks and supplement Docs): the app's "Recently added from Drive".
 */
export async function listRemoteFiles(
  ownerId: string,
  provider: SuiteProvider,
  q: string | undefined,
  log: Log
): Promise<RemoteFile[]> {
  if (provider === "google") {
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
    const { res } = await call(
      ownerId,
      provider,
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      {},
      GOOGLE_FILES
    );
    if (!res.ok) throw providerFailure(provider, res, log, "file list");
    const body = (await res.json()) as { files?: GoogleFile[] };
    return (body.files ?? []).map(fromGoogle);
  }

  const scope = { name: MS_FILES_SCOPE, what: "reading OneDrive" };
  const url = q
    ? `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(q.replace(/'/g, "''"))}')?$top=50&$select=${GRAPH_SELECT}`
    : `https://graph.microsoft.com/v1.0/me/drive/recent?$top=50`;
  let { res, token } = await call(ownerId, provider, url, {}, scope);
  // `recent` is not served for every account type; fall back to the drive root.
  if (!res.ok && !q) {
    ({ res, token } = await call(
      ownerId,
      provider,
      `https://graph.microsoft.com/v1.0/me/drive/root/children?$top=100&$select=${GRAPH_SELECT}`,
      {},
      scope
    ));
  }
  if (!res.ok) throw providerFailure(provider, res, log, "file list");
  const body = (await res.json()) as { value?: GraphItem[] };
  return (body.value ?? [])
    .map((i) => fromGraph(i, token.accountId))
    .filter((f): f is RemoteFile => f !== null);
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
  const { res, token } = await call(
    ownerId,
    provider,
    `${graphItemUrl(fileId, driveId)}?$select=${GRAPH_SELECT}`,
    {},
    { name: MS_FILES_SCOPE, what: "reading OneDrive" }
  );
  if (!res.ok) throw providerFailure(provider, res, log, "file");
  const file = fromGraph((await res.json()) as GraphItem, token.accountId);
  if (!file) throw badRequest("That item is a folder, not a file");
  return file;
}

async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IMPORT_BYTES) throw badRequest("That file is larger than 25 MB");
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
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
    const bytes = await readCapped(res);
    const filename = exp && !file.name.toLowerCase().endsWith(`.${exp.ext}`) ? `${file.name}.${exp.ext}` : file.name;
    return { bytes, mimeType: exp?.mime ?? file.mimeType ?? "application/octet-stream", filename };
  }

  // Graph answers /content with a redirect to a short-lived pre-authenticated
  // download URL on Microsoft's own storage; fetch follows it and drops the
  // Authorization header on the cross-origin hop.
  const { res } = await call(
    ownerId,
    provider,
    `${graphItemUrl(file.id, file.driveId)}/content`,
    {},
    { name: MS_FILES_SCOPE, what: "reading OneDrive" }
  );
  if (!res.ok) throw providerFailure(provider, res, log, "file download");
  const bytes = await readCapped(res);
  return { bytes, mimeType: file.mimeType ?? "application/octet-stream", filename: file.name };
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
  const bytes = await readCapped(res);
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
