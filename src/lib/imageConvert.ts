/**
 * Pictures for the public college-photos bucket, which holds JPEGs only
 * (`<unitid>/<sha1>-1280.jpg` and `-500.jpg`; the table's CHECKs say so too).
 *
 * A college's share image is often a WebP or a PNG, and for the "site" photo
 * the 500 px card size used to be the same file as the 1280 px one (up to 3 MB
 * on every card). With `sharp` any of the three formats becomes a real 1280 px
 * JPEG and a real 500 px JPEG.
 *
 * `sharp` is a native module, so it is loaded on first use with a dynamic
 * import and its absence is survivable: without it a JPEG is stored as it is
 * (one copy under both names, the old behaviour) and a PNG or WebP is refused.
 * A failed load is remembered; the next image does not try again.
 *
 * The input is hostile: a size cap upstream (fetchBytes), a pixel limit here,
 * `failOn: "error"` so a damaged file is refused rather than half-decoded, and
 * the magic bytes decide the format, never a header or a file name.
 */

import type sharpModule from "sharp";

export type ImageKind = "jpeg" | "png" | "webp";

/** What the bucket takes for one picture. */
export type StoredImage = {
  /** The 1280 px (or smaller, never enlarged) JPEG. */
  full: Buffer;
  /** The 500 px (or smaller) JPEG. */
  thumb: Buffer;
  /** The stored full copy's size. */
  width: number;
  height: number;
  /** The source's size as it is shown (EXIF orientation applied), for the "big enough, landscape" rule. */
  srcWidth: number;
  srcHeight: number;
};

export const FULL_WIDTH = 1280;
export const THUMB_WIDTH = 500;
/** About 40 megapixels: a large camera frame; bigger is refused before it is decoded. */
export const MAX_INPUT_PIXELS = 40_000_000;
/**
 * A JPEG is decoded shrunk (libjpeg scales it by 1/2, 1/4 or 1/8 as it loads), so a
 * camera original costs little to resize: a 42 MP, 2.8 MB share image converted in 64 ms
 * and about 23 MB. The 40 MP guard refused those. A PNG or WebP can't shrink on load, and
 * a flat-colour one is a few KB that inflates to hundreds of MB, so those keep 40 MP.
 */
export const MAX_INPUT_PIXELS_JPEG = 100_000_000;

export function pixelLimitFor(kind: ImageKind): number {
  return kind === "jpeg" ? MAX_INPUT_PIXELS_JPEG : MAX_INPUT_PIXELS;
}

/** The format a file's first bytes name, or null. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "png";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) {
    return "webp";
  }
  return null;
}

/** Width and height from a baseline or progressive JPEG's frame header; null if unreadable. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

type SharpFactory = typeof sharpModule;

/** Loads sharp, or answers null/throws when it can't. Swapped in tests. */
type SharpLoader = () => Promise<SharpFactory | null>;

const realLoader: SharpLoader = async () => {
  const mod = await import("sharp");
  const sharp = (mod.default ?? mod) as unknown as SharpFactory;
  // Photos are one-offs: don't hold decoded files in libvips' cache in a process every tenant shares.
  sharp.cache(false);
  return sharp;
};

let loader: SharpLoader = realLoader;
let loaded: Promise<SharpFactory | null> | null = null;

function loadSharp(): Promise<SharpFactory | null> {
  loaded ??= loader().catch(() => null);
  return loaded;
}

/** Test seams: replace how sharp is loaded. Returns a function that restores the real one. Never called outside tests. */
export const imageTesting = {
  useSharp(fn: SharpLoader): () => void {
    loader = fn;
    loaded = null;
    return () => {
      loader = realLoader;
      loaded = null;
    };
  },
};

/**
 * A picture as the bucket stores it, or null when it can't be: not a JPEG,
 * PNG or WebP, damaged, over the pixel limit, or a PNG/WebP with no sharp to
 * convert it. Never throws.
 */
export async function toStoredJpegs(bytes: Buffer, o: { maxPixels?: number } = {}): Promise<StoredImage | null> {
  const kind = sniffImage(bytes);
  if (!kind) return null;

  const sharp = await loadSharp();
  if (!sharp) {
    // No converter: the old behaviour for a JPEG (one copy under both names), nothing for the rest.
    if (kind !== "jpeg") return null;
    const size = jpegSize(bytes);
    return size ? { full: bytes, thumb: bytes, width: size.width, height: size.height, srcWidth: size.width, srcHeight: size.height } : null;
  }

  try {
    const open = () => sharp(bytes, { limitInputPixels: o.maxPixels ?? pixelLimitFor(kind), failOn: "error" });
    const meta = await open().metadata();
    if (!meta.width || !meta.height) return null;
    // EXIF orientation 5-8 turns the picture a quarter: what is shown is the other way round.
    const turned = (meta.orientation ?? 1) >= 5;
    const [srcWidth, srcHeight] = turned ? [meta.height, meta.width] : [meta.width, meta.height];

    // rotate() applies the orientation; flatten() puts a transparent PNG on white, as a JPEG has no alpha.
    const render = (width: number, quality: number) =>
      open()
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality, progressive: true })
        .toBuffer({ resolveWithObject: true });
    const full = await render(FULL_WIDTH, 82);
    const thumb = await render(THUMB_WIDTH, 80);
    if (!full.info.width || !full.info.height) return null;
    return { full: full.data, thumb: thumb.data, width: full.info.width, height: full.info.height, srcWidth, srcHeight };
  } catch {
    return null;
  }
}
