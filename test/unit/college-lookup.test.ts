import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fetchJpeg, fetchPageMeta, linkTesting, parsePageMeta, type PinnedResponse } from "../../src/lib/links.js";
import { jpegSize, lookUpCollege, nameWords, onOwnHost, titleNamesCollege } from "../../src/lib/collegeLookup.js";

const PUBLIC = async () => [{ address: "93.184.215.14", family: 4 }];
const base = new URL("https://www.example.edu/about/");

test("parsePageMeta reads og tags, falls back to name=description, resolves a relative image", () => {
  const m = parsePageMeta(
    `<html><head><title>Fallback &amp; Co</title>
     <meta property="og:title" content="Example University">
     <meta name="description" content="A school > a place">
     <meta property='og:image' content='/img/campus.jpg'></head>`,
    base
  );
  assert.equal(m.title, "Example University");
  assert.equal(m.description, "A school > a place");
  assert.equal(m.image, "https://www.example.edu/img/campus.jpg");
});

test("parsePageMeta refuses a non-http image and survives an unterminated tag", () => {
  assert.equal(parsePageMeta(`<meta property="og:image" content="javascript:alert(1)">`, base).image, null);
  assert.equal(parsePageMeta(`<meta property="og:image" content="data:image/png;base64,AAAA">`, base).image, null);
  const t0 = Date.now();
  parsePageMeta("<meta ".repeat(100_000), base);
  assert.ok(Date.now() - t0 < 2000);
});

test("fetchPageMeta goes through the pinned opener and refuses a private redirect", async () => {
  const undo = linkTesting.useResolver(async (host) =>
    host === "internal.test" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]
  );
  const seen: string[] = [];
  const undoOpen = linkTesting.useOpener(async (hop): Promise<PinnedResponse> => {
    seen.push(hop.url.hostname);
    if (hop.url.hostname === "a.test") {
      return { status: 302, headers: { location: "http://internal.test/x" }, body: Readable.from([]) };
    }
    return { status: 200, headers: { "content-type": "text/html" }, body: Readable.from([Buffer.from('<meta property="og:image" content="/p.jpg">')]) };
  });
  try {
    await assert.rejects(fetchPageMeta("http://a.test/"), /./);
    assert.deepEqual(seen, ["a.test"]);
    const ok = await fetchPageMeta("https://b.test/");
    assert.equal(ok.image, "https://b.test/p.jpg");
  } finally {
    undoOpen();
    undo();
  }
});

test("fetchJpeg takes only a JPEG within the cap", async () => {
  const undo = linkTesting.useResolver(PUBLIC);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  let body: Buffer = jpeg;
  let type = "image/jpeg";
  const undoOpen = linkTesting.useOpener(async () => ({ status: 200, headers: { "content-type": type }, body: Readable.from([body]) }));
  try {
    assert.equal((await fetchJpeg("https://b.test/p.jpg", 1000)).bytes.length, 8);
    type = "text/html";
    await assert.rejects(fetchJpeg("https://b.test/p.jpg", 1000));
    type = "image/jpeg";
    body = Buffer.alloc(2000, 0xff);
    await assert.rejects(fetchJpeg("https://b.test/p.jpg", 1000), /too large/);
    body = Buffer.from("GIF89a-not-a-jpeg");
    await assert.rejects(fetchJpeg("https://b.test/p.jpg", 1000), /JPEG/);
  } finally {
    undoOpen();
    undo();
  }
});

test("a Commons title must name the school", () => {
  assert.deepEqual(nameWords("The University of Texas at Austin"), ["texas", "austin"]);
  assert.ok(titleNamesCollege("File:Texas Austin campus tower.jpg", "University of Texas at Austin"));
  assert.ok(!titleNamesCollege("File:Texas A&M campus.jpg", "University of Texas at Austin"));
  assert.ok(!titleNamesCollege("File:Anything.jpg", "The University"));
});

test("onOwnHost allows the host and subdomains only", () => {
  assert.ok(onOwnHost("https://cdn.example.edu/a.jpg", "example.edu"));
  assert.ok(onOwnHost("https://www.example.edu/a.jpg", "example.edu"));
  assert.ok(!onOwnHost("https://example.edu.evil.com/a.jpg", "example.edu"));
  assert.ok(!onOwnHost("https://evilexample.edu/a.jpg", "example.edu"));
  assert.ok(!onOwnHost("ftp://example.edu/a.jpg", "example.edu"));
});

test("jpegSize reads the frame header", () => {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x58, 0x04, 0x00, 3, 0, 0, 0]);
  assert.deepEqual(jpegSize(b), { width: 1024, height: 600 });
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff])), null);
});

test("lookUpCollege stores the site image when Commons has nothing, and leaves a school with a photo alone", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x58, 0x04, 0x00, 3, 0, 0, 0]);
  const uploads: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps = (hasPhoto: boolean) => ({
    commons: { search: async () => [], imageinfo: async () => ({}), download: async () => new Uint8Array() },
    store: { upload: async (p: string) => void uploads.push(p), upsert: async (r: Record<string, unknown>) => void rows.push(r) } as never,
    fetchMeta: async () => ({ finalUrl: "https://www.example.edu/", title: "Example", description: "d", image: "https://cdn.example.edu/c.jpg" }),
    fetchImage: async () => ({ finalUrl: "https://cdn.example.edu/c.jpg", bytes: jpeg }),
    hasPhoto,
  });
  const college = { id: "c1", name: "Example University", unitid: 123456, website: "https://www.example.edu" };

  const kept = await lookUpCollege(college, deps(true));
  assert.equal(kept.photo, null);
  assert.equal(kept.site?.title, "Example");
  assert.equal(rows.length, 0);

  const out = await lookUpCollege(college, deps(false));
  assert.equal(out.photo?.source, "site");
  assert.equal(uploads.length, 2);
  assert.equal(rows[0]!.source, "site");
  assert.equal(rows[0]!.license, "University website");
  assert.equal(rows[0]!.commons_title, null);

  // An image on another host is never taken.
  rows.length = 0;
  const other = await lookUpCollege(college, {
    ...deps(false),
    fetchMeta: async () => ({ finalUrl: "https://www.example.edu/", title: null, description: null, image: "https://evil.test/c.jpg" }),
  });
  assert.equal(other.photo, null);
  assert.equal(rows.length, 0);
});
