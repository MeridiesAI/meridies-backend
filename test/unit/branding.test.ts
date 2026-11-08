import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRANDING_BUCKET,
  BRANDING_MAX_BYTES,
  brandingObjectPath,
  brandingScope,
  brandingUploadBody,
  brandingPutBody,
  firmBrandingUpdate,
  isFirmBrandingEditor,
  isHexColor,
  ownBrandingPath,
  parseBrandingUrl,
  publicBrandingUrl,
  sniffImageType,
} from "../../src/lib/branding.js";

const BASE = "https://abcd1234.supabase.co";
const LOCAL = "http://127.0.0.1:56321";
const ME = "6f1c2b0e-5d3a-4c8e-9b7f-0a1b2c3d4e5f";
const OTHER = "0a1b2c3d-4e5f-4c8e-9b7f-6f1c2b0e5d3a";
const url = (path: string, base = BASE) => `${base}/storage/v1/object/public/${BRANDING_BUCKET}/${path}`;

test("hex colours: #RRGGBB only", () => {
  for (const ok of ["#12402e", "#ABCDEF", "#000000"]) assert.ok(isHexColor(ok), ok);
  for (const bad of ["12402e", "#fff", "#12402eff", "red", "rgb(0,0,0)", "#12402g", " #12402e", "", null, 7]) {
    assert.equal(isHexColor(bad), false, String(bad));
  }
});

test("an object path is <scope>/<kind>-<16 hex>.<ext>, never a client name", () => {
  const p = brandingObjectPath(ME, "logo", "image/png");
  assert.match(p, new RegExp(`^${ME}/logo-[0-9a-f]{16}\\.png$`));
  assert.match(brandingObjectPath(ME, "banner", "image/jpeg"), /\/banner-[0-9a-f]{16}\.jpg$/);
  assert.match(brandingObjectPath(ME, "banner", "image/webp"), /\.webp$/);
  assert.notEqual(brandingObjectPath(ME, "logo", "image/png"), p, "random each time");
});

test("the public URL of a path, and back", () => {
  const p = `${ME}/logo-0123456789abcdef.png`;
  assert.equal(publicBrandingUrl(p, BASE), url(p));
  assert.equal(publicBrandingUrl(p, `${BASE}/`), url(p), "a trailing slash on the project URL is ignored");
  assert.deepEqual(parseBrandingUrl(url(p), BASE), { path: p, scopeId: ME, kind: "logo", ext: "png" });
  assert.deepEqual(parseBrandingUrl(url(`${ME}/banner-0123456789abcdef.webp`), BASE)?.kind, "banner");
});

test("a URL outside this project's branding bucket is refused", () => {
  const p = `${ME}/logo-0123456789abcdef.png`;
  for (const bad of [
    "https://evil.example/logo.png",
    url(p).replace("abcd1234.supabase.co", "abcd1234.supabase.co.evil.example"), // look-alike host
    url(p).replace("abcd1234.supabase.co", "evil-abcd1234.supabase.co"),
    url(p).replace("https://", "https://user:pw@"), // credentials
    url(p).replace("https://abcd1234.supabase.co", "https://abcd1234.supabase.co:8443"), // another port
    url(p).replace("https://", "http://"), // downgraded scheme
    url(p).replace("/public/branding/", "/public/college-logos/"), // another bucket
    url(p).replace("/public/", "/sign/"), // a signed (private) object
    url(p) + "?download=1",
    url(p) + "#x",
    url(`${ME}/../${OTHER}/logo-0123456789abcdef.png`), // traversal
    url(`${ME}/%2e%2e/${OTHER}/logo-0123456789abcdef.png`),
    url(`${ME}%2Flogo-0123456789abcdef.png`),
    url(`${ME}/sub/logo-0123456789abcdef.png`),
    url(`${ME}/logo-0123456789abcdef.svg`), // never svg
    url(`${ME}/logo-0123456789abcdef.png.svg`),
    url(`${ME}/logo-0123456789ABCDEF.png`), // only what the API mints
    url(`${ME}/logo-0123.png`),
    url(`${ME}/icon-0123456789abcdef.png`),
    url(`not-a-uuid/logo-0123456789abcdef.png`),
    `data:image/png;base64,AAAA`,
    `javascript:alert(1)`,
    "",
    "not a url",
  ]) {
    assert.equal(parseBrandingUrl(bad, BASE), null, bad);
  }
});

test("the local stack's plain-http project URL works for itself, and only a loopback one may be http", () => {
  const p = `${ME}/logo-0123456789abcdef.png`;
  assert.equal(parseBrandingUrl(url(p, LOCAL), LOCAL)?.path, p);
  assert.equal(parseBrandingUrl(url(p, "http://abcd1234.supabase.co"), "http://abcd1234.supabase.co"), null);
});

test("ownBrandingPath: the caller's own folder and the field's own kind", () => {
  const logo = url(`${ME}/logo-0123456789abcdef.png`);
  assert.equal(ownBrandingPath(logo, ME, "logo", BASE), `${ME}/logo-0123456789abcdef.png`);
  assert.equal(ownBrandingPath(logo, OTHER, "logo", BASE), null, "another counselor's or firm's folder");
  assert.equal(ownBrandingPath(logo, ME, "banner", BASE), null, "a logo saved as the banner");
  assert.equal(ownBrandingPath("https://evil.example/x.png", ME, "logo", BASE), null);
});

test("upload request: type allowlist and size caps per kind", () => {
  const ok = (b: unknown) => brandingUploadBody.safeParse(b).success;
  assert.ok(ok({ kind: "logo", contentType: "image/png", sizeBytes: 1000 }));
  assert.ok(ok({ kind: "logo", contentType: "image/jpeg", sizeBytes: BRANDING_MAX_BYTES.logo }));
  assert.ok(ok({ kind: "banner", contentType: "image/webp", sizeBytes: BRANDING_MAX_BYTES.banner }));
  assert.equal(BRANDING_MAX_BYTES.logo, 2 * 1024 * 1024);
  assert.equal(BRANDING_MAX_BYTES.banner, 4 * 1024 * 1024);
  assert.equal(ok({ kind: "logo", contentType: "image/png", sizeBytes: BRANDING_MAX_BYTES.logo + 1 }), false, "3 MB logo");
  assert.equal(ok({ kind: "banner", contentType: "image/png", sizeBytes: BRANDING_MAX_BYTES.banner + 1 }), false);
  assert.equal(ok({ kind: "logo", contentType: "image/png", sizeBytes: 0 }), false);
  assert.equal(ok({ kind: "logo", contentType: "image/png", sizeBytes: 1.5 }), false);
  for (const t of ["image/svg+xml", "image/gif", "text/html", "image/png; charset=x", "IMAGE/PNG", "application/octet-stream"]) {
    assert.equal(ok({ kind: "logo", contentType: t, sizeBytes: 10 }), false, t);
  }
  assert.equal(ok({ kind: "icon", contentType: "image/png", sizeBytes: 10 }), false);
  assert.equal(ok({ kind: "logo", contentType: "image/png", sizeBytes: 10, path: "x" }), false, "no client-named path");
});

test("PUT body: hex or null colour, URL or null, nothing else", () => {
  const ok = (b: unknown) => brandingPutBody.safeParse(b).success;
  assert.ok(ok({}));
  assert.ok(ok({ accentColor: "#12402e", logoUrl: null, bannerUrl: null }));
  assert.ok(ok({ accentColor: null, accentColorSource: "default" }));
  assert.ok(ok({ accentColor: "#12402e", accentColorSource: "logo" }));
  assert.equal(ok({ accentColor: "red" }), false);
  assert.equal(ok({ accentColorSource: "css" }), false);
  assert.equal(ok({ logoUrl: 5 }), false);
  assert.equal(ok({ name: "x" }), false, "strict");
});

test("scope: a firm member gets the firm's, a solo counselor their own", () => {
  assert.deepEqual(brandingScope({ id: ME, firm_id: OTHER }), { scope: "firm", id: OTHER });
  assert.deepEqual(brandingScope({ id: ME, firm_id: null }), { scope: "solo", id: ME });
  assert.deepEqual(brandingScope({ id: ME }), { scope: "solo", id: ME });
});

test("only owner and admin seats edit firm branding", () => {
  assert.ok(isFirmBrandingEditor("owner"));
  assert.ok(isFirmBrandingEditor("admin"));
  for (const s of ["counselor", "assistant", null, undefined, ""]) assert.equal(isFirmBrandingEditor(s), false, String(s));
});

test("firm update: the accent records its source the way PATCH /firms/mine always did", () => {
  assert.deepEqual(firmBrandingUpdate({ accentColor: "#12402e" }, "T"), { accent_color: "#12402e", accent_color_source: "manual" });
  assert.deepEqual(firmBrandingUpdate({ accentColor: null }, "T"), { accent_color: null, accent_color_source: "default" });
  assert.deepEqual(firmBrandingUpdate({ accentColor: "#12402e", accentColorSource: "logo" }, "T"), { accent_color: "#12402e", accent_color_source: "logo" });
  assert.deepEqual(firmBrandingUpdate({ accentColorSource: "banner" }, "T"), { accent_color_source: "banner" });
  assert.deepEqual(firmBrandingUpdate({ logoUrl: "u" }, "T"), { logo_url: "u", logo_updated_at: "T" });
  assert.deepEqual(firmBrandingUpdate({ bannerUrl: null }, "T"), { banner_url: null });
  assert.deepEqual(firmBrandingUpdate({}, "T"), {});
});

test("sniffImageType reads the bytes, not the label", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(jpg), "image/jpeg");
  assert.equal(sniffImageType(webp), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")), null);
  assert.equal(sniffImageType(new TextEncoder().encode("<html><script>alert(1)</script>")), null);
  assert.equal(sniffImageType(new Uint8Array()), null);
});

test("folder cleanup: only stale, unsaved objects of our own naming scheme go", async () => {
  const { brandingCleanup, BRANDING_FOLDER_MAX, BRANDING_STALE_MS } = await import("../../src/lib/branding.js");
  assert.equal(BRANDING_FOLDER_MAX, 10);
  assert.equal(BRANDING_STALE_MS, 2 * 3600 * 1000);
  const now = Date.parse("2026-11-08T12:00:00Z");
  const old = "2026-11-08T09:00:00Z"; // 3 h ago
  const fresh = "2026-11-08T11:30:00Z"; // 30 min ago
  const objects = [
    { name: "logo-0000000000000001.png", created_at: old }, // stale, unsaved: goes
    { name: "banner-0000000000000002.webp", created_at: old }, // stale, unsaved: goes
    { name: "logo-0000000000000003.png", created_at: old }, // the current logo: kept
    { name: "banner-0000000000000004.jpg", created_at: old }, // the current banner: kept
    { name: "logo-0000000000000005.png", created_at: fresh }, // may still be on its way to a save: kept
    { name: "notes.txt", created_at: old }, // not ours: never touched
    { name: "logo-0000000000000006.svg", created_at: old }, // not the scheme: never touched
    { name: "logo-000000000000000G.png", created_at: old },
    { name: "logo-0000000000000007.png", created_at: null }, // no time: kept
    { name: "logo-0000000000000008.png", created_at: "garbage" },
  ];
  const keep = new Set([`${ME}/logo-0000000000000003.png`, `${ME}/banner-0000000000000004.jpg`]);
  const r = brandingCleanup(objects, ME, keep, now);
  assert.deepEqual(r.remove, [`${ME}/logo-0000000000000001.png`, `${ME}/banner-0000000000000002.webp`]);
  assert.equal(r.remaining, objects.length - 2);
  assert.ok(r.remove.every((p) => p.startsWith(`${ME}/`)), "only inside the caller's folder");
  assert.deepEqual(brandingCleanup([], ME, new Set(), now), { remove: [], remaining: 0 });
});
