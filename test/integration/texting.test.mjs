// Texting from a consultant's own number (migration 20261103000002,
// routes/messaging.ts, lib/inboundSms.ts, POST /pipeline/contacts/:id/text and
// the Communication composer), as real accounts on a local Supabase against a
// running API (see harness.mjs).
//
// Needs an API started for it, so it runs only when MESSAGING_SUITE=1:
//   TWILIO_ACCOUNT_SID=AC<32 hex>  TWILIO_AUTH_TOKEN=...  TWILIO_MESSAGING_SERVICE_SID=MG<32 hex>
//   TWILIO_API_BASE=http://127.0.0.1:4198  (this file serves a stand-in Twilio there)
//   PUBLIC_API_URL=<the API's own URL>   (Twilio's signature is computed over it)
//
// Checks: a counselor finds, buys and keeps one number; texts go from it, the
// first one carrying the opt-out line; a family's reply lands on the contact's
// timeline and in the counselor's inbox; STOP is honoured and START lifts it;
// a retried or unsigned webhook writes nothing; another practice sees none of it.
import { createHmac } from "node:crypto";
import http from "node:http";
import { API, CLIENT, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

if (process.env.MESSAGING_SUITE !== "1") {
  console.log("SKIP  texting suite (set MESSAGING_SUITE=1 with an API started for it)");
  process.exit(0);
}

const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PUBLIC = (process.env.PUBLIC_API_URL ?? API).replace(/\/+$/, "");
const FAKE_PORT = Number(new URL(process.env.TWILIO_API_BASE).port);
const MS = process.env.TWILIO_MESSAGING_SERVICE_SID;
const tag = Date.now();
// A parent's number no other run (or suite) has texted, so "the first text" is really the first.
const last4 = String(tag % 10000).padStart(4, "0");
const PARENT_E164 = `+1415${String(500 + (Math.floor(tag / 10000) % 400)).padStart(3, "0")}${last4}`;
const PARENT_CARD = `(${PARENT_E164.slice(2, 5)}) ${PARENT_E164.slice(5, 8)}-${PARENT_E164.slice(8)}`;

// ---- a stand-in for Twilio -----------------------------------------------------
const messages = []; // form posted to Messages.json
const bought = [];
const joined = [];
const released = [];
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const url = req.url ?? "";
    const form = Object.fromEntries(new URLSearchParams(raw));
    if (req.method === "GET" && /AvailablePhoneNumbers\/US\/Local\.json/.test(url)) {
      return res.end(JSON.stringify({ available_phone_numbers: [
        { phone_number: "+14155550111", friendly_name: "(415) 555-0111", locality: "San Francisco", region: "CA" },
        { phone_number: "+14155550112", friendly_name: "(415) 555-0112", locality: "San Francisco", region: "CA" },
      ] }));
    }
    if (req.method === "POST" && /IncomingPhoneNumbers\.json/.test(url)) {
      bought.push(form);
      return res.end(JSON.stringify({ sid: "PN" + String(bought.length).padStart(32, "0"), phone_number: form.PhoneNumber }));
    }
    if (req.method === "POST" && /\/v1\/Services\/[^/]+\/PhoneNumbers/.test(url)) {
      joined.push(form);
      return res.end(JSON.stringify({ sid: form.PhoneNumberSid }));
    }
    if (req.method === "DELETE" && /IncomingPhoneNumbers\/(PN\w+)\.json/.test(url)) {
      released.push(url);
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === "POST" && /Messages\.json/.test(url)) {
      messages.push(form);
      return res.end(JSON.stringify({ sid: "SM" + String(messages.length).padStart(32, "0") }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));

const sign = (url, params) => {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", TOKEN).update(data).digest("base64");
};
const inbound = async (params, { badSig = false } = {}) => {
  const url = `${PUBLIC}/webhooks/twilio/inbound`;
  const body = new URLSearchParams(params).toString();
  const r = await fetch(`${API}/webhooks/twilio/inbound`, {
    method: "POST",
    headers: { ...CLIENT, "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": badSig ? "AAAA" : sign(url, params) },
    body,
  });
  return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
};

// The stand-in sells the same two numbers every run; a re-run on the same database must be able to buy them again.
await sql("delete from public.consultant_phone_numbers where phone_e164 in ('+14155550111', '+14155550112')");

// ---- accounts ------------------------------------------------------------------------
const C = await user("tx-counselor");
const X = await user("tx-outsider");
const stage = (await call(C.token, "GET", "/pipeline")).body.stages[0].id;
const contact = (
  await call(C.token, "POST", "/pipeline/contacts", {
    stageId: stage,
    studentName: "Maya Lee",
    parentName: "Ann Lee",
    parentEmail: `ann-${tag}@families.test`,
    parentPhone: PARENT_CARD,
  })
).body;
const timeline = async () => (await call(C.token, "GET", `/pipeline/contacts/${contact.id}/activities?limit=200`)).body.activities ?? [];
const text = (over = {}) => call(C.token, "POST", `/pipeline/contacts/${contact.id}/text`, { body: "Maya's draft is in.", to: ["parent"], ...over });

// ---- no number yet --------------------------------------------------------------------
const none = await call(C.token, "GET", "/messaging/number");
check("a counselor with no number is told they can get one", none.status === 200 && none.body.available === true && none.body.number === null, JSON.stringify(none.body));
// A different family, so this text can't count as "the first text" to the parent below.
const other = (
  await call(C.token, "POST", "/pipeline/contacts", { stageId: stage, studentName: "Ben Kim", parentName: "Joy Kim", parentPhone: "(415) 555-0150" })
).body;
const noNumberText = await call(C.token, "POST", `/pipeline/contacts/${other.id}/text`, { body: "Hello", to: ["parent"] });
check("before a number exists, a text still goes (from the shared sender)", noNumberText.status === 200 && noNumberText.body.sentCount === 1 && messages.at(-1)?.MessagingServiceSid === MS, JSON.stringify(noNumberText.body));
messages.length = 0;

// ---- finding and buying -----------------------------------------------------------------
const search = await call(C.token, "POST", "/messaging/number/search", { areaCode: "415" });
check("searching an area code lists numbers that can text", search.status === 200 && search.body.numbers?.length === 2 && search.body.numbers[0].phone === "+14155550111", JSON.stringify(search.body));
check("a bad area code is refused", (await call(C.token, "POST", "/messaging/number/search", { areaCode: "12" })).status === 400);
check("only a number from the search can be bought", (await call(C.token, "POST", "/messaging/number", { phone: "415-555-0111" })).status === 400);

const [b1, b2] = await Promise.all([
  call(C.token, "POST", "/messaging/number", { phone: "+14155550111" }),
  call(C.token, "POST", "/messaging/number", { phone: "+14155550112" }),
]);
const statuses = [b1.status, b2.status].sort();
check("a double submit buys one number, not two", statuses[0] === 201 && statuses[1] >= 400 && (await sql(`select count(*) from public.consultant_phone_numbers where counselor_id = '${C.id}'`)) === "1", JSON.stringify([b1.status, b2.status]));
const mine = (await call(C.token, "GET", "/messaging/number")).body.number?.phone;
check("the number is theirs", mine === "+14155550111" || mine === "+14155550112", String(mine));
const NUMBER = mine;
const purchase = bought.find((f) => f.PhoneNumber === NUMBER);
check("incoming texts are pointed at this API", purchase?.SmsUrl === `${PUBLIC}/webhooks/twilio/inbound` && purchase?.SmsMethod === "POST", JSON.stringify(purchase));
check("the number joined the registered campaign's Messaging Service", joined.length >= 1 && /^PN/.test(joined[0].PhoneNumberSid) && MS !== undefined);
const again = await call(C.token, "POST", "/messaging/number", { phone: "+14155550112" });
check("a second number is refused", again.status === 409 && again.body.code === "number_exists", JSON.stringify(again.body));
const outsider = await call(X.token, "GET", "/messaging/number");
check("another counselor sees no number of theirs", outsider.body.number === null, JSON.stringify(outsider.body));
const asStudent = await call((await user("tx-student", "student")).token, "POST", "/messaging/number/search", {});
check("a student can't search for numbers", asStudent.status === 403, String(asStudent.status));
const fakeRow = await rest(C.token, "POST", "/rest/v1/consultant_phone_numbers", { counselor_id: C.id, phone_e164: "+14155550199", twilio_sid: "PN" + "0".repeat(32) });
check("a client can't write a number row", fakeRow.status >= 400, String(fakeRow.status));

// ---- texting from it ----------------------------------------------------------------------------
messages.length = 0;
const t1 = await text();
check("texting the parent works", t1.status === 200 && t1.body.sentCount === 1 && t1.body.results[0].status === "sent", JSON.stringify(t1.body));
const m1 = messages.at(-1);
check("it goes from the consultant's own number, not the shared sender", m1?.From === NUMBER && m1?.MessagingServiceSid === undefined, JSON.stringify(m1));
check("to the parent's number on the card, in E.164", m1?.To === PARENT_E164, m1?.To);
check("opening with who it is from and which student it is about", /^Hi Ann, it's tx-counselor about Maya: Maya's draft is in\./.test(m1?.Body ?? ""), m1?.Body);
check("the first text to a number carries the opt-out line", /Reply STOP to opt out\.$/.test(m1?.Body ?? ""), m1?.Body);
await text({ body: "Second one." });
check("later texts don't repeat it", !/STOP/.test(messages.at(-1)?.Body ?? ""), messages.at(-1)?.Body);
const logged = (await timeline()).find((a) => a.kind === "sms" && /Texted the parent: Maya's draft is in\./.test(a.body));
check("what was texted is on the contact's timeline", Boolean(logged));
check("a contact with no phone can't be texted", (await text({ to: ["student"] })).status === 400);

const seq = await call(C.token, "POST", "/pipeline/sequences", {
  name: "Text reply drip",
  sendHour: 9,
  steps: [{ offsetDays: 3, to: "parent", subject: "Checking in", body: "Any questions so far?" }],
});
await call(C.token, "POST", `/pipeline/contacts/${contact.id}/sequences`, { sequenceId: seq.body.id });

// ---- a reply ------------------------------------------------------------------------------------------------
const reply = await inbound({ From: PARENT_E164, To: NUMBER, Body: "Thursday at 4 works.", MessageSid: `SMin1-${tag}` });
check("Twilio is answered with empty TwiML", reply.status === 200 && /xml/.test(reply.type) && reply.text.includes("<Response></Response>"), JSON.stringify(reply));
const inTl = (await timeline()).filter((a) => a.kind === "sms" && a.meta?.direction === "in");
check("the reply is on the contact's timeline, from the parent", inTl.length === 1 && inTl[0].body === "Thursday at 4 works." && inTl[0].meta.party === "parent" && inTl[0].meta.senderKnown === true, JSON.stringify(inTl));
check("their email sequence stops when they answer by text", (await sql(`select status || ':' || stop_reason from public.pipeline_sequence_enrollments where contact_id = '${contact.id}'`)) === "stopped:replied");
check("a copy of the reply was mailed to the counselor", (await sql(`select count(*) from public.message_deliveries where template = 'family-text-forward' and to_email = '${C.email}'`)) === "1");
const dup = await inbound({ From: PARENT_E164, To: NUMBER, Body: "Thursday at 4 works.", MessageSid: `SMin1-${tag}` });
check("a retried webhook writes nothing twice", dup.status === 200 && (await timeline()).filter((a) => a.meta?.direction === "in").length === 1);
const unsigned = await inbound({ From: PARENT_E164, To: NUMBER, Body: "forged", MessageSid: `SMin2-${tag}` }, { badSig: true });
check("an unsigned webhook is refused", unsigned.status === 401, String(unsigned.status));
const stranger = await inbound({ From: "+16505550100", To: NUMBER, Body: "Who is this?", MessageSid: `SMin3-${tag}` });
check("a text from a number we don't hold is kept, unplaced", stranger.status === 200 && (await sql(`select count(*) from public.inbound_messages where counselor_id = '${C.id}' and from_addr = '+16505550100' and contact_id is null and sender_known = false`)) === "1");
const wrongNumber = await inbound({ From: PARENT_E164, To: "+14155559999", Body: "hello", MessageSid: `SMin4-${tag}` });
check("a text to a number that isn't a consultant's places nothing", wrongNumber.status === 200 && (await sql(`select count(*) from public.inbound_messages where provider_message_id like 'twilio:SMin4-${tag}%'`)) === "0");
const xs = await rest(X.token, "GET", `/rest/v1/inbound_messages?select=id&counselor_id=eq.${C.id}`);
check("another counselor reads none of it", Array.isArray(xs.body) && xs.body.length === 0, JSON.stringify(xs.body));

// ---- STOP and START ----------------------------------------------------------------------------------------------------
await inbound({ From: PARENT_E164, To: NUMBER, Body: "STOP", MessageSid: `SMin5-${tag}` });
check("STOP is recorded", (await sql(`select count(*) from public.sms_opt_outs where counselor_id = '${C.id}' and phone_e164 = '${PARENT_E164}'`)) === "1");
check("and shown on the timeline so nobody texts them again", (await timeline()).some((a) => a.meta?.direction === "in" && /opted out/i.test(a.body)));
const before = messages.length;
const blocked = await text({ body: "Are you there?" });
check("a number that said STOP is not texted", blocked.body.results?.[0]?.status === "failed" && /STOP/.test(blocked.body.results[0].error ?? "") && messages.length === before, JSON.stringify(blocked.body));
await inbound({ From: PARENT_E164, To: NUMBER, Body: "start", MessageSid: `SMin6-${tag}` });
check("START lifts it", (await sql(`select count(*) from public.sms_opt_outs where counselor_id = '${C.id}'`)) === "0");
const again2 = await text({ body: "Welcome back." });
check("and texts go out again", again2.body.sentCount === 1 && messages.length === before + 1);
check("a sentence that merely contains 'stop' is a message, not an opt-out", await (async () => {
  await inbound({ From: PARENT_E164, To: NUMBER, Body: "please stop by Thursday", MessageSid: `SMin7-${tag}` });
  return (await sql(`select count(*) from public.sms_opt_outs where counselor_id = '${C.id}'`)) === "0";
})());

// ---- the Communication composer ----------------------------------------------------------------------------------------------
const S = await studentOf(C, "tx-student2");
await sql(`insert into public.guardians (student_id, full_name, email, phone) values ('${S.id}', 'Pat Parent', 'pat-${tag}@families.test', '(415) 555-0177')`);
messages.length = 0;
const composed = await call(C.token, "POST", `/communication/${S.id}/messages`, { audience: "parent", channel: "sms", body: "Quick note on the essay.", overrideQuietHours: true });
check("a parent text from the student page works", composed.status === 201 && composed.body.status === "sent", JSON.stringify(composed.body).slice(0, 200));
check("from the consultant's number to the guardian", messages.at(-1)?.From === NUMBER && messages.at(-1)?.To === "+14155550177" && /^Hi Pat, it's tx-counselor about tx-student2:/.test(messages.at(-1)?.Body ?? ""), JSON.stringify(messages.at(-1)));

// ---- a failed save gives the number back ---------------------------------------------------------------------------------------------
const D = await user("tx-buyer2");
await sql(`insert into public.consultant_phone_numbers (counselor_id, phone_e164, twilio_sid) values ('${D.id}', '+14155550112', 'PN${"9".repeat(32)}') on conflict do nothing`);
// D already holds +14155550112's row; a different counselor buying the same number collides on the unique number and must release it.
const E = await user("tx-buyer3");
const clash = await call(E.token, "POST", "/messaging/number", { phone: "+14155550112" });
check("a number that can't be recorded is released, not kept", clash.status >= 400 && released.length >= 1, `${clash.status} released=${released.length}`);

fake.close();
