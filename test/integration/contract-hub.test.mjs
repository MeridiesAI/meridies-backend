// Contract Hub (20261130000001, routes/contractHub.ts): upload a PDF, add signers, place fields, send, sign from a
// link (typed and drawn), decline, void; clients write nothing; another counselor sees nothing; a used link stops.
import { createHash, randomBytes } from "node:crypto";
import { ANON, API, CLIENT, SB, call, check, rest, sql, user } from "./harness.mjs";

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function uploadPdf(u, bytes = PDF) {
  const t = await call(u.token, "POST", "/contract-hub/upload-url", { sizeBytes: bytes.length });
  if (t.status !== 200) throw new Error(`upload-url ${t.status} ${JSON.stringify(t.body)}`);
  const put = await fetch(`${SB}/storage/v1/object/upload/sign/contract-hub/${t.body.path}?token=${encodeURIComponent(t.body.token)}`, {
    method: "PUT",
    headers: { apikey: ANON, Authorization: `Bearer ${u.token}`, "Content-Type": "application/pdf", "x-upsert": "false" },
    body: bytes,
  });
  if (put.status !== 200) throw new Error(`signed PUT ${put.status} ${await put.text()}`);
  return t.body.path;
}

/** Give a signer a known link, as Send would (the real one only goes out by email). */
async function linkFor(signerId) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql(`update public.contract_hub_signers set token_hash = '${hash}', token_expires_at = now() + interval '1 day' where id = '${signerId}'`);
  return token;
}
const pub = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { ...CLIENT, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, type: r.headers.get("content-type") };
};

const me = await user("hub-owner");
const other = await user("hub-other");
const student = await user("hub-student", "student");

// ---- Create ----
const path = await uploadPdf(me);
check("the upload path is in the caller's own folder", path.startsWith(`${me.id}/`) && path.endsWith(".pdf"), path);
const notPdf = await uploadPdf(me, new TextEncoder().encode("<html>nope</html>"));
const refused = await call(me.token, "POST", "/contract-hub/envelopes", { title: "X", fileName: "x.pdf", path: notPdf, pageCount: 1, signers: [{ name: "A", email: "a@test.local" }] });
check("a file that isn't a PDF is refused", refused.status === 400, JSON.stringify(refused.body));
const foreign = await call(other.token, "POST", "/contract-hub/envelopes", { title: "X", fileName: "x.pdf", path, pageCount: 1, signers: [{ name: "A", email: "a@test.local" }] });
check("another counselor can't claim my upload", foreign.status === 400, `${foreign.status}`);
const studentTry = await call(student.token, "POST", "/contract-hub/upload-url", { sizeBytes: 10 });
check("a student can't use the hub", studentTry.status === 403, `${studentTry.status}`);

const created = await call(me.token, "POST", "/contract-hub/envelopes", {
  title: "Consulting agreement",
  fileName: "agreement.pdf",
  path,
  pageCount: 2,
  signers: [
    { name: "Ana Ruiz", email: "ana@test.local" },
    { name: "Ben Ruiz", email: "ben@test.local" },
  ],
});
check("a draft is created with its signers", created.status === 201 && created.body.status === "draft" && created.body.signers.length === 2, JSON.stringify(created.body));
const env = created.body;
const [ana, ben] = env.signers;

// ---- Reads and isolation ----
const list = await call(me.token, "GET", "/contract-hub/envelopes");
check("the owner lists it", list.status === 200 && list.body.envelopes.some((e) => e.id === env.id), `${list.status}`);
const otherGet = await call(other.token, "GET", `/contract-hub/envelopes/${env.id}`);
check("another counselor gets 404", otherGet.status === 404, `${otherGet.status}`);
const otherRest = await rest(other.token, "GET", `/rest/v1/contract_hub_envelopes?id=eq.${env.id}`);
check("another counselor reads nothing through PostgREST", otherRest.status === 200 && otherRest.body.length === 0, JSON.stringify(otherRest.body));
const doc = await fetch(`${API}/contract-hub/envelopes/${env.id}/document`, { headers: { ...CLIENT, Authorization: `Bearer ${me.token}` } });
check("the owner downloads the PDF", doc.status === 200 && doc.headers.get("content-type") === "application/pdf", `${doc.status}`);
const hashRead = await rest(me.token, "GET", `/rest/v1/contract_hub_signers?select=token_hash&envelope_id=eq.${env.id}`);
check("a client can't read link hashes", hashRead.status !== 200, `${hashRead.status}`);

// ---- Clients write nothing ----
const forge = await rest(me.token, "PATCH", `/rest/v1/contract_hub_envelopes?id=eq.${env.id}`, { status: "completed" }, { Prefer: "return=representation" });
const after = await sql(`select status from public.contract_hub_envelopes where id = '${env.id}'`);
check("the owner can't mark it completed through PostgREST", after === "draft", `${forge.status} ${after}`);
const forgeSigner = await rest(me.token, "PATCH", `/rest/v1/contract_hub_signers?id=eq.${ana.id}`, { status: "signed" });
check("nor sign for a signer", await sql(`select status from public.contract_hub_signers where id = '${ana.id}'`) === "waiting", `${forgeSigner.status}`);

// ---- Fields and send ----
const early = await call(me.token, "POST", `/contract-hub/envelopes/${env.id}/send`);
check("send is refused until every signer has a signature field", early.status === 400 && /Ana Ruiz and Ben Ruiz/.test(early.body.error ?? ""), JSON.stringify(early.body));
const offPage = await call(me.token, "PUT", `/contract-hub/envelopes/${env.id}/fields`, { fields: [{ signerId: ana.id, type: "signature", page: 3, x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] });
check("a field past the last page is refused", offPage.status === 400, `${offPage.status}`);
const fields = await call(me.token, "PUT", `/contract-hub/envelopes/${env.id}/fields`, {
  fields: [
    { signerId: ana.id, type: "signature", page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
    { signerId: ana.id, type: "date", page: 2, x: 0.5, y: 0.2, w: 0.2, h: 0.03 },
    { signerId: ana.id, type: "name", page: 2, x: 0.1, y: 0.3, w: 0.3, h: 0.03 },
    { signerId: ben.id, type: "signature", page: 2, x: 0.1, y: 0.5, w: 0.3, h: 0.05 },
    { signerId: ben.id, type: "initials", page: 1, x: 0.8, y: 0.9, w: 0.1, h: 0.04 },
  ],
});
check("the fields are saved", fields.status === 200 && fields.body.fields.length === 5, JSON.stringify(fields.body));
const sent = await call(me.token, "POST", `/contract-hub/envelopes/${env.id}/send`);
check("send moves it out for signature", sent.status === 200 && sent.body.status === "sent", JSON.stringify(sent.body));
const twice = await call(me.token, "POST", `/contract-hub/envelopes/${env.id}/send`);
check("a second send is refused", twice.status === 409, `${twice.status}`);
const lateFields = await call(me.token, "PUT", `/contract-hub/envelopes/${env.id}/fields`, { fields: [] });
check("fields can't change once sent", lateFields.status === 409, `${lateFields.status}`);
check("each signer got a link", await sql(`select count(*) from public.contract_hub_signers where envelope_id = '${env.id}' and token_hash is not null`) === "2");

// ---- Signing ----
const anaToken = await linkFor(ana.id);
const view = await pub("GET", `/contract-hub/sign/${anaToken}`);
check("the link shows the document to its signer", view.status === 200 && view.body.signer.name === "Ana Ruiz" && view.body.fields.length === 5, JSON.stringify(view.body));
check("the link shows no email", !JSON.stringify(view.body).includes("@test.local"), "");
const pdfPub = await pub("GET", `/contract-hub/sign/${anaToken}/document`);
check("the link serves the PDF", pdfPub.status === 200 && pdfPub.type === "application/pdf", `${pdfPub.status}`);
const bad = await pub("GET", `/contract-hub/sign/${"x".repeat(43)}`);
check("an unknown link is 404", bad.status === 404, `${bad.status}`);
const noConsent = await pub("POST", `/contract-hub/sign/${anaToken}`, { consent: false });
check("signing needs consent", noConsent.status === 400, `${noConsent.status}`);
const nameField = fields.body.fields.find((f) => f.type === "name");
const missing = await pub("POST", `/contract-hub/sign/${anaToken}`, { consent: true, signature: { kind: "typed", value: "Ana Ruiz" } });
check("every name field must be filled", missing.status === 400, JSON.stringify(missing.body));
const signedAna = await pub("POST", `/contract-hub/sign/${anaToken}`, { consent: true, signature: { kind: "typed", value: "Ana Ruiz" }, values: { [nameField.id]: "Ana Ruiz" } });
check("Ana signs; Ben still to sign", signedAna.status === 200 && signedAna.body.status === "sent", JSON.stringify(signedAna.body));
const reused = await pub("GET", `/contract-hub/sign/${anaToken}`);
check("a used link stops working", reused.status === 404, `${reused.status}`);

const benToken = await linkFor(ben.id);
const noInitials = await pub("POST", `/contract-hub/sign/${benToken}`, { consent: true, signature: { kind: "drawn", value: `data:image/png;base64,${PNG}` } });
check("initials are required when placed", noInitials.status === 400, `${noInitials.status}`);
const notPng = await pub("POST", `/contract-hub/sign/${benToken}`, { consent: true, signature: { kind: "drawn", value: "R0lGODlhAQABAAAAACw=" }, initials: { kind: "typed", value: "BR" } });
check("a drawing that isn't a PNG is refused", notPng.status === 400, `${notPng.status}`);
const signedBen = await pub("POST", `/contract-hub/sign/${benToken}`, { consent: true, signature: { kind: "drawn", value: `data:image/png;base64,${PNG}` }, initials: { kind: "typed", value: "BR" } });
check("Ben signs last and completes it", signedBen.status === 200 && signedBen.body.status === "completed", JSON.stringify(signedBen.body));
const done = await call(me.token, "GET", `/contract-hub/envelopes/${env.id}`);
const b = done.body.signers.find((s) => s.id === ben.id);
check(
  "the owner sees both signatures, the filled fields and the timeline",
  done.body.status === "completed" && b.signature.kind === "drawn" && b.signature.value === `data:image/png;base64,${PNG}`
    && done.body.fields.find((f) => f.type === "name").value === "Ana Ruiz" && !!done.body.fields.find((f) => f.type === "date").value
    && done.body.events.some((e) => /Completed/.test(e.text)),
  JSON.stringify(done.body),
);
check("signing kept the IP and browser", await sql(`select count(*) from public.contract_hub_signers where envelope_id = '${env.id}' and signed_at is not null and signed_user_agent is not null`) === "2");

// ---- Decline, void, delete ----
async function draftWithOne(title) {
  const p = await uploadPdf(me);
  const c = await call(me.token, "POST", "/contract-hub/envelopes", { title, fileName: "a.pdf", path: p, pageCount: 1, signers: [{ name: "Cara", email: "cara@test.local" }] });
  const s = c.body.signers[0];
  await call(me.token, "PUT", `/contract-hub/envelopes/${c.body.id}/fields`, { fields: [{ signerId: s.id, type: "signature", page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] });
  return { env: c.body, signer: s };
}
{
  const d = await draftWithOne("To decline");
  await call(me.token, "POST", `/contract-hub/envelopes/${d.env.id}/send`);
  const t = await linkFor(d.signer.id);
  const dec = await pub("POST", `/contract-hub/sign/${t}/decline`, { reason: "Wrong fee" });
  check("a signer can decline", dec.status === 200, JSON.stringify(dec.body));
  const g = await call(me.token, "GET", `/contract-hub/envelopes/${d.env.id}`);
  check("the contract reads declined with the reason", g.body.status === "declined" && g.body.signers[0].declineReason === "Wrong fee", JSON.stringify(g.body));
}
{
  const d = await draftWithOne("To void");
  await call(me.token, "POST", `/contract-hub/envelopes/${d.env.id}/send`);
  const t = await linkFor(d.signer.id);
  const v = await call(me.token, "POST", `/contract-hub/envelopes/${d.env.id}/void`);
  check("the owner voids it", v.status === 200 && v.body.status === "voided", `${v.status}`);
  const dead = await pub("GET", `/contract-hub/sign/${t}`);
  check("a voided contract's link stops", dead.status === 404, `${dead.status}`);
  const del = await call(me.token, "DELETE", `/contract-hub/envelopes/${d.env.id}`);
  check("a sent contract can't be deleted", del.status === 409, `${del.status}`);
}
{
  const d = await draftWithOne("Draft to delete");
  const del = await call(me.token, "DELETE", `/contract-hub/envelopes/${d.env.id}`);
  check("a draft is deleted", del.status === 200 && await sql(`select count(*) from public.contract_hub_envelopes where id = '${d.env.id}'`) === "0", `${del.status}`);
}
{
  // A link from a counselor who has lost approval answers nothing.
  const d = await draftWithOne("Unapproved");
  await call(me.token, "POST", `/contract-hub/envelopes/${d.env.id}/send`);
  const t = await linkFor(d.signer.id);
  await sql(`update public.profiles set counselor_approved_at = null where id = '${me.id}'`);
  const r = await pub("GET", `/contract-hub/sign/${t}`);
  check("an unapproved counselor's link is 404", r.status === 404, `${r.status}`);
  await sql(`update public.profiles set counselor_approved_at = now() where id = '${me.id}'`);
}
