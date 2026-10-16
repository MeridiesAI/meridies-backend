/**
 * Supplement Google Docs (demo lib/supplementDocs.ts, made real).
 *
 * For a school on a student's list, one Doc in the counselor's Drive titled
 * "{Student} | {College} Supplements {cycle}": each prompt in bold with its
 * word limit in gray, a rule, and room for the answer, shared with the student
 * as an editor. The demo mocked this with the Docs API batchUpdate body it
 * stood for; here the Doc is created in one Drive multipart upload of HTML,
 * which Drive converts to a native Doc (bold, gray and the rule survive), under
 * the narrow `drive.file` scope: the app can only touch files it created.
 *
 * Reading answers back for word counts uses the Doc's plain-text export and
 * splits it on the prompts the Doc was written from. Reading answers back uses
 * drive.file: the Doc was created by this app, or picked by the counselor.
 *
 * Every request goes to a fixed Google host with an id Google issued, so this
 * is not the lib/links.ts SSRF surface.
 */

import { conflict, HttpError, unavailable } from "./errors.js";
import { accessTokenFor, requireScope, type LiveToken } from "./oauth.js";
import { normalizeText } from "./documentText.js";

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const HTTP_TIMEOUT_MS = 20_000;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const GOOGLE_ID = /^[A-Za-z0-9_-]{5,300}$/;

type Log = { warn: (obj: object, msg: string) => void };

export type DocPrompt = { title: string; prompt: string; wordLimit: number | null };

/** "2026-2027" for anything from August 2026 to July 2027. */
export function currentCycle(now = new Date()): string {
  const y = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${y}-${y + 1}`;
}

export function docTitle(studentName: string, collegeName: string, cycle: string): string {
  return `${studentName} | ${collegeName} Supplements ${cycle}`;
}

/** The Doc id in a docs.google.com URL, or null. */
export function googleDocIdFromUrl(url: string): string | null {
  const m = url.match(/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{5,300})/);
  return m ? m[1] : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function docHtml(prompts: DocPrompt[]): string {
  const blocks = prompts.map((p) => {
    const limit = p.wordLimit ? ` <span style="color:#737373">(${p.wordLimit} words)</span>` : "";
    return `<p><b>${escapeHtml(p.prompt)}</b>${limit}</p><p></p><hr><p></p>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${blocks.join("")}</body></html>`;
}

async function googleCall(
  ownerId: string,
  url: string,
  init: RequestInit,
  scope: { name: string; what: string; code?: string }
): Promise<Response> {
  let token: LiveToken = await accessTokenFor(ownerId, "google");
  requireScope(token, "google", scope.name, scope.what, scope.code);
  const go = (t: LiveToken) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t.accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  let res = await go(token);
  if (res.status === 401) {
    token = await accessTokenFor(ownerId, "google", { force: true });
    res = await go(token);
  }
  return res;
}

function failure(res: Response, log: Log, what: string): HttpError {
  log.warn({ provider: "google", status: res.status, what }, "google request failed");
  if (res.status === 403) return conflict(`Google refused ${what}.`);
  if (res.status === 404) return new HttpError(404, "Google couldn't find that Doc, or it isn't shared with you.");
  if (res.status === 429) return new HttpError(429, "Google is rate-limiting requests. Try again shortly.");
  return unavailable(`Google didn't answer the ${what} request.`);
}

/**
 * Create the Doc and share it. Sharing failing does not undo the Doc: the
 * counselor still has it and the row says it was not shared.
 */
export async function createSupplementDoc(
  ownerId: string,
  input: { title: string; prompts: DocPrompt[]; shareWith: string | null },
  log: Log
): Promise<{ fileId: string; webUrl: string; shareStatus: "shared" | "not-shared" | "failed" }> {
  const boundary = `meridies-${Math.random().toString(36).slice(2)}`;
  const metadata = {
    name: input.title.slice(0, 300),
    mimeType: "application/vnd.google-apps.document",
  };
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    docHtml(input.prompts),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const res = await googleCall(
    ownerId,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
    { name: GOOGLE_DRIVE_FILE_SCOPE, what: "creating Docs", code: "drive_not_granted" }
  );
  if (!res.ok) throw failure(res, log, "creating the Doc");
  const created = (await res.json()) as { id?: string; webViewLink?: string };
  if (!created.id || !GOOGLE_ID.test(created.id)) throw unavailable("Google didn't return the new Doc.");
  const webUrl =
    created.webViewLink && created.webViewLink.startsWith("https://")
      ? created.webViewLink
      : `https://docs.google.com/document/d/${created.id}/edit`;

  let shareStatus: "shared" | "not-shared" | "failed" = "not-shared";
  if (input.shareWith) {
    const share = await googleCall(
      ownerId,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(created.id)}/permissions?sendNotificationEmail=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user", role: "writer", emailAddress: input.shareWith }),
      },
      { name: GOOGLE_DRIVE_FILE_SCOPE, what: "sharing Docs", code: "drive_not_granted" }
    ).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "doc share failed");
      return null;
    });
    shareStatus = share && share.ok ? "shared" : "failed";
    if (share && !share.ok) log.warn({ status: share.status }, "doc share refused");
  }

  return { fileId: created.id, webUrl, shareStatus };
}

/** A picked or app-created Doc's plain text; `not-picked` when Google says the app can't see it. */
export async function exportDocTextResult(
  ownerId: string,
  fileId: string,
  log: Log
): Promise<{ ok: true; text: string } | { ok: false; reason: "not-picked" | "failed" }> {
  if (!GOOGLE_ID.test(fileId)) return { ok: false, reason: "failed" };
  const res = await googleCall(
    ownerId,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain`,
    {},
    { name: GOOGLE_DRIVE_FILE_SCOPE, what: "reading Docs you picked", code: "drive_not_granted" }
  );
  const declaredBytes = Number(res.headers.get("content-length") ?? "0");
  // The body is read only for an OK answer whose declared size is acceptable.
  const text = res.ok && declaredBytes <= MAX_EXPORT_BYTES ? await res.text() : null;
  const outcome = docExportOutcome({ status: res.status, declaredBytes, text });
  if (!outcome.ok && outcome.reason === "failed" && res.status !== 404 && res.status !== 403 && !res.ok) {
    log.warn({ status: res.status }, "google doc export failed");
  }
  return outcome;
}

/** Pure mapping of a Doc export answer: 404 or 403 (drive.file's appNotAuthorizedToFile) is not-picked, any other failure or oversize is failed. */
export function docExportOutcome(a: {
  status: number;
  declaredBytes: number;
  text: string | null;
}): { ok: true; text: string } | { ok: false; reason: "not-picked" | "failed" } {
  if (a.status === 404 || a.status === 403) return { ok: false, reason: "not-picked" };
  if (a.status < 200 || a.status > 299) return { ok: false, reason: "failed" };
  if (a.declaredBytes > MAX_EXPORT_BYTES || a.text === null || a.text.length > MAX_EXPORT_BYTES) {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, text: normalizeText(a.text) };
}

export async function exportDocText(ownerId: string, fileId: string, log: Log): Promise<string | null> {
  const r = await exportDocTextResult(ownerId, fileId, log);
  return r.ok ? r.text : null;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Each prompt's answer out of the exported Doc: the text after the prompt's
 * line and before the next prompt, without the rule Drive exports as a row of
 * underscores. A prompt the student deleted from the Doc reads as null (not
 * found), which the caller leaves untouched rather than zeroing.
 */
export function splitAnswers(text: string, prompts: DocPrompt[]): (string | null)[] {
  const lines = text.split("\n");
  const keys = lines.map(squash);
  const starts = prompts.map((p) => {
    const key = squash(p.prompt).slice(0, 80);
    if (!key) return -1;
    return keys.findIndex((k) => k.startsWith(key));
  });
  return prompts.map((_, i) => {
    const start = starts[i];
    if (start < 0) return null;
    const later = starts.filter((s) => s > start);
    const end = later.length > 0 ? Math.min(...later) : lines.length;
    const answer = lines
      .slice(start + 1, end)
      .filter((l) => !/^\s*[_\-—–=*]{3,}\s*$/.test(l))
      .join("\n");
    return normalizeText(answer);
  });
}
