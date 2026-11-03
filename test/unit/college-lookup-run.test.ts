import assert from "node:assert/strict";
import { test } from "node:test";
import { runCollegeLookup, type LookupRunDeps } from "../../src/lib/collegeLookupRun.js";
import { toSiteInfoRow, type CollegeSiteInfo, type SiteInfoOutcome, type SiteInfoRow } from "../../src/lib/collegeSiteInfo.js";
import type { LookupOutcome } from "../../src/lib/collegeLookup.js";
import type { SitePage } from "../../src/lib/links.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const college = { id: "c1", name: "Example University", website: "www.example.edu" };
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const info = (over: Partial<CollegeSiteInfo> = {}): CollegeSiteInfo => ({
  sourceUrl: "https://www.example.edu/",
  pages: ["https://www.example.edu/"],
  about: "A small college.",
  deadlines: [{ plan: "ED", date: "November 1", evidence: "Early Decision applications are due November 1." }],
  testPolicy: null,
  essaysRecs: null,
  programs: ["Biology"],
  fetchedAt: ago(1),
  scraped: true,
  ...over,
});
const rowOf = (over: Partial<SiteInfoRow> = {}, i = info()): SiteInfoRow => ({ ...toSiteInfoRow("c1", i, "m"), ...over });

const home: SitePage = {
  finalUrl: "https://www.example.edu/",
  title: "Example",
  text: "Welcome",
  links: [],
  meta: { finalUrl: "https://www.example.edu/", title: "Example", description: "From the head.", image: null, images: [] },
};
const photoNone: LookupOutcome = { site: null, photo: null, photoNote: "No usable picture was found." };

type Calls = { read: number; write: SiteInfoRow[]; home: string[]; build: number; photo: number };
function setup(over: Partial<LookupRunDeps> & { stored?: SiteInfoRow | null; missing?: boolean } = {}) {
  const calls: Calls = { read: 0, write: [], home: [], build: 0, photo: 0 };
  const deps: LookupRunDeps = {
    now: () => NOW,
    readSiteInfo: async () => (calls.read++, { row: over.stored ?? null, missing: over.missing ?? false }),
    writeSiteInfo: async (row) => (calls.write.push(row), "ok"),
    fetchHome: async (url) => (calls.home.push(url), home),
    buildInfo: async () => (calls.build++, { info: info({ fetchedAt: NOW.toISOString() }), model: "m", note: null } satisfies SiteInfoOutcome),
    lookUpPhoto: async () => (calls.photo++, photoNone),
    log: { warn: () => {} },
    ...over,
  };
  delete (deps as Record<string, unknown>).stored;
  delete (deps as Record<string, unknown>).missing;
  return { calls, deps };
}

test("a fresh saved lookup for a school that has a photo costs nothing: no fetch, no model, no write", async () => {
  const { calls, deps } = setup({ stored: rowOf({ fetched_at: ago(3) }) });
  const out = await runCollegeLookup(college, { refresh: false, hasPhoto: true }, deps);
  assert.equal(out.cached, true);
  assert.equal(out.info?.about, "A small college.");
  assert.deepEqual(out.site, { url: "https://www.example.edu/", title: null, description: "A small college." });
  assert.equal(out.photo, null);
  assert.deepEqual([calls.home.length, calls.build, calls.photo, calls.write.length], [0, 0, 0, 0]);
});

test("a fresh saved lookup still goes after a missing photo, without reading the pages for facts again", async () => {
  const { calls, deps } = setup({ stored: rowOf({ fetched_at: ago(3) }) });
  const out = await runCollegeLookup(college, { refresh: false, hasPhoto: false }, deps);
  assert.equal(out.cached, true);
  assert.equal(out.photoNote, "No usable picture was found.");
  assert.deepEqual([calls.home.length, calls.build, calls.photo, calls.write.length], [1, 0, 1, 0]);
  assert.equal(out.site?.description, "From the head.");
});

test("no saved row, a stale row, or Refresh reads the site, builds the facts and saves them", async () => {
  for (const [label, stored, refresh] of [
    ["none", null, false],
    ["stale", rowOf({ fetched_at: ago(31) }), false],
    ["refresh", rowOf({ fetched_at: ago(1) }), true],
  ] as const) {
    const { calls, deps } = setup({ stored });
    const out = await runCollegeLookup(college, { refresh, hasPhoto: true }, deps);
    assert.equal(out.cached, false, label);
    assert.equal(out.info?.fetchedAt, NOW.toISOString(), label);
    assert.deepEqual([calls.home, calls.build, calls.write.length], [["https://www.example.edu"], 1, 1], label);
    assert.equal(calls.write[0]!.college_id, "c1", label);
    assert.equal(calls.write[0]!.model, "m", label);
  }
});

test("the site is read once, and the facts and the picture are looked for at the same time", async () => {
  const order: string[] = [];
  let releaseInfo!: (o: SiteInfoOutcome) => void;
  let releasePhoto!: (o: LookupOutcome) => void;
  const { calls, deps } = setup({
    buildInfo: () => (order.push("info started"), new Promise<SiteInfoOutcome>((r) => (releaseInfo = r))),
    lookUpPhoto: async (fetchMeta) => {
      order.push("photo started");
      const meta = await fetchMeta("https://www.example.edu");
      assert.equal(meta, home.meta, "the photo hunt reuses the page already read");
      return new Promise<LookupOutcome>((r) => (releasePhoto = r));
    },
  });
  const run = runCollegeLookup(college, { refresh: true, hasPhoto: false }, deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order.sort(), ["info started", "photo started"]);
  releasePhoto({ site: null, photo: { source: "site", storagePath: "123456/x-1280.jpg" }, photoNote: null });
  releaseInfo({ info: info({ fetchedAt: NOW.toISOString() }), model: "m", note: null });
  const out = await run;
  assert.equal(out.photo?.source, "site");
  assert.equal(out.info?.about, "A small college.");
  assert.equal(calls.home.length, 1);
});

test("a thin result (no model read the pages) never replaces a saved row a model did read", async () => {
  const good = rowOf({ fetched_at: ago(40) });
  const { calls, deps } = setup({
    stored: good,
    buildInfo: async () => ({ info: info({ about: "Only the description.", deadlines: [], programs: [] }), model: null, note: "You've hit today's AI limit." }),
  });
  const out = await runCollegeLookup(college, { refresh: true, hasPhoto: true }, deps);
  assert.equal(calls.write.length, 0);
  assert.equal(out.cached, true);
  assert.equal(out.info?.about, "A small college.");
  assert.equal(out.infoNote, "You've hit today's AI limit.");
});

test("a thin result is saved when there is nothing saved yet, and says why it is thin", async () => {
  const { calls, deps } = setup({
    buildInfo: async () => ({ info: info({ about: "Only the description.", deadlines: [], programs: [] }), model: null, note: "Summaries aren't available right now." }),
  });
  const out = await runCollegeLookup(college, { refresh: false, hasPhoto: true }, deps);
  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0]!.model, null);
  assert.equal(out.info?.about, "Only the description.");
  assert.equal(out.infoNote, "Summaries aren't available right now.");
});

test("without the table the lookup still answers: facts returned, nothing saved, no error", async () => {
  const { deps } = setup({ missing: true, writeSiteInfo: async () => "missing" });
  const out = await runCollegeLookup(college, { refresh: false, hasPhoto: false }, deps);
  assert.equal(out.info?.about, "A small college.");
  assert.equal(out.cached, false);
  assert.equal(out.photoNote, "No usable picture was found.");

  const failing = setup({
    writeSiteInfo: async () => {
      throw new Error("db down");
    },
  });
  const out2 = await runCollegeLookup(college, { refresh: false, hasPhoto: true }, failing.deps);
  assert.equal(out2.info?.about, "A small college.");
});

test("when the site can't be read the saved facts (even stale) are all there is, and the picture hunt goes on", async () => {
  const { calls, deps } = setup({
    stored: rowOf({ fetched_at: ago(60) }),
    fetchHome: async () => {
      throw new Error("That page returned 403");
    },
    lookUpPhoto: async (fetchMeta) => {
      calls.photo++;
      await assert.rejects(fetchMeta("https://www.example.edu"));
      return { site: null, photo: null, photoNote: "No usable picture was found." };
    },
  });
  const out = await runCollegeLookup(college, { refresh: false, hasPhoto: false }, deps);
  assert.equal(out.site, null);
  assert.equal(out.info?.about, "A small college.");
  assert.equal(out.cached, true);
  assert.match(out.infoNote ?? "", /Couldn't read Example University's site/);
  assert.equal(calls.build, 0);
  assert.equal(calls.photo, 1);

  const none = setup({
    fetchHome: async () => {
      throw new Error("nope");
    },
  });
  const out2 = await runCollegeLookup(college, { refresh: false, hasPhoto: true }, none.deps);
  assert.equal(out2.info, null);
  assert.equal(out2.site, null);
  assert.match(out2.infoNote ?? "", /Couldn't read/);
});

test("a slow step is cut off at the deadline and the other still answers", async () => {
  const { deps } = setup({
    stored: rowOf({ fetched_at: ago(60) }),
    buildInfo: () => new Promise(() => {}),
    deadlineMs: 40,
  });
  const t0 = Date.now();
  const out = await runCollegeLookup(college, { refresh: false, hasPhoto: false }, deps);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(out.info?.about, "A small college.");
  assert.equal(out.cached, true);
  assert.match(out.infoNote ?? "", /too long/);
  assert.equal(out.photoNote, "No usable picture was found.");
});

test("a picture step that throws costs the picture only", async () => {
  const { deps } = setup({
    lookUpPhoto: async () => {
      throw new Error("storage down: secret detail");
    },
  });
  const out = await runCollegeLookup(college, { refresh: true, hasPhoto: false }, deps);
  assert.equal(out.photo, null);
  assert.ok(out.photoNote && !/secret/.test(out.photoNote));
  assert.equal(out.info?.about, "A small college.");
});

test("a website given without a scheme is read over https", async () => {
  const { calls, deps } = setup();
  await runCollegeLookup({ ...college, website: "www.example.edu/about" }, { refresh: true, hasPhoto: true }, deps);
  assert.deepEqual(calls.home, ["https://www.example.edu/about"]);
});
