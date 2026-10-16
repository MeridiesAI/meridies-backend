/**
 * Campus photos for the catalog: one freely licensed photo per college, from
 * Wikimedia Commons, copied into the public `college-photos` bucket
 * (migration 20261023070001).
 *
 * Where a photo comes from:
 *   - Wikidata: the item whose IPEDS id (P1771) is the college's unitid, and
 *     that item's main image (P18). A unitid claimed by two items, or an item
 *     claiming two unitids (a system, a merged campus), is skipped: either way
 *     the photo could be another campus. An item with several main images takes
 *     the alphabetically first, which is still that college.
 *   - The team's picks (scripts/ingest/data/college-photo-picks.csv), which win
 *     over Wikidata. `none` suppresses a college: it gets no photo, and an
 *     existing one is removed.
 *   - Nothing else. There is no search fallback: a search picks the wrong
 *     building, and a college with no usable image keeps the app's plain ground.
 *
 * What a file must be (choosePhoto): on Commons (moved files followed), a JPEG,
 * at least 1000 px wide and landscape (1.2:1) unless the team picked it, CC0,
 * public domain, CC BY or CC BY-SA (never NC or ND), not flagged non-free, with
 * no restriction template (personality rights, trademark, insignia), and, for
 * CC BY and BY-SA, an author credit to attribute it with. A credit too long to
 * store is refused, never clipped.
 *
 * What a run does (runCollegePhotoIngest): one ingest_runs row; the Wikidata
 * query (a failure ends the run touching nothing); Commons metadata for every
 * target title, 50 a request; then per college: unchanged (same Commons sha1)
 * gets its credit and license text refreshed and checked_at touched, new or
 * changed is downloaded at 500 and 1280 px and uploaded under
 * <unitid>/<sha1>-<width>.jpg before its row is written (old objects removed
 * after), and no target, a refused file or a suppression deletes the row and
 * its objects. Deletions the picks file didn't ask for are held when they
 * would remove more than a tenth of the stored photos (and more than five):
 * a truncated or vandalised Wikidata answer must not wipe the catalog's photos.
 *
 * The review gate (reviewDecision, migration 20261024000071): Wikidata and
 * Commons are crowd-edited, so a new or changed photo is published only once
 * it has been stable for STABLE_DAYS. Stable means the Wikidata item (its
 * schema:dateModified, from the same SPARQL query), the Commons file version
 * (imageinfo timestamp) and its description page (latest revision, and its
 * `touched` time, which also moves when a template the page uses is edited)
 * were all last changed at least that long before the run, and the file
 * wasn't reached through a redirect; or a run at least that long ago saw this
 * exact candidate (title, sha1, credit and license), held it, and nothing it
 * depends on changed since (quietSince: a revert and a re-applied edit don't
 * keep the old sighting). A replacement of a photo already shown (any new
 * version under the same title, or another file) always needs that sighting.
 * A held candidate is written to college_photo_candidates and the stored
 * photo keeps serving. A team pick is published at once, except a new
 * version of the file already shown (a replacement like any other) or a
 * title that now redirects; a pick pinned to a sha1 is published at once
 * while the file is that version and held while it isn't. A changed credit
 * or license for the photo already shown waits the same way (textDecision).
 * Without the migration nothing is remembered: new photos still pass on
 * their timestamps, replacements are held, and changed text waits for a quiet
 * description page.
 *
 * The bytes are tied to the version judged (sameVersion): upload.wikimedia.org
 * thumbnail URLs name the file, not the version, so Commons is asked again
 * after the downloads and the copies are stored only when the file is still
 * exactly that version (sha1 and upload time). Otherwise nothing is kept.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { replaceTags } from "../linearText.js";
import { parseCsv } from "./ipeds.js";
import { isAllowedDownloadUrl, type WikimediaClient } from "./wikimedia.js";

type Raw = Record<string, unknown>;
type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export const WIDTHS = { thumb: 500, full: 1280 } as const;
export const MIN_WIDTH = 1000;
export const MIN_ASPECT = 1.2;
export const CREDIT_MAX = 500;
export const BATCH = 50;
/** Hold deletions past this share of the stored photos, once they also pass the floor. */
export const DELETE_GUARD = { fraction: 0.1, floor: 5 } as const;
/** A new or changed photo waits until Wikidata and Commons have been quiet about it this long. */
export const STABLE_DAYS = 7;
export const STABLE_MS = STABLE_DAYS * 86_400_000;
export const PICKS_FILE = new URL("../../../scripts/ingest/data/college-photo-picks.csv", import.meta.url);

// ---- Licenses and credits (pure; unit-tested) ---------------------------------------

/** Licenses that allow reuse with attribution. NC and ND are out, and so is GFDL alone. The demo's rule. */
export function allowedLicense(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim();
  if (n.length > 60) return false;
  if (/\b(NC|ND)\b/i.test(n)) return false;
  return /^(CC0|Public domain|PD\b|CC BY(-SA)? \d(\.\d)?)/i.test(n);
}

/** CC BY and CC BY-SA require attribution; CC0 and public domain don't. */
export const needsAttribution = (license: string): boolean => /^CC BY/i.test(license.trim());

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

/** Commons' Artist/Attribution HTML as plain text: tags out, entities decoded, whitespace collapsed. */
export function stripHtml(html: unknown): string {
  if (typeof html !== "string") return "";
  // Tags out with an indexOf scan (lib/linearText.ts), the same as
  // `/<[^>]*>/g`, which rescans to the end from every "<" when no ">" follows.
  return replaceTags(html, " ", true)
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One cell of the dry-run review CSV. A cell that a spreadsheet would read as
 * a formula (it starts with = + - @, a tab or a carriage return, after any
 * leading spaces) gets a leading apostrophe, the OWASP CSV-injection rule:
 * the credit and the title come from Commons, where anyone can write them,
 * and the team opens this file in Excel or Sheets. Then the usual quoting for
 * a comma, a quote or a line break.
 */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[ ]*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---- Titles --------------------------------------------------------------------------

/**
 * "File:Some name.jpg" in MediaWiki's own form: underscores as spaces, single
 * spaces, the namespace as File:, the first letter of the name capitalised.
 * Null for anything that can't be a file title (empty, control characters, or
 * a character MediaWiki forbids in titles, such as the `|` that separates them
 * in an API call).
 */
export function normalizeTitle(raw: string): string | null {
  let t = raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(file|image)\s*:\s*/i, "");
  if (!t || t.length > 380) return null;
  if (/[\u0000-\u001f\u007f#<>[\]{}|]/.test(t)) return null;
  return `File:${t[0]!.toUpperCase()}${t.slice(1)}`;
}

/** A Wikidata P18 value (http://commons.wikimedia.org/wiki/Special:FilePath/<name>) as a file title. */
export function fileTitleFromUri(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const m = /^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/(.+)$/.exec(uri.trim());
  if (!m) return null;
  let name: string;
  try {
    name = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return normalizeTitle(name);
}

// ---- Wikidata ------------------------------------------------------------------------

/** An ISO 8601 date-time from Wikidata or Commons, normalised; null when absent or unreadable. */
export function isoTime(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export type SparqlResult = {
  /** unitid -> the one item that claims it, its main images (sorted) and when the item was last edited (null: unknown). */
  byUnitid: Map<number, { qid: string; titles: string[]; modified: string | null }>;
  /** unitids claimed by two items, or by an item that claims more than one. */
  ambiguous: Set<number>;
  /** Bindings whose unitid or item wasn't readable. */
  invalid: number;
  bindings: number;
};

/** The WDQS JSON answer, read strictly. Throws when it isn't one, so a run can stop touching nothing. */
export function parseSparql(json: unknown): SparqlResult {
  const bindings = (json as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  if (!Array.isArray(bindings)) throw new Error("Wikidata answer has no results");
  const itemsByUnitid = new Map<number, Set<string>>();
  const unitidsByItem = new Map<string, Set<number>>();
  const titlesByItem = new Map<string, Set<string>>();
  const modifiedByItem = new Map<string, number>();
  let invalid = 0;
  for (const b of bindings as Raw[]) {
    const item = (b?.item as Raw | undefined)?.value;
    const raw = (b?.unitid as Raw | undefined)?.value;
    const qid = typeof item === "string" ? /\/entity\/(Q[0-9]{1,12})$/.exec(item)?.[1] : undefined;
    const idText = typeof raw === "string" ? raw.trim() : "";
    if (!qid || !/^[0-9]{6}$/.test(idText)) {
      invalid++;
      continue;
    }
    const unitid = Number(idText);
    if (!itemsByUnitid.has(unitid)) itemsByUnitid.set(unitid, new Set());
    itemsByUnitid.get(unitid)!.add(qid);
    if (!unitidsByItem.has(qid)) unitidsByItem.set(qid, new Set());
    unitidsByItem.get(qid)!.add(unitid);
    if (!titlesByItem.has(qid)) titlesByItem.set(qid, new Set());
    const title = fileTitleFromUri((b?.image as Raw | undefined)?.value);
    if (title) titlesByItem.get(qid)!.add(title);
    const modified = isoTime((b?.modified as Raw | undefined)?.value);
    if (modified !== null) modifiedByItem.set(qid, Math.max(modifiedByItem.get(qid) ?? 0, Date.parse(modified)));
  }
  const byUnitid = new Map<number, { qid: string; titles: string[]; modified: string | null }>();
  const ambiguous = new Set<number>();
  for (const [unitid, items] of itemsByUnitid) {
    const [qid] = [...items];
    if (items.size !== 1 || unitidsByItem.get(qid!)!.size !== 1) {
      ambiguous.add(unitid);
      continue;
    }
    const modified = modifiedByItem.get(qid!);
    byUnitid.set(unitid, { qid: qid!, titles: [...titlesByItem.get(qid!)!].sort(), modified: modified === undefined ? null : new Date(modified).toISOString() });
  }
  return { byUnitid, ambiguous, invalid, bindings: bindings.length };
}

// ---- Picks ---------------------------------------------------------------------------

/**
 * A team pick: the file's title, or the title and the exact version the team
 * looked at (its Commons sha1, the optional commons_sha1 column). A pinned
 * pick is published only while the file is that version, and at once; an
 * unpinned one is published at once unless it is a new version of the file
 * already shown, or its title now redirects (reviewDecision).
 */
export type PickEntry = string | { title: string; sha1: string };
export type Picks = Map<number, PickEntry | "none">;
export const pickTitle = (p: PickEntry): string => (typeof p === "string" ? p : p.title);
export const pickSha1 = (p: PickEntry): string | null => (typeof p === "string" ? null : p.sha1);

const pickRow = z
  .object({
    unitid: z.string().trim().regex(/^[0-9]{6}$/, "unitid must be six digits"),
    commons_title: z.string().trim().min(1, "commons_title is empty").max(400),
    note: z.string().max(300).optional().default(""),
    commons_sha1: z
      .string()
      .trim()
      .regex(/^([0-9a-fA-F]{40})?$/, "commons_sha1 must be 40 hex characters or empty")
      .optional()
      .default(""),
  })
  .strict();

const PICK_HEADERS = ["unitid,commons_title,note", "unitid,commons_title,note,commons_sha1"];

/** The team's picks CSV (unitid,commons_title,note[,commons_sha1]). Strict: one bad row fails the whole file. */
export function parsePicks(csv: string): Picks {
  const rows = parseCsv(csv);
  const firstLine = csv.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const header = firstLine.split(",").map((h) => h.trim());
  if (!PICK_HEADERS.includes(header.join(","))) throw new Error("picks file: the header must be unitid,commons_title,note (and optionally commons_sha1)");
  const out: Picks = new Map();
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const parsed = pickRow.safeParse(r);
    if (!parsed.success) {
      errors.push(`line ${line}: ${parsed.error.issues.map((x) => x.message).join("; ")}`);
      return;
    }
    const unitid = Number(parsed.data.unitid);
    if (out.has(unitid)) {
      errors.push(`line ${line}: ${unitid} is listed twice`);
      return;
    }
    const sha1 = parsed.data.commons_sha1.toLowerCase();
    if (parsed.data.commons_title.toLowerCase() === "none") {
      if (sha1) {
        errors.push(`line ${line}: none takes no commons_sha1`);
        return;
      }
      out.set(unitid, "none");
      return;
    }
    const title = normalizeTitle(parsed.data.commons_title);
    if (!title || !/^File:/i.test(parsed.data.commons_title.trim())) {
      errors.push(`line ${line}: commons_title must be a File: title or none`);
      return;
    }
    out.set(unitid, sha1 ? { title, sha1 } : title);
  });
  if (errors.length) throw new Error(`picks file: ${errors.slice(0, 10).join(" | ")}`);
  return out;
}

export function loadPicks(file: URL | string = PICKS_FILE): Picks {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error("picks file unreadable");
  }
  return parsePicks(text);
}

// ---- Commons -------------------------------------------------------------------------

type Page = Raw & { title?: string; missing?: boolean; invalid?: boolean; imageinfo?: Raw[]; revisions?: unknown; touched?: unknown };

/**
 * Each requested title's page in an imageinfo answer, following Commons'
 * normalisation (spaces for underscores, a capital first letter) and, with
 * redirects=1, a moved file to its new name. Without this a moved file would
 * read as missing and lose its photo. Titles reached through a redirect are
 * added to `redirected`: the review gate can't see when the redirect was made.
 */
export function resolvePages(json: unknown, requested: string[], redirected?: Set<string>): Map<string, Page | null> {
  const q = (json as { query?: Raw } | null)?.query;
  if (!q || typeof q !== "object") throw new Error("Commons answer has no query");
  const map = (list: unknown) =>
    new Map(
      (Array.isArray(list) ? (list as Raw[]) : [])
        .filter((x) => typeof x?.from === "string" && typeof x?.to === "string")
        .map((x) => [String(x.from), String(x.to)])
    );
  const normalized = map(q.normalized);
  const redirects = map(q.redirects);
  const pages = new Map<string, Page>();
  for (const p of Array.isArray(q.pages) ? (q.pages as Page[]) : []) if (typeof p?.title === "string") pages.set(p.title, p);
  const out = new Map<string, Page | null>();
  for (const r of requested) {
    let t = normalized.get(r) ?? r;
    let hops = 0;
    for (; hops < 3 && redirects.has(t); hops++) t = redirects.get(t)!;
    if (hops > 0) redirected?.add(r);
    out.set(r, pages.get(t) ?? null);
  }
  return out;
}

export type ChosenPhoto = {
  title: string;
  sha1: string;
  width: number | null;
  height: number | null;
  credit: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
  fullUrl: string;
  /** When the current version of the file was uploaded (imageinfo timestamp); null when Commons didn't say. */
  uploadedAt: string | null;
  /** When the description page (credit, license) was last edited; null when Commons didn't say. */
  pageEditedAt: string | null;
  /**
   * The description page's `touched` time (prop=info): it also moves when a
   * template the page uses is edited, such as a {{Creator:...}} or a
   * photographer's own credit template, which change the credit and license
   * Commons reports without an edit to the page itself. Null when not given.
   */
  pageTouchedAt: string | null;
};

export type RejectReason =
  | "missing"
  | "mime"
  | "size"
  | "license"
  | "nonfree"
  | "restricted"
  | "no-credit"
  | "credit-too-long"
  | "bad-metadata";

const meta = (m: Raw | undefined, k: string): unknown => (m?.[k] as Raw | undefined)?.value;
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

/** Whether a Commons page (from the 1280 px imageinfo call) may become a college's photo. */
export function choosePhoto(page: Page | null | undefined, opts: { picked?: boolean } = {}): { ok: true; photo: ChosenPhoto } | { ok: false; reason: RejectReason } {
  const info = page?.imageinfo?.[0];
  if (!page || page.missing || page.invalid || !info || typeof page.title !== "string") return { ok: false, reason: "missing" };
  if (info.mime !== "image/jpeg") return { ok: false, reason: "mime" };
  const width = positive(info.width);
  const height = positive(info.height);
  if (!opts.picked && !(width !== null && height !== null && width >= MIN_WIDTH && width >= MIN_ASPECT * height)) {
    return { ok: false, reason: "size" };
  }
  const m = info.extmetadata as Raw | undefined;
  const license = stripHtml(meta(m, "LicenseShortName"));
  if (!allowedLicense(license)) return { ok: false, reason: "license" };
  // extmetadata values are strings ("true", "personality|trademarked").
  if (String(meta(m, "NonFree") ?? "").trim().toLowerCase() === "true") return { ok: false, reason: "nonfree" };
  if (stripHtml(meta(m, "Restrictions")).replace(/[|\s]/g, "") !== "") return { ok: false, reason: "restricted" };

  let credit = stripHtml(meta(m, "Attribution")) || stripHtml(meta(m, "Artist"));
  if (!credit) {
    if (needsAttribution(license)) return { ok: false, reason: "no-credit" };
    credit = "Unknown author";
  }
  if (credit.length > CREDIT_MAX) return { ok: false, reason: "credit-too-long" };

  const sha1 = typeof info.sha1 === "string" ? info.sha1.toLowerCase() : "";
  const sourceUrl = typeof info.descriptionurl === "string" ? info.descriptionurl : "";
  const fullUrl = typeof info.thumburl === "string" ? info.thumburl : typeof info.url === "string" ? info.url : "";
  if (!/^[0-9a-f]{40}$/.test(sha1) || !sourceUrl.startsWith("https://commons.wikimedia.org/") || sourceUrl.length > 2000 || !isAllowedDownloadUrl(fullUrl)) {
    return { ok: false, reason: "bad-metadata" };
  }
  let licenseUrl = typeof meta(m, "LicenseUrl") === "string" ? String(meta(m, "LicenseUrl")).trim() : "";
  if (licenseUrl.startsWith("//")) licenseUrl = `https:${licenseUrl}`;
  if (!/^https?:\/\//.test(licenseUrl) || licenseUrl.length > 500) licenseUrl = "";

  // The stored copy's size: the 1280 px thumbnail, or the original when it is narrower.
  const tw = positive(info.thumbwidth);
  const th = positive(info.thumbheight);
  return {
    ok: true,
    photo: {
      title: page.title,
      sha1,
      width: tw ?? width,
      height: tw ? th : height,
      credit,
      license,
      licenseUrl: licenseUrl || null,
      sourceUrl,
      fullUrl,
      uploadedAt: isoTime(info.timestamp),
      pageEditedAt: isoTime((Array.isArray(page.revisions) ? (page.revisions as Raw[])[0] : undefined)?.timestamp),
      pageTouchedAt: isoTime(page.touched),
    },
  };
}

/** The 500 px thumbnail URL from the second (url-only) imageinfo call. */
export function thumbUrlOf(page: Page | null | undefined): string | null {
  const info = page?.imageinfo?.[0];
  const u = typeof info?.thumburl === "string" ? info.thumburl : typeof info?.url === "string" ? info.url : null;
  return u && isAllowedDownloadUrl(u) ? u : null;
}

/**
 * Whether an imageinfo page still describes exactly the version a photo was
 * judged on: the same title (not moved or redirected since), the same sha1
 * and the same upload time. Thumbnail URLs on upload.wikimedia.org name the
 * file, not the version, so bytes fetched from them are those of whatever
 * version is current when they are fetched; the run asks again after the
 * downloads and keeps them only when this still holds. The upload time is
 * what tells a revert apart: re-uploading the old version brings back its
 * sha1 but is a new upload, with a new time. Unknown times never match.
 */
export function sameVersion(page: Page | null | undefined, photo: Pick<ChosenPhoto, "title" | "sha1" | "uploadedAt">): boolean {
  const info = page?.imageinfo?.[0];
  if (!page || !info || page.title !== photo.title || photo.uploadedAt === null) return false;
  const sha1 = typeof info.sha1 === "string" ? info.sha1.toLowerCase() : "";
  return sha1 === photo.sha1 && isoTime(info.timestamp) === photo.uploadedAt;
}

/** Where a college's two copies live in the bucket; content-addressed by the Commons sha1. */
export function storagePaths(unitid: number, sha1: string): { full: string; thumb: string } {
  if (!Number.isInteger(unitid) || unitid < 100000 || unitid > 999999) throw new Error("unitid out of range");
  if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error("sha1 malformed");
  return { full: `${unitid}/${sha1}-${WIDTHS.full}.jpg`, thumb: `${unitid}/${sha1}-${WIDTHS.thumb}.jpg` };
}

// ---- The review gate (pure; unit-tested) -------------------------------------------------

/** What a run held back and why: a college_photo_candidates row (migration 20261024000071). */
export type PhotoCandidate = {
  college_id: string;
  source: "wikidata" | "pick";
  commons_title: string;
  commons_sha1: string;
  text_hash: string;
  reasons: HoldReason[];
  first_seen_at: string;
  last_seen_at: string;
};

export type HoldReason =
  /** The current version of the file was uploaded within the window (or Commons didn't say when). */
  | "file-recent"
  /** The description page, or a template it uses, changed within the window (or Commons didn't say when). */
  | "page-recent"
  /** The Wikidata item was edited within the window (or the query didn't say when). */
  | "wikidata-recent"
  /** Wikidata's title reached the file through a redirect, whose age the APIs don't give. Never confirmed by a sighting. */
  | "redirected"
  /** It would replace a photo already shown: that needs a sighting by an earlier run. */
  | "replacement"
  /** Before 20261024000071: no memory of earlier sightings, so a replacement can't be confirmed. */
  | "no-review-table"
  /** A team pick whose title now redirects to another file: the team updates the picks file. */
  | "pick-redirected"
  /** A team pick pinned to a version (commons_sha1) the file no longer is: the team updates the pin. */
  | "pick-changed"
  /** The file changed while the run was downloading it: nothing downloaded is kept. */
  | "changed-during-run"
  /** The credit or license Commons reports for the photo already shown changed: the new text waits for a sighting. */
  | "text-changed";

export type ReviewDecision =
  | { publish: true; via: "pick" | "stable" | "observed" }
  | { publish: false; reasons: HoldReason[] };

/** The credit and license a candidate carried, so an edited credit is a new candidate. */
export function candidateTextHash(photo: Pick<ChosenPhoto, "credit" | "license" | "licenseUrl">): string {
  return createHash("sha1").update(`${photo.license}\n${photo.credit}\n${photo.licenseUrl ?? ""}`).digest("hex");
}

/** The text hash of what a stored row shows; null when the row's text wasn't read. */
export function storedTextHash(prev: Pick<StoredPhoto, "credit" | "license" | "license_url">): string | null {
  if (typeof prev.credit !== "string" || typeof prev.license !== "string") return null;
  return candidateTextHash({ credit: prev.credit, license: prev.license, licenseUrl: prev.license_url ?? null });
}

/** Whether an edit at `at` is at least STABLE_MS before `now`. Unknown or future times are never stable. */
export function stableSince(at: string | null, now: Date): boolean {
  if (at === null) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && now.getTime() - t >= STABLE_MS;
}

/** The description page and the templates it uses, both quiet for the window. */
const pageStable = (photo: ChosenPhoto, now: Date): boolean => stableSince(photo.pageEditedAt, now) && stableSince(photo.pageTouchedAt, now);

/**
 * Whether nothing the candidate depends on changed after `at` (a sighting):
 * the file version, its description page and the templates it uses, and,
 * for Wikidata's choice, the item. Unknown times count as changed. Without
 * this a sighting would only prove the candidate was there at two instants a
 * week apart: a vandal reverted within hours could re-apply the same edit
 * just before the next run and be confirmed by the first sighting.
 * `itemModified` undefined: the item doesn't matter (a pick, or text only).
 */
export function quietSince(at: string, photo: ChosenPhoto, itemModified: string | null | undefined): boolean {
  const limit = Date.parse(at);
  if (!Number.isFinite(limit)) return false;
  const notAfter = (t: string | null) => t !== null && Number.isFinite(Date.parse(t)) && Date.parse(t) <= limit;
  if (!notAfter(photo.uploadedAt) || !notAfter(photo.pageEditedAt) || !notAfter(photo.pageTouchedAt)) return false;
  return itemModified === undefined || notAfter(itemModified);
}

const sameCandidate = (c: PhotoCandidate | undefined, source: "wikidata" | "pick", photo: ChosenPhoto): c is PhotoCandidate =>
  c !== undefined &&
  c.source === source &&
  c.commons_title === photo.title &&
  c.commons_sha1 === photo.sha1 &&
  c.text_hash === candidateTextHash(photo);

/**
 * Whether a new or changed photo (its Commons sha1 differs from what is
 * stored, or nothing is stored) may be published on this run.
 *
 *   - A team pick pinned to a version (commons_sha1) is published at once
 *     while the file is that version, and held while it isn't.
 *   - An unpinned team pick is published at once, unless its title now
 *     reaches another file through a redirect (anyone who can edit the
 *     redirect page could point it anywhere) or it is a new version of the
 *     file already shown, under the same title, whichever source showed it:
 *     a new version uploaded over a picked or shown file is a replacement
 *     like any other.
 *   - Otherwise it waits for STABLE_DAYS of quiet: the file version, its
 *     description page (revision and `touched`) and, for Wikidata's choice,
 *     the item last changed at least that long ago, and not reached through a
 *     redirect.
 *   - A replacement of a photo already shown always waits for a sighting by
 *     an earlier run.
 *   - A sighting counts when a run at least STABLE_DAYS ago held this exact
 *     candidate (same source, title, sha1, credit and license), nothing it
 *     depends on changed since that sighting (quietSince), and it wasn't
 *     reached through a redirect. Then it stands in for every clock.
 */
export function reviewDecision(i: {
  source: "wikidata" | "pick";
  photo: ChosenPhoto;
  itemModified: string | null;
  redirected: boolean;
  /** The version a team pick is pinned to (picks CSV commons_sha1); null or absent when unpinned. */
  pinnedSha1?: string | null;
  prev: Pick<StoredPhoto, "source" | "commons_title" | "commons_sha1"> | undefined;
  candidate: PhotoCandidate | undefined;
  /** False before migration 20261024000071: there is no memory of sightings. */
  candidatesAvailable: boolean;
  now: Date;
}): ReviewDecision {
  const { source, photo, prev, now } = i;
  if (source === "pick") {
    if (i.pinnedSha1) return i.pinnedSha1 === photo.sha1 ? { publish: true, via: "pick" } : { publish: false, reasons: ["pick-changed"] };
    if (i.redirected) return { publish: false, reasons: ["pick-redirected"] };
    const newVersion = prev !== undefined && prev.commons_title === photo.title;
    if (!newVersion) return { publish: true, via: "pick" };
  }

  const reasons: HoldReason[] = [];
  if (!stableSince(photo.uploadedAt, now)) reasons.push("file-recent");
  if (!pageStable(photo, now)) reasons.push("page-recent");
  if (source === "wikidata") {
    if (!stableSince(i.itemModified, now)) reasons.push("wikidata-recent");
    if (i.redirected) reasons.push("redirected");
  }
  if (prev !== undefined) reasons.push("replacement");
  if (reasons.length === 0) return { publish: true, via: "stable" };

  const c = i.candidate;
  const observed =
    i.candidatesAvailable &&
    !i.redirected &&
    sameCandidate(c, source, photo) &&
    stableSince(c.first_seen_at, now) &&
    quietSince(c.first_seen_at, photo, source === "wikidata" ? i.itemModified : undefined);
  if (observed) return { publish: true, via: "observed" };
  if (!i.candidatesAvailable && prev !== undefined) reasons.push("no-review-table");
  return { publish: false, reasons };
}

/**
 * Whether the credit and license Commons now reports for the photo already
 * shown (same file, same sha1) may replace the text the row shows. The same
 * text always may. Changed text is crowd-edited text on every college surface
 * and on the credits page, and it can change without an edit to the file's
 * page (a transcluded credit template), so it waits like a new photo: with
 * the review queue, for a sighting of the same text at least STABLE_DAYS old
 * with nothing changed since (the page's `touched` time covers templates once
 * MediaWiki's job queue has caught up; the sighting covers the lag); before
 * the queue's migration, for the description page's revision and `touched`
 * times to be a week old.
 */
export function textDecision(i: {
  source: "wikidata" | "pick";
  photo: ChosenPhoto;
  storedHash: string | null;
  candidate: PhotoCandidate | undefined;
  candidatesAvailable: boolean;
  now: Date;
}): { apply: true } | { apply: false; reasons: HoldReason[] } {
  const { photo, now } = i;
  if (i.storedHash !== null && i.storedHash === candidateTextHash(photo)) return { apply: true };
  if (!i.candidatesAvailable) return pageStable(photo, now) ? { apply: true } : { apply: false, reasons: ["text-changed", "page-recent"] };
  const c = i.candidate;
  if (sameCandidate(c, i.source, photo) && stableSince(c.first_seen_at, now) && quietSince(c.first_seen_at, photo, undefined)) return { apply: true };
  return { apply: false, reasons: pageStable(photo, now) ? ["text-changed"] : ["text-changed", "page-recent"] };
}

/**
 * The candidate row to write for a held photo. first_seen is kept while it is
 * the same candidate and nothing it depends on changed after that first
 * sighting (quietSince); otherwise the wait starts again now.
 */
export function nextCandidate(
  collegeId: string,
  source: "wikidata" | "pick",
  photo: ChosenPhoto,
  reasons: HoldReason[],
  existing: PhotoCandidate | undefined,
  now: Date,
  itemModified?: string | null
): PhotoCandidate {
  const textHash = candidateTextHash(photo);
  const at = now.toISOString();
  const same =
    sameCandidate(existing, source, photo) &&
    Date.parse(existing.first_seen_at) <= now.getTime() &&
    quietSince(existing.first_seen_at, photo, itemModified);
  return {
    college_id: collegeId,
    source,
    commons_title: photo.title,
    commons_sha1: photo.sha1,
    text_hash: textHash,
    reasons,
    first_seen_at: same && existing ? existing.first_seen_at : at,
    last_seen_at: at,
  };
}

// ---- The store (the database and bucket, behind a narrow interface) -------------------

export type StoredPhoto = {
  college_id: string;
  source: "wikidata" | "pick";
  commons_title: string;
  commons_sha1: string;
  storage_path: string;
  thumb_path: string;
  /** The text the row shows, read so a changed credit can be held (textDecision). */
  credit?: string;
  license?: string;
  license_url?: string | null;
};

export type PhotoRow = StoredPhoto & {
  wikidata_id: string | null;
  width: number | null;
  height: number | null;
  credit: string;
  license: string;
  license_url: string | null;
  source_url: string;
  checked_at: string;
};

export type Trigger = "manual" | "cron" | "script";

export type PhotoStore = {
  /** "no-schema" when the migration isn't applied: nothing may be written then. */
  probe(): Promise<"ok" | "no-schema" | "error">;
  startRun(trigger: Trigger): Promise<string | null>;
  /** `counts` goes to ingest_runs.counts (20261024000071); the row is finished without it before that. */
  finishRun(
    id: string,
    f: { status: string; rows_upserted: number; rows_skipped: number; errors: string[]; duration_ms: number; counts: Record<string, number> }
  ): Promise<void>;
  colleges(): Promise<{ id: string; unitid: number; name: string }[]>;
  existing(): Promise<StoredPhoto[]>;
  upsert(row: PhotoRow): Promise<void>;
  touch(collegeId: string, fields: Partial<PhotoRow>): Promise<void>;
  remove(collegeId: string): Promise<void>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  removeObjects(paths: string[]): Promise<void>;
  /** The review queue by college; null before migration 20261024000071 (nothing is remembered then). */
  candidates(): Promise<Map<string, PhotoCandidate> | null>;
  saveCandidates(rows: PhotoCandidate[]): Promise<void>;
  clearCandidates(collegeIds: string[]): Promise<void>;
};

export const PHOTO_BUCKET = "college-photos";
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

/** The real store: the service client (the loader is a job, not a user). Errors carry codes only. */
export function supabasePhotoStore(svc: SupabaseClient): PhotoStore {
  const fail = (what: string, e: { code?: string; message?: string } | null) => {
    if (e) throw new Error(`${what}: ${e.code ?? "error"}`);
  };
  return {
    async probe() {
      const { error } = await svc.from("college_photos").select("college_id").limit(1);
      if (!error) return "ok";
      return MISSING_TABLE.has(error.code ?? "") ? "no-schema" : "error";
    },
    async startRun(trigger) {
      const { data } = await svc.from("ingest_runs").insert({ source: "college-photos", trigger }).select("id").single();
      return (data as Raw | null)?.id ? String((data as Raw).id) : null;
    },
    async finishRun(id, f) {
      const row = { ...f, errors: f.errors.slice(0, 50), finished_at: new Date().toISOString() };
      const { error } = await svc.from("ingest_runs").update(row).eq("id", id);
      // Before 20261024000071 there is no counts column: finish the row without it.
      if (error && MISSING_COLUMN.has(error.code ?? "") && /counts/.test(error.message ?? "")) {
        const { counts: _counts, ...rest } = row;
        await svc.from("ingest_runs").update(rest).eq("id", id);
      }
    },
    async colleges() {
      const out: { id: string; unitid: number; name: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await svc
          .from("colleges")
          .select("id, unitid, name")
          .not("unitid", "is", null)
          .order("unitid")
          .range(from, from + 999);
        fail("read colleges", error);
        const rows = (data ?? []) as Raw[];
        out.push(...rows.map((r) => ({ id: String(r.id), unitid: Number(r.unitid), name: String(r.name) })));
        if (rows.length < 1000) return out;
      }
    },
    async existing() {
      const out: StoredPhoto[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await svc
          .from("college_photos")
          .select("college_id, source, commons_title, commons_sha1, storage_path, thumb_path, credit, license, license_url")
          .order("college_id")
          .range(from, from + 999);
        fail("read photos", error);
        const rows = (data ?? []) as unknown as StoredPhoto[];
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    },
    async upsert(row) {
      const { error } = await svc.from("college_photos").upsert(row, { onConflict: "college_id" });
      fail("write photo", error);
    },
    async touch(collegeId, fields) {
      const { error } = await svc.from("college_photos").update(fields).eq("college_id", collegeId);
      fail("touch photo", error);
    },
    async remove(collegeId) {
      const { error } = await svc.from("college_photos").delete().eq("college_id", collegeId);
      fail("delete photo", error);
    },
    async upload(path, bytes) {
      const { error } = await svc.storage
        .from(PHOTO_BUCKET)
        .upload(path, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (error) throw new Error("upload failed");
    },
    async removeObjects(paths) {
      if (!paths.length) return;
      const { error } = await svc.storage.from(PHOTO_BUCKET).remove(paths);
      if (error) throw new Error("object delete failed");
    },
    async candidates() {
      const out = new Map<string, PhotoCandidate>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await svc
          .from("college_photo_candidates")
          .select("college_id, source, commons_title, commons_sha1, text_hash, reasons, first_seen_at, last_seen_at")
          .order("college_id")
          .range(from, from + 999);
        if (error && MISSING_TABLE.has(error.code ?? "")) return null;
        fail("read review queue", error);
        const rows = (data ?? []) as unknown as PhotoCandidate[];
        for (const r of rows) out.set(r.college_id, r);
        if (rows.length < 1000) return out;
      }
    },
    async saveCandidates(rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await svc.from("college_photo_candidates").upsert(rows.slice(i, i + 500), { onConflict: "college_id" });
        fail("write review queue", error);
      }
    },
    async clearCandidates(ids) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await svc.from("college_photo_candidates").delete().in("college_id", ids.slice(i, i + 200));
        fail("clear review queue", error);
      }
    },
  };
}

// ---- The run ---------------------------------------------------------------------------

export type PhotoDeps = Pick<WikimediaClient, "sparql" | "imageinfo" | "download"> & { picks: () => Picks };

export type PhotoOutcome = {
  runId: string | null;
  status: "succeeded" | "partial" | "failed";
  /** Why a run couldn't start or stopped early. */
  reason?: "no-schema" | "db-error" | "sparql" | "picks";
  dryRun: boolean;
  /** How many colleges ended each way, by reason (numbers only). */
  counts: Record<string, number>;
  /** Deletions held back by the guard. */
  held: number;
  /** New or changed photos held by the review gate (the stored photo, if any, keeps serving). */
  heldForReview: number;
  /** Whether the review queue (migration 20261024000071) was there to remember sightings. */
  reviewTable: boolean;
  errors: string[];
  /** What a dry run would attach (new or replaced), for spot review. */
  attach: ReviewItem[];
  /** What the review gate held back on this run (dry or not), and why. */
  review: ReviewItem[];
};

export type ReviewItem = {
  /** held-text: the photo stays, a changed credit or license for it waits (textDecision). */
  action: "add" | "replace" | "held-new" | "held-replace" | "held-text";
  unitid: number;
  name: string;
  title: string;
  license: string;
  credit: string;
  source: "wikidata" | "pick";
  /** The title shown today, for a replacement. */
  current: string | null;
  reasons: HoldReason[];
};

type Target = { title: string; source: "wikidata" | "pick"; qid: string | null; itemModified: string | null; pinnedSha1: string | null };

/** Photos downloaded, then re-checked against Commons, per round: bounds memory (two copies each, 3 MB at most a copy). */
export const DOWNLOAD_CHUNK = 20;

async function inPool<T>(items: T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    })
  );
}

export async function runCollegePhotoIngest(
  store: PhotoStore,
  deps: PhotoDeps,
  log: Log,
  opts: { trigger?: Trigger; limit?: number; only?: number[]; dryRun?: boolean; now?: () => Date } = {}
): Promise<PhotoOutcome> {
  const dryRun = Boolean(opts.dryRun);
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const errors: string[] = [];
  const attach: ReviewItem[] = [];
  const review: ReviewItem[] = [];
  const base = { dryRun, counts, held: 0, heldForReview: 0, reviewTable: false, errors, attach, review };

  const probe = await store.probe();
  if (probe !== "ok") return { ...base, runId: null, status: "failed", reason: probe === "no-schema" ? "no-schema" : "db-error" };

  const started = Date.now();
  const now = opts.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const runId = dryRun ? null : await store.startRun(opts.trigger ?? "manual");
  let written = 0;
  let unchanged = 0;
  let deleted = 0;
  let skipped = 0;
  let reviewTable = false;

  const finish = async (status: PhotoOutcome["status"], reason?: PhotoOutcome["reason"], held = 0): Promise<PhotoOutcome> => {
    if (runId) {
      await store.finishRun(runId, {
        status,
        rows_upserted: written + unchanged,
        rows_skipped: skipped,
        errors,
        duration_ms: Date.now() - started,
        counts,
      });
    }
    log.info({ status, counts, held, heldForReview: review.length, errors: errors.length, dryRun }, "college photos: finished");
    return { ...base, runId, status, reason, held, heldForReview: review.length, reviewTable };
  };

  // Everything that decides what to touch is read first; any failure here ends
  // the run before a single row or object changes.
  let picks: Picks;
  let sparql: SparqlResult;
  let colleges: { id: string; unitid: number; name: string }[];
  let stored: StoredPhoto[];
  let candidates: Map<string, PhotoCandidate> | null;
  try {
    picks = deps.picks();
  } catch (err) {
    errors.push(err instanceof Error ? err.message.slice(0, 300) : "picks file unreadable");
    return finish("failed", "picks");
  }
  try {
    [colleges, stored, candidates] = await Promise.all([store.colleges(), store.existing(), store.candidates()]);
  } catch (err) {
    errors.push(err instanceof Error ? err.message.slice(0, 300) : "database read failed");
    return finish("failed", "db-error");
  }
  try {
    sparql = parseSparql(await deps.sparql());
    if (sparql.byUnitid.size === 0) throw new Error("Wikidata returned no colleges");
  } catch (err) {
    errors.push(`wikidata: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
    return finish("failed", "sparql");
  }
  log.info({ bindings: sparql.bindings, colleges: sparql.byUnitid.size, ambiguous: sparql.ambiguous.size, invalid: sparql.invalid }, "college photos: wikidata read");
  reviewTable = candidates !== null;
  if (!reviewTable) log.warn({}, "college photos: no review queue (apply 20261024000071); replacements are held");

  const only = opts.only?.length ? new Set(opts.only) : null;
  let scope = colleges.filter((c) => !only || only.has(c.unitid)).sort((a, b) => a.unitid - b.unitid);
  if (opts.limit !== undefined) scope = scope.slice(0, Math.max(0, opts.limit));
  const storedBy = new Map(stored.map((s) => [s.college_id, s]));
  const scopeIds = new Set(scope.map((c) => c.id));

  type Deletion = { college: (typeof scope)[number]; reason: string; suppressed: boolean };
  const deletions: Deletion[] = [];
  const targets = new Map<string, Target>();
  for (const c of scope) {
    const pick = picks.get(c.unitid);
    const wd = sparql.byUnitid.get(c.unitid);
    if (pick === "none") {
      bump("suppressed");
      skipped++;
      if (storedBy.has(c.id)) deletions.push({ college: c, reason: "suppressed", suppressed: true });
      continue;
    }
    if (pick) {
      targets.set(c.id, { title: pickTitle(pick), source: "pick", qid: wd?.qid ?? null, itemModified: wd?.modified ?? null, pinnedSha1: pickSha1(pick) });
      continue;
    }
    if (wd && wd.titles.length) {
      targets.set(c.id, { title: wd.titles[0]!, source: "wikidata", qid: wd.qid, itemModified: wd.modified, pinnedSha1: null });
      continue;
    }
    const reason = sparql.ambiguous.has(c.unitid) ? "ambiguous" : wd ? "no-image" : "not-in-wikidata";
    bump(reason);
    skipped++;
    if (storedBy.has(c.id)) deletions.push({ college: c, reason, suppressed: false });
  }

  // Commons metadata for every target title, 50 a request. A failed request
  // leaves its colleges exactly as they are.
  const titles = [...new Set([...targets.values()].map((t) => t.title))];
  const pages = new Map<string, Page | null>();
  const redirected = new Set<string>();
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    try {
      for (const [t, p] of resolvePages(await deps.imageinfo(batch, WIDTHS.full, true), batch, redirected)) pages.set(t, p);
    } catch (err) {
      errors.push(`commons batch ${i / BATCH + 1}: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
    }
  }

  type Plan = { college: (typeof scope)[number]; target: Target; photo: ChosenPhoto; prev: StoredPhoto | undefined; applyText?: boolean };
  const toDownload: Plan[] = [];
  const toTouch: Plan[] = [];
  /** Held: a new or changed photo, or (text) a changed credit for the photo already shown. itemModified undefined: the item doesn't matter. */
  const toHold: { plan: Plan; reasons: HoldReason[]; itemModified: string | null | undefined }[] = [];
  // Colleges whose review-queue row stays as it is: held now, or not looked at.
  const keepCandidate = new Set<string>();
  const item = (p: Plan, action: ReviewItem["action"], reasons: HoldReason[] = []): ReviewItem => ({
    action,
    unitid: p.college.unitid,
    name: p.college.name,
    title: p.photo.title,
    license: p.photo.license,
    credit: p.photo.credit,
    source: p.target.source,
    current: p.prev?.commons_title ?? null,
    reasons,
  });
  const holdPhoto = (plan: Plan, reasons: HoldReason[]) => {
    toHold.push({ plan, reasons, itemModified: plan.target.source === "wikidata" ? plan.target.itemModified : undefined });
    keepCandidate.add(plan.college.id);
    skipped++;
    bump(plan.prev ? "held-replace" : "held-new");
    for (const r of reasons) bump(`hold:${r}`);
    review.push(item(plan, plan.prev ? "held-replace" : "held-new", reasons));
  };
  for (const c of scope) {
    const target = targets.get(c.id);
    if (!target) continue;
    if (!pages.has(target.title)) {
      bump("commons-unavailable");
      keepCandidate.add(c.id);
      continue;
    }
    const chosen = choosePhoto(pages.get(target.title), { picked: target.source === "pick" });
    const prev = storedBy.get(c.id);
    if (!chosen.ok) {
      bump(chosen.reason);
      skipped++;
      if (prev) deletions.push({ college: c, reason: chosen.reason, suppressed: false });
      continue;
    }
    const plan: Plan = { college: c, target, photo: chosen.photo, prev };
    // A pin the file no longer matches holds even an unchanged photo: the team looked at another version.
    if (target.pinnedSha1 && target.pinnedSha1 !== chosen.photo.sha1) {
      holdPhoto(plan, ["pick-changed"]);
      continue;
    }
    if (prev && prev.commons_sha1 === chosen.photo.sha1) {
      const text = textDecision({
        source: target.source,
        photo: chosen.photo,
        storedHash: storedTextHash(prev),
        candidate: candidates?.get(c.id),
        candidatesAvailable: candidates !== null,
        now,
      });
      plan.applyText = text.apply;
      toTouch.push(plan);
      if (!text.apply) {
        // The photo stays and is touched; only its new credit and license wait.
        toHold.push({ plan, reasons: text.reasons, itemModified: undefined });
        keepCandidate.add(c.id);
        bump("text-held");
        for (const r of text.reasons) bump(`hold:${r}`);
        review.push(item(plan, "held-text", text.reasons));
      }
      continue;
    }
    const decision = reviewDecision({
      source: target.source,
      photo: chosen.photo,
      itemModified: target.itemModified,
      redirected: redirected.has(target.title),
      pinnedSha1: target.pinnedSha1,
      prev,
      candidate: candidates?.get(c.id),
      candidatesAvailable: candidates !== null,
      now,
    });
    if (decision.publish) {
      if (decision.via === "observed") bump("confirmed");
      toDownload.push(plan);
      continue;
    }
    holdPhoto(plan, decision.reasons);
  }
  if (toHold.length) log.info({ held: toHold.length }, "college photos: new or changed photos held for review");

  // The guard: deletions nobody asked for, past a tenth of what is stored.
  const unasked = deletions.filter((d) => !d.suppressed);
  const allowed = Math.max(DELETE_GUARD.floor, Math.ceil(DELETE_GUARD.fraction * stored.length));
  const hold = unasked.length > allowed;
  if (hold) {
    errors.push(`deletion guard: ${unasked.length} photos would be removed (limit ${allowed}); none were`);
    log.warn({ wouldDelete: unasked.length, stored: stored.length, allowed }, "college photos: deletions held");
  }
  const toDelete = hold ? deletions.filter((d) => d.suppressed) : deletions;
  const heldCount = hold ? unasked.length : 0;

  const rowOf = (p: Plan, paths: { full: string; thumb: string }): PhotoRow => ({
    college_id: p.college.id,
    source: p.target.source,
    wikidata_id: p.target.qid,
    commons_title: p.photo.title,
    commons_sha1: p.photo.sha1,
    storage_path: paths.full,
    thumb_path: paths.thumb,
    width: p.photo.width,
    height: p.photo.height,
    credit: p.photo.credit,
    license: p.photo.license,
    license_url: p.photo.licenseUrl,
    source_url: p.photo.sourceUrl,
    checked_at: checkedAt,
  });

  if (dryRun) {
    if (toTouch.length) counts.unchanged = toTouch.length;
    for (const p of toDownload) {
      bump(p.prev ? "would-replace" : "would-add");
      attach.push(item(p, p.prev ? "replace" : "add"));
    }
    for (const d of toDelete) bump(`would-delete-${d.suppressed ? "suppressed" : "other"}`);
    return finish(errors.length || hold ? "partial" : "succeeded", undefined, heldCount);
  }

  // The review queue: what is held now, remembered for the run that confirms it.
  if (candidates !== null && toHold.length) {
    try {
      await store.saveCandidates(
        toHold.map((h) => nextCandidate(h.plan.college.id, h.plan.target.source, h.plan.photo, h.reasons, candidates.get(h.plan.college.id), now, h.itemModified))
      );
    } catch (err) {
      errors.push(`review queue: ${err instanceof Error ? err.message.slice(0, 200) : "write failed"}`);
    }
  }

  // Unchanged: the same file. The row follows a move and its other facts are
  // refreshed; the credit and license only when textDecision allowed it,
  // otherwise the text shown stays as it was.
  for (const p of toTouch) {
    try {
      const { college_id: _id, storage_path: _s, thumb_path: _t, commons_sha1: _h, credit, license, license_url, ...fields } = rowOf(p, {
        full: p.prev!.storage_path,
        thumb: p.prev!.thumb_path,
      });
      await store.touch(p.college.id, p.applyText ? { ...fields, credit, license, license_url } : fields);
      bump("unchanged");
      unchanged++;
    } catch (err) {
      errors.push(`${p.college.unitid}: ${err instanceof Error ? err.message.slice(0, 200) : "touch failed"}`);
    }
  }

  // New or changed, DOWNLOAD_CHUNK at a time: the 500 px URLs (and the version
  // they belong to), both copies, then Commons asked again; only bytes whose
  // version is still the one judged are uploaded, then the row, then the old
  // objects go. A version that changed at any point is held and nothing
  // downloaded for it is kept: the thumbnail URLs name the file, not the
  // version, so this is what ties the stored bytes to the reviewed sha1.
  const changedDuringRun = (p: Plan) => {
    bump("changed-during-run");
    skipped++;
    keepCandidate.add(p.college.id);
    review.push(item(p, p.prev ? "held-replace" : "held-new", ["changed-during-run"]));
    log.warn({ unitid: p.college.unitid }, "college photos: the file changed during the run; nothing kept");
  };
  const lookUp = async (titles: string[], what: string): Promise<Map<string, Page | null> | null> => {
    try {
      return resolvePages(await deps.imageinfo(titles, WIDTHS.thumb, false), titles);
    } catch (err) {
      errors.push(`commons ${what}: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
      return null;
    }
  };
  const failChunk = (chunk: Plan[]) => {
    for (const p of chunk) {
      bump("download-failed");
      keepCandidate.add(p.college.id);
    }
  };
  for (let i = 0; i < toDownload.length; i += DOWNLOAD_CHUNK) {
    const chunk = toDownload.slice(i, i + DOWNLOAD_CHUNK);
    const titles = [...new Set(chunk.map((p) => p.photo.title))];
    const before = await lookUp(titles, `thumbs batch ${i / DOWNLOAD_CHUNK + 1}`);
    if (!before) {
      failChunk(chunk);
      continue;
    }
    const fetched: { p: Plan; full: Uint8Array; thumb: Uint8Array }[] = [];
    await inPool(chunk, 2, async (p) => {
      const page = before.get(p.photo.title);
      if (!sameVersion(page, p.photo)) return changedDuringRun(p);
      try {
        const thumbUrl = thumbUrlOf(page);
        if (!thumbUrl) throw new Error("no 500 px thumbnail");
        const full = await deps.download(p.photo.fullUrl);
        const thumb = await deps.download(thumbUrl);
        fetched.push({ p, full, thumb });
      } catch (err) {
        bump("download-failed");
        keepCandidate.add(p.college.id);
        errors.push(`${p.college.unitid}: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
      }
    });
    if (!fetched.length) continue;
    const after = await lookUp([...new Set(fetched.map((f) => f.p.photo.title))], `re-check batch ${i / DOWNLOAD_CHUNK + 1}`);
    if (!after) {
      failChunk(fetched.map((f) => f.p));
      continue;
    }
    for (const { p, full, thumb } of fetched) {
      if (!sameVersion(after.get(p.photo.title), p.photo)) {
        changedDuringRun(p);
        continue;
      }
      try {
        const paths = storagePaths(p.college.unitid, p.photo.sha1);
        await store.upload(paths.full, full);
        await store.upload(paths.thumb, thumb);
        await store.upsert(rowOf(p, paths));
        written++;
        bump(p.prev ? "replaced" : "added");
        if (p.prev && p.prev.storage_path !== paths.full) {
          await store.removeObjects([p.prev.storage_path, p.prev.thumb_path]).catch(() => {
            errors.push(`${p.college.unitid}: old objects left in the bucket`);
          });
        }
      } catch (err) {
        bump("download-failed");
        keepCandidate.add(p.college.id);
        errors.push(`${p.college.unitid}: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
      }
    }
  }

  for (const d of toDelete) {
    const prev = storedBy.get(d.college.id)!;
    try {
      await store.remove(d.college.id);
      deleted++;
      bump("deleted");
    } catch (err) {
      errors.push(`${d.college.unitid}: ${err instanceof Error ? err.message.slice(0, 200) : "delete failed"}`);
      continue;
    }
    await store.removeObjects([prev.storage_path, prev.thumb_path]).catch(() => {
      errors.push(`${d.college.unitid}: objects left in the bucket`);
    });
  }

  // Everything else in scope with a queue row was published, is unchanged, or
  // has no photo now: its row goes, so a later candidate starts its wait afresh.
  if (candidates !== null) {
    const clear = [...candidates.keys()].filter((id) => scopeIds.has(id) && !keepCandidate.has(id));
    if (clear.length) {
      await store.clearCandidates(clear).catch((err: unknown) => {
        errors.push(`review queue: ${err instanceof Error ? err.message.slice(0, 200) : "clear failed"}`);
      });
    }
  }

  const status: PhotoOutcome["status"] =
    errors.length === 0 ? "succeeded" : written + unchanged + deleted > 0 ? "partial" : "failed";
  return finish(status, undefined, heldCount);
}
