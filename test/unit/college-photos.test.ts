import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  allowedLicense,
  choosePhoto,
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
  assert.deepEqual(r.byUnitid.get(166683), { qid: "Q49108", titles: ["File:Great dome of MIT, Feb 2021.jpg"] });
  assert.equal(r.byUnitid.get(110635)?.qid, "Q168756", "a padded unitid is trimmed");
  assert.equal(r.byUnitid.get(110635)?.titles[0], "File:Sather Tower été.jpg", "the title is passed on for Commons to normalize");
  assert.deepEqual(r.byUnitid.get(130794), { qid: "Q49112", titles: [] }, "no image");
  assert.deepEqual(r.byUnitid.get(217156)?.titles, ["File:Aerial view of Brown University.jpg", "File:Richardsonian Romanesque Brown.jpg"]);
  assert.ok(r.ambiguous.has(190415), "a unitid on two items");
  assert.ok(r.ambiguous.has(199998) && r.ambiguous.has(199999), "an item claiming two unitids");
  assert.ok(!r.byUnitid.has(190415) && !r.byUnitid.has(199998));
  assert.equal(r.invalid, 1, "the five-digit id");
  assert.equal(r.byUnitid.has(12345), false);
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
  const m = resolvePages(full, ["File:Sather Tower été.jpg", "File:College Hall Penn old name.jpg", "File:Not in the answer.jpg"]);
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
