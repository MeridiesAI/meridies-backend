/**
 * Looking a school up for its picture and its logo, by hand (POST
 * /colleges/:id/lookup), automatically when a page shows a school without
 * them (GET /colleges/media, `lookUpMediaSoon`), and in bulk
 * (scripts/ingest/college-media.ts).
 *
 * One read of the school's home page serves both: the photo follows
 * lib/collegeLookup.ts (Commons by name, else the site's share image), the
 * logo lib/collegeLogos.ts (the site's own icon). Neither replaces what a
 * school already has. No model is called, so the automatic lookup spends no
 * AI budget; it is bounded by a small queue (two at a time per instance, a
 * hundred waiting at most) and a week between tries for the same school
 * (in memory, and `college_logos.checked_at` across deploys).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPageMeta, type PageMeta } from "./links.js";
import { collegeHost } from "./eventsDiscovery.js";
import { lookUpCollege, type LookupOutcome } from "./collegeLookup.js";
import { isMissingPhotoSchema } from "./collegePhotos.js";
import { isMissingLogoSchema, logoPublicUrl, lookUpLogo, supabaseLogoStore } from "./collegeLogos.js";
import { supabasePhotoStore } from "./ingest/collegePhotos.js";
import { wikimediaClient } from "./ingest/wikimedia.js";
import { serviceClient } from "./supabase.js";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export const RETRY_AFTER_MS = 7 * 24 * 3600_000;
const MAX_IN_FLIGHT = 2;
const MAX_QUEUED = 100;

export type MediaCollege = { id: string; name: string; unitid: number | null; website: string | null };

export type MediaOutcome = LookupOutcome & { logoUrl: string | null; logoNote: string | null };

/** What the school has now: a photo row, and a logo row (with or without a stored icon). Null on a missing table. */
async function current(svc: SupabaseClient, id: string) {
  const [photo, logo] = await Promise.all([
    svc.from("college_photos").select("college_id").eq("college_id", id).maybeSingle(),
    svc.from("college_logos").select("storage_path, checked_at").eq("college_id", id).maybeSingle(),
  ]);
  return {
    photosReady: !photo.error || !isMissingPhotoSchema(photo.error.code),
    hasPhoto: !!photo.data,
    logosReady: !logo.error || !isMissingLogoSchema(logo.error.code),
    logoPath: (logo.data as { storage_path: string | null } | null)?.storage_path ?? null,
  };
}

/**
 * Look one school up: its photo when it has none (and the photo table is
 * there), its logo when it has none (and the logo table is there). One read
 * of its home page for both.
 */
export async function lookUpMedia(svc: SupabaseClient, college: MediaCollege, log?: Log): Promise<MediaOutcome> {
  const now = await current(svc, college.id);
  const host = collegeHost(college.website);
  let meta: PageMeta | null = null;
  if (college.website) {
    try {
      meta = await fetchPageMeta(/^https?:\/\//i.test(college.website) ? college.website : `https://${college.website}`);
    } catch (err) {
      log?.warn({ err: err instanceof Error ? err.message : "failed" }, "college media: site not read");
    }
  }

  const photoOutcome: LookupOutcome = now.photosReady
    ? await lookUpCollege(college, {
        commons: wikimediaClient(),
        store: supabasePhotoStore(svc),
        hasPhoto: now.hasPhoto,
        log,
        fetchMeta: async () => {
          if (!meta) throw new Error("site not read");
          return meta;
        },
      })
    : { site: meta ? { url: meta.finalUrl, title: meta.title, description: meta.description } : null, photo: null, photoNote: null };

  let logoUrl: string | null = now.logoPath ? logoPublicUrl(now.logoPath) : null;
  let logoNote: string | null = null;
  if (now.logosReady && !now.logoPath) {
    try {
      const o = await lookUpLogo(college, meta, host, { ...supabaseLogoStore(svc), log });
      logoUrl = o.storagePath ? logoPublicUrl(o.storagePath) : null;
      logoNote = o.note;
    } catch (err) {
      log?.warn({ err: err instanceof Error ? err.message : "failed" }, "college media: logo not stored");
    }
  }
  return { ...photoOutcome, logoUrl, logoNote };
}

// ---- The automatic lookup ---------------------------------------------------------------------

const attempted = new Map<string, number>();
const queue: MediaCollege[] = [];
let inFlight = 0;

/** For tests. */
export function resetMediaQueue(): void {
  attempted.clear();
  queue.length = 0;
}

/**
 * Queue lookups for schools a page just showed without a photo or a logo.
 * Returns the ids queued or still being looked up, so the page knows to ask
 * again. A school tried in the past week (here, or `checkedAt` from
 * college_logos) is left alone. Nothing happens without the service role key.
 */
export function lookUpMediaSoon(
  colleges: (MediaCollege & { checkedAt?: string | null })[],
  log: Log,
  now: number = Date.now()
): string[] {
  const svc = serviceClient();
  if (!svc) return [];
  const started: string[] = [];
  for (const c of colleges) {
    if (!collegeHost(c.website)) continue;
    const checked = c.checkedAt ? Date.parse(c.checkedAt) : NaN;
    if (Number.isFinite(checked) && now - checked < RETRY_AFTER_MS) continue;
    const last = attempted.get(c.id);
    if (last !== undefined && now - last < RETRY_AFTER_MS) {
      if (queue.some((q) => q.id === c.id) || last > now - 2 * 60_000) started.push(c.id);
      continue;
    }
    if (queue.length >= MAX_QUEUED) break;
    attempted.set(c.id, now);
    queue.push(c);
    started.push(c.id);
  }
  drain(svc, log);
  return started;
}

function drain(svc: SupabaseClient, log: Log) {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const college = queue.shift()!;
    inFlight += 1;
    void (async () => {
      try {
        const o = await lookUpMedia(svc, college, log);
        log.info({ collegeId: college.id, photo: !!o.photo, logo: !!o.logoUrl }, "college media: looked a school up");
      } catch (err) {
        log.warn({ collegeId: college.id, err: err instanceof Error ? err.message : "unknown" }, "college media: lookup failed");
      } finally {
        inFlight -= 1;
        drain(svc, log);
      }
    })();
  }
}
