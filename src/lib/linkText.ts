/**
 * The text of a saved link's page, kept so AxIS can answer from it (migration 20261123000001,
 * `document_links.page_text`).
 *
 * Reading a link (POST /files/links, routes/files.ts readLink) already fetches the page and
 * extracts its readable text (lib/links.ts fetchReadablePage, at most 40,000 characters) to write
 * the digest. Before this, only the digest (summary and key points) was stored and the text was
 * dropped, so AxIS saw a link's title and address and nothing of what the page said.
 *
 * The text is stored with the digest, under the same rules: only onto a link still open to AI,
 * and the keep-out trigger clears it the moment the link is kept out of AI. It is served to AxIS
 * (GET /files/links/:id/text, the `files.read_link` lookup) only when every switch that governs
 * it is on: the link's own "AI may read it", the practice's AI summaries switch (the one that
 * lets a page be read at all, `link-digest`) and its "Auto-parse uploaded documents" switch
 * (AxIS reading the text of what is filed in Files). AxIS reads it as untrusted web content.
 */
import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "./errors.js";
import type { FetchedPage } from "./links.js";
import type { PrivacySettings } from "./practiceSettings.js";

/** What is stored: the same cap the reader puts on a page (lib/links.ts MAX_TEXT_CHARS). */
export const LINK_TEXT_MAX_CHARS = 40_000;

/** What one AxIS lookup shows of a page: the read_document tool's cap. */
export const LINK_TEXT_AXIS_CHARS = 12_000;

export type LinkTextRefusal = "kept-out" | "not-read" | "no-text" | "summaries-off" | "documents-off";

export const LINK_TEXT_REFUSALS: Record<LinkTextRefusal, string> = {
  "kept-out": "That link is kept out of AI, so AxIS can't read it.",
  "not-read": "That link hasn't been read yet. Read it in Files first.",
  "no-text": "That link was read before Meridies kept page text. Read it again in Files so AxIS can see the page.",
  "summaries-off": "AI summaries are turned off in Settings › Data & privacy, so AxIS can't read saved pages.",
  "documents-off": "Automatic document reading is turned off in Settings › Data & privacy, so AxIS can't read saved pages.",
};

/** Whether this link's stored text may reach a model now. Pure: the row and the practice's switches. */
export function linkTextVerdict(
  row: { available_to_llm?: unknown; status?: unknown; page_text?: unknown },
  settings: Pick<PrivacySettings, "aiSummaries" | "autoParseDocuments">
): { ok: true; text: string } | { ok: false; reason: LinkTextRefusal } {
  if (row.available_to_llm !== true) return { ok: false, reason: "kept-out" };
  if (!settings.aiSummaries) return { ok: false, reason: "summaries-off" };
  if (!settings.autoParseDocuments) return { ok: false, reason: "documents-off" };
  if (row.status !== "read") return { ok: false, reason: "not-read" };
  const text = typeof row.page_text === "string" ? row.page_text.trim() : "";
  if (!text) return { ok: false, reason: "no-text" };
  return { ok: true, text };
}

/** At most `max` characters, cut at a line or word break when one is near. */
export function cutLinkText(text: string, max = LINK_TEXT_AXIS_CHARS): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
  return { text: at > max * 0.8 ? head.slice(0, at) : head, cut: true };
}

/** Postgres "undefined column" or PostgREST's schema-cache miss for page_text: the migration isn't applied yet. */
export function isMissingPageText(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return (error.code === "42703" || error.code === "PGRST204") && /\bpage_text\b/.test(error.message ?? "");
}

/** The columns GET /files/links lists: everything the DTO needs, never the page text (up to 40 KB a row). */
export const LINK_LIST_COLUMNS =
  "id, owner_id, student_id, folder_id, url, domain, title, kind, status, summary, key_points, relevance, content_chars, available_to_llm, error, read_at, created_at";

export type LinkDigest = { title: string; summary: string; keyPoints: string[]; relevance: "high" | "medium" | "low" | "none" };

/**
 * The write a successful read makes: the digest and, with `withText` (the column exists), the page's text.
 * The text used to be dropped here, which is why AxIS could see a read link's title and nothing it said.
 */
export function digestUpdate(
  o: { title: string | null; digest: LinkDigest; page: FetchedPage },
  withText: boolean,
  now: Date = new Date()
): Record<string, unknown> {
  return {
    ...(withText ? { page_text: o.page.text.slice(0, LINK_TEXT_MAX_CHARS) } : {}),
    status: "read",
    title: o.title ?? o.digest.title ?? o.page.title,
    summary: o.digest.summary,
    key_points: o.digest.keyPoints,
    relevance: o.digest.relevance,
    content_chars: o.page.chars,
    extracted: { finalUrl: o.page.finalUrl, contentType: o.page.contentType, truncated: o.page.truncated },
    error: null,
    read_at: now.toISOString(),
  };
}

/** What GET /files/links/:id/text answers. */
export type LinkTextDto = {
  id: string;
  url: string;
  domain: string | null;
  title: string | null;
  summary: string | null;
  keyPoints: string[];
  text: string;
  truncated: boolean;
  chars: number;
};

type Db = FastifyRequest["db"];
type Row = Record<string, unknown>;
const TEXT_ROW = "id, url, domain, title, status, summary, key_points, available_to_llm, content_chars, extracted";

/**
 * One link's text for AxIS, on the caller's own client (RLS decides which links they may open), or why not.
 * Before the migration there is no column: every link reads as one read before page text was kept.
 */
export async function loadLinkText(
  db: Db,
  id: string,
  settings: Pick<PrivacySettings, "aiSummaries" | "autoParseDocuments">
): Promise<{ status: "ok"; link: LinkTextDto } | { status: "missing" } | { status: "refused"; reason: LinkTextRefusal; message: string }> {
  const read = (columns: string) => db.from("document_links").select(columns).eq("id", id).maybeSingle();
  let { data, error } = await read(`${TEXT_ROW}, page_text`);
  if (error && isMissingPageText(error)) ({ data, error } = await read(TEXT_ROW));
  if (error) throw fromPostgrest(error);
  if (!data) return { status: "missing" };
  const row = data as unknown as Row;
  const verdict = linkTextVerdict(row, settings);
  if (!verdict.ok) return { status: "refused", reason: verdict.reason, message: LINK_TEXT_REFUSALS[verdict.reason] };
  const shown = cutLinkText(verdict.text, LINK_TEXT_AXIS_CHARS);
  const extracted = (row.extracted ?? {}) as Row;
  return {
    status: "ok",
    link: {
      id: String(row.id),
      url: String(row.url),
      domain: typeof row.domain === "string" ? row.domain : null,
      title: typeof row.title === "string" ? row.title : null,
      summary: typeof row.summary === "string" ? row.summary : null,
      keyPoints: Array.isArray(row.key_points) ? (row.key_points as unknown[]).map(String) : [],
      text: shown.text,
      // Cut here for the prompt, or cut when it was read (the page ran past what is stored).
      truncated: shown.cut || extracted.truncated === true,
      chars: typeof row.content_chars === "number" ? row.content_chars : verdict.text.length,
    },
  };
}
