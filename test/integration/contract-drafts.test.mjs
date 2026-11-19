// Contracts drafted in Meridies and the consultant's saved signature (routes/contractDrafts.ts,
// lib/contractDraftApi.ts, migration 20261129000002), against a running API (see harness.mjs).
//
//   S   a solo counselor (their own practice, so an admin)
//   A   owner of a firm, B a consultant in it who is not an admin
//   O   a counselor of another practice
//   C   a solo counselor who fills the 100-draft cap
//
// Checks: create -> list -> edit -> duplicate -> archive; a firm member reads but never writes; another practice
// sees nothing and gets 404; the cap; a strict body; the saved signature (typed, drawn with a real PNG whose
// stored hash is the server's, replaced in place), what a bad image does, and that no one else reads it.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { crc32 } from "node:zlib";
import { call, check, rest, sql, user } from "./harness.mjs";

const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
async function joinFirm(firmId, u, seat = "counselor") {
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${u.id}', '${seat}') on conflict do nothing`);
  await sql(`update public.profiles set firm_id = '${firmId}' where id = '${u.id}'`);
}
// A real 1x1 PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const png = Buffer.from(PNG_B64, "base64");
const SIGNATURE_MAX = 61_440;
// The real PNG made `total` bytes long by a valid tEXt chunk after its IHDR, so the IEND stays the last chunk.
const padded = (total) => {
  const data = Buffer.alloc(total - png.length - 12);
  const type = Buffer.from("tEXt");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, 33), head, type, data, crc, png.subarray(33)]);
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sections = (extra = []) => [
  { id: "services", kind: "text", heading: "Services", body: "{{counselor_name}} will guide {{student_name}} and {{family_name}}." },
  { id: "prerequisites", kind: "list", heading: "Prerequisites", items: ["A completed intake form", "A current transcript"] },
  { id: "fees", kind: "text", heading: "Fees and payment terms", body: "See the invoice that comes with this agreement." },
  { id: "cancellation", kind: "clause", heading: "Cancellation and refunds", body: "You may cancel in writing at any time." },
  ...extra,
];
const draftBody = (title, extra = []) => ({ title, sections: sections(extra) });

const S = await user("cd-solo");
const A = await user("cd-owner");
const B = await user("cd-member");
const O = await user("cd-other");
const Stu = await user("cd-student", "student");
const firm = await call(A.token, "POST", "/firms", { name: `Draft firm ${tag}` });
check("the owner starts a firm", firm.status === 201, JSON.stringify(firm.body));
await joinFirm(firm.body.firmId, B);

// ---- Create, list, edit, duplicate, archive -----------------------------------------------------------------------------
const empty = await call(S.token, "GET", "/pipeline/contract-drafts");
check("a new practice has no drafts and may edit", empty.status === 200 && empty.body.drafts.length === 0 && empty.body.canEdit === true, JSON.stringify(empty.body));
const made = await call(S.token, "POST", "/pipeline/contract-drafts", draftBody(`  Engagement ${tag}  `));
check("create answers 201 with the draft, trimmed", made.status === 201 && made.body.title === `Engagement ${tag}` && made.body.archivedAt === null && isDeepStrictEqual(made.body.sections, sections()) && /^[0-9a-f-]{36}$/.test(made.body.id), JSON.stringify(made.body));
const row = JSON.parse(await sql(`select row_to_json(d)::text from (select practice_id, firm_id, counselor_id, created_by from public.contract_drafts where id = '${made.body.id}') d`));
check("the row belongs to the practice and its writer", row.practice_id === S.id && row.firm_id === null && row.counselor_id === S.id && row.created_by === S.id, JSON.stringify(row));
const listed = await call(S.token, "GET", "/pipeline/contract-drafts");
check("the list carries it", listed.status === 200 && listed.body.drafts.length === 1 && listed.body.drafts[0].id === made.body.id && listed.body.canEdit === true, JSON.stringify(listed.body));

const edited = await call(S.token, "PUT", `/pipeline/contract-drafts/${made.body.id}`, draftBody(`Engagement v2 ${tag}`, [{ id: "ending", kind: "clause", heading: "Ending this agreement", body: "Either side may end it in writing." }]));
check("edit replaces title and sections", edited.status === 200 && edited.body.id === made.body.id && edited.body.title === `Engagement v2 ${tag}` && edited.body.sections.length === 5 && edited.body.sections[4].id === "ending", JSON.stringify(edited.body));
check("...and moves updatedAt, not createdAt", edited.body.createdAt === made.body.createdAt && Date.parse(edited.body.updatedAt) >= Date.parse(made.body.updatedAt));
const stored = JSON.parse(await sql(`select row_to_json(x)::text from (select jsonb_array_length(sections) as n, title from public.contract_drafts where id = '${made.body.id}') x`));
check("the database holds the edit", stored.n === 5 && stored.title === `Engagement v2 ${tag}`, JSON.stringify(stored));

const dup = await call(S.token, "POST", `/pipeline/contract-drafts/${made.body.id}/duplicate`);
check("duplicate answers 201 with a new draft titled (copy)", dup.status === 201 && dup.body.id !== made.body.id && dup.body.title === `Engagement v2 ${tag} (copy)` && JSON.stringify(dup.body.sections) === JSON.stringify(edited.body.sections) && dup.body.archivedAt === null, JSON.stringify(dup.body));
const longTitle = await call(S.token, "POST", "/pipeline/contract-drafts", draftBody("L".repeat(160)));
const longDup = await call(S.token, "POST", `/pipeline/contract-drafts/${longTitle.body.id}/duplicate`);
check("a 160-character title still fits once copied", longDup.status === 201 && longDup.body.title === `${"L".repeat(153)} (copy)` && longDup.body.title.length <= 160, longDup.body.title?.length);

const arch = await call(S.token, "DELETE", `/pipeline/contract-drafts/${made.body.id}`);
check("DELETE archives the draft", arch.status === 200 && arch.body.id === made.body.id && typeof arch.body.archivedAt === "string", JSON.stringify(arch.body));
const live = await call(S.token, "GET", "/pipeline/contract-drafts");
const all = await call(S.token, "GET", "/pipeline/contract-drafts?includeArchived=true");
check("the list leaves archived drafts out unless asked", !live.body.drafts.some((d) => d.id === made.body.id) && live.body.drafts.length === 3 && all.body.drafts.length === 4 && all.body.drafts.some((d) => d.id === made.body.id && d.archivedAt), `${live.body.drafts.length}/${all.body.drafts.length}`);
check("(newest first)", all.body.drafts.map((d) => Date.parse(d.createdAt)).every((t, i, a) => i === 0 || a[i - 1] >= t));
check("an unknown query key is refused", (await call(S.token, "GET", "/pipeline/contract-drafts?foo=1")).status === 400);
check("the row is archived, not deleted", (await sql(`select count(*) from public.contract_drafts where id = '${made.body.id}' and archived_at is not null`)) === "1");

// ---- A strict body --------------------------------------------------------------------------------------------------------
const put = (body, id = dup.body.id) => call(S.token, "PUT", `/pipeline/contract-drafts/${id}`, body);
check("an unknown key is refused", (await put({ ...draftBody("x"), extra: 1 })).status === 400);
check("an empty title is refused", (await put(draftBody(""))).status === 400);
check("a 161-character title is refused", (await put(draftBody("t".repeat(161)))).status === 400);
check("sections out of order are refused", (await put({ title: "x", sections: [sections()[1], sections()[0], sections()[2]] })).status === 400);
check("a clause where the fee text goes is refused", (await put({ title: "x", sections: [sections()[0], sections()[1], sections()[3]] })).status === 400);
check("duplicate section ids are refused", (await put(draftBody("x", [{ id: "services", kind: "clause", heading: "Dup", body: "x" }]))).status === 400);
check("an empty clause body is refused", (await put(draftBody("x", [{ id: "e", kind: "clause", heading: "Empty", body: "  " }]))).status === 400);
check("41 sections are refused", (await put(draftBody("x", Array.from({ length: 37 }, (_, i) => ({ id: `k${i}`, kind: "clause", heading: `K${i}`, body: "x" }))))).status === 400);
check("over 50,000 characters are refused", (await put(draftBody("x", [{ id: "big", kind: "clause", heading: "Big", body: "b".repeat(50_000) }]))).status === 400);
check("a refused edit changed nothing", (await sql(`select title from public.contract_drafts where id = '${dup.body.id}'`)) === `Engagement v2 ${tag} (copy)`);
// A NUL can't be stored (Postgres refuses it in jsonb), so it is a 400 before the database, never a 500.
const draftsOf = async () => (await sql(`select count(*) from public.contract_drafts where counselor_id = '${S.id}'`));
const beforeNul = await draftsOf();
const nulBody = (extra) => draftBody(`Nul ${tag}`, [{ id: "nul", kind: "clause", heading: "Payment", body: "Pay by\u0000Friday", ...extra }]);
const nulPost = await call(S.token, "POST", "/pipeline/contract-drafts", nulBody());
check("a NUL in a clause body is 400 on create, and nothing is stored", nulPost.status === 400 && (await draftsOf()) === beforeNul && (await sql(`select count(*) from public.contract_drafts where title = 'Nul ${tag}'`)) === "0", JSON.stringify(nulPost.body).slice(0, 200));
check("...and on edit, leaving the draft as it was", (await put(nulBody())).status === 400 && (await sql(`select title from public.contract_drafts where id = '${dup.body.id}'`)) === `Engagement v2 ${tag} (copy)`);
check("a NUL in a title, heading or list item is 400", (await put(draftBody("T\u0000x"))).status === 400 && (await put(draftBody("x", [{ id: "h", kind: "clause", heading: "H\u0000x", body: "b" }]))).status === 400 && (await put({ title: "x", sections: [sections()[0], { id: "prerequisites", kind: "list", heading: "P", items: ["a\u0000b"] }, sections()[2]] })).status === 400);
check("a line break in a title or a tab in a list item is 400", (await put(draftBody("T\nx"))).status === 400 && (await put({ title: "x", sections: [sections()[0], { id: "prerequisites", kind: "list", heading: "P", items: ["a\tb"] }, sections()[2]] })).status === 400);
const multi = await put(draftBody("x", [{ id: "multi", kind: "clause", heading: "Payment", body: "Line one\nLine two\r\n\tindented" }]));
check("a body keeps its line breaks and tabs", multi.status === 200 && multi.body.sections[4].body === "Line one\nLine two\r\n\tindented", JSON.stringify(multi.body.sections?.[4]));
await put({ title: `Engagement v2 ${tag} (copy)`, sections: dup.body.sections });
check("a malformed id is 400, an unknown one 404", (await put(draftBody("x"), "nope")).status === 400 && (await put(draftBody("x"), "00000000-0000-4000-8000-000000000000")).status === 404);

// ---- A firm: members read, owners write ------------------------------------------------------------------------------------
const fd = await call(A.token, "POST", "/pipeline/contract-drafts", draftBody(`Firm draft ${tag}`));
check("a firm owner creates a draft for the firm", fd.status === 201, JSON.stringify(fd.body));
check("...stored on the firm's practice", (await sql(`select practice_id = '${firm.body.firmId}' and firm_id = '${firm.body.firmId}' from public.contract_drafts where id = '${fd.body.id}'`)) === "t");
const mine = await call(B.token, "GET", "/pipeline/contract-drafts");
check("a member lists the firm's drafts and can't edit", mine.status === 200 && mine.body.drafts.length === 1 && mine.body.drafts[0].id === fd.body.id && mine.body.canEdit === false, JSON.stringify(mine.body));
check("a member can't create (403)", (await call(B.token, "POST", "/pipeline/contract-drafts", draftBody("Nope"))).status === 403);
check("a member can't edit (403)", (await call(B.token, "PUT", `/pipeline/contract-drafts/${fd.body.id}`, draftBody("Nope"))).status === 403);
check("a member can't duplicate (403)", (await call(B.token, "POST", `/pipeline/contract-drafts/${fd.body.id}/duplicate`)).status === 403);
check("a member can't archive (403)", (await call(B.token, "DELETE", `/pipeline/contract-drafts/${fd.body.id}`)).status === 403);
check("...and nothing changed", (await sql(`select count(*) from public.contract_drafts where practice_id = '${firm.body.firmId}'`)) === "1" && (await sql(`select title from public.contract_drafts where id = '${fd.body.id}' and archived_at is null`)) === `Firm draft ${tag}`);
const memberPg = await rest(B.token, "PATCH", `/rest/v1/contract_drafts?id=eq.${fd.body.id}`, { title: "Hijack" }, { Prefer: "return=representation" });
check("RLS: a member can't write through PostgREST either", Array.isArray(memberPg.body) ? memberPg.body.length === 0 : memberPg.status >= 400, JSON.stringify(memberPg.body));

// ---- Another practice -------------------------------------------------------------------------------------------------------
const oList = await call(O.token, "GET", "/pipeline/contract-drafts?includeArchived=true");
check("another practice sees none of them", oList.status === 200 && oList.body.drafts.length === 0, JSON.stringify(oList.body));
check("another practice's PUT is 404", (await call(O.token, "PUT", `/pipeline/contract-drafts/${dup.body.id}`, draftBody("Mine now"))).status === 404);
check("another practice's duplicate is 404", (await call(O.token, "POST", `/pipeline/contract-drafts/${dup.body.id}/duplicate`)).status === 404);
check("another practice's archive is 404", (await call(O.token, "DELETE", `/pipeline/contract-drafts/${dup.body.id}`)).status === 404);
check("RLS: another counselor reads and writes no rows through PostgREST", (await rest(O.token, "GET", "/rest/v1/contract_drafts?select=id")).body?.length === 0 && (await rest(O.token, "PATCH", `/rest/v1/contract_drafts?id=eq.${dup.body.id}`, { title: "x" }, { Prefer: "return=representation" })).body?.length === 0);
check("a student has no drafts or signature", (await call(Stu.token, "GET", "/pipeline/contract-drafts")).status === 403 && (await call(Stu.token, "GET", "/pipeline/signature")).status === 403);
check("...and nothing without a token", (await fetch(`${process.env.API_URL}/pipeline/contract-drafts`)).status === 401);

// ---- The cap: 100 unarchived drafts a practice -------------------------------------------------------------------------------
const C = await user("cd-cap");
await sql(`insert into public.contract_drafts (counselor_id, practice_id, title, sections, created_by)
           select '${C.id}', '${C.id}', 'Draft ' || n, '[]'::jsonb, '${C.id}' from generate_series(1, 100) n`);
const full = await call(C.token, "POST", "/pipeline/contract-drafts", draftBody("The 101st"));
check("the 101st unarchived draft is 409 contract_drafts_full", full.status === 409 && full.body.code === "contract_drafts_full", JSON.stringify(full.body));
const cList = await call(C.token, "GET", "/pipeline/contract-drafts");
check("(the list answers all 100)", cList.body.drafts.length === 100);
const first = cList.body.drafts[0];
check("a duplicate at the cap is 409 too", (await call(C.token, "POST", `/pipeline/contract-drafts/${first.id}/duplicate`)).body?.code === "contract_drafts_full");
check("archiving one frees a place", (await call(C.token, "DELETE", `/pipeline/contract-drafts/${first.id}`)).status === 200 && (await call(C.token, "POST", "/pipeline/contract-drafts", draftBody("Now it fits"))).status === 201);

// ---- The saved signature ---------------------------------------------------------------------------------------------------------
const none = await call(S.token, "GET", "/pipeline/signature");
check("no signature yet reads null", none.status === 200 && none.body.signature === null, JSON.stringify(none.body));
const typed = await call(S.token, "PUT", "/pipeline/signature", { kind: "typed", signerName: "  Casey Counselor " });
check("a typed signature saves", typed.status === 200 && typed.body.signerName === "Casey Counselor" && typed.body.kind === "typed" && typed.body.imageDataUrl === null && typeof typed.body.updatedAt === "string", JSON.stringify(typed.body));
const got = await call(S.token, "GET", "/pipeline/signature");
check("...and reads back", got.status === 200 && JSON.stringify(got.body.signature) === JSON.stringify(typed.body), JSON.stringify(got.body));

const drawn = await call(S.token, "PUT", "/pipeline/signature", { kind: "drawn", signerName: "Casey Counselor", imagePngBase64: PNG_B64 });
check("a drawn signature with a real PNG saves", drawn.status === 200 && drawn.body.kind === "drawn" && drawn.body.imageDataUrl === `data:image/png;base64,${PNG_B64}`, JSON.stringify(drawn.body).slice(0, 200));
const srow = JSON.parse(await sql(`select row_to_json(s)::text from (select kind, encode(image_png, 'hex') as hex, image_sha256 from public.counselor_signatures where counselor_id = '${S.id}') s`));
check("the stored bytes are the PNG's, with the server's SHA-256", srow.kind === "drawn" && srow.hex === png.toString("hex") && srow.image_sha256 === sha(png), JSON.stringify(srow));
check("the data URL's bytes hash to the stored hash", sha(Buffer.from(drawn.body.imageDataUrl.split(",")[1], "base64")) === srow.image_sha256);
check("one row per consultant, replaced in place", (await sql(`select count(*) from public.counselor_signatures where counselor_id = '${S.id}'`)) === "1");
const back = await call(S.token, "GET", "/pipeline/signature");
check("a drawn signature reads back the same", JSON.stringify(back.body.signature) === JSON.stringify(drawn.body));

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9, ...new Array(30).fill(0)]);
const wide = Buffer.from(png);
wide.writeUInt32BE(1201, 16);
const heavy = padded(61_570); // a whole PNG, only too big
const sig = (b) => call(S.token, "PUT", "/pipeline/signature", b);
check("a JPEG is 400", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: jpeg.toString("base64") })).status === 400);
check("HTML is 400", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: Buffer.from("<html><script>1</script></html>").toString("base64") })).status === 400);
check("a PNG over 61,440 bytes is 400", heavy.length > 61_440 && (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: heavy.toString("base64") })).status === 400, String(heavy.length));
check("a PNG wider than 1200 is 400", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: wide.toString("base64") })).status === 400);
check("bad base64 is 400", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: "***not base64***" })).status === 400 && (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: PNG_B64.slice(0, -3) })).status === 400);
const dataUrl = await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: `data:image/png;base64,${PNG_B64}` });
check("a data URL is 400 and says to send the raw base64", dataUrl.status === 400 && /raw base64, without a data: prefix/.test(dataUrl.body.error), JSON.stringify(dataUrl.body));
const generic = await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: jpeg.toString("base64") });
check("(any other bad image keeps the general message)", generic.status === 400 && /must be a PNG/.test(generic.body.error), JSON.stringify(generic.body));
check("a PNG cut off after its header is 400", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: png.subarray(0, 40).toString("base64") })).status === 400 && (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: png.subarray(0, 33).toString("base64") })).status === 400);
check("a valid header followed by a script is 400", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: Buffer.concat([png.subarray(0, 33), Buffer.from("<script>alert(1)</script>")]).toString("base64") })).status === 400);
check("a whole PNG with a byte after its end is 400", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: Buffer.concat([png, Buffer.from([0])]).toString("base64") })).status === 400);
check("drawn with no image is 400", (await sig({ kind: "drawn", signerName: "Casey" })).status === 400);
check("typed with an image is 400", (await sig({ kind: "typed", signerName: "Casey", imagePngBase64: PNG_B64 })).status === 400);
check("a client-sent hash is refused, never trusted", (await sig({ kind: "drawn", signerName: "Casey", imagePngBase64: PNG_B64, imageSha256: "0".repeat(64) })).status === 400);
check("a name with a line break or none is 400", (await sig({ kind: "typed", signerName: "Case\ny" })).status === 400 && (await sig({ kind: "typed", signerName: "  " })).status === 400 && (await sig({ kind: "typed", signerName: "n".repeat(121) })).status === 400);
// A lone UTF-16 surrogate passes JSON but Postgres refuses it (22P02): a 400 in words, never a 500.
const loneDraft = await call(S.token, "POST", "/pipeline/contract-drafts", draftBody("Half an emoji \uD800"));
check("a draft title with a lone surrogate is 400 in words, not 500", loneDraft.status === 400 && /broken character/.test(JSON.stringify(loneDraft.body.details)), JSON.stringify(loneDraft.body));
const loneBody = await call(S.token, "POST", "/pipeline/contract-drafts", { title: "Fine", sections: sections().map((x, i) => (i === 3 ? { ...x, body: "a\uDC00b" } : x)) });
check("...and a lone surrogate in a body too", loneBody.status === 400 && /broken character/.test(JSON.stringify(loneBody.body.details)), JSON.stringify(loneBody.body));
check("a signer name with one is 400", (await sig({ kind: "typed", signerName: "Casey\uD800" })).status === 400);
check("every refusal left the saved signature as it was", JSON.stringify((await call(S.token, "GET", "/pipeline/signature")).body.signature) === JSON.stringify(drawn.body));
check("(a whole emoji is fine)", (await sig({ kind: "typed", signerName: "Casey \uD83D\uDE00" })).status === 200);

const swapped = await call(S.token, "PUT", "/pipeline/signature", { kind: "typed", signerName: "Casey C." });
const trow = JSON.parse(await sql(`select row_to_json(s)::text from (select kind, signer_name, image_png is null as no_image, image_sha256 from public.counselor_signatures where counselor_id = '${S.id}') s`));
check("replacing with a typed one clears the image on the same row", swapped.status === 200 && swapped.body.imageDataUrl === null && trow.kind === "typed" && trow.no_image === true && trow.image_sha256 === null && trow.signer_name === "Casey C.", JSON.stringify(trow));
check("(still one row, updatedAt moved on)", (await sql(`select count(*) from public.counselor_signatures where counselor_id = '${S.id}'`)) === "1" && Date.parse(swapped.body.updatedAt) >= Date.parse(drawn.body.updatedAt));
const max = padded(SIGNATURE_MAX);
const maxSave = await sig({ kind: "drawn", signerName: "Casey C.", imagePngBase64: max.toString("base64") });
check("a PNG of exactly 61,440 bytes saves whole, hash and all", max.length === SIGNATURE_MAX && maxSave.status === 200 && maxSave.body.imageDataUrl === `data:image/png;base64,${max.toString("base64")}` && (await sql(`select length(image_png)::text || ':' || image_sha256 from public.counselor_signatures where counselor_id = '${S.id}'`)) === `${SIGNATURE_MAX}:${sha(max)}`, `${maxSave.status}`);
check("one byte more is 400", (await sig({ kind: "drawn", signerName: "Casey C.", imagePngBase64: padded(SIGNATURE_MAX + 1).toString("base64") })).status === 400);
check("a firm member has a signature of their own", (await call(B.token, "PUT", "/pipeline/signature", { kind: "typed", signerName: "Morgan Member" })).status === 200 && (await call(A.token, "GET", "/pipeline/signature")).body.signature === null);

check("another counselor reads no signature of ours", (await call(O.token, "GET", "/pipeline/signature")).body.signature === null);
check("RLS: no client reads another's signature through PostgREST", (await rest(O.token, "GET", `/rest/v1/counselor_signatures?counselor_id=eq.${S.id}&select=counselor_id`)).body?.length === 0);
check("RLS: nor writes it", (await rest(O.token, "PATCH", `/rest/v1/counselor_signatures?counselor_id=eq.${S.id}`, { signer_name: "Stolen" }, { Prefer: "return=representation" })).body?.length === 0 && (await sql(`select signer_name from public.counselor_signatures where counselor_id = '${S.id}'`)) === "Casey C.");

console.log("done");
