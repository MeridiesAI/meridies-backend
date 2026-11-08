// Agreements (typed-name acceptance, 20261111000010), as real accounts on a local
// Supabase against a running API (see harness.mjs). Needs the API started with
// AGREEMENTS_ENABLED=true (CI does); against an API with it off, only the
// "switched off" checks run.
//
// Checks: every route is 404 agreements_off while switched off; create, send and
// void are the contact's biller's only (another practice can't see or send, an
// unapproved counselor and a student are refused); send needs an email on the
// card; opening the link changes nothing; accepting records exactly one row with
// the body hash, IP, user agent and consent version; a second submit says
// "already accepted" and adds nothing; expired, void and tampered links are
// refused; acceptance rows can't be changed or removed by anyone (client,
// service role, even postgres); the body can't change once sent; both copies
// are emailed with the certificate; audit_log; the contact moves to "Contract
// signed"; the public routes' limits trip.
import { createHash } from "node:crypto";
import { API, SB, call, check, rest, sql, user } from "./harness.mjs";

const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const ip = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const MY_IP = ip();
const pub = async (method, path, { body, headers = {}, from = MY_IP } = {}) => {
  const r = await fetch(API + path, {
    method,
    redirect: "manual",
    headers: { "X-Forwarded-For": from, ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...headers },
    body,
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
};
const sqlFails = async (q) => {
  try {
    await sql(q);
    return false;
  } catch {
    return true;
  }
};
const svcRest = async (method, path, body) => {
  const r = await fetch(SB + path, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text };
};
const mailsTo = async (email) => {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return (await r.json()).messages ?? [];
};
const fullMail = async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
/** The newest agreement link mailed to `email` for `title`. */
async function linkFor(email, title) {
  for (let i = 0; i < 20; i++) {
    for (const m of await mailsTo(email)) {
      if (!m.Subject.includes(title)) continue;
      const tok = /\/agree\/([A-Za-z0-9_-]{43})/.exec((await fullMail(m)).Text)?.[1];
      if (tok) return tok;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const S = await user("ag-solo");
const board = (await call(S.token, "GET", "/pipeline")).body;
const firstStage = board.stages[0];
const parentEmail = `ag-parent-${tag}@families.test`;
const contact = (await call(S.token, "POST", "/pipeline/contacts", { stageId: firstStage.id, studentName: `Agnes Agree ${tag}`, parentName: "Pat Agree", parentEmail })).body;

// ---- Switched off ------------------------------------------------------------------------
const probe = await call(S.token, "POST", "/agreements", { contactId: contact.id, title: "Probe", bodyText: "Probe" });
if (probe.status === 404 && probe.body?.code === "agreements_off") {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [m, p] of [["GET", `/agreements?contactId=${contact.id}`], ["GET", `/agreements/${id}`], ["POST", `/agreements/${id}/send`], ["POST", `/agreements/${id}/void`]]) {
    const r = await call(S.token, m, p, m === "POST" ? {} : undefined);
    check(`switched off: ${m} ${p.split("?")[0]} is 404 agreements_off`, r.status === 404 && r.body.code === "agreements_off", JSON.stringify(r.body));
  }
  const anon = await fetch(`${API}/agreements/${id}`);
  check("switched off: even without signing in", anon.status === 404 && (await anon.json()).code === "agreements_off");
  for (const m of ["GET", "POST"]) {
    const r = await pub(m, `/agree/${"A".repeat(43)}`, m === "POST" ? { body: "signerName=Ana+Ruiz&consent=yes" } : {});
    check(`switched off: ${m} /agree/:token is a plain 404 page`, r.status === 404 && /not available/i.test(r.text) && r.headers.get("x-robots-tag") === "noindex");
  }
  console.log("AGREEMENTS_ENABLED is off on this API: only the switched-off checks ran.");
  process.exit(process.exitCode ?? 0);
}

// ---- Create ---------------------------------------------------------------------------------
const title = `Counseling agreement ${tag}`;
const bodyText = `1. Fees: $4,000 for the senior year.\r\n2. Terms <script>alert(1)</script> & "more".\n`;
const created = await call(S.token, "POST", "/agreements", { contactId: contact.id, title, bodyText });
check("a counselor creates a draft for their contact", created.status === 201 && created.body.status === "draft", JSON.stringify(created.body));
check("the body hash is the sha256 of the exact text", created.body.bodySha256 === sha(bodyText), created.body.bodySha256);
check("the consent version is the placeholder", created.body.consentVersion === "v0-PLACEHOLDER");
const A = created.body.id;

const forged = await rest(S.token, "POST", "/rest/v1/agreements", { counselor_id: S.id, contact_id: contact.id, title: "F", body_text: "F", consent_version: "v", body_sha256: "0".repeat(64) });
check("PostgREST can't set the hash (no grant on body_sha256)", forged.status >= 400, JSON.stringify(forged.body));
const forged2 = await rest(S.token, "POST", "/rest/v1/agreements?select=status,body_sha256", { counselor_id: S.id, contact_id: contact.id, title: "F2", body_text: "F2", consent_version: "v" }, { Prefer: "return=representation" });
check("a client insert is a draft with the database's hash", forged2.status === 201 && forged2.body[0]?.status === "draft" && forged2.body[0]?.body_sha256 === sha("F2"), JSON.stringify(forged2.body));
const forgedAccept = await rest(S.token, "PATCH", `/rest/v1/agreements?title=eq.F2&contact_id=eq.${contact.id}`, { status: "accepted" });
check("a client can't mark an agreement accepted", forgedAccept.status >= 400, JSON.stringify(forgedAccept.body));

// ---- Who may ---------------------------------------------------------------------------------
const X = await user("ag-outsider");
check("another practice can't read it", (await call(X.token, "GET", `/agreements/${A}`)).status === 404);
const xs = await call(X.token, "POST", `/agreements/${A}/send`);
check("another practice can't send it", xs.status === 404, JSON.stringify(xs.body));
check("another practice can't void it", (await call(X.token, "POST", `/agreements/${A}/void`)).status === 404);
const xc = await call(X.token, "POST", "/agreements", { contactId: contact.id, title: "X", bodyText: "X" });
check("another practice can't attach one to the contact", xc.status === 404, JSON.stringify(xc.body));
const xl = await call(X.token, "GET", `/agreements?contactId=${contact.id}`);
check("another practice lists nothing", xl.status === 200 && xl.body.agreements.length === 0, JSON.stringify(xl.body));
const xr = await rest(X.token, "GET", `/rest/v1/agreements?id=eq.${A}`);
check("nor through PostgREST", xr.status === 200 && xr.body.length === 0, JSON.stringify(xr.body));
const P = await user("ag-pending", "counselor", { approved: false });
const pc = await call(P.token, "POST", "/agreements", { contactId: contact.id, title: "P", bodyText: "P" });
check("an unapproved counselor is refused (403)", pc.status === 403 && pc.body.code === "account_pending", JSON.stringify(pc.body));
const St = await user("ag-student", "student");
check("a student is refused (403)", (await call(St.token, "GET", `/agreements?contactId=${contact.id}`)).status === 403);
const tokRead = await rest(S.token, "GET", "/rest/v1/agreement_tokens?select=token_hash&limit=1");
check("tokens are service-role only", tokRead.status >= 400 || (Array.isArray(tokRead.body) && tokRead.body.length === 0), JSON.stringify(tokRead.body));

// ---- Send ------------------------------------------------------------------------------------
const bare = (await call(S.token, "POST", "/pipeline/contacts", { stageId: firstStage.id, studentName: `No Email ${tag}` })).body;
const bareDraft = (await call(S.token, "POST", "/agreements", { contactId: bare.id, title: "No email", bodyText: "x" })).body;
const noEmail = await call(S.token, "POST", `/agreements/${bareDraft.id}/send`);
check("send needs an email on the card", noEmail.status === 400 && noEmail.body.code === "contact_no_email", JSON.stringify(noEmail.body));

const sent = await call(S.token, "POST", `/agreements/${A}/send`);
check("send emails the parent and marks it sent", sent.status === 200 && sent.body.sentTo === parentEmail && sent.body.agreement.status === "sent" && sent.body.agreement.sentAt, JSON.stringify(sent.body));
const token = await linkFor(parentEmail, title);
check("the email carries a private link", !!token);
const delivery = await sql(`select body from public.message_deliveries where to_email='${parentEmail}' and template='agreement-sent' order by created_at desc limit 1`);
check("the delivery record keeps no link", delivery.length > 0 && !delivery.includes(token) && !delivery.includes("/agree/"));
check("only the token's hash is stored", await sql(`select count(*) from public.agreement_tokens where agreement_id='${A}' and token_hash='${sha(token)}'`) === "1");

// ---- Body immutable after send ----------------------------------------------------------------
const edit = await rest(S.token, "PATCH", `/rest/v1/agreements?id=eq.${A}`, { body_text: "Something else" });
check("the body can't change once sent (client)", edit.status >= 400, JSON.stringify(edit.body));
check("not even as postgres", await sqlFails(`update public.agreements set body_text='changed' where id='${A}'`));
check("the stored body is the one sent", await sql(`select body_sha256 from public.agreements where id='${A}'`) === sha(bodyText));

// ---- The page changes nothing ---------------------------------------------------------------
const auditBefore = await sql(`select count(*) from public.audit_log where entity_id='${A}'`);
const view = await pub("GET", `/agree/${token}`);
check("the link opens the agreement", view.status === 200 && view.text.includes(title.replace(/&/g, "&amp;")), `status ${view.status}`);
check("the body is shown inert", !view.text.includes("<script>alert(1)") && view.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
check("with the consent box and a name field", /name="consent" value="yes"/.test(view.text) && /name="signerName"/.test(view.text));
check("headers: no-store, noindex, no-referrer, CSP without script",
  view.headers.get("cache-control") === "no-store" && view.headers.get("x-robots-tag") === "noindex" && view.headers.get("referrer-policy") === "no-referrer" &&
  /default-src 'none'/.test(view.headers.get("content-security-policy") ?? "") && !/script-src/.test(view.headers.get("content-security-policy") ?? ""));
await pub("GET", `/agree/${token}`);
check("opening it (twice) changed nothing",
  await sql(`select status from public.agreements where id='${A}'`) === "sent" &&
  await sql(`select count(*) from public.agreement_acceptances where agreement_id='${A}'`) === "0" &&
  await sql(`select count(*) from public.audit_log where entity_id='${A}'`) === auditBefore);
const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
check("a tampered link is 404", (await pub("GET", `/agree/${tampered}`)).status === 404 && (await pub("POST", `/agree/${tampered}`, { body: "signerName=Ana+Ruiz&consent=yes" })).status === 404);

// ---- Accept --------------------------------------------------------------------------------------
const noConsent = await pub("POST", `/agree/${token}`, { body: "signerName=Pat+Agree" });
check("no consent tick, nothing recorded", noConsent.status === 400 && await sql(`select count(*) from public.agreement_acceptances where agreement_id='${A}'`) === "0");
const extra = await pub("POST", `/agree/${token}`, { body: "signerName=Pat+Agree&consent=yes&status=accepted" });
check("an extra field is refused", extra.status === 400);

const UA = `AgreementTest/1.0 (${tag})`;
const accept = await pub("POST", `/agree/${token}`, { body: "signerName=%3Cb%3EPat%3C%2Fb%3E+Agree&consent=yes", headers: { "User-Agent": UA } });
check("accepting records it", accept.status === 200 && /recorded/.test(accept.text), `status ${accept.status}`);
check("the signer's name is escaped on the page", !accept.text.includes("<b>Pat</b>") && accept.text.includes("&lt;b&gt;Pat&lt;/b&gt; Agree"));
const row = JSON.parse(await sql(`select row_to_json(a) from public.agreement_acceptances a where agreement_id='${A}'`) || "null");
check("exactly one acceptance", await sql(`select count(*) from public.agreement_acceptances where agreement_id='${A}'`) === "1");
check("with the typed name, the contact's email and the body hash", row?.signer_name === "<b>Pat</b> Agree" && row?.signer_email === parentEmail && row?.body_sha256 === sha(bodyText), JSON.stringify(row));
check("the IP, the user agent and the consent version", row?.ip === MY_IP && row?.user_agent === UA && row?.consent_version === "v0-PLACEHOLDER", JSON.stringify(row));
check("and a certificate that says what it is", /Typed-name acceptance; not a certified electronic signature\./.test(row?.certificate_text ?? "") && (row?.certificate_text ?? "").includes(`Document SHA-256: ${sha(bodyText)}`) && (row?.certificate_text ?? "").includes(`IP address: ${MY_IP}`));
check("the agreement is accepted", await sql(`select status from public.agreements where id='${A}'`) === "accepted");
check("an audit_log row with the address", await sql(`select count(*) from public.audit_log where entity_id='${A}' and action='agreement.accepted' and ip='${MY_IP}' and user_agent='${UA}'`) === "1");
check("the contact moved to Contract signed",
  await sql(`select s.name from public.pipeline_contacts c join public.pipeline_stages s on s.id=c.stage_id where c.id='${contact.id}'`) === "Contract signed");

const again = await pub("POST", `/agree/${token}`, { body: "signerName=Someone+Else&consent=yes" });
check("a second submit says already accepted", again.status === 409 && /Already accepted/.test(again.text));
check("and adds nothing", await sql(`select count(*) from public.agreement_acceptances where agreement_id='${A}'`) === "1" && await sql(`select signer_name from public.agreement_acceptances where agreement_id='${A}'`) === "<b>Pat</b> Agree");
const after = await pub("GET", `/agree/${token}`);
check("the link now shows it read-only", after.status === 200 && !/<form/.test(after.text) && /Accepted by/.test(after.text));

const mine = await call(S.token, "GET", `/agreements/${A}`);
check("the counselor sees the acceptance", mine.status === 200 && mine.body.acceptance?.signerName === "<b>Pat</b> Agree" && mine.body.acceptance?.certificateText === row?.certificate_text, JSON.stringify(mine.body.acceptance));
const listed = await call(S.token, "GET", `/agreements?contactId=${contact.id}`);
check("and in the list", listed.status === 200 && listed.body.agreements.some((a) => a.id === A && a.status === "accepted" && a.acceptance) && listed.body.agreements.every((a) => a.bodyText === undefined));
check("an accepted agreement can't be voided", (await call(S.token, "POST", `/agreements/${A}/void`)).status === 409);
check("or sent again", (await call(S.token, "POST", `/agreements/${A}/send`)).status === 409);

// ---- Both copies -----------------------------------------------------------------------------------
const copies = await sql(`select string_agg(template || ':' || to_email, ',' order by template) from public.message_deliveries where template like 'agreement-accepted%' and (to_email='${parentEmail}' or to_email='${S.email}')`);
check("both copies are recorded", copies === `agreement-accepted:${parentEmail},agreement-accepted-counselor:${S.email}`, copies);
const certLine = `Document SHA-256: ${sha(bodyText)}`;
const parentCopy = (await mailsTo(parentEmail)).find((m) => m.Subject.startsWith("You accepted"));
const counselorCopy = (await mailsTo(S.email)).find((m) => m.Subject.includes("accepted:"));
check("the family's copy carries the certificate", !!parentCopy && (await fullMail(parentCopy)).Text.includes(certLine));
check("the counselor's copy carries the certificate", !!counselorCopy && (await fullMail(counselorCopy)).Text.includes(certLine));
check("and the escaped name in the HTML", !!counselorCopy && !(await fullMail(counselorCopy)).HTML.includes("<b>Pat</b>"));

// ---- Nobody changes an acceptance ----------------------------------------------------------------
const cu = await rest(S.token, "PATCH", `/rest/v1/agreement_acceptances?agreement_id=eq.${A}`, { signer_name: "Tampered" });
check("the counselor can't update it", cu.status >= 400, JSON.stringify(cu.body));
const cd = await rest(S.token, "DELETE", `/rest/v1/agreement_acceptances?agreement_id=eq.${A}`);
check("the counselor can't delete it", cd.status >= 400, JSON.stringify(cd.body));
const su = await svcRest("PATCH", `/rest/v1/agreement_acceptances?agreement_id=eq.${A}`, { signer_name: "Tampered" });
check("the service role can't update it", su.status >= 400, su.body);
const sd = await svcRest("DELETE", `/rest/v1/agreement_acceptances?agreement_id=eq.${A}`);
check("the service role can't delete it", sd.status >= 400, sd.body);
check("an authenticated session can't update it (SQL)", await sqlFails(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${S.id}","role":"authenticated"}', true); update public.agreement_acceptances set signer_name='T' where agreement_id='${A}'; commit;`));
check("a service_role session can't update it (SQL)", await sqlFails(`begin; set local role service_role; update public.agreement_acceptances set signer_name='T' where agreement_id='${A}'; commit;`));
check("a service_role session can't delete it (SQL)", await sqlFails(`begin; set local role service_role; delete from public.agreement_acceptances where agreement_id='${A}'; commit;`));
check("not even postgres can update or delete it", await sqlFails(`update public.agreement_acceptances set signer_name='T' where agreement_id='${A}'`) && await sqlFails(`delete from public.agreement_acceptances where agreement_id='${A}'`));
check("nor change the accepted agreement", await sqlFails(`update public.agreements set title='T' where id='${A}'`));
check("the row is as recorded", await sql(`select signer_name from public.agreement_acceptances where agreement_id='${A}'`) === "<b>Pat</b> Agree");

// ---- Void and expired links ------------------------------------------------------------------------
const voidTitle = `Void me ${tag}`;
const V = (await call(S.token, "POST", "/agreements", { contactId: contact.id, title: voidTitle, bodyText: "v" })).body.id;
await call(S.token, "POST", `/agreements/${V}/send`);
const voidToken = await linkFor(parentEmail, voidTitle);
const voided = await call(S.token, "POST", `/agreements/${V}/void`);
check("a sent agreement can be voided", voided.status === 200 && voided.body.status === "void" && voided.body.voidedAt, JSON.stringify(voided.body));
check("its link says withdrawn", (await pub("GET", `/agree/${voidToken}`)).status === 410);
const vp = await pub("POST", `/agree/${voidToken}`, { body: "signerName=Pat+Agree&consent=yes" });
check("and can't be accepted", vp.status === 410 && await sql(`select count(*) from public.agreement_acceptances where agreement_id='${V}'`) === "0");
check("a void agreement can't be sent again", (await call(S.token, "POST", `/agreements/${V}/send`)).status === 409);

const expTitle = `Expire me ${tag}`;
const E = (await call(S.token, "POST", "/agreements", { contactId: contact.id, title: expTitle, bodyText: "e" })).body.id;
await call(S.token, "POST", `/agreements/${E}/send`);
const expToken = await linkFor(parentEmail, expTitle);
await sql(`update public.agreement_tokens set expires_at = now() - interval '1 hour' where agreement_id='${E}'`);
check("an expired link says so", (await pub("GET", `/agree/${expToken}`)).status === 410);
const ep = await pub("POST", `/agree/${expToken}`, { body: "signerName=Pat+Agree&consent=yes" });
check("and can't be accepted", ep.status === 410 && await sql(`select count(*) from public.agreement_acceptances where agreement_id='${E}'`) === "0" && await sql(`select status from public.agreements where id='${E}'`) === "sent");
const resent = await call(S.token, "POST", `/agreements/${E}/send`);
check("sending again mints a fresh link", resent.status === 200 && await sql(`select count(*) from public.agreement_tokens where agreement_id='${E}' and expires_at > now()`) === "1");

// ---- Limits ------------------------------------------------------------------------------------------
const anyToken = Buffer.from(`${tag}-limit-token-padding-padding`).toString("base64url").slice(0, 43).padEnd(43, "x");
let tokenTrip = 0;
for (let i = 0; i < 11; i++) tokenTrip = (await pub("POST", `/agree/${anyToken}`, { body: "signerName=Pat+Agree&consent=yes", from: ip() })).status;
check("one link takes 10 accept tries an hour, from any address", tokenTrip === 429, `status ${tokenTrip}`);
const flood = ip();
let ipTrip = 0;
for (let i = 0; i < 31; i++) ipTrip = (await pub("GET", `/agree/${"Z".repeat(42)}${i % 10}`, { from: flood })).status;
check("one address takes 30 requests a minute", ipTrip === 429, `status ${ipTrip}`);
