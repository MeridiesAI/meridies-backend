// A contract drafted in Meridies, attached to an invoice with `agreement: { draftId }` (lib/invoiceAgreement.ts):
// rendered with the family's names, signed with the SENDER's saved signature, frozen as an agreement and sent
// with the invoice. Against a running API with AGREEMENTS_ENABLED on (see harness.mjs).
//
//   S   a solo counselor (their own practice)
//   A   owner of a firm (writes the firm's drafts), B a consultant in it who is not an admin
//
// Checks: no signature is 409 and writes nothing; the preview renders and writes nothing; send signs and
// freezes (text, snapshot, link, acceptance hash); replacing the signature or editing/archiving the draft
// changes nothing already sent; Send again with { agreementId } re-signs nothing; a drawn signature binds its
// hash; missing/unknown fields and an over-long text are 400 before anything is written; the old guards hold;
// a firm member signs as themselves; a scheduled invoice can't carry a draft and the cron refuses one. The
// family's page shows a drawn signature under the text (open, accepted and "already accepted"), serves its PNG
// at /agree/<token>/signature behind the same link checks as /file, and an agreement with no snapshot or a
// typed one has no image and no such route. A stored image that doesn't match the signed text is a 503 and
// nothing is served: staged by inserting snapshot rows as postgres (the table refuses UPDATE and DELETE, not INSERT).
// A draft row written by hand (a list with no items) is 400 at preview and send. The agreement_signatures guards are
// proved last: UPDATE/DELETE/TRUNCATE refused even as postgres, the cascade and AxIS Restore, the column grants, and
// the insert policy (it must be the caller's own saved signature, on their own draft agreement).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { API, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const MY_IP = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const pub = async (method, path, body) => {
  const r = await fetch(API + path, {
    method,
    redirect: "manual",
    headers: { "X-Forwarded-For": MY_IP, ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body,
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
};
const pubBytes = async (path) => {
  const r = await fetch(API + path, { redirect: "manual", headers: { "X-Forwarded-For": MY_IP } });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
};
const mailsTo = async (email) => {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return (await r.json()).messages ?? [];
};
const fullMail = async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
async function mailWith(email, needle) {
  for (let i = 0; i < 24; i++) {
    const m = (await mailsTo(email)).find((x) => x.Subject.includes(needle));
    if (m) return fullMail(m);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
// The link in a mail to `email` whose subject has `needle`, other than `oldTok` (a resend mints a new one).
async function linkAfter(email, needle, oldTok) {
  for (let i = 0; i < 24; i++) {
    for (const m of (await mailsTo(email)).filter((x) => x.Subject.includes(needle))) {
      const t = tokenIn((await fullMail(m)).Text);
      if (t && t !== oldTok) return t;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const tokenIn = (s) => /\/agree\/([A-Za-z0-9_-]{43})/.exec(s ?? "")?.[1] ?? null;
const sha = (x) => createHash("sha256").update(x).digest("hex");
const count = async (q) => Number(await sql(q));
const agreementsOf = (contactId) => count(`select count(*) from public.agreements where contact_id = '${contactId}'`);
const invoicesOf = (contactId) => count(`select count(*) from public.pipeline_invoices where contact_id = '${contactId}'`);
const snapshotsOf = (contactId) => count(`select count(*) from public.agreement_signatures s join public.agreements a on a.id = s.agreement_id where a.contact_id = '${contactId}'`);
const snapshot = async (agreementId) => JSON.parse((await sql(`select row_to_json(x)::text from (select signer_name, kind, image_sha256, encode(image_png, 'hex') as png from public.agreement_signatures where agreement_id = '${agreementId}') x`)) || "null");
const today = new Date().toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
const inv = (label, extra = {}) => ({ label, amountCents: 10000, dueOn: due, ...extra });
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const sections = (services = "{{counselor_name}} will guide {{student_name}} and {{family_name}} from {{date}}.") => [
  { id: "services", kind: "text", heading: "Services", body: services },
  { id: "prerequisites", kind: "list", heading: "Prerequisites", items: ["A completed intake form"] },
  { id: "fees", kind: "text", heading: "Fees", body: "See the invoice." },
  { id: "cancellation", kind: "clause", heading: "Cancellation", body: "Cancel in writing." },
];

const probe = await call((await user("cdi-probe")).token, "GET", "/agreements?contactId=00000000-0000-4000-8000-000000000000");
if (probe.status === 404 && probe.body?.code === "agreements_off") {
  console.log("AGREEMENTS_ENABLED is off on this API: these checks need it on.");
  process.exit(0);
}

const S = await user("cdi-solo");
const stage = (await call(S.token, "GET", "/pipeline")).body.stages[0];
const parentEmail = `cdi-parent-${tag}@families.test`;
const studentName = `Sam Draft ${tag}`;
const contact = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName, parentName: "Pat Parent", parentEmail })).body;
await call(S.token, "PUT", `/pipeline/contacts/${contact.id}/package`, { packageName: "Senior package", totalCents: 900000, installments: 3 });
const D = (await call(S.token, "POST", "/pipeline/contract-drafts", { title: `Agreement for {{student_name}} ${tag}`, sections: sections() })).body;
check("a draft to attach", typeof D.id === "string", JSON.stringify(D));
const mergedTitle = `Agreement for ${studentName} ${tag}`;

// ---- No saved signature: 409, nothing written ---------------------------------------------------------------
const before = { a: await agreementsOf(contact.id), i: await invoicesOf(contact.id) };
const noSig = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("Deposit", { agreement: { draftId: D.id } }));
check("no saved signature: 409 signature_needed", noSig.status === 409 && noSig.body.code === "signature_needed" && /Add your signature in Settings first/.test(noSig.body.error), JSON.stringify(noSig.body));
const noSigPv = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("Deposit", { agreement: { draftId: D.id } }));
check("(the preview says the same)", noSigPv.status === 409 && noSigPv.body.code === "signature_needed", JSON.stringify(noSigPv.body));
check("...and nothing was written (no agreement, no invoice number)", (await agreementsOf(contact.id)) === before.a && (await invoicesOf(contact.id)) === before.i);

// ---- Preview: renders, writes nothing ------------------------------------------------------------------------------
await call(S.token, "PUT", "/pipeline/signature", { kind: "typed", signerName: "Casey Signer" });
const pv = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("Deposit", { agreement: { draftId: D.id } }));
check("the preview answers the merged title and no id", pv.status === 200 && pv.body.agreement?.id === null && pv.body.agreement?.title === mergedTitle, JSON.stringify(pv.body.agreement ?? pv.body));
check("...and writes nothing (no agreement, no snapshot)", (await agreementsOf(contact.id)) === before.a && (await snapshotsOf(contact.id)) === 0);

// ---- Send: signed, frozen, accepted ----------------------------------------------------------------------------------
const sent = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`Deposit ${tag}`, { agreement: { draftId: D.id } }));
check("the invoice goes out with the drafted contract", sent.status === 201 && sent.body.emailSent === true && sent.body.agreement?.title === mergedTitle, JSON.stringify(sent.body));
const ag1 = (await call(S.token, "GET", `/agreements/${sent.body.agreement?.id}`)).body;
check("the agreement is sent, the sender's, the family's", ag1.status === "sent" && ag1.counselorId === S.id && ag1.contactId === contact.id, JSON.stringify(ag1));
check("its text has the parent's name, the student's, the counselor's and today's date", ["Pat Parent", studentName, "cdi-solo will guide", today].every((s) => ag1.bodyText?.includes(s)), ag1.bodyText);
check("and the signature line", ag1.bodyText?.includes(`Signed for cdi-solo by Casey Signer, ${today}.`) && !/SHA-256/.test(ag1.bodyText), ag1.bodyText?.slice(-120));
const snap1 = await snapshot(ag1.id);
check("one signature snapshot, the saved typed signature", snap1?.signer_name === "Casey Signer" && snap1.kind === "typed" && snap1.image_sha256 === null && (await snapshotsOf(contact.id)) === 1, JSON.stringify(snap1));
const mail1 = await mailWith(parentEmail, `Invoice ${sent.body.invoiceNumber}`);
const tok1 = tokenIn(mail1?.Text);
const page1 = tok1 ? await pub("GET", `/agree/${tok1}`) : { status: 0, text: "" };
check("the email's link opens the contract's text", page1.status === 200 && page1.text.includes("Casey Signer") && page1.text.includes("Pat Parent"), page1.text.slice(0, 100));
const accepted = await pub("POST", `/agree/${tok1}`, "signerName=Pat+Parent&consent=yes");
check("the family accepts with a typed name", accepted.status === 200 && /acceptance is recorded/i.test(accepted.text), accepted.text.slice(0, 120));
const acc1 = (await call(S.token, "GET", `/agreements/${ag1.id}`)).body;
check("the recorded hash is the sha256 of the signed text", acc1.status === "accepted" && acc1.acceptance?.bodySha256 === sha(ag1.bodyText), JSON.stringify(acc1.acceptance));
const typedPage = await pub("GET", `/agree/${tok1}`);
check("a typed signature has no image on the (accepted) page", typedPage.status === 200 && !typedPage.text.includes("<img") && typedPage.text.includes("Accepted by Pat Parent"), typedPage.text.slice(0, 80));
const typedSig = await pubBytes(`/agree/${tok1}/signature`);
check("...and /signature is 404 for it", typedSig.status === 404 && !(typedSig.headers.get("content-type") ?? "").startsWith("image/"), String(typedSig.status));

// ---- Replacing the signature changes nothing already sent ----------------------------------------------------------
await call(S.token, "PUT", "/pipeline/signature", { kind: "drawn", signerName: "Casey Drawn", imagePngBase64: PNG_B64 });
const ag1b = (await call(S.token, "GET", `/agreements/${ag1.id}`)).body;
check("after a new signature the earlier text is unchanged", ag1b.bodyText === ag1.bodyText);
check("...and so is its snapshot", JSON.stringify(await snapshot(ag1.id)) === JSON.stringify(snap1));

// ---- Drawn: the image's hash is bound into the text ------------------------------------------------------------------
const drawn = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`Second ${tag}`, { agreement: { draftId: D.id } }));
const ag2 = (await call(S.token, "GET", `/agreements/${drawn.body.agreement?.id}`)).body;
const snap2 = await snapshot(ag2.id);
const pngSha = sha(Buffer.from(PNG_B64, "base64"));
check("a drawn signature's text names the image hash", drawn.status === 201 && ag2.bodyText?.includes(`Signed for cdi-solo by Casey Drawn, ${today}.\nSignature image SHA-256: ${pngSha}`), ag2.bodyText?.slice(-160));
check("...the snapshot's own hash, and its image the saved bytes", snap2?.image_sha256 === pngSha && snap2.kind === "drawn" && snap2.png === Buffer.from(PNG_B64, "base64").toString("hex"), JSON.stringify(snap2));

// ---- The family's page shows the drawn signature -----------------------------------------------------------------------
const mail2 = await mailWith(parentEmail, `Invoice ${drawn.body.invoiceNumber}`);
const tok2 = tokenIn(mail2?.Text);
const sigPath = (t) => `/agree/${t}/signature`;
const imgTag = (t) => `<img src="${sigPath(t)}" alt="Signature of Casey Drawn"`;
const open2 = tok2 ? await pub("GET", `/agree/${tok2}`) : { status: 0, text: "", headers: new Headers() };
check("the open page shows the signature under the text, above the form", open2.status === 200 && open2.text.includes(imgTag(tok2)) && open2.text.indexOf("</pre>") < open2.text.indexOf("<img") && open2.text.indexOf("<img") < open2.text.indexOf("<form"), open2.text.slice(0, 200));
const pageCsp = open2.headers.get("content-security-policy") ?? "";
check("the page's CSP lets its own image load: img-src 'self', default-src 'none', nothing else widened", /(^|; )img-src 'self'(;|$)/.test(pageCsp) && /(^|; )default-src 'none'(;|$)/.test(pageCsp) && !/script-src|connect-src|object-src|https?:|data:|\*/.test(pageCsp), pageCsp);
const png = await pubBytes(sigPath(tok2));
check("the image is 200 image/png, the saved bytes, hashing to image_sha256", png.status === 200 && png.headers.get("content-type") === "image/png" && sha(png.bytes) === snap2.image_sha256 && png.bytes.toString("hex") === snap2.png, `${png.status} ${png.headers.get("content-type")}`);
const h = (n) => png.headers.get(n);
check("...no-store, nosniff, no referrer, noindex, and a sandboxing CSP of its own", /no-store/.test(h("cache-control")) && h("x-content-type-options") === "nosniff" && h("referrer-policy") === "no-referrer" && h("x-robots-tag") === "noindex" && h("content-security-policy") === "default-src 'none'; sandbox", JSON.stringify([...png.headers]));
check("a wrong link gets no image (404)", (await pubBytes(sigPath("A".repeat(43)))).status === 404);
check("a malformed link gets none either (404)", (await pubBytes(sigPath("short"))).status === 404);

// A second drawn contract, accepted: its page, the "already accepted" answer and the image all still show it.
const drawn3 = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`Third ${tag}`, { agreement: { draftId: D.id } }));
const tok3 = tokenIn((await mailWith(parentEmail, `Invoice ${drawn3.body.invoiceNumber}`))?.Text);
const done3 = await pub("POST", `/agree/${tok3}`, "signerName=Pat+Parent&consent=yes");
check("accepting a drawn-signature contract: the answer shows the image", done3.status === 200 && /acceptance is recorded/i.test(done3.text) && done3.text.includes(imgTag(tok3)), done3.text.slice(0, 120));
const acceptedPage3 = await pub("GET", `/agree/${tok3}`);
check("the accepted page shows the image above the accepted lines", acceptedPage3.status === 200 && acceptedPage3.text.includes(imgTag(tok3)) && acceptedPage3.text.indexOf("<img") < acceptedPage3.text.indexOf("Accepted by") && !acceptedPage3.text.includes("<form"));
const again3 = await pub("POST", `/agree/${tok3}`, "signerName=Pat+Parent&consent=yes");
check("a second submit (409 already accepted) shows it too", again3.status === 409 && again3.text.includes(imgTag(tok3)), String(again3.status));
const png3 = await pubBytes(sigPath(tok3));
check("and the image is still served once accepted", png3.status === 200 && png3.headers.get("content-type") === "image/png" && sha(png3.bytes) === snap2.image_sha256);
const bad3 = await pub("POST", `/agree/${tok2}`, "signerName=&consent=no");
check("the form-error page (open, 400) keeps the image", bad3.status === 400 && bad3.text.includes(imgTag(tok2)), String(bad3.status));

// ---- Edit, then archive, the draft --------------------------------------------------------------------------------------
await call(S.token, "PUT", `/pipeline/contract-drafts/${D.id}`, { title: "Changed", sections: sections("Something else for {{student_name}}.") });
check("editing the draft leaves the sent text alone", (await call(S.token, "GET", `/agreements/${ag2.id}`)).body.bodyText === ag2.bodyText);
await call(S.token, "DELETE", `/pipeline/contract-drafts/${D.id}`);
check("archiving it too", (await call(S.token, "GET", `/agreements/${ag2.id}`)).body.bodyText === ag2.bodyText);
const archived = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { agreement: { draftId: D.id } }));
check("an archived draft can't be attached (404)", archived.status === 404, JSON.stringify(archived.body));

// ---- Send again with the agreement: no second signature, same text, a new link ------------------------------------------
const inv2 = await sql(`select id from public.pipeline_invoices where contact_id = '${contact.id}' and number = '${drawn.body.invoiceNumber}'`);
const snapsBefore = await snapshotsOf(contact.id);
const again = await call(S.token, "POST", `/pipeline/invoices/${inv2}/send`, { agreement: { agreementId: ag2.id } });
check("Send again with the drafted contract's agreement", again.status === 200 && again.body.agreement?.id === ag2.id, JSON.stringify(again.body));
check("...still one snapshot for it, the same text", (await snapshotsOf(contact.id)) === snapsBefore && JSON.stringify(await snapshot(ag2.id)) === JSON.stringify(snap2) && (await call(S.token, "GET", `/agreements/${ag2.id}`)).body.bodyText === ag2.bodyText);
check("...and the earlier link stopped (a new one went)", tok2 && (await pub("GET", `/agree/${tok2}`)).status === 410);
check("...its image stopped with it (410, like the file)", (await pubBytes(sigPath(tok2))).status === 410);
const tok2b = await linkAfter(parentEmail, `Invoice ${drawn.body.invoiceNumber}`, tok2);
check("the new link still shows the image", tok2b && (await pubBytes(sigPath(tok2b))).status === 200 && (await pub("GET", `/agree/${tok2b}`)).text.includes(imgTag(tok2b)));
const voided = await call(S.token, "POST", `/agreements/${ag2.id}/void`);
check("a withdrawn agreement: its page and its image are 410", voided.status === 200 && (await pub("GET", `/agree/${tok2b}`)).status === 410 && (await pubBytes(sigPath(tok2b))).status === 410, JSON.stringify(voided.body));

// An agreement with no snapshot (every older one) is the page it always was.
const plainSent = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`Plain ${tag}`, { agreement: { title: `Plain ${tag}`, bodyText: "Plain terms with no signature." } }));
const tokPlain = tokenIn((await mailWith(parentEmail, `Invoice ${plainSent.body.invoiceNumber}`))?.Text);
const plainPage = await pub("GET", `/agree/${tokPlain}`);
check("an agreement with no snapshot: no image, the form follows the text", plainSent.status === 201 && plainPage.status === 200 && !plainPage.text.includes("<img") && /<\/pre>\n<form method="post">/.test(plainPage.text), plainPage.text.slice(0, 120));
check("...and /signature is 404 for it", (await pubBytes(sigPath(tokPlain))).status === 404);

// ---- A stored image that doesn't match the signed text is never served (503) -------------------------------------------
// The snapshot table refuses UPDATE and DELETE but not INSERT, and sql() runs as postgres, so each case is its own
// sent agreement (plain text, no snapshot) given one forged drawn row. Rows can't be deleted; every run makes fresh agreements.
const P = Buffer.from(PNG_B64, "base64");
const Q = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const H = sha(P);
const HQ = sha(Q);
const textNaming = (h) => `Staged terms.\n\nSigned for cdi-solo by Casey Forged, ${today}.${h ? `\nSignature image SHA-256: ${h}` : ""}`;
async function staged(label, text, bytes, rowSha) {
  const r = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`${label} ${tag}`, { agreement: { title: `${label} ${tag}`, bodyText: text } }));
  const id = r.body.agreement?.id;
  const tok = tokenIn((await mailWith(parentEmail, `Invoice ${r.body.invoiceNumber}`))?.Text);
  await sql(`insert into public.agreement_signatures (agreement_id, signer_name, kind, image_png, image_sha256) values ('${id}', 'Casey Forged', 'drawn', decode('${bytes.toString("hex")}', 'hex'), '${rowSha}')`);
  return { id, tok };
}
const refused = (r) => r.status === 503 && !(r.headers.get("content-type") ?? "").startsWith("image/") && !r.bytes.includes(P) && !r.bytes.includes(Q) && !r.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
check("(the staged images are different bytes)", H !== HQ);
const okRow = await staged("Staged ok", textNaming(HQ), Q, HQ);
const okImg = await pubBytes(sigPath(okRow.tok));
check("control: a consistent forged row (bytes, row hash and text agree) is served", okImg.status === 200 && okImg.headers.get("content-type") === "image/png" && okImg.bytes.equals(Q), String(okImg.status));
const badBytes = await staged("Staged bytes", textNaming(H), Q, H);
const r1 = await pubBytes(sigPath(badBytes.tok));
check("stored bytes that don't hash to the row's hash (the text names that hash): 503, nothing served", refused(r1), `${r1.status} ${r1.headers.get("content-type")}`);
const otherText = await staged("Staged text", textNaming(H), Q, HQ);
const r2 = await pubBytes(sigPath(otherText.tok));
check("a consistent row whose image the text does NOT name (it names another hash): 503, nothing served", refused(r2), `${r2.status} ${r2.headers.get("content-type")}`);
const noLine = await staged("Staged noline", textNaming(null), Q, HQ);
const r3 = await pubBytes(sigPath(noLine.tok));
check("a drawn row whose text has no `Signature image SHA-256:` line at all: 503, not 200", refused(r3), `${r3.status} ${r3.headers.get("content-type")}`);
if (process.env.API_LOG) {
  let log = "";
  for (let i = 0; i < 20; i++) {
    log = readFileSync(process.env.API_LOG, "utf8");
    if ([badBytes, otherText, noLine].every((x) => log.includes(`"agreement":"${x.id}"`))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const lines = log.split("\n").filter((l) => l.includes("the signature image doesn't match"));
  check("each refusal is logged by agreement id", [badBytes, otherText, noLine].every((x) => lines.some((l) => l.includes(`"agreement":"${x.id}"`))));
  check("...and never with the image bytes", !log.includes(Q.toString("hex")) && !log.includes(Q.toString("base64")) && !log.includes(P.toString("hex")) && !log.includes(P.toString("base64")));
  check("...and the control (consistent) logged no refusal", !lines.some((l) => l.includes(okRow.id)));
}

// ---- Refusals before anything is written --------------------------------------------------------------------------------
const D2 = (await call(S.token, "POST", "/pipeline/contract-drafts", { title: "Plain", sections: sections() })).body;
const noName = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName: `No parent name ${tag}`, parentEmail: `cdi-np-${tag}@families.test` })).body;
await call(S.token, "PUT", `/pipeline/contacts/${noName.id}/package`, { packageName: "P", totalCents: 100000, installments: 1 });
const refusedBefore = { a: await agreementsOf(noName.id), i: await invoicesOf(noName.id) };
const missing = await call(S.token, "POST", `/pipeline/contacts/${noName.id}/invoices`, inv("X", { agreement: { draftId: D2.id } }));
check("a parent email with no parent name: 400 contract_fields_missing, in words", missing.status === 400 && missing.body.code === "contract_fields_missing" && /the parent's or student's name/.test(missing.body.error) && /family's card/.test(missing.body.error), JSON.stringify(missing.body));
const Dfee = (await call(S.token, "POST", "/pipeline/contract-drafts", { title: "Fee", sections: sections("The fee is {{fee}}.") })).body;
const unknown = await call(S.token, "POST", `/pipeline/contacts/${noName.id}/invoices`, inv("X", { agreement: { draftId: Dfee.id } }));
check("an unknown field: 400 contract_fields_missing naming {{fee}}", unknown.status === 400 && unknown.body.code === "contract_fields_missing" && unknown.body.error.includes("{{fee}}"), JSON.stringify(unknown.body));
const Dlong = (await call(S.token, "POST", "/pipeline/contract-drafts", { title: "Long", sections: sections("{{student_name}}".repeat(3000)) })).body;
const tooLong = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { agreement: { draftId: Dlong.id } }));
check("a render over 60,000 characters: 400 contract_too_long", tooLong.status === 400 && tooLong.body.code === "contract_too_long", JSON.stringify(tooLong.body));
const pvLong = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("X", { agreement: { draftId: Dlong.id } }));
check("(the preview refuses it the same way)", pvLong.status === 400 && pvLong.body.code === "contract_too_long", JSON.stringify(pvLong.body));
const needsSend = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { send: false, agreement: { draftId: D2.id } }));
check("send: false with a draft: 400 agreement_needs_send", needsSend.status === 400 && needsSend.body.code === "agreement_needs_send", JSON.stringify(needsSend.body));
const textInv = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { channel: "text", agreement: { draftId: D2.id } }));
check("a text invoice with a draft: 400 text_no_agreement", textInv.status === 400 && textInv.body.code === "text_no_agreement", JSON.stringify(textInv.body));
check("none of them wrote anything", (await agreementsOf(noName.id)) === refusedBefore.a && (await invoicesOf(noName.id)) === refusedBefore.i && (await agreementsOf(contact.id)) === 8);

// ---- A firm member signs as themselves ---------------------------------------------------------------------------------------
const A = await user("cdi-owner");
const B = await user("cdi-member");
const firm = await call(A.token, "POST", "/firms", { name: `Draft Firm ${tag}` });
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firm.body.firmId}', '${B.id}', 'counselor') on conflict do nothing`);
await sql(`update public.profiles set firm_id = '${firm.body.firmId}' where id = '${B.id}'`);
const FD = (await call(A.token, "POST", "/pipeline/contract-drafts", { title: "Firm contract", sections: sections() })).body;
await call(A.token, "PUT", "/pipeline/signature", { kind: "typed", signerName: "Owner Ann" });
await call(B.token, "PUT", "/pipeline/signature", { kind: "typed", signerName: "Member Bea" });
const aStage = (await call(A.token, "GET", "/pipeline")).body.stages[0];
const bEmail = `cdi-b-${tag}@families.test`;
const bc = (await call(A.token, "POST", "/pipeline/contacts", { stageId: aStage.id, studentName: `Firm Kid ${tag}`, parentName: "Fran Firm", parentEmail: bEmail })).body;
await call(A.token, "PUT", `/pipeline/contacts/${bc.id}/package`, { packageName: "P", totalCents: 100000, installments: 1 });
// The contact's owner may bill it: hand the family to the member.
await call(A.token, "PATCH", `/pipeline/contacts/${bc.id}`, { ownerId: B.id });
const bSent = await call(B.token, "POST", `/pipeline/contacts/${bc.id}/invoices`, inv(`Firm ${tag}`, { agreement: { draftId: FD.id } }));
const bAg = (await call(B.token, "GET", `/agreements/${bSent.body.agreement?.id}`)).body;
check("a non-admin firm member attaches the firm's draft", bSent.status === 201 && bAg.status === "sent" && bAg.counselorId === B.id, JSON.stringify(bSent.body));
check("...signed by them, for the firm", bAg.bodyText?.includes(`Signed for Draft Firm ${tag} by Member Bea, ${today}.`) && (await snapshot(bAg.id))?.signer_name === "Member Bea", bAg.bodyText?.slice(-100));

// ---- Scheduled invoices can't carry a draft; the cron refuses one ------------------------------------------------------------
const payload = inv(`Saved ${tag}`, { agreement: { draftId: D2.id } });
const sched = await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: contact.id, payload, state: "scheduled" });
check("a scheduled invoice with a drafted contract: 409 draft_contract_send_now", sched.status === 409 && sched.body.code === "draft_contract_send_now", JSON.stringify(sched.body));
const saved = await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: contact.id, payload, state: "draft" });
check("saving it unscheduled is fine", saved.status === 201, JSON.stringify(saved.body));
const toSched = await call(S.token, "PUT", `/pipeline/invoice-drafts/${saved.body.id}`, { state: "scheduled" });
check("...and scheduling it later is refused the same way", toSched.status === 409 && toSched.body.code === "draft_contract_send_now", JSON.stringify(toSched.body));
const sendNow = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, payload);
check("the composer's Send now signs it", sendNow.status === 201 && Boolean(await snapshot(sendNow.body.agreement?.id)), JSON.stringify(sendNow.body));
// A row that got past the route (written straight to the table) is refused by the cron, never signed.
const forged = await sql(
  `insert into public.pipeline_invoice_drafts (contact_id, payload, state, send_at, created_by) values ('${contact.id}', '${JSON.stringify(payload)}'::jsonb, 'scheduled', now() - interval '1 minute', '${S.id}') returning id`
);
const agBefore = await agreementsOf(contact.id);
await fetch(`${API}/internal/invoice-drafts/dispatch`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}`, "X-Forwarded-For": MY_IP } });
const forgedRow = JSON.parse(await sql(`select row_to_json(x)::text from (select state, last_error from public.pipeline_invoice_drafts where id = '${forged.split("\n")[0]}') x`));
check("the cron refuses a stored drafted contract", forgedRow.state === "failed" && /signed when you send it/.test(forgedRow.last_error ?? ""), JSON.stringify(forgedRow));
check("...and signed nothing", (await agreementsOf(contact.id)) === agBefore);

// ---- A draft row written by hand is held to the save rules again at send ----------------------------------------------------
// contract_drafts is writable through PostgREST by an admin, so a row can hold any jsonb: here a list with no items.
const forgedDraft = (
  await sql(`insert into public.contract_drafts (counselor_id, practice_id, title, sections, created_by) values ('${S.id}', '${S.id}', 'Forged ${tag}', '[{"kind":"list"}]'::jsonb, '${S.id}') returning id`)
).split("\n")[0];
const forgedBefore = { a: await agreementsOf(contact.id), i: await invoicesOf(contact.id), s: await snapshotsOf(contact.id) };
const forgedPreview = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("X", { agreement: { draftId: forgedDraft } }));
const forgedSend = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { agreement: { draftId: forgedDraft } }));
const forgedMsg = "This drafted contract needs fixing in your library before it can be sent.";
check("a forged draft row: the preview is 400 contract_draft_invalid, in words", forgedPreview.status === 400 && forgedPreview.body.code === "contract_draft_invalid" && forgedPreview.body.error === forgedMsg, JSON.stringify(forgedPreview.body));
check("...and so is the send (not a 500)", forgedSend.status === 400 && forgedSend.body.code === "contract_draft_invalid" && forgedSend.body.error === forgedMsg, JSON.stringify(forgedSend.body));
check("...with no invoice, agreement or snapshot written", (await agreementsOf(contact.id)) === forgedBefore.a && (await invoicesOf(contact.id)) === forgedBefore.i && (await snapshotsOf(contact.id)) === forgedBefore.s);

// ---- agreement_signatures: the database's own guards -------------------------------------------------------------------------
// S's saved signature is set here so every row below is judged against a known one.
const PNGB = Buffer.from(PNG_B64, "base64");
await call(S.token, "PUT", "/pipeline/signature", { kind: "drawn", signerName: "Casey Guard", imagePngBase64: PNG_B64 });
const GRP = "/rest/v1/agreement_signatures";
const hex = (b) => `\\x${b.toString("hex")}`;
const mine = (agreementId, over = {}) => ({ agreement_id: agreementId, signer_name: "Casey Guard", kind: "drawn", image_png: hex(PNGB), image_sha256: sha(PNGB), ...over });
const insertSnap = (token, body) => rest(token, "POST", GRP, body, { Prefer: "return=minimal" });
const snapCount = (id) => count(`select count(*) from public.agreement_signatures where agreement_id = '${id}'`);
const refusedRls = (r) => r.status === 403 && r.body?.code === "42501";
// Run as postgres inside a transaction that is rolled back, so a guard that did not hold would still change nothing.
const sqlError = async (q) => {
  try {
    await sql(`begin; ${q}; rollback;`);
    return null;
  } catch (e) {
    return String(e.stderr ?? e.message);
  }
};
const newAgreement = async (token, contactId, title) => (await call(token, "POST", "/agreements", { contactId, title: `${title} ${tag}`, bodyText: "Terms." })).body.id;
const stageG = (await call(S.token, "GET", "/pipeline")).body.stages[0];
const K = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stageG.id, studentName: `Guard Kid ${tag}`, parentName: "Gail Guard", parentEmail: `cdi-guard-${tag}@families.test` })).body;

// The insert policy: only the caller's own saved signature, on their own draft agreement.
const G = await newAgreement(S.token, K.id, "Guard draft");
check("an insert whose image hash is not the saved signature's is refused", refusedRls(await insertSnap(S.token, mine(G, { image_sha256: "0".repeat(64) }))) && (await snapCount(G)) === 0);
check("...nor another signer name", refusedRls(await insertSnap(S.token, mine(G, { signer_name: "Casey Other" }))) && (await snapCount(G)) === 0);
const Q64 = Q.toString("hex");
check("...nor another image, even with its own correct hash", refusedRls(await insertSnap(S.token, mine(G, { image_png: `\\x${Q64}`, image_sha256: HQ }))) && (await snapCount(G)) === 0);
check("...nor a typed one when the saved signature is drawn", refusedRls(await insertSnap(S.token, { agreement_id: G, signer_name: "Casey Guard", kind: "typed" })) && (await snapCount(G)) === 0);
const Hsent = await newAgreement(S.token, K.id, "Guard sent");
check("(the agreement to be sent is a draft first)", (await call(S.token, "POST", `/agreements/${Hsent}/send`)).status === 200);
check("an agreement already sent can't be given a snapshot, even the caller's own signature", refusedRls(await insertSnap(S.token, mine(Hsent))) && (await snapCount(Hsent)) === 0);
const A2 = await newAgreement(A.token, bc.id, "Colleague draft");
const typedMine = (agreementId) => ({ agreement_id: agreementId, signer_name: "Member Bea", kind: "typed" });
check("a colleague's draft agreement can't be given a snapshot, even with the caller's own saved signature", refusedRls(await insertSnap(B.token, typedMine(A2))) && (await snapCount(A2)) === 0);
const B2 = await newAgreement(B.token, bc.id, "Own draft");
check("(control: the same insert on their own draft agreement goes through)", (await insertSnap(B.token, typedMine(B2))).status === 201 && (await snapCount(B2)) === 1);
const okSnap = await insertSnap(S.token, mine(G));
check("control: the caller's own saved signature on their own draft agreement goes through", okSnap.status === 201 && (await snapCount(G)) === 1, JSON.stringify(okSnap.body));

// Column grants: the image is the service role's alone.
const noImg = await rest(S.token, "GET", `${GRP}?agreement_id=eq.${G}&select=image_png`);
check("an authenticated select of image_png is denied", refusedRls(noImg) && !JSON.stringify(noImg.body).includes(PNGB.toString("hex")) && !JSON.stringify(noImg.body).includes(PNG_B64), JSON.stringify(noImg.body));
check("...select=* is denied too", refusedRls(await rest(S.token, "GET", `${GRP}?agreement_id=eq.${G}&select=*`)));
const cols = await rest(S.token, "GET", `${GRP}?agreement_id=eq.${G}&select=agreement_id,signer_name,kind,image_sha256`);
check("the other columns read for the practice's own member", cols.status === 200 && JSON.stringify(cols.body) === JSON.stringify([{ agreement_id: G, signer_name: "Casey Guard", kind: "drawn", image_sha256: sha(PNGB) }]), JSON.stringify(cols.body));
check("another practice reads no snapshot rows", ((await rest((await user("cdi-guard-other")).token, "GET", `${GRP}?agreement_id=eq.${G}&select=agreement_id`)).body ?? []).length === 0);

// Immutable: a signature is never changed or removed, by a client or by postgres itself.
const snapG = await snapshot(G);
const signedAtG = await sql(`select signed_at::text from public.agreement_signatures where agreement_id = '${G}'`);
const permanent = /permanent record/;
check("UPDATE is refused, even as postgres", permanent.test((await sqlError(`update public.agreement_signatures set signer_name = 'Changed' where agreement_id = '${G}'`)) ?? ""));
check("DELETE is refused, even as postgres", permanent.test((await sqlError(`delete from public.agreement_signatures where agreement_id = '${G}'`)) ?? ""));
check("TRUNCATE is refused, even as postgres", permanent.test((await sqlError("truncate public.agreement_signatures")) ?? ""));
check("PostgREST has no UPDATE or DELETE for it either", refusedRls(await rest(S.token, "PATCH", `${GRP}?agreement_id=eq.${G}`, { signer_name: "Changed" })) && refusedRls(await rest(S.token, "DELETE", `${GRP}?agreement_id=eq.${G}`)));
check("...and the row is exactly as it was", JSON.stringify(await snapshot(G)) === JSON.stringify(snapG) && (await sql(`select signed_at::text from public.agreement_signatures where agreement_id = '${G}'`)) === signedAtG);

// The cascade: removing a DRAFT agreement removes its snapshot (the delete runs nested inside the foreign key's own trigger).
const G4 = await newAgreement(S.token, K.id, "Cascade draft");
check("(a draft agreement with a snapshot)", (await insertSnap(S.token, mine(G4))).status === 201 && (await snapCount(G4)) === 1);
await sql(`delete from public.agreements where id = '${G4}'`);
check("deleting the draft agreement removes its snapshot", (await sql(`select count(*) from public.agreements where id = '${G4}'`)) === "0" && (await snapCount(G4)) === 0);

// ...and through the contact, with AxIS Restore putting the snapshot back with its image.
const action = randomUUID();
const gone = await rest(S.token, "DELETE", `/rest/v1/pipeline_contacts?id=eq.${K.id}`, undefined, { "x-meridies-axis-action": action, Prefer: "return=representation" });
check("an AxIS-marked delete of the contact goes through and takes the snapshot with its agreement", gone.status === 200 && (await snapCount(G)) === 0 && (await agreementsOf(K.id)) === 0, JSON.stringify(gone.body));
check("the snapshot is kept in the trash", (await sql(`select count(*) from private.axis_trash where action_id = '${action}' and table_name = 'agreement_signatures'`)) === "1");
const back = await rest(S.token, "POST", "/rest/v1/rpc/axis_trash_restore", { p_action: action });
check("Restore puts the snapshot back with its image, hash and time", back.status === 200 && back.body?.ok === true && JSON.stringify(await snapshot(G)) === JSON.stringify(snapG) && (await sql(`select signed_at::text from public.agreement_signatures where agreement_id = '${G}'`)) === signedAtG, JSON.stringify(back.body));
