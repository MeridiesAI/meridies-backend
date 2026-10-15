import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parsePicks,
  runCollegePhotoIngest,
  storagePaths,
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

function fakeStore(opts: { stored?: StoredPhoto[]; probe?: "ok" | "no-schema" | "error"; failUpload?: boolean; colleges?: typeof COLLEGES } = {}) {
  const rows = new Map<string, PhotoRow | StoredPhoto>((opts.stored ?? []).map((s) => [s.college_id, s]));
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
  };
  return { store, rows, objects, runs, touched, uploads };
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
  assert.deepEqual(attached, ["c-berkeley", "c-binghamton", "c-brown", "c-mit", "c-penn", "c-rochester", "c-stanford", "c-swarthmore"].sort());
  for (const slug of ["cornell", "yale", "columbia", "dartmouth", "lehigh", "tufts", "vassar", "bucknell", "union", "hamilton", "stonybrook", "notinwikidata"]) {
    assert.equal(s.rows.has(idOf(slug)), false, slug);
  }
  const mit = s.rows.get("c-mit") as PhotoRow;
  assert.equal(mit.source, "wikidata");
  assert.equal(mit.wikidata_id, "Q49108");
  assert.equal(mit.credit, "José & Co.");
  assert.match(mit.storage_path, /^166683\/[0-9a-f]{40}-1280\.jpg$/);
  assert.ok(s.objects.has(mit.storage_path) && s.objects.has(mit.thumb_path));
  // The moved file is stored under its new name, the normalized one under Commons' form.
  assert.equal((s.rows.get("c-penn") as PhotoRow).commons_title, "File:College Hall, University of Pennsylvania.jpg");
  assert.equal((s.rows.get("c-berkeley") as PhotoRow).commons_title, "File:Sather Tower été.jpg");
  assert.equal((s.rows.get("c-brown") as PhotoRow).commons_title, "File:Aerial view of Brown University.jpg");
  // Every download came from the upload host, at the two widths.
  assert.equal(calls.downloads.length, 16);
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
  assert.equal(s.runs[0]!.finish!.rows_upserted, 8);
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

test("an unchanged file (same sha1) is not downloaded again; its text is refreshed", async () => {
  const title = "File:Great dome of MIT, Feb 2021.jpg";
  const sha1 = await sha1Of(title);
  const s = fakeStore({ stored: [stored("mit", title, sha1)] });
  const { deps, calls } = fakeDeps();
  const out = await runCollegePhotoIngest(s.store, deps, log, { only: [166683] });
  assert.equal(out.status, "succeeded");
  assert.equal(calls.downloads.length, 0);
  assert.deepEqual(s.touched, ["c-mit"]);
  assert.equal((s.rows.get("c-mit") as PhotoRow).credit, "José & Co.");
  assert.equal(out.counts.unchanged, 1);
  assert.equal(calls.imageinfo.filter((c) => c.width === 500).length, 0, "no thumbnail lookup when nothing downloads");
});

test("a file that changed on Commons gets new objects, and the old ones go", async () => {
  const old = stored("mit", "File:Great dome of MIT, Feb 2021.jpg", "f".repeat(40));
  const s = fakeStore({ stored: [old] });
  const out = await runCollegePhotoIngest(s.store, fakeDeps().deps, log, { only: [166683] });
  assert.equal(out.counts.replaced, 1);
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
  assert.equal(out.counts["would-add"], 8);
  const mit = out.attach.find((a) => a.unitid === 166683);
  assert.deepEqual(mit, { unitid: 166683, name: "mit", title: "File:Great dome of MIT, Feb 2021.jpg", license: "CC BY-SA 4.0", credit: "José & Co.", source: "wikidata" });
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
