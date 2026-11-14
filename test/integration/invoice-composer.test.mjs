// The invoice composer (settings, package templates, composer fields on invoice preview/create/resend, the pay
// page, text channel), against a running API (see harness.mjs). A solo counselor is the practice admin; a firm
// consultant (not an admin) reads the settings and can't change them.
import { API, call, check, rest, sql, user } from "./harness.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const MY_IP = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const pub = async (method, path, body) => {
  const r = await fetch(API + path, { method, redirect: "manual", headers: { "X-Forwarded-For": MY_IP }, body });
  return { status: r.status, text: await r.text(), location: r.headers.get("location") };
};
const mailsTo = async (email) => ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()).messages ?? []);
const fullMail = async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
async function mailWith(email, needle) {
  for (let i = 0; i < 24; i++) {
    const m = (await mailsTo(email)).find((x) => x.Subject.includes(needle));
    if (m) return fullMail(m);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

const S = await user("ic-solo");
const board = (await call(S.token, "GET", "/pipeline")).body;
const stage = board.stages[0];
const parentEmail = `ic-parent-${tag}@families.test`;
const contact = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName: `Cora Composer ${tag}`, parentName: "Pat Composer", parentEmail, parentPhone: "+15125550142" })).body;
const pkgRes = await call(S.token, "PUT", `/pipeline/contacts/${contact.id}/package`, { packageName: "Senior package", totalCents: 600000, installments: 3 });
check("a package to bill", pkgRes.status === 200, JSON.stringify(pkgRes.body));

// ---- Payment methods -------------------------------------------------------------------------------
const m0 = await call(S.token, "GET", "/pipeline/payment-methods");
check("first read seeds the five built-ins", m0.status === 200 && m0.body.methods.map((m) => m.key).join() === "card,ach,zelle,paypal,check" && m0.body.canEdit === true, JSON.stringify(m0.body));
check("(saved, not virtual)", Number(await sql(`select count(*) from public.practice_payment_methods where counselor_id = '${S.id}'`)) === 5);
const put = await call(S.token, "PUT", "/pipeline/payment-methods", { methods: [{ key: "zelle", instructions: "Zelle to pay@cora.test with the invoice number" }, { key: "check", enabled: false }] });
check("instructions and switches save", put.status === 200 && put.body.methods.find((m) => m.key === "zelle").instructions.startsWith("Zelle to") && put.body.methods.find((m) => m.key === "check").enabled === false, JSON.stringify(put.body));
check("a built-in keeps its name", (await call(S.token, "PUT", "/pipeline/payment-methods", { methods: [{ key: "zelle", label: "Zeller" }] })).status === 400);
check("card takes no instructions", (await call(S.token, "PUT", "/pipeline/payment-methods", { methods: [{ key: "card", instructions: "x" }] })).status === 400);
check("an unknown key is 404", (await call(S.token, "PUT", "/pipeline/payment-methods", { methods: [{ key: "nope" }] })).status === 404);
const custom = await call(S.token, "POST", "/pipeline/payment-methods", { label: "Venmo <b>", instructions: "@cora-admissions" });
check("a custom method is added", custom.status === 201 && /^custom-[0-9a-f]{8}$/.test(custom.body.key) && custom.body.builtin === false, JSON.stringify(custom.body));
check("a duplicate name is 409", (await call(S.token, "POST", "/pipeline/payment-methods", { label: "venmo <B>" })).status === 409);
check("a built-in can't be removed (409 builtin_method)", (await call(S.token, "DELETE", "/pipeline/payment-methods/zelle")).body?.code === "builtin_method");
check("a strict body", (await call(S.token, "POST", "/pipeline/payment-methods", { label: "x", extra: 1 })).status === 400);

const O = await user("ic-other");
const om = await call(O.token, "GET", "/pipeline/payment-methods");
check("another practice sees its own (and none of ours)", om.status === 200 && !om.body.methods.some((m) => m.key === custom.body.key));
check("RLS: another counselor can't read our rows through PostgREST", (await rest(O.token, "GET", `/rest/v1/practice_payment_methods?counselor_id=eq.${S.id}&select=key`)).body?.length === 0);
check("RLS: ...or write them", (await rest(O.token, "PATCH", `/rest/v1/practice_payment_methods?counselor_id=eq.${S.id}`, { instructions: "pwned" }, { Prefer: "return=representation" })).body?.length === 0);

// ---- Style ------------------------------------------------------------------------------------------------
const st0 = await call(S.token, "GET", "/pipeline/invoice-style");
check("the style starts at the original look, with six fonts", st0.status === 200 && st0.body.style.fontKey === "serif" && st0.body.style.accentColor === null && st0.body.fonts.length === 6, JSON.stringify(st0.body.style));
const st1 = await call(S.token, "PUT", "/pipeline/invoice-style", { accentColor: "#1D4ED8", fontKey: "mono", corner: "pill", buttonLabel: "Pay now" });
check("a partial style saves", st1.status === 200 && st1.body.style.accentColor === "#1D4ED8" && st1.body.style.fontKey === "mono" && st1.body.style.headerAlign === "left", JSON.stringify(st1.body));
check("a bad colour or font is 400", (await call(S.token, "PUT", "/pipeline/invoice-style", { accentColor: "red" })).status === 400 && (await call(S.token, "PUT", "/pipeline/invoice-style", { fontKey: "comic" })).status === 400);
check("another practice's style is untouched", (await call(O.token, "GET", "/pipeline/invoice-style")).body.style.fontKey === "serif");

// ---- Package templates ----------------------------------------------------------------------------------------
const tpl = await call(S.token, "POST", "/pipeline/package-templates", { name: "Senior year", yearsTag: "Grade 12", totalCents: 600000, depositCents: 100000, installments: 3, durationMonths: 12, inclusions: ["Essays", "Applications"] });
check("a template is created with its plan", tpl.status === 201 && tpl.body.plan.map((p) => p.amountCents).join() === "100000,250000,250000" && tpl.body.plan[0].label === "Deposit", JSON.stringify(tpl.body));
check("a deposit past the total is refused", (await call(S.token, "POST", "/pipeline/package-templates", { name: "Bad", totalCents: 100, depositCents: 200, installments: 1 })).status === 400);
const fam = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName: `Fern From-Template ${tag}`, parentEmail: `ic-fern-${tag}@families.test` })).body;
const from = await call(S.token, "POST", `/pipeline/contacts/${fam.id}/package/from-template`, { templateId: tpl.body.id });
check("a family is set up from a template (copied)", from.status === 200 && from.body.account.packageName === "Senior year" && from.body.account.totalCents === 600000 && from.body.account.installments === 3 && from.body.account.durationMonths === 12 && from.body.plan.length === 3, JSON.stringify(from.body).slice(0, 300));
await call(S.token, "PUT", `/pipeline/package-templates/${tpl.body.id}`, { name: "Senior year", totalCents: 700000, depositCents: 100000, installments: 3 });
check("editing the template changes nothing already copied", (await call(S.token, "GET", `/pipeline/payments`)).body.accounts.find((a) => a.contactId === fam.id)?.totalCents === 600000);
check("another practice can't use our template (404)", (await call(O.token, "POST", `/pipeline/contacts/${fam.id}/package/from-template`, { templateId: tpl.body.id })).status === 404);
const arch = await call(S.token, "DELETE", `/pipeline/package-templates/${tpl.body.id}`);
check("DELETE archives", arch.status === 200 && arch.body.archivedAt !== null && (await call(S.token, "GET", "/pipeline/package-templates")).body.templates.every((t) => t.id !== tpl.body.id));
check("an archived template can't be assigned", (await call(S.token, "POST", `/pipeline/contacts/${fam.id}/package/from-template`, { templateId: tpl.body.id })).status === 404);

// ---- Preview ------------------------------------------------------------------------------------------------------
const body = (extra = {}) => ({ label: "Deposit", amountCents: 150000, dueOn: due, ...extra });
const old = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, body());
check("an old payload previews as ever (and the additive fields exist)", old.status === 200 && old.body.amountDueCents === 150000 && typeof old.body.html === "string" && old.body.style === null && old.body.methods.length === 0 && !/Other ways to pay/.test(old.body.html), JSON.stringify(old.body).slice(0, 200));
const pv = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, body({
  lines: [{ description: "Application strategy", amountCents: 100000 }, { description: "Essay review", detail: "4 essays", amountCents: 50000 }],
  methods: ["card", "zelle", custom.body.key], note: "Thank you!", cc: ["cc@families.test"], reminders: [-3, 0, 3],
}));
check("the preview shows the lines, the ways to pay (escaped), the note and the saved style", pv.status === 200 && pv.body.html.includes("Application strategy") && pv.body.html.includes("Zelle to pay@cora.test") && pv.body.html.includes("Venmo &lt;b&gt;") && !pv.body.html.includes("Venmo <b>") && pv.body.html.includes("Thank you!") && pv.body.html.includes("Courier"), pv.body.html?.slice(0, 200));
check("...and a text version, Cc and lines", pv.body.sms.includes("sent an invoice") && pv.body.cc[0] === "cc@families.test" && pv.body.lines.length === 2);
const pvStyle = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, body({ methods: ["card"], style: { accentColor: "#aa00aa", headerAlign: "center", buttonLabel: "Settle up" } }));
check("a style override previews without saving", pvStyle.status === 200 && pvStyle.body.style.headerAlign === "center" && pvStyle.body.style.fontKey === "mono" && (await call(S.token, "GET", "/pipeline/invoice-style")).body.style.headerAlign === "left");
check("lines that don't add up are refused (400 lines_sum_mismatch)", (await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, body({ lines: [{ description: "x", amountCents: 1 }] }))).body?.code === "lines_sum_mismatch");
check("bad reminders are refused", (await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, body({ reminders: [99] }))).body?.code === "bad_reminders");
check("a text with no texting number says so on preview", pv.body.textAvailable === false);

// ---- Send ----------------------------------------------------------------------------------------------------------------
const invCount = async () => Number(await sql(`select count(*) from public.pipeline_invoices where contact_id = '${contact.id}'`));
const before = await invCount();
const bad = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, body({ lines: [{ description: "x", amountCents: 5 }] }));
check("a line mismatch leaves no invoice behind", bad.status === 400 && (await invCount()) === before);
const noText = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, body({ channel: "text" }));
check("a text without your own number is 409 texting_unavailable, and nothing is numbered", noText.status === 409 && noText.body.code === "texting_unavailable" && (await invCount()) === before, JSON.stringify(noText.body));
const sent = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, body({
  label: `Deposit ${tag}`, lines: [{ description: "Application strategy", amountCents: 100000 }, { description: "Essay review", detail: "4 essays", amountCents: 50000 }],
  methods: ["zelle", custom.body.key], note: "Thank you for choosing us.", cc: ["cc@families.test"], reminders: [3, -3, 0],
}));
check("the composer invoice is sent", sent.status === 201 && sent.body.emailSent === true, JSON.stringify(sent.body));
const number = sent.body.invoiceNumber;
const row = await sql(`select row_to_json(i)::text from (select line_items, accepted_methods, pass_card_fee, note, cc, reminders, reminders_sent, style_snapshot, amount_cents from public.pipeline_invoices where number = '${number}' and contact_id = '${contact.id}') i`);
const r = JSON.parse(row);
check("the composer columns are stored", r.line_items.length === 2 && r.accepted_methods.join() === `zelle,${custom.body.key}` && r.pass_card_fee === false && r.note === "Thank you for choosing us." && r.cc[0] === "cc@families.test" && r.reminders.join() === "-3,0,3" && r.style_snapshot.fontKey === "mono" && r.amount_cents === 150000, row);
const mail = await mailWith(parentEmail, `Invoice ${number}`);
check("the email lists the ways to pay and the lines, has the note, and Cc's the address", mail && /Zelle to pay@cora\.test/.test(mail.Text) && /Application strategy/.test(mail.Text) && /Thank you for choosing us/.test(mail.Text) && mail.Cc?.some((c) => c.Address === "cc@families.test"), JSON.stringify(mail?.Cc));
check("with no card on it there is no Pay by card button", mail && !/by card/i.test(mail.HTML));
const viewUrl = /View this invoice online: (\S+)/.exec(mail?.Text ?? "")?.[1];
check("it carries its own page link", Boolean(viewUrl) && viewUrl.includes("/pay/"), mail?.Text?.slice(-300));
const page = viewUrl ? await pub("GET", new URL(viewUrl).pathname) : { status: 0, text: "" };
check("the invoice page shows the ways to pay and the stored look, with no card button", page.status === 200 && page.text.includes("Zelle to pay@cora.test") && page.text.includes("Venmo") && page.text.includes("Courier") && !/<button/.test(page.text), `${page.status}`);
check("a POST there starts nothing", (await pub("POST", new URL(viewUrl).pathname)).status === 200);

// The look is the one it went out with: change the style, resend, same look.
await call(S.token, "PUT", "/pipeline/invoice-style", { fontKey: "sans" });
const invoiceId = await sql(`select id from public.pipeline_invoices where number = '${number}' and contact_id = '${contact.id}'`);
const again = await call(S.token, "POST", `/pipeline/invoices/${invoiceId}/send`);
check("Send again works", again.status === 200 && again.body.emailSent === true, JSON.stringify(again.body));
let resent = null;
for (let i = 0; i < 24 && !resent; i++) {
  const all = (await mailsTo(parentEmail)).filter((x) => x.Subject.includes(`Invoice ${number}`));
  if (all.length >= 2) resent = await fullMail(all[0]);
  else await new Promise((r) => setTimeout(r, 250));
}
check("...and the resend keeps the look it went out with (a sent invoice never re-skins)", resent && /Courier/.test(resent.HTML) && !/Helvetica,Arial,sans-serif/.test(resent.HTML.split("Pay")[0] ?? ""));

// The database holds the composer's rules too, and the readers don't trust a row.
const trig = (cols, vals) => sql(`insert into public.pipeline_invoices (contact_id, label, amount_cents, issued_on, due_on, created_by, ${cols}) values ('${contact.id}', 'Guard', 100, current_date, current_date + 1, '${S.id}', ${vals})`).then(() => "ok", (e) => String(e.message));
check("the database refuses line items that don't add up", /add up/.test(await trig("line_items", `'[{"description":"A","amountCents":99}]'::jsonb`)));
check("...or aren't valid lines", /aren't valid/.test(await trig("line_items", `'[{"description":5,"amountCents":100}]'::jsonb`)) && /aren't valid/.test(await trig("line_items", `'[{"description":"A","amountCents":1.5}]'::jsonb`)));
check("...and reminder offsets beyond 30 days", /up to 30/.test(await trig("reminders", `'{99}'`)) && /up to 30/.test(await trig("reminders", `'{-31}'`)));
check("a valid composer row goes in", (await trig("line_items, reminders", `'[{"description":"A","detail":null,"amountCents":100}]'::jsonb, '{-30,0,30}'`)) === "ok");
await sql(`delete from public.pipeline_invoices where contact_id = '${contact.id}' and label = 'Guard'`);
await sql(`set session_replication_role = replica; update public.pipeline_invoices set line_items = '[{"description":5,"amountCents":150000}]'::jsonb, accepted_methods = '{zelle,"<b>"}', cc = '{"x@y.co","bad address"}' where id = '${invoiceId}'`);
const damaged = viewUrl ? await pub("GET", new URL(viewUrl).pathname) : { status: 0, text: "" };
check("a damaged row doesn't break the invoice page: it falls back to the package line", damaged.status === 200 && damaged.text.includes("Senior package") && !damaged.text.includes(">5<") && damaged.text.includes("Zelle to pay@cora.test"), `${damaged.status}`);
const dResend = await call(S.token, "POST", `/pipeline/invoices/${invoiceId}/send`);
check("...and Send again still works", dResend.status === 200 && dResend.body.emailSent === true, JSON.stringify(dResend.body));

// Old payloads are the invoices they always were.
const plain = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, body({ label: `Plain ${tag}` }));
check("an old payload still sends", plain.status === 201 && plain.body.emailSent === true, JSON.stringify(plain.body));
const plainRow = JSON.parse(await sql(`select row_to_json(i)::text from (select line_items, accepted_methods, style_snapshot, reminders, pass_card_fee from public.pipeline_invoices where number = '${plain.body.invoiceNumber}' and contact_id = '${contact.id}') i`));
check("...and writes none of the composer's columns", plainRow.line_items === null && plainRow.accepted_methods === null && plainRow.style_snapshot === null && plainRow.reminders === null && plainRow.pass_card_fee === false);
const pm = await mailWith(parentEmail, `Invoice ${plain.body.invoiceNumber}`);
check("its email is the original design (no ways to pay block)", pm && !/Other ways to pay/.test(pm.Text) && !/Courier/.test(pm.HTML));

// ---- Text channel -------------------------------------------------------------------------------------------------------
await sql(`insert into public.consultant_phone_numbers (counselor_id, phone_e164, twilio_sid, status) values ('${S.id}', '+1415555${String(Date.now()).slice(-4)}', 'PN${"a".repeat(32)}', 'active') on conflict do nothing`);
const opts = await call(S.token, "GET", "/pipeline/invoice-options");
check("with a texting number the Text channel is available", opts.status === 200 && opts.body.textAvailable === true && opts.body.cardFeeEnabled === false && opts.body.composerReady === true, JSON.stringify(opts.body));
const nophone = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName: `No Phone ${tag}`, parentEmail: `ic-np-${tag}@families.test` })).body;
await call(S.token, "PUT", `/pipeline/contacts/${nophone.id}/package`, { packageName: "P", totalCents: 100000, installments: 1 });
check("a card with no phone is 400 contact_no_phone", (await call(S.token, "POST", `/pipeline/contacts/${nophone.id}/invoices`, { label: "x", amountCents: 1000, dueOn: due, channel: "text" })).body?.code === "contact_no_phone");
const text = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, body({ label: `Texted ${tag}`, channel: "text" }));
check("a text invoice goes through the Twilio helper (queued here: no provider)", text.status === 201 && text.body.sentTo === "+15125550142" && text.body.emailSent === false, JSON.stringify(text.body));
const sms = await sql(`select body from public.message_deliveries where channel = 'sms' and template = 'pipeline-invoice-sms' and to_phone = '+15125550142' order by created_at desc limit 1`);
check("the text is short and has the invoice's own link", /sent invoice INV-\d+: \$1,500 due /.test(sms) && /\/pay\//.test(sms), sms);
check("a text can't carry an agreement", (await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, body({ channel: "text", agreement: { title: "T", bodyText: "B" } }))).body?.code === "text_no_agreement");

// ---- Recording a PayPal payment ---------------------------------------------------------------------------------------------
const pay = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/payments`, { amountCents: 10000, receivedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), method: "paypal", note: "via PayPal.me" });
check("PayPal is a recordable method", pay.status === 201 || pay.status === 200, JSON.stringify(pay.body).slice(0, 200));
console.log("done");
