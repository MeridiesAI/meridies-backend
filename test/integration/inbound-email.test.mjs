// A family answers an email (migration 20261103000002, lib/inboundEmail.ts,
// POST /webhooks/resend `email.received`), as real accounts on a local Supabase
// against a running API (see harness.mjs).
//
// The API must be started with:
//   REPLY_DOMAIN=reply.test.local  RESEND_API_KEY=re_test_key
//   RESEND_API_BASE=http://127.0.0.1:4199  (this file serves a stand-in Resend there)
//   RESEND_WEBHOOK_SECRET=whsec_dGVzdC1yZXNlbmQtc2VjcmV0LWZvci1sb2NhbC10ZXN0cw==
//
// Checks: a sent email mints a reply address; a reply lands on the contact's
// timeline without its quoted history and a copy goes to the counselor; a
// retried webhook writes nothing twice; an unrecognised sender is shown as
// such; auto-replies, bad signatures, unknown tokens and a revoked counselor
// place nothing; another practice reads none of it.
import { createHmac } from "node:crypto";
import http from "node:http";
import { API, CLIENT, call, check, rest, sql, user } from "./harness.mjs";

const SECRET = process.env.RESEND_WEBHOOK_SECRET ?? "whsec_dGVzdC1yZXNlbmQtc2VjcmV0LWZvci1sb2NhbC10ZXN0cw==";
const DOMAIN = process.env.REPLY_DOMAIN ?? "reply.test.local";
const FAKE_PORT = Number(new URL(process.env.RESEND_API_BASE ?? "http://127.0.0.1:4199").port);
const tag = Date.now();

// ---- a stand-in for Resend ---------------------------------------------------
const received = new Map(); // email id -> receiving-API body
const sent = []; // bodies the API posted to /emails
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const m = /^\/emails\/receiving\/([^/?]+)/.exec(req.url ?? "");
    if (req.method === "GET" && m) {
      const e = received.get(decodeURIComponent(m[1]));
      res.statusCode = e ? 200 : 404;
      return res.end(JSON.stringify(e ?? { message: "not found" }));
    }
    if (req.method === "POST" && req.url === "/emails") {
      try { sent.push(JSON.parse(raw)); } catch { /* ignore */ }
      return res.end(JSON.stringify({ id: `fake-${sent.length}` }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));

const sign = (id, body) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
};
const webhook = async (emailId, { badSig = false } = {}) => {
  const body = JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: emailId } });
  const headers = { ...CLIENT, "Content-Type": "application/json", ...sign(`msg_${emailId}_${Math.random()}`, badSig ? body + "x" : body) };
  const r = await fetch(`${API}/webhooks/resend`, { method: "POST", headers, body });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const incoming = (id, token, over = {}) =>
  received.set(id, {
    object: "email",
    id,
    to: [`r-${token}@${DOMAIN}`],
    from: "Ann Lee <ann@families.test>",
    subject: "Re: Meeting",
    text: "Tuesday at 4 works for us.\n\nAnn\n\nOn Mon, Nov 2, 2026 at 9:14 AM Brandon <hello@meridiesai.com> wrote:\n> Can we meet this week?",
    html: null,
    headers: {},
    received_for: [],
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    ...over,
  });

// ---- accounts ------------------------------------------------------------------
const C = await user("ie-counselor");
const X = await user("ie-outsider");
const stage = (await call(C.token, "GET", "/pipeline")).body.stages[0].id;
const contact = (
  await call(C.token, "POST", "/pipeline/contacts", {
    stageId: stage,
    studentName: "Maya Lee",
    parentName: "Ann Lee",
    parentEmail: "ann@families.test",
  })
).body;
const activities = async () => (await call(C.token, "GET", `/pipeline/contacts/${contact.id}/activities?limit=200`)).body.activities ?? [];

// ---- sending mints the reply address ---------------------------------------------
const mail = await call(C.token, "POST", `/pipeline/contacts/${contact.id}/email`, {
  subject: "Meeting this week",
  body: "Hi {first}, can we meet this week? — {me}",
  to: ["parent"],
});
check("emailing the parent works", mail.status === 200 && mail.body.sentCount === 1, JSON.stringify(mail.body));
const token = await sql(
  `select token from public.messaging_routes where contact_id = '${contact.id}' and party = 'parent' and counselor_id = '${C.id}'`
);
check("a routed reply address was minted for the parent", /^[0-9a-f]{24}$/.test(token), token);
const again = await call(C.token, "POST", `/pipeline/contacts/${contact.id}/email`, { subject: "Again", body: "Hi", to: ["parent"] });
check("a second email reuses the same address", again.status === 200 && (await sql(`select count(*) from public.messaging_routes where contact_id = '${contact.id}'`)) === "1");
const out = sent.find((b) => (b.to ?? []).includes("ann@families.test"));
if (out) {
  check("the Reply-To on the parent's email is the routed address", out.reply_to === `r-${token}@${DOMAIN}`, String(out.reply_to));
  check("the From line carries the counselor's name", /via Meridies/.test(String(out.from)), String(out.from));
} else {
  console.log("SKIP  (mail went to a catcher, not the stand-in: Reply-To not inspected)");
}

// ---- a reply lands on the timeline ----------------------------------------------------
incoming("em-1", token);
const r1 = await webhook("em-1");
check("the webhook accepts the reply", r1.status === 200 && r1.body.stored === true && r1.body.onTimeline === true, JSON.stringify(r1));
const tl = (await activities()).filter((a) => a.meta?.direction === "in");
check("exactly one inbound entry is on the contact timeline", tl.length === 1, String(tl.length));
check("it holds what she wrote, not the quoted history", tl[0]?.body === "Tuesday at 4 works for us.\n\nAnn", JSON.stringify(tl[0]?.body));
check("it is an email entry from the parent, from a known address", tl[0]?.kind === "email" && tl[0]?.meta?.party === "parent" && tl[0]?.meta?.senderKnown === true);
check("a reply counts as contact", (await sql(`select last_contacted_at is not null from public.pipeline_contacts where id = '${contact.id}'`)) === "t");
check("a copy was sent to the counselor's inbox", (await sql(`select count(*) from public.message_deliveries where template = 'family-reply-forward' and to_email = '${C.email}'`)) === "1");
const row = JSON.parse(await sql(`select row_to_json(m) from public.inbound_messages m where contact_id = '${contact.id}'`));
check("the reply is stored with its sender and authentication", row.from_addr === "ann@families.test" && row.sender_known === true && row.authenticated === true);

// ---- a retried webhook writes nothing twice ------------------------------------------------
const r1b = await webhook("em-1");
check("a retried webhook is recognised", r1b.status === 200 && r1b.body.ignored === "duplicate", JSON.stringify(r1b));
check("still one inbound entry", (await activities()).filter((a) => a.meta?.direction === "in").length === 1);

// ---- an address we don't hold ---------------------------------------------------------------------
incoming("em-2", token, { from: "Someone Else <ann.work@elsewhere.test>", text: "Replying from my work account." });
const r2 = await webhook("em-2");
check("a reply from another address is kept", r2.status === 200 && r2.body.stored === true, JSON.stringify(r2));
const second = (await activities()).find((a) => a.body === "Replying from my work account.");
check("and flagged as not a known address", second?.meta?.senderKnown === false);

// ---- not a person -------------------------------------------------------------------------------------
incoming("em-3", token, { headers: { "Auto-Submitted": "auto-replied" }, text: "I am out of the office." });
const r3 = await webhook("em-3");
check("an out-of-office reply is ignored", r3.status === 200 && r3.body.ignored === "automated", JSON.stringify(r3));
incoming("em-4", token, { text: "   " });
check("an empty reply is ignored", (await webhook("em-4")).body.ignored === "empty");

// ---- not ours -------------------------------------------------------------------------------------------
incoming("em-5", "ffffffffffffffffffffffff");
check("an unknown token places nothing", (await webhook("em-5")).body.ignored === "no-route");
incoming("em-6", token, { to: [`r-${token}@somewhere-else.test`] });
check("another domain's address places nothing", (await webhook("em-6")).body.ignored === "no-route");
const bad = await webhook("em-1", { badSig: true });
check("a bad signature is refused", bad.status === 401, String(bad.status));
check("nothing else reached the timeline", (await activities()).filter((a) => a.meta?.direction === "in").length === 2);

// ---- other practices -------------------------------------------------------------------------------------
const xs = await rest(X.token, "GET", `/rest/v1/inbound_messages?contact_id=eq.${contact.id}&select=id`);
check("another counselor reads none of it", xs.status === 200 && Array.isArray(xs.body) && xs.body.length === 0, JSON.stringify(xs.body));
const mine = await rest(C.token, "GET", `/rest/v1/inbound_messages?contact_id=eq.${contact.id}&select=id`);
check("the counselor reads their own", Array.isArray(mine.body) && mine.body.length === 2, JSON.stringify(mine.body));
const forge = await rest(C.token, "POST", "/rest/v1/inbound_messages", { channel: "email", counselor_id: C.id, from_addr: "a@b.test", body: "x", provider_message_id: "forged" });
check("a client can't write a reply", forge.status >= 400, String(forge.status));
const routes = await rest(C.token, "GET", "/rest/v1/messaging_routes?select=token");
check("a client can't read reply tokens", routes.status >= 400 || (Array.isArray(routes.body) && routes.body.length === 0), JSON.stringify(routes.body));

// ---- a revoked counselor receives nothing ----------------------------------------------------------------
await sql(`update public.profiles set counselor_approved_at = null where id = '${C.id}'`);
incoming("em-7", token, { text: "Anyone there?" });
check("a revoked counselor's route places nothing", (await webhook("em-7")).body.ignored === "unapproved");

fake.close();
