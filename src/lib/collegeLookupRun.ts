/**
 * What POST /colleges/:id/lookup does, minus the HTTP and the database: the
 * order of the steps and the rules between them, so they can be tested with
 * stand-ins (the route hands in the real reads, writes and model call).
 *
 *   1. A saved row is "fresh" for 30 days (a day, when no model read the pages)
 *      and `refresh` skips that. A fresh row for a school that already has a
 *      photo answers at once: no fetch, no model, no write.
 *   2. Otherwise the home page is read once. The facts (lib/collegeSiteInfo.ts)
 *      and the picture hunt (lib/collegeLookup.ts) then run AT THE SAME TIME,
 *      the picture hunt reusing that page's head instead of fetching it again,
 *      both under one deadline (45 s from the start).
 *   3. A thin result (no model read the pages, so only the school's own
 *      description) is never allowed to replace a saved row a model did read.
 *   4. Nothing here throws for a missing table, a slow site, a failed save or a
 *      failed picture: each costs only its own part, with a plain-words note.
 */

import type { LookupOutcome, LookupPhoto } from "./collegeLookup.js";
import { isFresh, toSiteInfo, toSiteInfoRow, type CollegeSiteInfo, type SiteInfoOutcome, type SiteInfoRow } from "./collegeSiteInfo.js";
import type { PageMeta, SitePage } from "./links.js";

export const LOOKUP_DEADLINE_MS = 45_000;
const HOME_DEADLINE_MS = 20_000;

export type LookupRunDeps = {
  now?: () => Date;
  /** The whole lookup's budget; the home page gets at most 20 s of it. */
  deadlineMs?: number;
  /** The saved row, or `missing` when the table isn't applied yet. Never throws. */
  readSiteInfo(): Promise<{ row: SiteInfoRow | null; missing: boolean }>;
  /** Saves a row; "missing" when the table isn't applied yet. May throw on a real failure. */
  writeSiteInfo(row: SiteInfoRow): Promise<"ok" | "missing">;
  fetchHome(url: string): Promise<SitePage>;
  buildInfo(home: SitePage): Promise<SiteInfoOutcome>;
  /** The picture hunt, handed the page head already read. */
  lookUpPhoto(fetchMeta: (url: string) => Promise<PageMeta>): Promise<LookupOutcome>;
  log?: { warn: (o: object, m?: string) => void };
};

export type LookupRun = {
  /** What the home page declares about itself; for a fresh saved row, its URL and description. */
  site: { url: string; title: string | null; description: string | null } | null;
  info: CollegeSiteInfo | null;
  /** True when `info` is a saved row rather than something read just now. */
  cached: boolean;
  photo: LookupPhoto | null;
  photoNote: string | null;
  /** Why the facts are missing or thin, in words for a toast. */
  infoNote: string | null;
};

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline")), Math.max(1, ms));
  });
  // Promise.race subscribes to `p`, so a late rejection of the loser is handled.
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const reason = (err: unknown) => (err instanceof Error ? err.message : "failed");

export async function runCollegeLookup(
  college: { id: string; name: string; website: string },
  o: { refresh: boolean; hasPhoto: boolean },
  d: LookupRunDeps
): Promise<LookupRun> {
  const startedAt = Date.now();
  const budget = d.deadlineMs ?? LOOKUP_DEADLINE_MS;
  const remaining = () => budget - (Date.now() - startedAt);
  const now = d.now?.() ?? new Date();
  const url = /^https?:\/\//i.test(college.website) ? college.website : `https://${college.website}`;

  const stored = await d.readSiteInfo();
  const saved = toSiteInfo(stored.row);
  const fresh = !o.refresh && isFresh(stored.row, now);

  if (fresh && o.hasPhoto) {
    return {
      site: saved ? { url: saved.sourceUrl, title: null, description: saved.about } : null,
      info: saved,
      cached: true,
      photo: null,
      photoNote: null,
      infoNote: null,
    };
  }

  let home: SitePage | null = null;
  try {
    home = await withDeadline(d.fetchHome(url), Math.min(HOME_DEADLINE_MS, remaining()));
  } catch (err) {
    d.log?.warn({ err: reason(err) }, "college lookup: site not read");
  }
  const head = home;

  type InfoResult = { info: CollegeSiteInfo | null; cached: boolean; note: string | null };
  const readInfo = async (): Promise<InfoResult> => {
    if (fresh) return { info: saved, cached: true, note: null };
    if (!home) return { info: saved, cached: saved !== null, note: `Couldn't read ${college.name}'s site.` };
    const built = await d.buildInfo(home);
    if (!built.info) return { info: saved, cached: saved !== null, note: built.note };
    // Only the description was kept: don't trade facts a model read for it.
    if (built.model === null && stored.row?.model) return { info: saved, cached: true, note: built.note };
    try {
      await d.writeSiteInfo(toSiteInfoRow(college.id, built.info, built.model));
    } catch (err) {
      d.log?.warn({ err: reason(err) }, "college lookup: facts not saved");
    }
    return { info: built.info, cached: false, note: built.note };
  };

  const fetchMeta = async (): Promise<PageMeta> => {
    if (!head) throw new Error("site not read");
    return head.meta;
  };

  const [infoR, photoR] = await Promise.allSettled([
    withDeadline(readInfo(), remaining()),
    withDeadline(d.lookUpPhoto(fetchMeta), remaining()),
  ]);

  let info: InfoResult;
  if (infoR.status === "fulfilled") {
    info = infoR.value;
  } else {
    const slow = reason(infoR.reason) === "deadline";
    d.log?.warn({ err: reason(infoR.reason) }, "college lookup: facts step failed");
    info = {
      info: saved,
      cached: saved !== null,
      note: slow ? `Reading ${college.name}'s pages took too long.` : `Couldn't read ${college.name}'s pages.`,
    };
  }

  let photo: LookupPhoto | null = null;
  let photoNote: string | null;
  if (photoR.status === "fulfilled") {
    photo = photoR.value.photo;
    photoNote = photoR.value.photoNote;
  } else {
    d.log?.warn({ err: reason(photoR.reason) }, "college lookup: picture step failed");
    photoNote = "Looking for a picture didn't finish.";
  }

  return {
    site: home ? { url: home.meta.finalUrl, title: home.meta.title, description: home.meta.description } : null,
    info: info.info,
    cached: info.cached,
    photo,
    photoNote,
    infoNote: info.note,
  };
}
