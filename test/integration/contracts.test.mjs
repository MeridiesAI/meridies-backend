// The contract library and attaching a contract to an invoice (routes/contracts.ts, lib/contracts.ts,
// migration 20261124000005), against a running API with AGREEMENTS_ENABLED=true (see harness.mjs).
// Checks: signed upload, the bytes decide the type (a fake PDF is refused and removed), the library, an
// invoice with a contract makes an agreement bound to the file's SHA-256, the PDF rides on the email, the
// family opens the file on the agreement page and accepts, the acceptance certificate records the hash,
// the pay page's Review button mints a fresh link, and no other practice or client can reach any of it.
import { createHash } from "node:crypto";
import { API, call, check, rest, sql, user } from "./harness.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const MY_IP = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const pub = async (method, path, body) => {
  const r = await fetch(API + path, { method, redirect: "manual", headers: { "X-Forwarded-For": MY_IP, ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body });
  return { status: r.status, text: await r.text(), headers: r.headers, location: r.headers.get("location") };
};
const mailsTo = async (email) => ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()).messages ?? []);
async function mailWith(email, needle) {
  for (let i = 0; i < 24; i++) {
    const m = (await mailsTo(email)).find((x) => x.Subject.includes(needle));
    if (m) return (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const pdfBytes = Buffer.from(`%PDF-1.4\n% engagement letter ${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
const upload = async (S, bytes, contentType = "application/pdf") => {
  const u = await call(S.token, "POST", "/pipeline/contracts/upload-url", { contentType, sizeBytes: bytes.length });
  if (u.status !== 200) return { u };
  const fd = new FormData();
  fd.append("cacheControl", "3600");
  fd.append("", new Blob([bytes], { type: contentType }));
  const put = await fetch(u.body.uploadUrl, { method: "PUT", headers: { "x-upsert": "false" }, body: fd });
  return { u, put };
};

const S = await user("ct-solo");
const board = (await call(S.token, "GET", "/pipeline")).body;
const parentEmail = `ct-parent-${tag}@families.test`;
const contact = (await call(S.token, "POST", "/pipeline/contacts", { stageId: board.stages[0].id, studentName: `Cleo Contract ${tag}`, parentName: "Pat Contract", parentEmail })).body;
await call(S.token, "PUT", `/pipeline/contacts/${contact.id}/package`, { packageName: "Senior package", totalCents: 600000, installments: 3 });
const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

// ---- Upload and register -------------------------------------------------------------------------------
check("an HTML or oversized upload is refused up front", (await call(S.token, "POST", "/pipeline/contracts/upload-url", { contentType: "text/html", sizeBytes: 10 })).status === 400 && (await call(S.token, "POST", "/pipeline/contracts/upload-url", { contentType: "application/pdf", sizeBytes: 20 * 1024 * 1024 })).status === 400);
const up = await upload(S, pdfBytes);
check("a signed upload URL for the practice's own folder", up.u.status === 200 && up.u.body.path.startsWith(`${S.id}/`) && up.u.body.path.endsWith(".pdf") && up.put?.ok, `${up.u.status} ${up.put?.status} ${JSON.stringify(up.u.body).slice(0, 200)}`);
const reg = await call(S.token, "POST", "/pipeline/contracts", { path: up.u.body.path, name: "Engagement letter" });
check("registering reads the file back: size, type and SHA-256 are the bytes'", reg.status === 201 && reg.body.mime === "application/pdf" && reg.body.sizeBytes === pdfBytes.length && reg.body.sha256 === createHash("sha256").update(pdfBytes).digest("hex"), JSON.stringify(reg.body));
check("the same file can't be registered twice", (await call(S.token, "POST", "/pipeline/contracts", { path: up.u.body.path, name: "Again" })).status === 409);

const fake = await upload(S, Buffer.from("<html><script>alert(1)</script></html>"));
const fakeReg = await call(S.token, "POST", "/pipeline/contracts", { path: fake.u.body.path, name: "Not a PDF" });
check("a file that isn't really a PDF is refused (the bytes decide, not the label)", fakeReg.status === 400, JSON.stringify(fakeReg.body));
const gone = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${"contracts"}/${fake.u.body.path}`, { headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
check("...and the object is removed", gone.status === 404 || gone.status === 400, String(gone.status));
check("a path outside the practice's folder can't be registered", (await call(S.token, "POST", "/pipeline/contracts", { path: `${S.id}/../x.pdf`, name: "x" })).status === 400 && (await call(S.token, "POST", "/pipeline/contracts", { path: `00000000-0000-0000-0000-000000000000/${up.u.body.path.split("/")[1]}`, name: "x" })).status === 400);

const list = await call(S.token, "GET", "/pipeline/contracts");
check("the library lists it", list.status === 200 && list.body.contracts.length === 1 && list.body.canEdit === true, JSON.stringify(list.body));
const view = await call(S.token, "GET", `/pipeline/contracts/${reg.body.id}/url`);
const viewed = view.status === 200 ? await fetch(view.body.url) : null;
check("a signed view link opens the file for the counselor", viewed?.ok && Buffer.from(await viewed.arrayBuffer()).equals(pdfBytes), String(view.status));

// ---- Isolation ----------------------------------------------------------------------------------------------------
const O = await user("ct-other");
check("another practice sees no contracts and can't view ours", (await call(O.token, "GET", "/pipeline/contracts")).body.contracts.length === 0 && (await call(O.token, "GET", `/pipeline/contracts/${reg.body.id}/url`)).status === 404);
check("RLS: another counselor can't read or write the table through PostgREST", (await rest(O.token, "GET", `/rest/v1/contract_files?select=id`)).body?.length === 0 && (await rest(O.token, "PATCH", `/rest/v1/contract_files?id=eq.${reg.body.id}`, { archived_at: new Date().toISOString() }, { Prefer: "return=representation" })).body?.length === 0);
check("no client can read the bucket", (await rest(O.token, "GET", `/storage/v1/object/authenticated/contracts/${up.u.body.path}`)).status >= 400);
const OBoard = (await call(O.token, "GET", "/pipeline")).body;
const oc = (await call(O.token, "POST", "/pipeline/contacts", { stageId: OBoard.stages[0].id, studentName: `Other ${tag}`, parentEmail: `ct-o-${tag}@families.test` })).body;
await call(O.token, "PUT", `/pipeline/contacts/${oc.id}/package`, { packageName: "P", totalCents: 100000, installments: 1 });
const stolen = await call(O.token, "POST", `/pipeline/contacts/${oc.id}/invoices`, { label: "X", amountCents: 1000, dueOn: due, agreement: { contractId: reg.body.id } });
check("another practice can't attach our contract (404) and no invoice is left", stolen.status === 404 && Number(await sql(`select count(*) from public.pipeline_invoices where contact_id = '${oc.id}'`)) === 0, JSON.stringify(stolen.body));
const forged = await sql(`select count(*) from (select 1) x where exists (select 1 from public.agreements where contact_id = '${oc.id}')`);
check("(and no agreement was written)", Number(forged) === 0);

// ---- Attach to an invoice -------------------------------------------------------------------------------------------
const pv = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices/preview`, { label: "Deposit", amountCents: 100000, dueOn: due, agreement: { contractId: reg.body.id } });
check("the preview names the contract and mints nothing", pv.status === 200 && pv.body.agreement?.title === "Engagement letter" && Number(await sql(`select count(*) from public.agreements where contact_id = '${contact.id}'`)) === 0, JSON.stringify(pv.body.agreement));
const sent = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, { label: `Deposit ${tag}`, amountCents: 100000, dueOn: due, methods: ["zelle"], agreement: { contractId: reg.body.id } });
check("the invoice goes out with the contract", sent.status === 201 && sent.body.emailSent === true && sent.body.agreement?.title === "Engagement letter", JSON.stringify(sent.body));
const ag = JSON.parse(await sql(`select row_to_json(a)::text from (select id, status, storage_path, contract_file_id, body_text, body_sha256 from public.agreements where contact_id = '${contact.id}') a`));
const stub = `Contract file: Engagement letter\nFile SHA-256: ${reg.body.sha256}`;
check("the agreement is bound to the file: the database wrote its text, with the file's hash, and its path", ag.contract_file_id === reg.body.id && ag.storage_path === up.u.body.path && ag.body_text === stub && ag.body_sha256 === createHash("sha256").update(stub).digest("hex") && ag.status === "sent", JSON.stringify(ag));
check("the invoice points at the agreement", (await sql(`select agreement_id from public.pipeline_invoices where number = '${sent.body.invoiceNumber}' and contact_id = '${contact.id}'`)) === ag.id);
const mail = await mailWith(parentEmail, `Invoice ${sent.body.invoiceNumber}`);
check("the email carries the agreement link and the PDF as an attachment", mail && /\/agree\/[A-Za-z0-9_-]{43}/.test(mail.Text) && mail.Attachments?.some((a) => a.FileName === "Engagement letter.pdf"), JSON.stringify(mail?.Attachments));
const tok = /\/agree\/([A-Za-z0-9_-]{43})/.exec(mail?.Text ?? "")?.[1];
const pageRes = await pub("GET", `/agree/${tok}`);
check("the agreement page offers the file", pageRes.status === 200 && pageRes.text.includes(`/agree/${tok}/file`) && pageRes.text.includes("Open the contract file"));
const file = await pub("GET", `/agree/${tok}/file`);
const fileBuf = Buffer.from(file.text, "latin1");
check("the family opens the exact file, inline, unable to run script", file.status === 200 && file.headers.get("content-type") === "application/pdf" && /inline/.test(file.headers.get("content-disposition")) && file.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(file.headers.get("content-security-policy")) && fileBuf.equals(pdfBytes), `${file.status} ${file.headers.get("content-type")}`);
check("a wrong link gets nothing", (await pub("GET", `/agree/${"A".repeat(43)}/file`)).status === 404);
const done = await pub("POST", `/agree/${tok}`, "signerName=Pat+Contract&consent=yes");
check("typed-name acceptance records the file's hash", done.status === 200 && (await sql(`select status from public.agreements where id = '${ag.id}'`)) === "accepted" && (await sql(`select certificate_text from public.agreement_acceptances where agreement_id = '${ag.id}'`)).includes(ag.body_sha256) && (await sql(`select body_sha256 from public.agreement_acceptances where agreement_id = '${ag.id}'`)) === ag.body_sha256);
check("the accepted page still offers the file", (await pub("GET", `/agree/${tok}`)).text.includes("Open the contract file"));

// ---- The pay page's Review button -------------------------------------------------------------------------------------
const sent2 = await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, { label: `Second ${tag}`, amountCents: 100000, dueOn: due, methods: ["zelle"], agreement: { contractId: reg.body.id } });
check("a second invoice can attach the same contract (a fresh agreement)", sent2.status === 201 && Number(await sql(`select count(*) from public.agreements where contract_file_id = '${reg.body.id}'`)) === 2, JSON.stringify(sent2.body));
const m2 = await mailWith(parentEmail, `Invoice ${sent2.body.invoiceNumber}`);
const payPath = /\/pay\/([A-Za-z0-9_-]{43})/.exec(m2?.Text ?? "")?.[1];
const payPage = payPath ? await pub("GET", `/pay/${payPath}`) : { status: 0, text: "" };
check("the invoice page offers the contract", payPage.status === 200 && payPage.text.includes(`/pay/${payPath}/contract`) && payPage.text.includes("Review and accept the agreement"), `${payPage.status}`);
const click = await pub("POST", `/pay/${payPath}/contract`);
const newTok = /\/agree\/([A-Za-z0-9_-]{43})/.exec(click.location ?? "")?.[1];
check("clicking Review redirects to a fresh private agreement link", click.status === 303 && newTok && (await pub("GET", `/agree/${newTok}`)).status === 200);
const ag2 = await sql(`select a.id from public.agreements a join public.pipeline_invoices i on i.agreement_id = a.id where i.number = '${sent2.body.invoiceNumber}' and i.contact_id = '${contact.id}'`);
const emailTok = /\/agree\/([A-Za-z0-9_-]{43})/.exec(m2?.Text ?? "")?.[1];
check("...and the link in the email still works", (await pub("GET", `/agree/${emailTok}`)).status === 200);
// A forged pointer to another family's agreement never gets a link.
await sql(`update public.pipeline_invoices set agreement_id = '${ag.id}' where number = '${sent2.body.invoiceNumber}' and contact_id = '${contact.id}'`);
check("(a pointer to an accepted agreement offers nothing)", (await pub("POST", `/pay/${payPath}/contract`)).status === 404);
const otherAg = await call(O.token, "POST", "/agreements", { contactId: oc.id, title: "Theirs", bodyText: "x" });
await sql(`update public.pipeline_invoices set agreement_id = '${otherAg.body.id}' where number = '${sent2.body.invoiceNumber}' and contact_id = '${contact.id}'`);
check("(and one to another family's agreement is refused)", (await pub("POST", `/pay/${payPath}/contract`)).status === 404 && !(await pub("GET", `/pay/${payPath}`)).text.includes("Theirs"));
void ag2;

// ---- Archive ---------------------------------------------------------------------------------------------------------------
const arch = await call(S.token, "DELETE", `/pipeline/contracts/${reg.body.id}`);
check("DELETE archives (the agreements made from it stay)", arch.status === 200 && arch.body.archivedAt && (await call(S.token, "GET", "/pipeline/contracts")).body.contracts.length === 0 && (await call(S.token, "GET", "/pipeline/contracts?includeArchived=true")).body.contracts.length === 1);
check("an archived contract can't be attached again", (await call(S.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, { label: "X", amountCents: 1000, dueOn: due, agreement: { contractId: reg.body.id } })).status === 404);
check("a contract agreement's text can't be edited, even by the owner through PostgREST", (await rest(S.token, "PATCH", `/rest/v1/agreements?id=eq.${ag2}`, { body_text: "changed" }, { Prefer: "return=representation" })).status >= 400 || (await sql(`select body_text from public.agreements where id = '${ag2}'`)) === `Contract file: Engagement letter\nFile SHA-256: ${reg.body.sha256}`);
console.log("done");
