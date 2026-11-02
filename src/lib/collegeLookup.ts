/**
 * College Search "Look up info & photo" (POST /colleges/:id/lookup).
 *
 * Reads the college's own site for what it declares about itself (title and
 * description) and tries to find a picture of the campus, in this order:
 *
 *   1. Wikimedia Commons, searched by the school's name. A file counts only if
 *      its name contains every significant word of the school's name, and it
 *      passes the same rules as the monthly loader (`choosePhoto`: JPEG, big
 *      enough, CC0 / public domain / CC BY / CC BY-SA, a credit). Stored as
 *      source `commons-search`, with the Commons credit and license.
 *   2. The college site's own share image (og:image), from the college's host
 *      or a subdomain of it, a JPEG of at most 3 MB. Stored as source `site`,
 *      credited to the university's website with a link back to the page. It
 *      is not freely licensed; the credit says whose it is.
 *
 * Both are copied into the public college-photos bucket (never hotlinked) and
 * written with the service role, like the loader's. A school that already has
 * a photo is left alone.
 */

import { createHash } from "node:crypto";
import { fetchJpeg, fetchPageMeta, type PageMeta } from "./links.js";
import { collegeHost } from "./eventsDiscovery.js";
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
const COMMONS_CANDIDATES = 6;
const NAME_STOPWORDS = new Set(["the", "of", "at", "in", "and", "for", "university", "college", "institute", "school", "state"]);

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
  hasPhoto: boolean;
  log?: { warn: (o: object, m?: string) => void };
};

/** The words of a school's name that a Commons file name must all contain. */
export function nameWords(name: string): string[] {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !NAME_STOPWORDS.has(w));
  return [...new Set(words)];
}

/** Whether a Commons title names this school (every significant word of its name). */
export function titleNamesCollege(title: string, name: string): boolean {
  const words = nameWords(name);
  if (words.length === 0) return false;
  const t = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ");
  return words.every((w) => t.includes(w));
}

/** Width and height from a baseline or progressive JPEG's frame header; null if unreadable. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

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
  const found = await d.commons.search(`${college.name} campus`, 12);
  const titles = found.filter((t) => titleNamesCollege(t, college.name)).slice(0, COMMONS_CANDIDATES);
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
  if (!meta.image || !onOwnHost(meta.image, host)) return null;
  const img = await (d.fetchImage ?? fetchJpeg)(meta.image, MAX_BYTES);
  const size = jpegSize(img.bytes);
  if (!size || size.width < MIN_SITE_WIDTH || size.width < size.height) return null;

  const sha1 = sha1Of(img.bytes);
  const paths = storagePaths(college.unitid, sha1);
  // One copy under both names: there is no image library here to make a 500 px one.
  await d.store.upload(paths.full, img.bytes);
  await d.store.upload(paths.thumb, img.bytes);
  await d.store.upsert({
    college_id: college.id,
    source: "site",
    wikidata_id: null,
    commons_title: null,
    commons_sha1: sha1,
    storage_path: paths.full,
    thumb_path: paths.thumb,
    width: size.width,
    height: size.height,
    credit: college.name,
    license: "University website",
    license_url: null,
    source_url: meta.finalUrl,
    checked_at: new Date().toISOString(),
  } satisfies PhotoRow);
  return { source: "site", storagePath: paths.full };
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
