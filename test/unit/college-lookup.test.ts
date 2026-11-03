import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import sharp from "sharp";
import { fetchImageAny, fetchJpeg, fetchPageMeta, linkTesting, parsePageMeta, type PinnedResponse } from "../../src/lib/links.js";
import { jpegSize, lookUpCollege, nameWords, onOwnHost, titleNamesCollege, type LookupDeps } from "../../src/lib/collegeLookup.js";
import { toStoredJpegs, type StoredImage } from "../../src/lib/imageConvert.js";

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

test("a Commons title must be this school's, not a lookalike", () => {
  const yes = (t: string, n: string) => assert.ok(titleNamesCollege(t, n), `${t} should name ${n}`);
  const no = (t: string, n: string) => assert.ok(!titleNamesCollege(t, n), `${t} should not name ${n}`);
  no("File:University of Texas at Austin Main Building.jpg", "Texas A&M University");
  yes("File:Texas A&M campus.jpg", "Texas A&M University");
  no("File:University of Pennsylvania College Hall.jpg", "Pennsylvania State University");
  yes("File:Pennsylvania State University Old Main.jpg", "Pennsylvania State University");
  no("File:Pennsylvania State University Old Main.jpg", "University of Pennsylvania");
  no("File:Boston University Photonics Center.jpg", "Boston College");
  yes("File:Boston College Gasson Hall.jpg", "Boston College");
  no("File:Boston College Gasson Hall.jpg", "Boston University");
  no("File:Ohio State University Oval.jpg", "Ohio University");
  no("File:Price Hall campus.jpg", "Rice University");
  yes("File:Rice University Lovett Hall.jpg", "Rice University");
});

test("nameWords keeps State and A&M, drops filler and type words, and doesn't split accents", () => {
  assert.deepEqual(nameWords("Texas A&M University"), ["texas", "am"]);
  assert.deepEqual(nameWords("Saint Mary's College"), ["saint", "mary"]);
  assert.deepEqual(nameWords("Montréal College"), ["montreal"]);
  assert.deepEqual(nameWords("Ohio State University"), ["ohio", "state"]);
});

test("lookUpCollege never stores a Commons file named for another school", async () => {
  let imageinfoCalls = 0;
  const rows: Record<string, unknown>[] = [];
  const out = await lookUpCollege(
    { id: "c2", name: "Texas A&M University", unitid: 228723, website: "https://www.tamu.edu" },
    {
      commons: {
        search: async () => ["File:University of Texas at Austin Main Building.jpg"],
        imageinfo: async () => (imageinfoCalls++, {}),
        download: async () => new Uint8Array(),
      },
      store: { upload: async () => {}, upsert: async (r: Record<string, unknown>) => void rows.push(r) } as never,
      fetchMeta: async () => ({ finalUrl: "https://www.tamu.edu/", title: "Texas A&M", description: null, image: null }),
      hasPhoto: false,
    }
  );
  assert.equal(out.photo, null);
  assert.equal(rows.length, 0);
  assert.equal(imageinfoCalls, 0);
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
    // The bytes above are only a frame header; this stands in for the conversion.
    convert: async (bytes: Buffer): Promise<StoredImage> => ({ full: bytes, thumb: bytes, width: 1024, height: 600, srcWidth: 1024, srcHeight: 600 }),
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

// ---- Every image a page declares, in any format a browser shows ------------------------------

test("parsePageMeta lists every image candidate once, in order, and keeps `image` the first", () => {
  const m = parsePageMeta(
    `<head>
     <meta property="og:image:url" content="/img/b.webp">
     <meta property="og:image" content="/img/a.jpg">
     <meta property="og:image" content="/img/a2.jpg">
     <meta name="twitter:image" content="https://cdn.example.edu/t.png">
     <meta property="og:image:secure_url" content="https://www.example.edu/img/a.jpg">
     <link rel="image_src" href="/img/l.jpg">
     <link rel="stylesheet" href="/not-an-image.css">
     <meta property="og:image" content="javascript:alert(1)"></head>`,
    base
  );
  assert.equal(m.image, "https://www.example.edu/img/a.jpg");
  assert.deepEqual(m.images, [
    "https://www.example.edu/img/a.jpg",
    "https://www.example.edu/img/a2.jpg",
    "https://www.example.edu/img/b.webp",
    "https://cdn.example.edu/t.png",
    "https://www.example.edu/img/l.jpg",
  ]);
  assert.deepEqual(parsePageMeta("<head></head>", base).images, []);
});

test("parsePageMeta reads at most a handful of candidates and stays linear on hostile input", () => {
  const many = Array.from({ length: 50 }, (_, i) => `<meta property="og:image" content="/i${i}.jpg">`).join("");
  assert.ok(parsePageMeta(many, base).images!.length <= 8);
  const t0 = Date.now();
  parsePageMeta("<link rel=image_src ".repeat(100_000), base);
  assert.ok(Date.now() - t0 < 2000);
});

test("fetchImageAny takes a JPEG, a PNG or a WebP within the cap and nothing that only claims to be one", async () => {
  const undo = linkTesting.useResolver(PUBLIC);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#123" } }).png().toBuffer();
  const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#123" } }).webp().toBuffer();
  let body: Buffer = png;
  let type = "image/png";
  const undoOpen = linkTesting.useOpener(async () => ({ status: 200, headers: { "content-type": type }, body: Readable.from([body]) }));
  try {
    assert.equal((await fetchImageAny("https://b.test/p.png", 100_000)).bytes.length, png.length);
    type = "image/webp";
    body = webp;
    assert.equal((await fetchImageAny("https://b.test/p.webp", 100_000)).bytes.length, webp.length);
    type = "image/jpg";
    body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    assert.equal((await fetchImageAny("https://b.test/p.jpg", 100_000)).bytes.length, 8);
    type = "text/html";
    await assert.rejects(fetchImageAny("https://b.test/p.png", 100_000));
    type = "image/svg+xml";
    await assert.rejects(fetchImageAny("https://b.test/p.svg", 100_000));
    type = "image/png";
    body = Buffer.from("<html>a page that says it is a png</html>");
    await assert.rejects(fetchImageAny("https://b.test/p.png", 100_000), /image/i);
    body = Buffer.alloc(2000, 0x89);
    await assert.rejects(fetchImageAny("https://b.test/p.png", 1000), /too large/);
  } finally {
    undoOpen();
    undo();
  }
});

// ---- The site photo: several candidates, any format, a real thumbnail ---------------------------

const noCommons: LookupDeps["commons"] = { search: async () => [], imageinfo: async () => ({}), download: async () => new Uint8Array() };
const exampleCollege = { id: "c1", name: "Example University", unitid: 123456, website: "https://www.example.edu" };
const metaWith = (images: string[]) => async () => ({
  finalUrl: "https://www.example.edu/",
  title: "Example",
  description: null,
  image: images[0] ?? null,
  images,
});

test("lookUpCollege turns a WebP share image into a 1280 px and a 500 px JPEG", async () => {
  const webp = await sharp({ create: { width: 2000, height: 1100, channels: 3, background: "#456" } }).webp().toBuffer();
  const uploads = new Map<string, Buffer>();
  const rows: Record<string, unknown>[] = [];
  const out = await lookUpCollege(exampleCollege, {
    commons: noCommons,
    store: { upload: async (p: string, b: Uint8Array) => void uploads.set(p, Buffer.from(b)), upsert: async (r: Record<string, unknown>) => void rows.push(r) } as never,
    fetchMeta: metaWith(["https://cdn.example.edu/share.webp"]),
    fetchImage: async (url) => ({ finalUrl: url, bytes: webp }),
    hasPhoto: false,
  });
  assert.equal(out.photo?.source, "site");
  const names = [...uploads.keys()];
  assert.ok(names.some((n) => n.endsWith("-1280.jpg")) && names.some((n) => n.endsWith("-500.jpg")));
  const fullBytes = uploads.get(names.find((n) => n.endsWith("-1280.jpg"))!)!;
  const thumbBytes = uploads.get(names.find((n) => n.endsWith("-500.jpg"))!)!;
  assert.equal(jpegSize(fullBytes)?.width, 1280);
  assert.equal(jpegSize(thumbBytes)?.width, 500);
  assert.equal(rows[0]!.width, 1280);
  assert.equal(rows[0]!.height, 704);
  assert.equal(rows[0]!.license, "University website");
});

test("lookUpCollege tries the next candidate when one can't be fetched or is too small, and stops after three", async () => {
  const good = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#456" } }).png().toBuffer();
  const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#456" } }).jpeg().toBuffer();
  const portrait = await sharp({ create: { width: 900, height: 1400, channels: 3, background: "#456" } }).jpeg().toBuffer();
  const asked: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps = (images: string[], answer: (url: string) => Buffer | Error): LookupDeps => ({
    commons: noCommons,
    store: { upload: async () => {}, upsert: async (r: Record<string, unknown>) => void rows.push(r) } as never,
    fetchMeta: metaWith(images),
    fetchImage: async (url) => {
      asked.push(url);
      const a = answer(url);
      if (a instanceof Error) throw a;
      return { finalUrl: url, bytes: a };
    },
    hasPhoto: false,
  });

  const out = await lookUpCollege(
    exampleCollege,
    deps(
      [
        "https://www.example.edu/404.jpg",
        "https://evil.test/off-host.jpg",
        "https://www.example.edu/small.jpg",
        "https://www.example.edu/portrait.jpg",
        "https://cdn.example.edu/good.png",
        "https://cdn.example.edu/never-asked.png",
      ],
      (url) => (url.includes("404") ? new Error("That page returned 404") : url.includes("small") ? small : url.includes("portrait") ? portrait : good)
    )
  );
  // The off-host one is never fetched; the three on-host candidates before the good one are all tried.
  assert.deepEqual(asked, ["https://www.example.edu/404.jpg", "https://www.example.edu/small.jpg", "https://www.example.edu/portrait.jpg"]);
  assert.equal(out.photo, null);
  assert.equal(rows.length, 0);

  asked.length = 0;
  const second = await lookUpCollege(exampleCollege, deps(["https://www.example.edu/404.jpg", "https://cdn.example.edu/good.png"], (url) => (url.includes("404") ? new Error("gone") : good)));
  assert.deepEqual(asked, ["https://www.example.edu/404.jpg", "https://cdn.example.edu/good.png"]);
  assert.equal(second.photo?.source, "site");
  assert.equal(rows.length, 1);
});

test("lookUpCollege's default conversion refuses bytes sharp can't read, and the school keeps no photo", async () => {
  const rows: Record<string, unknown>[] = [];
  const out = await lookUpCollege(exampleCollege, {
    commons: noCommons,
    store: { upload: async () => {}, upsert: async (r: Record<string, unknown>) => void rows.push(r) } as never,
    fetchMeta: metaWith(["https://www.example.edu/broken.jpg"]),
    // A frame header with no image behind it.
    fetchImage: async (url) => ({ finalUrl: url, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x58, 0x04, 0x00, 3, 0, 0, 0]) }),
    hasPhoto: false,
  });
  assert.equal(out.photo, null);
  assert.equal(rows.length, 0);
  assert.equal(await toStoredJpegs(Buffer.alloc(3)), null);
});
