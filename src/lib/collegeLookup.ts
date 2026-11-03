/**
 * College Search "Look up info & photo" (POST /colleges/:id/lookup).
 *
 * Reads the college's own site for what it declares about itself (title and
 * description) and tries to find a picture of the campus, in this order:
 *
 *   1. Wikimedia Commons, searched by the school's name. A file counts only if
 *      its name contains every word of the school's name as a whole word (bar
 *      "the/of/at…" and university/college), names no other kind of school or
 *      "State" the school's name lacks (`titleNamesCollege`), and it
 *      passes the same rules as the monthly loader (`choosePhoto`: JPEG, big
 *      enough, CC0 / public domain / CC BY / CC BY-SA, a credit). Stored as
 *      source `commons-search`, with the Commons credit and license.
 *   2. The college site's own share images (og:image and its siblings, up to
 *      three tried), from the college's host or a subdomain of it, a JPEG, PNG
 *      or WebP of at most 3 MB, at least 800 px wide and landscape. Each is
 *      converted to a 1280 px and a real 500 px JPEG (lib/imageConvert.ts).
 *      Stored as source `site`, credited to the university's website with a
 *      link back to the page. It is not freely licensed; the credit says whose
 *      it is.
 *
 * Both are copied into the public college-photos bucket (never hotlinked) and
 * written with the service role, like the loader's. A school that already has
 * a photo is left alone.
 */

import { createHash } from "node:crypto";
import { fetchImageAny, fetchPageMeta, type PageMeta } from "./links.js";
import { collegeHost } from "./eventsDiscovery.js";
import { jpegSize, toStoredJpegs, type StoredImage } from "./imageConvert.js";
import {
  WIDTHS,
  choosePhoto,
  resolvePages,
  sameVersion,
  storagePaths,
  thumbUrlOf,
  type PhotoRow,
  type PhotoStore,
} from "./ingest/collegePhotos.js";
import type { WikimediaClient } from "./ingest/wikimedia.js";
import { MAX_BYTES } from "./ingest/wikimedia.js";

const MIN_SITE_WIDTH = 800;
/** How many of a page's declared images are tried before giving up. */
const SITE_CANDIDATES = 3;
const COMMONS_CANDIDATES = 12;
/** How many Commons results to ask for before the name check and the ranking pick the best twelve. */
const COMMONS_SEARCH_LIMIT = 20;
/** Words that don't tell one school from another. */
const FILLER = new Set(["the", "of", "at", "in", "and", "for"]);
/** The kind of institution: a title may leave it out, but may not name a different kind. */
const TYPE_WORDS = new Set(["university", "college", "institute", "school"]);

export type LookupPhoto = { source: "commons-search" | "site"; storagePath: string };

export type LookupOutcome = {
  /** The page's own words, when the site could be read. */
  site: { url: string; title: string | null; description: string | null } | null;
  /** What was stored this time; null when none was found or the school already had one. */
  photo: LookupPhoto | null;
  /** Why there is no photo, in words for a toast. */
  photoNote: string | null;
};

export type LookupCollege = { id: string; name: string; unitid: number | null; website: string | null };

export type LookupDeps = {
  commons: Pick<WikimediaClient, "search" | "imageinfo" | "download">;
  store: Pick<PhotoStore, "upsert" | "upload">;
  fetchMeta?: (url: string) => Promise<PageMeta>;
  fetchImage?: (url: string, maxBytes: number) => Promise<{ finalUrl: string; bytes: Buffer }>;
  /** Bytes to the stored sizes; null when they can't be one (lib/imageConvert.ts). */
  convert?: (bytes: Buffer) => Promise<StoredImage | null>;
  hasPhoto: boolean;
  log?: { warn: (o: object, m?: string) => void };
};

/** Whole lowercase words: accents folded away, and "A&M" kept as the one word "am". */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\b([a-z])\s*&\s*([a-z])\b/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** The words of a school's name that a Commons file name must all contain, as whole words. */
export function nameWords(name: string): string[] {
  const words = tokens(name).filter((w) => w.length > 1 && !FILLER.has(w) && !TYPE_WORDS.has(w));
  return [...new Set(words)];
}

/**
 * Whether a Commons title names this school. Every word of its name must be a
 * whole word of the title ("rice" is not in "price"), the title may leave out
 * "university"/"college" but may not name a different kind (Boston College is
 * not Boston University), and it may say "State" only if the name does (Ohio
 * University is not Ohio State).
 */
export function titleNamesCollege(title: string, name: string): boolean {
  const words = nameWords(name);
  if (words.length === 0) return false;
  const have = new Set(tokens(title));
  if (!words.every((w) => have.has(w))) return false;
  const named = new Set(tokens(name));
  for (const t of TYPE_WORDS) if (have.has(t) && !named.has(t)) return false;
  return !(have.has("state") && !named.has("state"));
}

/** Title words that mark a picture that isn't a photograph of the campus as it is. */
const JUNK_WORDS = new Set([
  "map", "maps", "plan", "logo", "seal", "sign", "signs", "signage", "plaque", "flag", "diagram", "crest", "emblem",
  "poster", "stamp", "postcard", "print", "engraving", "drawing", "sketch", "store", "bookstore", "rock", "wordmark", "icon",
  "painting", "paintings", "aquatint", "lithograph", "illustration", "vintage",
]);

/** A year before 1990 in a title is an old print or a historic photograph. */
const OLD_YEAR = /^(1[0-8]\d\d|19[0-8]\d)$/;

/**
 * The name-matched Commons titles, best first. `choosePhoto` is strict (a large
 * landscape JPEG under a free licence), so which few files are tried matters:
 * a title that holds the school's whole name as a phrase comes first ("University
 * of Vermont Billings Library" before "Northern Vermont University Lyndon"), and
 * maps, signs, logos and pre-1990 prints go last. Equal scores keep Commons'
 * own order. Pure; drops nothing.
 */
export function rankCommonsTitles(titles: string[], name: string): string[] {
  const phrase = ` ${tokens(name).join(" ")} `;
  const score = (title: string): number => {
    const words = tokens(title.replace(/^File:/i, "").replace(/\.[a-z0-9]{2,4}$/i, ""));
    let n = ` ${words.join(" ")} `.includes(phrase) ? 3 : 0;
    if (words.some((w) => JUNK_WORDS.has(w))) n -= 5;
    if (words.some((w) => OLD_YEAR.test(w))) n -= 2;
    return n;
  };
  return titles
    .map((title, order) => ({ title, order, score: score(title) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.title);
}

export { jpegSize };

/** The URL's host is the college's host or one of its subdomains. */
export function onOwnHost(url: string, host: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

const sha1Of = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex");

async function fromCommons(college: LookupCollege & { unitid: number }, d: LookupDeps): Promise<LookupPhoto | null> {
  const found = await d.commons.search(`${college.name} campus`, COMMONS_SEARCH_LIMIT);
  const titles = rankCommonsTitles(
    found.filter((t) => titleNamesCollege(t, college.name)),
    college.name
  ).slice(0, COMMONS_CANDIDATES);
  if (!titles.length) return null;

  const pages = resolvePages(await d.commons.imageinfo(titles, WIDTHS.full, true), titles);
  let chosen: ReturnType<typeof choosePhoto> | null = null;
  for (const t of titles) {
    const c = choosePhoto(pages.get(t));
    if (c.ok) {
      chosen = c;
      break;
    }
  }
  if (!chosen || !chosen.ok) return null;
  const photo = chosen.photo;

  const small = resolvePages(await d.commons.imageinfo([photo.title], WIDTHS.thumb, false), [photo.title]).get(photo.title);
  const thumbUrl = thumbUrlOf(small);
  if (!thumbUrl) return null;
  const [full, thumb] = [await d.commons.download(photo.fullUrl), await d.commons.download(thumbUrl)];

  // The bytes must be the version that was judged: ask again after downloading.
  const again = resolvePages(await d.commons.imageinfo([photo.title], WIDTHS.full, false), [photo.title]).get(photo.title);
  if (!sameVersion(again, photo)) return null;

  const paths = storagePaths(college.unitid, photo.sha1);
  await d.store.upload(paths.full, full);
  await d.store.upload(paths.thumb, thumb);
  await d.store.upsert({
    college_id: college.id,
    source: "commons-search",
    wikidata_id: null,
    commons_title: photo.title,
    commons_sha1: photo.sha1,
    storage_path: paths.full,
    thumb_path: paths.thumb,
    width: photo.width,
    height: photo.height,
    credit: photo.credit,
    license: photo.license,
    license_url: photo.licenseUrl,
    source_url: photo.sourceUrl,
    checked_at: new Date().toISOString(),
  } satisfies PhotoRow);
  return { source: "commons-search", storagePath: paths.full };
}

async function fromSite(
  college: LookupCollege & { unitid: number },
  host: string,
  meta: PageMeta,
  d: LookupDeps
): Promise<LookupPhoto | null> {
  const declared = meta.images ?? (meta.image ? [meta.image] : []);
  const candidates = declared.filter((u) => onOwnHost(u, host)).slice(0, SITE_CANDIDATES);
  for (const url of candidates) {
    let img: { finalUrl: string; bytes: Buffer };
    let stored: StoredImage | null;
    try {
      img = await (d.fetchImage ?? fetchImageAny)(url, MAX_BYTES);
      stored = await (d.convert ?? toStoredJpegs)(img.bytes);
    } catch (err) {
      // One bad candidate (a 404, a type we don't take) doesn't end the search.
      d.log?.warn({ err: err instanceof Error ? err.message : "failed" }, "college lookup: site image skipped");
      continue;
    }
    if (!stored || stored.srcWidth < MIN_SITE_WIDTH || stored.srcWidth < stored.srcHeight) continue;

    const sha1 = sha1Of(img.bytes);
    const paths = storagePaths(college.unitid, sha1);
    await d.store.upload(paths.full, stored.full);
    await d.store.upload(paths.thumb, stored.thumb);
    await d.store.upsert({
      college_id: college.id,
      source: "site",
      wikidata_id: null,
      commons_title: null,
      commons_sha1: sha1,
      storage_path: paths.full,
      thumb_path: paths.thumb,
      width: stored.width,
      height: stored.height,
      credit: college.name,
      license: "University website",
      license_url: null,
      source_url: meta.finalUrl,
      checked_at: new Date().toISOString(),
    } satisfies PhotoRow);
    return { source: "site", storagePath: paths.full };
  }
  return null;
}

export async function lookUpCollege(college: LookupCollege, d: LookupDeps): Promise<LookupOutcome> {
  const host = collegeHost(college.website);
  let meta: PageMeta | null = null;
  if (college.website) {
    try {
      meta = await (d.fetchMeta ?? fetchPageMeta)(/^https?:\/\//i.test(college.website) ? college.website : `https://${college.website}`);
    } catch (err) {
      d.log?.warn({ err: err instanceof Error ? err.message : "failed" }, "college lookup: site not read");
    }
  }
  const site = meta ? { url: meta.finalUrl, title: meta.title, description: meta.description } : null;

  if (d.hasPhoto) return { site, photo: null, photoNote: null };
  if (college.unitid === null) return { site, photo: null, photoNote: "This school has no federal id on file, so a photo can't be stored for it." };
  const withId = { ...college, unitid: college.unitid };

  let photo: LookupPhoto | null = null;
  try {
    photo = await fromCommons(withId, d);
  } catch (err) {
    d.log?.warn({ err: err instanceof Error ? err.message : "failed" }, "college lookup: Commons failed");
  }
  if (!photo && meta && host) {
    try {
      photo = await fromSite(withId, host, meta, d);
    } catch (err) {
      d.log?.warn({ err: err instanceof Error ? err.message : "failed" }, "college lookup: site image failed");
    }
  }
  return {
    site,
    photo,
    photoNote: photo ? null : "No usable picture was found on Wikimedia Commons or the school's website.",
  };
}
