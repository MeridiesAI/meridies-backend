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
// typed one has no image and no such route. (A stored image whose hash isn't the one the text names is a 503;
// the snapshot table refuses updates, so that case is a unit test with a stub: test/unit/agreements.test.ts.)
import { createHash } from "node:crypto";
import { API, CRON_SECRET, call, check, sql, user } from "./harness.mjs";

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
check("none of them wrote anything", (await agreementsOf(noName.id)) === refusedBefore.a && (await invoicesOf(noName.id)) === refusedBefore.i && (await agreementsOf(contact.id)) === 4);

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
