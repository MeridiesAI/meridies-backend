// Persisted branding (20261111000008, routes/branding.ts): a solo counselor's own row, a firm's columns, the public
// images-only bucket written only through API-minted signed upload URLs, and the URL rule (this project's bucket, the
// caller's own folder, the field's own kind).
import { ANON, SB, call, check, rest, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

// A 1x1 transparent PNG.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

async function putSigned(token, path, uploadToken, bytes, mime) {
  const r = await fetch(`${SB}/storage/v1/object/upload/sign/branding/${path}?token=${encodeURIComponent(uploadToken)}`, {
    method: "PUT",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": mime, "x-upsert": "false" },
    body: bytes,
  });
  return { status: r.status, body: await r.text() };
}

/** upload-url -> PUT the bytes. Returns the ticket. */
async function upload(u, kind, bytes = PNG, mime = "image/png") {
  const t = await call(u.token, "POST", "/branding/upload-url", { kind, contentType: mime, sizeBytes: bytes.length });
  if (t.status !== 200) throw new Error(`upload-url ${t.status} ${JSON.stringify(t.body)}`);
  const put = await putSigned(u.token, t.body.path, t.body.token, bytes, mime);
  if (put.status !== 200) throw new Error(`signed PUT ${put.status} ${put.body}`);
  return t.body;
}
const fetchStatus = async (url) => (await fetch(url)).status;

// ---- Solo counselor ----
const solo = await user("brand-solo");
{
  const g = await call(solo.token, "GET", "/branding");
  check("a solo counselor starts with nothing", g.status === 200 && g.body.scope === "solo" && g.body.canEdit === true
    && g.body.logoUrl === null && g.body.bannerUrl === null && g.body.accentColor === null && g.body.accentColorSource === "default", JSON.stringify(g.body));

  const svg = await call(solo.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/svg+xml", sizeBytes: 100 });
  check("an SVG is refused", svg.status === 400, `${svg.status}`);
  const big = await call(solo.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 3 * 1024 * 1024 });
  check("a 3 MB logo is refused", big.status === 400, `${big.status}`);
  const bigBanner = await call(solo.token, "POST", "/branding/upload-url", { kind: "banner", contentType: "image/png", sizeBytes: 3 * 1024 * 1024 });
  check("a 3 MB banner is allowed", bigBanner.status === 200, `${bigBanner.status}`);
  const gif = await call(solo.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/gif", sizeBytes: 100 });
  check("another image type is refused", gif.status === 400, `${gif.status}`);
  const named = await call(solo.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100, path: `${solo.id}/x.png` });
  check("a client-named path is refused", named.status === 400, `${named.status}`);

  const t = await upload(solo, "logo");
  check("the ticket is in the caller's own folder, named by the API", new RegExp(`^${solo.id}/logo-[0-9a-f]{16}\\.png$`).test(t.path)
    && t.publicUrl.endsWith(`/storage/v1/object/public/branding/${t.path}`) && t.expiresIn > 0 && typeof t.uploadUrl === "string", JSON.stringify(t));

  const s = await call(solo.token, "PUT", "/branding", { logoUrl: t.publicUrl, accentColor: "#12402e" });
  check("saving the uploaded logo works", s.status === 200 && s.body.logoUrl === t.publicUrl && s.body.accentColor === "#12402e" && s.body.accentColorSource === "manual", JSON.stringify(s.body));
  const g2 = await call(solo.token, "GET", "/branding");
  check("GET shows it", g2.body.logoUrl === t.publicUrl && g2.body.accentColor === "#12402e", JSON.stringify(g2.body));
  const img = await fetch(t.publicUrl);
  const bytes = new Uint8Array(await img.arrayBuffer());
  check("the public URL serves the image", img.status === 200 && /^image\/png/.test(img.headers.get("content-type") ?? "") && bytes.length === PNG.length, `${img.status} ${img.headers.get("content-type")}`);

  // A replacement removes the old object.
  const t2 = await upload(solo, "logo");
  const r = await call(solo.token, "PUT", "/branding", { logoUrl: t2.publicUrl });
  check("a new logo replaces the old one", r.status === 200 && r.body.logoUrl === t2.publicUrl && r.body.accentColor === "#12402e", JSON.stringify(r.body));
  check("and the old object is gone", (await fetchStatus(t.publicUrl)) >= 400, `${await fetchStatus(t.publicUrl)}`);

  // Banner, then clear both.
  const b = await upload(solo, "banner");
  const asLogo = await call(solo.token, "PUT", "/branding", { logoUrl: b.publicUrl });
  check("a banner can't be saved as the logo", asLogo.status === 400, `${asLogo.status}`);
  const sb = await call(solo.token, "PUT", "/branding", { bannerUrl: b.publicUrl });
  check("the banner saves", sb.status === 200 && sb.body.bannerUrl === b.publicUrl, JSON.stringify(sb.body));
  const clear = await call(solo.token, "PUT", "/branding", { logoUrl: null, bannerUrl: null, accentColor: null });
  check("clearing works", clear.status === 200 && clear.body.logoUrl === null && clear.body.bannerUrl === null && clear.body.accentColor === null && clear.body.accentColorSource === "default", JSON.stringify(clear.body));
  check("and clearing removes the objects", (await fetchStatus(t2.publicUrl)) >= 400 && (await fetchStatus(b.publicUrl)) >= 400);

  // URLs that aren't the caller's own upload.
  const ext = await call(solo.token, "PUT", "/branding", { logoUrl: "https://evil.example/logo.png" });
  check("an arbitrary external URL is refused", ext.status === 400, `${ext.status}`);
  const dataUrl = await call(solo.token, "PUT", "/branding", { logoUrl: "data:image/png;base64,AAAA" });
  check("a data URL is refused", dataUrl.status === 400, `${dataUrl.status}`);
  const pending = await call(solo.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 });
  const notUp = await call(solo.token, "PUT", "/branding", { logoUrl: pending.body.publicUrl });
  check("a minted URL with nothing uploaded yet is refused", notUp.status === 400, `${notUp.status} ${JSON.stringify(notUp.body)}`);
  const lie = await upload(solo, "logo", SVG, "image/png");
  const lied = await call(solo.token, "PUT", "/branding", { logoUrl: lie.publicUrl });
  check("an upload whose bytes aren't the image it claimed is refused", lied.status === 400, `${lied.status} ${JSON.stringify(lied.body)}`);
  check("and that object is removed", (await fetchStatus(lie.publicUrl)) >= 400);
  // The 2 MB logo limit holds at save, whatever the ticket declared (the bucket itself allows 4 MB).
  const bigPng = new Uint8Array(3 * 1024 * 1024);
  bigPng.set(PNG);
  const smallTicket = await call(solo.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 });
  const bigPut = await putSigned(solo.token, smallTicket.body.path, smallTicket.body.token, bigPng, "image/png");
  check("a 3 MB PNG goes up on a ticket declared small (the bucket allows 4 MB)", bigPut.status === 200, `${bigPut.status} ${bigPut.body}`);
  const bigSave = await call(solo.token, "PUT", "/branding", { logoUrl: smallTicket.body.publicUrl });
  check("but saving it as the logo is refused", bigSave.status === 400, `${bigSave.status} ${JSON.stringify(bigSave.body)}`);
  check("and the object is removed", (await fetchStatus(smallTicket.body.publicUrl)) >= 400);
  const bad = await call(solo.token, "PUT", "/branding", { accentColor: "red" });
  check("a colour that isn't #RRGGBB is refused", bad.status === 400, `${bad.status}`);
}

// Another counselor's folder.
const other = await user("brand-other");
{
  const theirs = await upload(other, "logo");
  const r = await call(solo.token, "PUT", "/branding", { logoUrl: theirs.publicUrl });
  check("a URL in another counselor's folder is refused", r.status === 400, `${r.status}`);
  check("their own save of it works", (await call(other.token, "PUT", "/branding", { logoUrl: theirs.publicUrl })).status === 200);
  const g = await call(solo.token, "GET", "/branding");
  check("and the solo counselor still sees their own", g.body.logoUrl === null, JSON.stringify(g.body));

  // PostgREST: owner-only, and the CHECKs hold without the API.
  const peek = await rest(solo.token, "GET", `/rest/v1/counselor_branding?counselor_id=eq.${other.id}`);
  check("another counselor's row can't be read", peek.status === 200 && Array.isArray(peek.body) && peek.body.length === 0, JSON.stringify(peek.body));
  const forge = await rest(solo.token, "PATCH", `/rest/v1/counselor_branding?counselor_id=eq.${other.id}`, { accent_color: "#000000" }, { Prefer: "return=representation" });
  check("nor changed", Array.isArray(forge.body) ? forge.body.length === 0 : forge.status >= 400, JSON.stringify(forge.body));
  const plant = await rest(solo.token, "POST", "/rest/v1/counselor_branding", { counselor_id: other.id, accent_color: "#000000" });
  check("nor planted for someone else", plant.status >= 400, `${plant.status}`);
  const direct = await rest(solo.token, "PATCH", `/rest/v1/counselor_branding?counselor_id=eq.${solo.id}`, { logo_url: "https://evil.example/logo.png" });
  check("a direct write of an outside URL fails the CHECK", direct.status === 400 && direct.body?.code === "23514", `${direct.status} ${JSON.stringify(direct.body)}`);
  const cross = await rest(solo.token, "PATCH", `/rest/v1/counselor_branding?counselor_id=eq.${solo.id}`, { logo_url: theirs.publicUrl });
  check("and so does another counselor's folder", cross.status === 400 && cross.body?.code === "23514", `${cross.status} ${JSON.stringify(cross.body)}`);

  // Storage: no client writes or listing.
  const raw = await rest(solo.token, "POST", `/storage/v1/object/branding/${solo.id}/logo-0123456789abcdef.png`, PNG, { "Content-Type": "image/png" });
  check("a client can't upload to the bucket directly", raw.status >= 400, `${raw.status}`);
  const list = await rest(solo.token, "POST", "/storage/v1/object/list/branding", { prefix: `${other.id}/`, limit: 10 });
  check("nor list it", Array.isArray(list.body) ? list.body.length === 0 : list.status >= 400, JSON.stringify(list.body).slice(0, 120));
}

// ---- Firm ----
const owner = await user("brand-owner");
const member = await user("brand-member");
const admin = await user("brand-admin");
const firmId = await firmWith(owner, [member, admin]);
await sql(`update public.firm_members set seat_role = 'admin' where firm_id = '${firmId}' and profile_id = '${admin.id}'`);
{
  const gm = await call(member.token, "GET", "/branding");
  check("a firm member reads the firm's branding and can't edit", gm.status === 200 && gm.body.scope === "firm" && gm.body.canEdit === false, JSON.stringify(gm.body));
  const um = await call(member.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 });
  check("a member can't start an upload", um.status === 403, `${um.status}`);
  const pm = await call(member.token, "PUT", "/branding", { accentColor: "#123456" });
  check("a member can't save", pm.status === 403, `${pm.status}`);

  const go = await call(owner.token, "GET", "/branding");
  check("the owner can edit", go.body.scope === "firm" && go.body.canEdit === true, JSON.stringify(go.body));
  const t = await upload(owner, "logo");
  check("the firm's images are in the firm's folder", t.path.startsWith(`${firmId}/logo-`), t.path);
  const po = await call(owner.token, "PUT", "/branding", { logoUrl: t.publicUrl, accentColor: "#224466", accentColorSource: "logo" });
  check("the owner saves the firm's logo", po.status === 200 && po.body.logoUrl === t.publicUrl && po.body.accentColorSource === "logo", JSON.stringify(po.body));
  const firmRow = await sql(`select logo_url || '|' || accent_color || '|' || accent_color_source || '|' || (logo_updated_at is not null) from public.firms where id = '${firmId}'`);
  check("on the firm's own columns", firmRow === `${t.publicUrl}|#224466|logo|true`, firmRow);
  const gm2 = await call(member.token, "GET", "/branding");
  check("the member sees it", gm2.body.logoUrl === t.publicUrl && gm2.body.accentColor === "#224466", JSON.stringify(gm2.body));

  const b = await upload(admin, "banner");
  const pa = await call(admin.token, "PUT", "/branding", { bannerUrl: b.publicUrl });
  check("an admin saves the firm's banner", pa.status === 200 && pa.body.bannerUrl === b.publicUrl && pa.body.logoUrl === t.publicUrl, JSON.stringify(pa.body));

  const soloUp = await upload(other, "banner");
  const wrongFolder = await call(owner.token, "PUT", "/branding", { bannerUrl: soloUp.publicUrl });
  check("a firm can't save a solo counselor's image", wrongFolder.status === 400, `${wrongFolder.status}`);
  const intoSolo = await call(other.token, "PUT", "/branding", { bannerUrl: b.publicUrl });
  check("nor a solo counselor the firm's", intoSolo.status === 400, `${intoSolo.status}`);

  const outsider = await call(solo.token, "GET", "/branding");
  check("another practice reads its own, not the firm's", outsider.body.scope === "solo" && outsider.body.logoUrl !== t.publicUrl, JSON.stringify(outsider.body));
  const outsiderPg = await rest(solo.token, "PATCH", `/rest/v1/firms?id=eq.${firmId}`, { accent_color: "#000000" }, { Prefer: "return=representation" });
  check("nor writes the firm through PostgREST", Array.isArray(outsiderPg.body) ? outsiderPg.body.length === 0 : outsiderPg.status >= 400, JSON.stringify(outsiderPg.body));

  // PATCH /firms/mine is unchanged: data URLs refused, members refused.
  const d = await call(owner.token, "PATCH", "/firms/mine", { logoUrl: "data:image/png;base64,AAAA" });
  check("PATCH /firms/mine still refuses a data URL", d.status === 400, `${d.status}`);
  const plain = await call(owner.token, "PATCH", "/firms/mine", { logoUrl: "http://example.com/logo.png" });
  check("PATCH /firms/mine now refuses a plain http logo", plain.status === 400, `${plain.status}`);
  const plainBanner = await call(owner.token, "PATCH", "/firms/mine", { bannerUrl: "http://example.com/banner.png" });
  check("and a plain http banner", plainBanner.status === 400, `${plainBanner.status}`);
  const pmember = await call(member.token, "PATCH", "/firms/mine", { accentColor: "#123456" });
  check("and a member", pmember.status === 403, `${pmember.status}`);
  const powner = await call(owner.token, "PATCH", "/firms/mine", { accentColor: "#abcdef" });
  check("and still saves an owner's colour as manual", powner.status === 200 && powner.body.accentColor === "#abcdef" && powner.body.accentColorSource === "manual", JSON.stringify(powner.body));
}

// ---- The folder cleans itself and is capped ----
{
  const capped = await user("brand-cap");
  const tickets = [];
  for (let i = 0; i < 10; i++) tickets.push(await upload(capped, "logo"));
  const full = await call(capped.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 });
  check("ten unsaved uploads fill the folder: the 11th is refused", full.status === 429 && full.body?.code === "branding_folder_full", `${full.status} ${JSON.stringify(full.body)}`);
  const [current, stale] = tickets;
  check("the current logo saves", (await call(capped.token, "PUT", "/branding", { logoUrl: current.publicUrl })).status === 200);
  await sql(`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'branding' and name in ('${current.path}', '${stale.path}')`);
  const again = await call(capped.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 });
  check("an old unsaved upload is cleaned, so a new one can start", again.status === 200, `${again.status} ${JSON.stringify(again.body)}`);
  check("the old unsaved object is gone", (await fetchStatus(stale.publicUrl)) >= 400);
  check("the saved logo is kept, however old", (await fetchStatus(current.publicUrl)) === 200);
  const left = await sql(`select count(*) from storage.objects where bucket_id = 'branding' and name like '${capped.id}/%'`);
  check("nine objects left", left === "9", left);
}

// ---- Who may call ----
{
  const s = await studentOf(solo, "brand-student");
  check("a student is refused", (await call(s.token, "GET", "/branding")).status === 403);
  check("a student can't start an upload", (await call(s.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 })).status === 403);
  const p = await user("brand-pending", "counselor", { approved: false });
  const g = await call(p.token, "GET", "/branding");
  check("a pending counselor is refused", g.status === 403 && g.body?.code === "account_pending", JSON.stringify(g.body));
}

// ---- Rate limit: 20 upload URLs an hour ----
{
  const r = await user("brand-rate");
  let ok = 0;
  for (let i = 0; i < 20; i++) {
    if ((await call(r.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 })).status === 200) ok++;
  }
  const over = await call(r.token, "POST", "/branding/upload-url", { kind: "logo", contentType: "image/png", sizeBytes: 100 });
  check("20 upload URLs an hour, then 429", ok === 20 && over.status === 429, `${ok} ${over.status}`);
}
