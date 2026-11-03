import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePageMeta } from "../../src/lib/links.js";
import { declaredSize, iconCandidates, imageSize, logoPath, lookUpLogo, usableLogoSize } from "../../src/lib/collegeLogos.js";

const base = new URL("https://www.example.edu/");

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

test("parsePageMeta lists the icons a page declares, absolute, http(s) only", () => {
  const m = parsePageMeta(
    `<head><link rel="icon" href="/favicon.ico">
     <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
     <link rel="icon" type="image/png" sizes="32x32 192x192" href="https://cdn.example.edu/i.png">
     <link rel="stylesheet" href="/a.css">
     <link rel="icon" href="javascript:alert(1)"></head>`,
    base
  );
  assert.deepEqual(
    (m.icons ?? []).map((i) => i.href),
    ["https://www.example.edu/favicon.ico", "https://www.example.edu/apple.png", "https://cdn.example.edu/i.png"]
  );
});

test("declaredSize takes the largest square size", () => {
  assert.equal(declaredSize("16x16 32x32 192x192"), 192);
  assert.equal(declaredSize("any"), null);
  assert.equal(declaredSize(null), null);
});

test("iconCandidates: own host only, no SVG or ICO, apple-touch first, small ones out, root fallback last", () => {
  const meta = {
    finalUrl: "https://www.example.edu/",
    icons: [
      { href: "https://www.example.edu/favicon.ico", rel: "icon", sizes: null, type: null },
      { href: "https://www.example.edu/i-32.png", rel: "icon", sizes: "32x32", type: "image/png" },
      { href: "https://www.example.edu/i-192.png", rel: "icon", sizes: "192x192", type: "image/png" },
      { href: "https://www.example.edu/mark.svg", rel: "icon", sizes: null, type: "image/svg+xml" },
      { href: "https://evil.test/apple.png", rel: "apple-touch-icon", sizes: "180x180", type: null },
      { href: "https://brand.example.edu/apple.png", rel: "apple-touch-icon", sizes: "180x180", type: null },
    ],
  };
  assert.deepEqual(iconCandidates(meta, "example.edu"), [
    "https://brand.example.edu/apple.png",
    "https://www.example.edu/i-192.png",
    "https://www.example.edu/apple-touch-icon.png",
  ]);
});

test("imageSize reads a PNG header; usableLogoSize wants 48 px and not a tall strip", () => {
  assert.deepEqual(imageSize(png(180, 180), "png"), { width: 180, height: 180 });
  assert.equal(usableLogoSize({ width: 180, height: 180 }), true);
  assert.equal(usableLogoSize({ width: 32, height: 32 }), false);
  assert.equal(usableLogoSize({ width: 60, height: 200 }), false);
  assert.equal(usableLogoSize(null), false);
});

test("logoPath is content-addressed and refuses a malformed id", () => {
  assert.equal(logoPath(166683, "a".repeat(40), "png"), `166683/logo-${"a".repeat(40)}.png`);
  assert.throws(() => logoPath(12, "a".repeat(40), "png"));
});

test("lookUpLogo stores the first usable icon, skipping a tiny one, and records a miss", async () => {
  const uploads: string[] = [];
  const saved: { storage_path: string | null }[] = [];
  const deps = {
    upload: async (path: string) => void uploads.push(path),
    save: async (row: { storage_path: string | null }) => void saved.push(row),
    fetchIcon: async (url: string) => ({
      finalUrl: url,
      bytes: url.endsWith("apple.png") ? png(16, 16) : png(192, 192),
      type: "png" as const,
    }),
  };
  const meta = {
    finalUrl: "https://www.example.edu/",
    icons: [
      { href: "https://www.example.edu/apple.png", rel: "apple-touch-icon", sizes: null, type: null },
      { href: "https://www.example.edu/i-192.png", rel: "icon", sizes: "192x192", type: null },
    ],
  };
  const o = await lookUpLogo({ id: "c1", unitid: 166683 }, meta, "example.edu", deps);
  assert.match(o.storagePath ?? "", /^166683\/logo-[0-9a-f]{40}\.png$/);
  assert.equal(uploads.length, 1);
  assert.equal(saved.at(-1)?.storage_path, o.storagePath);

  const miss = await lookUpLogo({ id: "c2", unitid: 166684 }, { finalUrl: "https://www.example.edu/", icons: [] }, "example.edu", {
    ...deps,
    fetchIcon: async () => {
      throw new Error("404");
    },
  });
  assert.equal(miss.storagePath, null);
  assert.equal(saved.at(-1)?.storage_path, null);
});
