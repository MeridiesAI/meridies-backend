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
 */

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

export type SparqlResult = {
  /** unitid -> the one item that claims it, and its main images (sorted). */
  byUnitid: Map<number, { qid: string; titles: string[] }>;
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
  }
  const byUnitid = new Map<number, { qid: string; titles: string[] }>();
  const ambiguous = new Set<number>();
  for (const [unitid, items] of itemsByUnitid) {
    const [qid] = [...items];
    if (items.size !== 1 || unitidsByItem.get(qid!)!.size !== 1) {
      ambiguous.add(unitid);
      continue;
    }
    byUnitid.set(unitid, { qid: qid!, titles: [...titlesByItem.get(qid!)!].sort() });
  }
  return { byUnitid, ambiguous, invalid, bindings: bindings.length };
}

// ---- Picks ---------------------------------------------------------------------------

export type Picks = Map<number, string | "none">;

const pickRow = z
  .object({
    unitid: z.string().trim().regex(/^[0-9]{6}$/, "unitid must be six digits"),
    commons_title: z.string().trim().min(1, "commons_title is empty").max(400),
    note: z.string().max(300).optional().default(""),
  })
  .strict();

/** The team's picks CSV (unitid,commons_title,note). Strict: one bad row fails the whole file. */
export function parsePicks(csv: string): Picks {
  const rows = parseCsv(csv);
  const firstLine = csv.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const header = firstLine.split(",").map((h) => h.trim());
  if (header.join(",") !== "unitid,commons_title,note") throw new Error("picks file: the header must be unitid,commons_title,note");
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
    if (parsed.data.commons_title.toLowerCase() === "none") {
      out.set(unitid, "none");
      return;
    }
    const title = normalizeTitle(parsed.data.commons_title);
    if (!title || !/^File:/i.test(parsed.data.commons_title.trim())) {
      errors.push(`line ${line}: commons_title must be a File: title or none`);
      return;
    }
    out.set(unitid, title);
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

type Page = Raw & { title?: string; missing?: boolean; invalid?: boolean; imageinfo?: Raw[] };

/**
 * Each requested title's page in an imageinfo answer, following Commons'
 * normalisation (spaces for underscores, a capital first letter) and, with
 * redirects=1, a moved file to its new name. Without this a moved file would
 * read as missing and lose its photo.
 */
export function resolvePages(json: unknown, requested: string[]): Map<string, Page | null> {
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
    for (let hops = 0; hops < 3 && redirects.has(t); hops++) t = redirects.get(t)!;
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
    },
  };
}

/** The 500 px thumbnail URL from the second (url-only) imageinfo call. */
export function thumbUrlOf(page: Page | null | undefined): string | null {
  const info = page?.imageinfo?.[0];
  const u = typeof info?.thumburl === "string" ? info.thumburl : typeof info?.url === "string" ? info.url : null;
  return u && isAllowedDownloadUrl(u) ? u : null;
}

/** Where a college's two copies live in the bucket; content-addressed by the Commons sha1. */
export function storagePaths(unitid: number, sha1: string): { full: string; thumb: string } {
  if (!Number.isInteger(unitid) || unitid < 100000 || unitid > 999999) throw new Error("unitid out of range");
  if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error("sha1 malformed");
  return { full: `${unitid}/${sha1}-${WIDTHS.full}.jpg`, thumb: `${unitid}/${sha1}-${WIDTHS.thumb}.jpg` };
}

// ---- The store (the database and bucket, behind a narrow interface) -------------------

export type StoredPhoto = {
  college_id: string;
  source: "wikidata" | "pick";
  commons_title: string;
  commons_sha1: string;
  storage_path: string;
  thumb_path: string;
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
  finishRun(id: string, f: { status: string; rows_upserted: number; rows_skipped: number; errors: string[]; duration_ms: number }): Promise<void>;
  colleges(): Promise<{ id: string; unitid: number; name: string }[]>;
  existing(): Promise<StoredPhoto[]>;
  upsert(row: PhotoRow): Promise<void>;
  touch(collegeId: string, fields: Partial<PhotoRow>): Promise<void>;
  remove(collegeId: string): Promise<void>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  removeObjects(paths: string[]): Promise<void>;
};

export const PHOTO_BUCKET = "college-photos";
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

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
      await svc
        .from("ingest_runs")
        .update({ ...f, errors: f.errors.slice(0, 50), finished_at: new Date().toISOString() })
        .eq("id", id);
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
          .select("college_id, source, commons_title, commons_sha1, storage_path, thumb_path")
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
  errors: string[];
  /** What a dry run would attach (new or replaced), for spot review. */
  attach: { unitid: number; name: string; title: string; license: string; credit: string; source: "wikidata" | "pick" }[];
};

type Target = { title: string; source: "wikidata" | "pick"; qid: string | null };

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
  const attach: PhotoOutcome["attach"] = [];
  const base = { dryRun, counts, held: 0, errors, attach };

  const probe = await store.probe();
  if (probe !== "ok") return { ...base, runId: null, status: "failed", reason: probe === "no-schema" ? "no-schema" : "db-error" };

  const started = Date.now();
  const checkedAt = (opts.now?.() ?? new Date()).toISOString();
  const runId = dryRun ? null : await store.startRun(opts.trigger ?? "manual");
  let written = 0;
  let unchanged = 0;
  let deleted = 0;
  let skipped = 0;

  const finish = async (status: PhotoOutcome["status"], reason?: PhotoOutcome["reason"], held = 0): Promise<PhotoOutcome> => {
    if (runId) {
      await store.finishRun(runId, {
        status,
        rows_upserted: written + unchanged,
        rows_skipped: skipped,
        errors,
        duration_ms: Date.now() - started,
      });
    }
    log.info({ status, counts, held, errors: errors.length, dryRun }, "college photos: finished");
    return { ...base, runId, status, reason, held };
  };

  // Everything that decides what to touch is read first; any failure here ends
  // the run before a single row or object changes.
  let picks: Picks;
  let sparql: SparqlResult;
  let colleges: { id: string; unitid: number; name: string }[];
  let stored: StoredPhoto[];
  try {
    picks = deps.picks();
  } catch (err) {
    errors.push(err instanceof Error ? err.message.slice(0, 300) : "picks file unreadable");
    return finish("failed", "picks");
  }
  try {
    [colleges, stored] = await Promise.all([store.colleges(), store.existing()]);
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

  const only = opts.only?.length ? new Set(opts.only) : null;
  let scope = colleges.filter((c) => !only || only.has(c.unitid)).sort((a, b) => a.unitid - b.unitid);
  if (opts.limit !== undefined) scope = scope.slice(0, Math.max(0, opts.limit));
  const storedBy = new Map(stored.map((s) => [s.college_id, s]));

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
      targets.set(c.id, { title: pick, source: "pick", qid: wd?.qid ?? null });
      continue;
    }
    if (wd && wd.titles.length) {
      targets.set(c.id, { title: wd.titles[0]!, source: "wikidata", qid: wd.qid });
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
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    try {
      for (const [t, p] of resolvePages(await deps.imageinfo(batch, WIDTHS.full, true), batch)) pages.set(t, p);
    } catch (err) {
      errors.push(`commons batch ${i / BATCH + 1}: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
    }
  }

  type Plan = { college: (typeof scope)[number]; target: Target; photo: ChosenPhoto; prev: StoredPhoto | undefined };
  const toDownload: Plan[] = [];
  const toTouch: Plan[] = [];
  for (const c of scope) {
    const target = targets.get(c.id);
    if (!target) continue;
    if (!pages.has(target.title)) {
      bump("commons-unavailable");
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
    const plan = { college: c, target, photo: chosen.photo, prev };
    if (prev && prev.commons_sha1 === chosen.photo.sha1) toTouch.push(plan);
    else toDownload.push(plan);
  }

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
      attach.push({ unitid: p.college.unitid, name: p.college.name, title: p.photo.title, license: p.photo.license, credit: p.photo.credit, source: p.target.source });
    }
    for (const d of toDelete) bump(`would-delete-${d.suppressed ? "suppressed" : "other"}`);
    return finish(errors.length || hold ? "partial" : "succeeded", undefined, heldCount);
  }

  // Unchanged: the same file. Refresh the text Commons may have corrected.
  for (const p of toTouch) {
    try {
      const { college_id: _id, storage_path: _s, thumb_path: _t, commons_sha1: _h, ...fields } = rowOf(p, { full: p.prev!.storage_path, thumb: p.prev!.thumb_path });
      await store.touch(p.college.id, fields);
      bump("unchanged");
      unchanged++;
    } catch (err) {
      errors.push(`${p.college.unitid}: ${err instanceof Error ? err.message.slice(0, 200) : "touch failed"}`);
    }
  }

  // New or changed: the 500 px URLs, then both copies, then the row, then the old objects.
  const thumbs = new Map<string, Page | null>();
  const downloadTitles = [...new Set(toDownload.map((p) => p.photo.title))];
  for (let i = 0; i < downloadTitles.length; i += BATCH) {
    const batch = downloadTitles.slice(i, i + BATCH);
    try {
      for (const [t, p] of resolvePages(await deps.imageinfo(batch, WIDTHS.thumb, false), batch)) thumbs.set(t, p);
    } catch (err) {
      errors.push(`commons thumbs batch ${i / BATCH + 1}: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
    }
  }
  await inPool(toDownload, 2, async (p) => {
    try {
      const thumbUrl = thumbUrlOf(thumbs.get(p.photo.title));
      if (!thumbUrl) throw new Error("no 500 px thumbnail");
      const paths = storagePaths(p.college.unitid, p.photo.sha1);
      const full = await deps.download(p.photo.fullUrl);
      const thumb = await deps.download(thumbUrl);
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
      errors.push(`${p.college.unitid}: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
    }
  });

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

  const status: PhotoOutcome["status"] =
    errors.length === 0 ? "succeeded" : written + unchanged + deleted > 0 ? "partial" : "failed";
  return finish(status, undefined, heldCount);
}
