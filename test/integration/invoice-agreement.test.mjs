// An agreement sent with an invoice (lib/invoiceAgreement.ts): one email holding the invoice and the
// agreement's /agree/:token link, against a running API (see harness.mjs). With AGREEMENTS_ENABLED off
// only the "switched off" checks run: asking for an agreement is 404 agreements_off and nothing is
// written, and an invoice without one is sent exactly as before.
//
// Checks: the preview shows the agreement and mints nothing; a refusal (another family's agreement,
// a void one, a recorded-only invoice) leaves no invoice behind; Send mints the link the way
// POST /agreements/:id/send does (draft -> sent) and emails ONE message with both; the delivery
// record keeps no link; Send again with the agreement expires the earlier link; a new agreement
// written inline is saved and sent; the family accepts on the usual page; an accepted agreement
// can't be attached again; Send again without one is the plain invoice email.
import { randomUUID } from "node:crypto";
import { API, call, check, sql, user } from "./harness.mjs";

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
  return { status: r.status, text: await r.text() };
};
const mailsTo = async (email) => {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return (await r.json()).messages ?? [];
};
const fullMail = async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
/** The newest mail to `email` whose subject has `needle`, waiting for it to land. */
async function mailWith(email, needle) {
  for (let i = 0; i < 24; i++) {
    const m = (await mailsTo(email)).find((x) => x.Subject.includes(needle));
    if (m) return fullMail(m);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const tokenIn = (s) => /\/agree\/([A-Za-z0-9_-]{43})/.exec(s ?? "")?.[1] ?? null;
const invoiceCount = async (contactId) => Number(await sql(`select count(*) from public.pipeline_invoices where contact_id = '${contactId}'`));

const S = await user("ia-solo");
const board = (await call(S.token, "GET", "/pipeline")).body;
const stage = board.stages[0];
const parentEmail = `ia-parent-${tag}@families.test`;
const contact = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName: `Ivy Invoice ${tag}`, parentName: "Pat Invoice", parentEmail })).body;
const pkg = await call(S.token, "PUT", `/pipeline/contacts/${contact.id}/package`, { packageName: "Senior package", totalCents: 600000, installments: 3 });
check("a package to bill", pkg.status === 200, JSON.stringify(pkg.body));
const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
const inv = (label, extra = {}) => ({ label, amountCents: 50000, dueOn: due, ...extra });

// ---- Switched off --------------------------------------------------------------------------
const probe = await call(S.token, "GET", `/agreements?contactId=${contact.id}`);
if (probe.status === 404 && probe.body?.code === "agreements_off") {
  const before = await invoiceCount(contact.id);
  for (const agreement of [{ agreementId: randomUUID() }, { title: "T", bodyText: "B" }]) {
    const p = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("Off", { agreement }));
    check("switched off: a preview asking for an agreement is 404 agreements_off", p.status === 404 && p.body.code === "agreements_off", JSON.stringify(p.body));
    const r = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("Off", { agreement }));
    check("switched off: an invoice asking for an agreement is 404 agreements_off", r.status === 404 && r.body.code === "agreements_off", JSON.stringify(r.body));
  }
  check("switched off: and no invoice was made", (await invoiceCount(contact.id)) === before);
  const plain = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`Plain ${tag}`));
  check("switched off: an invoice without one is sent as before", plain.status === 201 && plain.body.emailSent === true && !("agreement" in plain.body), JSON.stringify(plain.body));
  const m = await mailWith(parentEmail, plain.body.invoiceNumber);
  check("switched off: its email has no agreement in it", m && !/agreement/i.test(m.Text) && !tokenIn(m.Text), m?.Subject);
  console.log("AGREEMENTS_ENABLED is off on this API: only the switched-off checks ran.");
  process.exit(process.exitCode ?? 0);
}

// ---- Preview -----------------------------------------------------------------------------------
const title = `Engagement letter ${tag}`;
const A = (await call(S.token, "POST", "/agreements", { contactId: contact.id, title, bodyText: "1. Fees as invoiced.\n2. Terms <b>&</b>." })).body;
check("a draft agreement for the family", A.status === "draft", JSON.stringify(A));
const pv = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("Deposit", { agreement: { agreementId: A.id } }));
check(
  "the preview names the agreement and says so in the subject",
  pv.status === 200 && pv.body.agreement?.id === A.id && pv.body.agreement?.title === title && /agreement to review/.test(pv.body.subject),
  JSON.stringify(pv.body)
);
check("the preview's text has the agreement block, with no link", pv.body.text?.includes("Review and accept the agreement") && !tokenIn(pv.body.text));
check("the preview mints nothing (still a draft)", (await call(S.token, "GET", `/agreements/${A.id}`)).body.status === "draft");
const agreementsBefore = Number(await sql(`select count(*) from public.agreements where contact_id = '${contact.id}'`));
const pvInline = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("Deposit", { agreement: { title: "Inline preview", bodyText: "x" } }));
check("an inline agreement previews without being saved", pvInline.status === 200 && pvInline.body.agreement?.id === null && pvInline.body.agreement?.title === "Inline preview", JSON.stringify(pvInline.body));
check("(no agreement row was written)", Number(await sql(`select count(*) from public.agreements where contact_id = '${contact.id}'`)) === agreementsBefore);
const pvPlain = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, inv("Deposit"));
check("a preview without one has no agreement field and no agreement words", pvPlain.status === 200 && !("agreement" in pvPlain.body) && !/agreement/i.test(pvPlain.body.text + pvPlain.body.subject), JSON.stringify(pvPlain.body));

// ---- Refusals leave nothing behind ------------------------------------------------------------------
const other = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName: `Other ${tag}`, parentEmail: `ia-other-${tag}@families.test` })).body;
const otherAg = (await call(S.token, "POST", "/agreements", { contactId: other.id, title: "Other family", bodyText: "x" })).body;
const voided = (await call(S.token, "POST", "/agreements", { contactId: contact.id, title: "Voided", bodyText: "x" })).body;
await call(S.token, "POST", `/agreements/${voided.id}/void`);
const before = await invoiceCount(contact.id);
const r1 = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { agreement: { agreementId: otherAg.id } }));
check("another family's agreement can't be attached (404)", r1.status === 404, JSON.stringify(r1.body));
const r2 = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { agreement: { agreementId: voided.id } }));
check("a void agreement can't be attached (409 agreement_closed)", r2.status === 409 && r2.body.code === "agreement_closed", JSON.stringify(r2.body));
const r3 = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv("X", { send: false, agreement: { agreementId: A.id } }));
check("an invoice only recorded can't carry one (400)", r3.status === 400 && r3.body.code === "agreement_needs_send", JSON.stringify(r3.body));
check("no invoice was made by any of them", (await invoiceCount(contact.id)) === before);
check("(and the other family's agreement is still a draft)", (await call(S.token, "GET", `/agreements/${otherAg.id}`)).body.status === "draft");
const X = await user("ia-outsider");
const xc = (await call(X.token, "POST", "/pipeline/contacts", { stageId: (await call(X.token, "GET", "/pipeline")).body.stages[0].id, studentName: `X ${tag}`, parentEmail: `ia-x-${tag}@families.test` })).body;
await call(X.token, "PUT", `/pipeline/contacts/${xc.id}/package`, { packageName: "P", totalCents: 100000, installments: 1 });
const xr = await call(X.token, "POST", `/pipeline/contacts/${xc.id}/invoices`, inv("X", { agreement: { agreementId: A.id } }));
check("another practice can't send someone else's agreement on their invoice (404)", xr.status === 404, JSON.stringify(xr.body));
check("(it is still a draft)", (await call(S.token, "GET", `/agreements/${A.id}`)).body.status === "draft");

// ---- Send: one email, both ---------------------------------------------------------------------------------
const sent = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`Deposit ${tag}`, { agreement: { agreementId: A.id } }));
check("the invoice goes out with the agreement", sent.status === 201 && sent.body.emailSent === true && sent.body.agreement?.id === A.id, JSON.stringify(sent.body));
const number = sent.body.invoiceNumber;
check("the agreement is now sent (its link minted the usual way)", (await call(S.token, "GET", `/agreements/${A.id}`)).body.status === "sent");
const mail = await mailWith(parentEmail, `Invoice ${number}`);
check("ONE email to the parent, its subject naming the invoice and the agreement", mail && /agreement to review/.test(mail.Subject), mail?.Subject);
const mails = (await mailsTo(parentEmail)).filter((m) => m.Subject.includes(`Invoice ${number}`) || m.Subject.includes(title));
check("no separate agreement email went", mails.length === 1, mails.map((m) => m.Subject).join(" | "));
const tok1 = tokenIn(mail?.Text);
check("the email carries the /agree/ link, in the text and as the HTML button", tok1 && mail.HTML.includes(`/agree/${tok1}`) && mail.HTML.includes("Review and accept the agreement"));
check("and the invoice itself", mail?.HTML.includes(`Invoice ${number}`) && mail.HTML.includes("Amount due") && mail.HTML.includes("$500"));
check("the title is escaped in the HTML", !mail?.HTML.includes("<b>&</b>"));
const rec = await sql(`select template || '|' || body from public.message_deliveries d join public.pipeline_invoices i on i.message_delivery_id = d.id where i.contact_id = '${contact.id}' and i.number = '${number}'`);
check("the delivery record is marked as carrying an agreement", rec.startsWith("pipeline-invoice-agreement|"), rec.slice(0, 60));
check("and keeps no link to it", !rec.includes("/agree/") && rec.includes("[private agreement link omitted]") && rec.includes(title));
const view1 = await pub("GET", `/agree/${tok1}`);
check("the link opens the usual agreement page", view1.status === 200 && view1.text.includes("Accept the agreement"));

// ---- Send again: a new link, the old one stops ----------------------------------------------------------------
const invoiceId = await sql(`select id from public.pipeline_invoices where contact_id = '${contact.id}' and number = '${number}'`);
const again = await call(S.token, "POST", `/pipeline/invoices/${invoiceId}/send`, { agreement: { agreementId: A.id } });
check("Send again with the agreement", again.status === 200 && again.body.emailSent === true && again.body.agreement?.id === A.id, JSON.stringify(again.body));
let tok2 = null;
for (let i = 0; i < 24 && !tok2; i++) {
  for (const m of await mailsTo(parentEmail)) {
    const t = tokenIn((await fullMail(m)).Text);
    if (t && t !== tok1) tok2 = t;
  }
  if (!tok2) await new Promise((r) => setTimeout(r, 250));
}
check("a new link went out", Boolean(tok2));
check("the earlier link expired, as a resend always does", (await pub("GET", `/agree/${tok1}`)).status === 410);

// ---- Inline: written in the invoice form ----------------------------------------------------------------
const inlineTitle = `Payment terms ${tag}`;
const inline = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, inv(`Second ${tag}`, { agreement: { title: inlineTitle, bodyText: "Pay within 14 days." } }));
check("a new agreement written with the invoice is saved and sent", inline.status === 201 && inline.body.agreement?.title === inlineTitle, JSON.stringify(inline.body));
const B = (await call(S.token, "GET", `/agreements/${inline.body.agreement?.id}`)).body;
check("it is the contact's, sent, with the text as written", B.contactId === contact.id && B.status === "sent" && B.bodyText === "Pay within 14 days.", JSON.stringify(B));

// ---- The family accepts ----------------------------------------------------------------------------------------
const acc = await pub("POST", `/agree/${tok2}`, "signerName=Pat+Invoice&consent=yes");
check("the family accepts on the usual page", acc.status === 200 && /acceptance is recorded/i.test(acc.text), acc.text.slice(0, 120));
const listed = (await call(S.token, "GET", `/agreements?contactId=${contact.id}`)).body.agreements.find((a) => a.id === A.id);
check("the agreement reads accepted, with its record", listed?.status === "accepted" && listed.acceptance?.signerName === "Pat Invoice", JSON.stringify(listed));
const closed = await call(S.token, "POST", `/pipeline/invoices/${invoiceId}/send`, { agreement: { agreementId: A.id } });
check("an accepted agreement can't be attached again (409)", closed.status === 409 && closed.body.code === "agreement_closed", JSON.stringify(closed.body));

// ---- Without one: the plain email ------------------------------------------------------------------------------
const plainAgain = await call(S.token, "POST", `/pipeline/invoices/${invoiceId}/send`);
check("Send again with no body is what it always was", plainAgain.status === 200 && plainAgain.body.emailSent === true && !("agreement" in plainAgain.body), JSON.stringify(plainAgain.body));
const bad = await call(S.token, "POST", `/pipeline/invoices/${invoiceId}/send`, { agreement: { agreementId: A.id, title: "x", bodyText: "y" } });
check("a muddled attachment is a clean 400", bad.status === 400, JSON.stringify(bad.body));
