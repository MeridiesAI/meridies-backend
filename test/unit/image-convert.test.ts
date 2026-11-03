import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { imageTesting, jpegSize, pixelLimitFor, sniffImage, toStoredJpegs } from "../../src/lib/imageConvert.js";

const solid = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({ create: { width, height, channels, background: channels === 4 ? { r: 20, g: 60, b: 120, alpha: 0.5 } : { r: 20, g: 60, b: 120 } } });

test("sniffImage knows a JPEG, a PNG and a WebP by their first bytes, and nothing else", async () => {
  assert.equal(sniffImage(await solid(8, 8).jpeg().toBuffer()), "jpeg");
  assert.equal(sniffImage(await solid(8, 8).png().toBuffer()), "png");
  assert.equal(sniffImage(await solid(8, 8).webp().toBuffer()), "webp");
  assert.equal(sniffImage(await solid(8, 8).gif().toBuffer()), null);
  assert.equal(sniffImage(Buffer.from("<html>not an image</html>")), null);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("jpegSize reads baseline and progressive frame headers", async () => {
  const baseline = await solid(640, 360).jpeg({ progressive: false }).toBuffer();
  const progressive = await solid(640, 360).jpeg({ progressive: true }).toBuffer();
  assert.deepEqual(jpegSize(baseline), { width: 640, height: 360 });
  assert.deepEqual(jpegSize(progressive), { width: 640, height: 360 });
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff])), null);
});

test("a PNG, a WebP and a big JPEG become a 1280 px and a 500 px JPEG", async () => {
  for (const [label, bytes] of [
    ["png", await solid(1600, 900).png().toBuffer()],
    ["webp", await solid(2000, 1000).webp().toBuffer()],
    ["jpeg", await solid(3000, 2000).jpeg().toBuffer()],
  ] as const) {
    const out = await toStoredJpegs(bytes);
    assert.ok(out, label);
    assert.equal(sniffImage(out.full), "jpeg", label);
    assert.equal(sniffImage(out.thumb), "jpeg", label);
    assert.equal(jpegSize(out.full)?.width, 1280, label);
    assert.equal(jpegSize(out.thumb)?.width, 500, label);
    assert.equal(out.width, 1280, label);
    assert.ok(out.thumb.length < out.full.length, `${label}: the thumb is the smaller file`);
  }
  const wide = await toStoredJpegs(await solid(1600, 900).png().toBuffer());
  assert.deepEqual([wide?.srcWidth, wide?.srcHeight, wide?.height], [1600, 900, 720]);
});

test("a small image is never enlarged, and a transparent PNG is flattened to a JPEG", async () => {
  const small = await toStoredJpegs(await solid(900, 600).jpeg().toBuffer());
  assert.equal(small?.width, 900);
  assert.equal(small?.height, 600);
  assert.equal(jpegSize(small!.thumb)?.width, 500);
  const tiny = await toStoredJpegs(await solid(300, 200).png().toBuffer());
  assert.equal(jpegSize(tiny!.thumb)?.width, 300);
  const alpha = await toStoredJpegs(await solid(1000, 700, 4).png().toBuffer());
  assert.equal(sniffImage(alpha!.full), "jpeg");
});

test("an image rotated by its EXIF orientation is judged, and stored, the way it is shown", async () => {
  const sideways = await solid(1200, 800).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const out = await toStoredJpegs(sideways);
  assert.deepEqual([out?.srcWidth, out?.srcHeight], [800, 1200]);
  assert.deepEqual([out?.width, out?.height], [800, 1200]);
});

test("bytes that only look like an image, and an image over the pixel limit, are refused without throwing", async () => {
  assert.equal(await toStoredJpegs(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a png")])), null);
  assert.equal(await toStoredJpegs(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])), null);
  assert.equal(await toStoredJpegs(Buffer.from("plain text")), null);
  assert.equal(await toStoredJpegs(await solid(400, 300).png().toBuffer(), { maxPixels: 10_000 }), null);
});

test("without sharp a JPEG passes through as it is and a PNG or WebP is refused", async () => {
  const undo = imageTesting.useSharp(async () => null);
  try {
    const jpeg = await solid(1000, 600).jpeg().toBuffer();
    const out = await toStoredJpegs(jpeg);
    assert.ok(out);
    assert.equal(out.full, jpeg);
    assert.equal(out.thumb, jpeg);
    assert.deepEqual([out.width, out.height, out.srcWidth, out.srcHeight], [1000, 600, 1000, 600]);
    assert.equal(await toStoredJpegs(await solid(1000, 600).png().toBuffer()), null);
    assert.equal(await toStoredJpegs(await solid(1000, 600).webp().toBuffer()), null);
    assert.equal(await toStoredJpegs(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), null);
  } finally {
    undo();
  }
});

test("a sharp that fails to load is remembered as unavailable, not retried on every image", async () => {
  let loads = 0;
  const undo = imageTesting.useSharp(async () => {
    loads += 1;
    throw new Error("native module missing");
  });
  try {
    const jpeg = await solid(900, 600).jpeg().toBuffer();
    assert.ok(await toStoredJpegs(jpeg));
    assert.ok(await toStoredJpegs(jpeg));
    assert.equal(loads, 1);
  } finally {
    undo();
  }
});

test("a camera-original JPEG above 40 megapixels is taken (a JPEG shrinks as it loads); PNG and WebP keep the 40 MP limit", async () => {
  // Syracuse's share image is 7952 x 5304 = 42.2 MP in 2.8 MB, and was refused for being "too large".
  assert.ok(pixelLimitFor("jpeg") >= 100_000_000);
  assert.equal(pixelLimitFor("png"), 40_000_000);
  assert.equal(pixelLimitFor("webp"), 40_000_000);

  const big = await solid(8000, 5400).jpeg({ quality: 30 }).toBuffer(); // 43.2 MP, flat colour: a small file
  assert.ok(big.length < 3_145_728);
  const out = await toStoredJpegs(big);
  assert.ok(out, "a 43 MP JPEG is converted");
  assert.equal(out.width, 1280);
  assert.equal(out.srcWidth, 8000);
  assert.equal(sniffImage(out.thumb), "jpeg");
});
