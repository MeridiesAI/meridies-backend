/**
 * The roster summary as one Google Sheet in the counselor's own Drive
 * (`POST /account/export/drive`).
 *
 * One Drive multipart upload: metadata naming the native Sheets type, then the
 * CSV, which Drive converts. It runs under the `drive.file` scope the app
 * already asks for (supplement Docs, `lib/supplementDocs.ts`): the app may only
 * touch files it created, and no new scope is needed.
 *
 * Errors a counselor can act on: `drive_not_granted` (409) when Google isn't
 * connected, needs reconnecting, or the grant lacks drive.file; `drive_failed`
 * (502) when Google fails or doesn't answer; `drive_unavailable` (503) when
 * this server has no Google settings. The CSV and the tokens are never logged
 * and never put in an error: a failure logs the HTTP status only.
 *
 * The client is injectable (token source and fetch) so it is tested without
 * Google. `DRIVE_EXPORT_FAKE=fixture` (NODE_ENV development or test only; the
 * server refuses to start otherwise) swaps in a stand-in for the integration
 * suite and the local stack: it decides "granted" from the caller's
 * `integration_tokens` row (never decrypting it) and makes no network call.
 */

import { env as appEnv } from "../env.js";
import { HttpError } from "./errors.js";
import { accessTokenFor, hasScope, type LiveToken } from "./oauth.js";
import { serviceClient } from "./supabase.js";
import { GOOGLE_DRIVE_FILE_SCOPE } from "./supplementDocs.js";

type Log = { warn: (obj: object, msg: string) => void };

export type SheetClient = {
  createSheet(ownerId: string, input: { title: string; csv: string }, log: Log): Promise<{ webViewLink: string }>;
};

const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink";
const HTTP_TIMEOUT_MS = 30_000;
const GOOGLE_ID = /^[A-Za-z0-9_-]{5,300}$/;

const notGranted = () =>
  new HttpError(409, "Connect Google Drive under App Integrations (and leave the Drive permission ticked) to export to Sheets.", "drive_not_granted");
const failed = () => new HttpError(502, "Google Drive didn't create the Sheet. Try again in a minute.", "drive_failed");

/** "Meridies export 2026-11-07" (UTC date). */
export function sheetTitle(now = new Date()): string {
  return `Meridies export ${now.toISOString().slice(0, 10)}`;
}

export function multipartSheetBody(title: string, csv: string, boundary: string): string {
  const metadata = { name: title.slice(0, 300), mimeType: "application/vnd.google-apps.spreadsheet" };
  return [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/csv; charset=UTF-8",
    "",
    csv,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

type Deps = {
  token: (ownerId: string, force?: boolean) => Promise<LiveToken>;
  fetch: typeof fetch;
};

/** The real client. `deps` default to the stored OAuth grant and global fetch. */
export function googleSheetClient(
  deps: Deps = { token: (o, force) => accessTokenFor(o, "google", { force }), fetch: (...a) => fetch(...a) }
): SheetClient {
  const tokenFor = async (ownerId: string, force: boolean): Promise<LiveToken> => {
    let t: LiveToken;
    try {
      t = await deps.token(ownerId, force);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) throw notGranted();
      if (err instanceof HttpError && err.statusCode === 503) {
        throw new HttpError(503, "Google Drive isn't set up on this server.", "drive_unavailable");
      }
      throw failed();
    }
    if (!hasScope(t, GOOGLE_DRIVE_FILE_SCOPE)) throw notGranted();
    return t;
  };

  return {
    async createSheet(ownerId, input, log) {
      const boundary = `meridies-${crypto.randomUUID()}`;
      const body = multipartSheetBody(input.title, input.csv, boundary);
      const send = async (t: LiveToken) => {
        try {
          return await deps.fetch(UPLOAD_URL, {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}`, Authorization: `Bearer ${t.accessToken}` },
            body,
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
        } catch {
          log.warn({ provider: "google", what: "sheet export", status: "network" }, "google request failed");
          throw failed();
        }
      };

      let res = await send(await tokenFor(ownerId, false));
      if (res.status === 401) res = await send(await tokenFor(ownerId, true));
      if (res.status === 401) throw notGranted();
      if (!res.ok) {
        log.warn({ provider: "google", what: "sheet export", status: res.status }, "google request failed");
        throw failed();
      }
      let created: { id?: unknown; webViewLink?: unknown };
      try {
        created = (await res.json()) as typeof created;
      } catch {
        throw failed();
      }
      if (typeof created.id !== "string" || !GOOGLE_ID.test(created.id)) throw failed();
      const link =
        typeof created.webViewLink === "string" && created.webViewLink.startsWith("https://docs.google.com/")
          ? created.webViewLink
          : `https://docs.google.com/spreadsheets/d/${created.id}/edit`;
      return { webViewLink: link };
    },
  };
}

// ---- The test double -----------------------------------------------------------

const FAKE_ALLOWED_ENVS = ["development", "test"];

/** A message for index.ts to refuse to start with, or null: the fake is for tests only. */
export function driveFakeRefusal(e: { DRIVE_EXPORT_FAKE?: string | undefined; NODE_ENV?: string | undefined }): string | null {
  if (!e.DRIVE_EXPORT_FAKE) return null;
  if (e.NODE_ENV === "production") {
    return "refusing to start: DRIVE_EXPORT_FAKE is for tests only and must not be set when NODE_ENV=production";
  }
  if (e.NODE_ENV === undefined || !FAKE_ALLOWED_ENVS.includes(e.NODE_ENV)) {
    return "refusing to start: DRIVE_EXPORT_FAKE is for tests only and needs NODE_ENV=development or NODE_ENV=test";
  }
  return null;
}

/**
 * Stand-in for Google: granted when the caller has a google `integration_tokens`
 * row whose scopes include drive.file; an `account_email` starting
 * `drive-fail` makes Google "fail" (502). Never decrypts a token, never calls out.
 */
export function fakeSheetClient(): SheetClient {
  return {
    async createSheet(ownerId, input) {
      const db = serviceClient();
      if (!db) throw new HttpError(503, "Google Drive isn't set up on this server.", "drive_unavailable");
      const { data, error } = await db
        .from("integration_tokens")
        .select("scopes, account_email")
        .eq("owner_id", ownerId)
        .eq("provider", "google")
        .maybeSingle();
      if (error) throw failed();
      if (!data) throw notGranted();
      const scopes = ((data.scopes as string[] | null) ?? []);
      if (!hasScope({ accessToken: "", accountId: null, accountEmail: null, scopes }, GOOGLE_DRIVE_FILE_SCOPE)) throw notGranted();
      if (String(data.account_email ?? "").startsWith("drive-fail")) throw failed();
      const lines = input.csv.split("\r\n").filter(Boolean).length;
      return { webViewLink: `https://docs.google.com/spreadsheets/d/fake-${crypto.randomUUID()}-${lines}/edit` };
    },
  };
}

let override: SheetClient | null = null;
/** Unit tests only: replace the client the route uses. */
export function setSheetClientForTests(client: SheetClient | null): void {
  override = client;
}

/** The client the route uses: a test override, the fake when allowed and asked for, else Google. */
export function sheetClient(env: { DRIVE_EXPORT_FAKE?: string | undefined } = { DRIVE_EXPORT_FAKE: appEnv.DRIVE_EXPORT_FAKE }): SheetClient {
  if (override) return override;
  const fakeOn = !!env.DRIVE_EXPORT_FAKE && driveFakeRefusal({ DRIVE_EXPORT_FAKE: env.DRIVE_EXPORT_FAKE, NODE_ENV: process.env.NODE_ENV }) === null;
  return fakeOn ? fakeSheetClient() : googleSheetClient();
}
