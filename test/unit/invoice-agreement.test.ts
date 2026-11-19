import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../../src/env.js";
import { AGREEMENT_LINK_DAYS, NOT_CERTIFIED_LINE } from "../../src/lib/agreements.js";
import {
  AGREEMENT_BUTTON,
  AGREEMENT_FINE_PRINT,
  AGREEMENT_LINK_OMITTED,
  renderInvoiceEmail,
  renderInvoicePageBody,
  type InvoiceDocument,
} from "../../src/lib/invoiceDocument.js";
import { checkInvoiceAgreement, contractFieldsMessage, invoiceAgreementInput, issueInvoiceAgreement, resolveInvoiceAgreement, withAgreementSubject } from "../../src/lib/invoiceAgreement.js";
import { HttpError } from "../../src/lib/errors.js";

const PAY = "https://api.example.com/pay/paytok";
const AGREE = "https://api.example.com/agree/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

const doc = (over: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  practice: { name: "Northfield Admissions", logoUrl: null, accentColor: "#12402e" },
  number: "INV-1005",
  issuedOn: "2026-10-30",
  dueOn: "2026-11-09",
  billTo: { name: "Ava Hartwell family", contactName: "Morgan Hartwell", email: "morgan@example.com" },
  lines: [{ description: "Senior application package", detail: "Installment 2 of 3", amountCents: 200000 }],
  subtotalCents: 200000,
  creditAppliedCents: 0,
  alreadyPaidCents: 0,
  amountDueCents: 200000,
  status: "due",
  payUrl: PAY,
  plan: null,
  footnote: "Sent by Blair Billing through Meridies.",
  ...over,
});

const withSwitch = async (on: boolean, fn: () => void | Promise<void>) => {
  const prev = env.AGREEMENTS_ENABLED;
  (env as { AGREEMENTS_ENABLED: string }).AGREEMENTS_ENABLED = on ? "true" : "false";
  try {
    await fn();
  } finally {
    (env as { AGREEMENTS_ENABLED: string }).AGREEMENTS_ENABLED = prev;
  }
};

// ---- No agreement: the invoice email exactly as before --------------------------------------

test("without an agreement the email is byte for byte the invoice email, with no record copy", () => {
  const d = doc();
  const plain = renderInvoiceEmail(d);
  const none = renderInvoiceEmail(d, null);
  assert.deepEqual(none, plain);
  assert.equal(plain.recordText, undefined);
  for (const out of [plain.html, plain.text]) {
    assert.doesNotMatch(out, /agreement/i);
    assert.ok(!out.includes("/agree/"));
  }
});

// ---- With one: both links, agreement first -------------------------------------------------

test("with an agreement, one email carries both links, the agreement before the Pay button", () => {
  const { html, text } = renderInvoiceEmail(doc(), { title: "Engagement letter", url: AGREE });
  for (const out of [html, text]) {
    assert.ok(out.includes(AGREE), "the agreement link");
    assert.ok(out.includes(PAY), "the pay link");
    assert.ok(out.includes(AGREEMENT_BUTTON));
    assert.ok(out.indexOf(AGREE) < out.indexOf(PAY), "agree first, then pay");
    assert.ok(out.indexOf("Engagement letter") < out.indexOf("Bill to"), "the agreement block is above the invoice");
    assert.match(out, /before you pay/);
  }
  assert.match(html, new RegExp(`<a href="${AGREE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`));
  // The invoice itself is all still there.
  assert.ok(html.includes("Invoice INV-1005") && html.includes("Amount due") && html.includes("Pay $2,000 by card"));
});

test("without a pay button the agreement block doesn't talk about paying", () => {
  for (const d of [doc({ payUrl: null }), doc({ status: "paid", amountDueCents: 0 })]) {
    const { html, text } = renderInvoiceEmail(d, { title: "Engagement letter", url: AGREE });
    assert.ok(html.includes(AGREE) && text.includes(AGREE));
    assert.doesNotMatch(html + text, /before you pay/);
    assert.ok(!html.includes(PAY));
  }
});

test("the title and the link are escaped in the HTML", () => {
  const nasty = `Fees <script>alert(1)</script> & "terms"`;
  const { html, text } = renderInvoiceEmail(doc(), { title: nasty, url: `${AGREE}"><img src=x>` });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("Fees &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;terms&quot;"));
  assert.ok(!html.includes('"><img src=x>'), "the href can't break out of its attribute");
  assert.ok(text.includes(nasty), "the plain-text part keeps the title as typed");
});

test("the record copy leaves the private agreement link out and keeps the rest", () => {
  const r = renderInvoiceEmail(doc(), { title: "Engagement letter", url: AGREE });
  assert.ok(r.recordText);
  assert.ok(!r.recordText.includes(AGREE));
  assert.ok(!r.recordText.includes("/agree/"));
  assert.ok(r.recordText.includes(AGREEMENT_LINK_OMITTED));
  assert.ok(r.recordText.includes("Engagement letter"));
  assert.ok(r.recordText.includes("Amount due: $2,000"));
  assert.equal(r.recordText, r.text.replace(AGREE, AGREEMENT_LINK_OMITTED));
});

test("the pay page never shows the agreement", () => {
  const page = renderInvoicePageBody(doc({ payUrl: "" }));
  assert.doesNotMatch(page, /agreement/i);
});

test("the agreement copy says what it is and never claims more", () => {
  assert.ok(AGREEMENT_FINE_PRINT.includes(NOT_CERTIFIED_LINE));
  assert.ok(AGREEMENT_FINE_PRINT.includes(`${AGREEMENT_LINK_DAYS} days`), "the link's life matches AGREEMENT_LINK_DAYS");
  const { html, text } = renderInvoiceEmail(doc(), { title: "T", url: AGREE });
  for (const re of [/legally\s+(binding|valid|enforceable)/i, /e-?sign(ature)?[ -]compliant/i, /\bESIGN\b/, /\bUETA\b/, /binding\s+(contract|agreement)/i]) {
    assert.doesNotMatch(html + text, re);
  }
});

test("the subject says an agreement comes with it", () => {
  assert.equal(withAgreementSubject("Invoice INV-1: $500 due 2026-12-01"), "Invoice INV-1: $500 due 2026-12-01 · agreement to review");
  assert.ok(withAgreementSubject("x".repeat(300)).length <= 200);
});

// ---- The gate ------------------------------------------------------------------------------

const code = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof HttpError);
    return `${e.statusCode} ${e.code}`;
  }
};

test("switched off: no agreement is the old path; asking for one is 404 agreements_off before anything else", async () => {
  await withSwitch(false, () => {
    assert.equal(code(() => checkInvoiceAgreement(undefined, { to: "a@b.test", send: true })), null);
    assert.equal(code(() => checkInvoiceAgreement(undefined, { to: "", send: false })), null);
    assert.equal(code(() => checkInvoiceAgreement({ agreementId: "11111111-1111-4111-8111-111111111111" }, { to: "a@b.test", send: true })), "404 agreements_off");
    assert.equal(code(() => checkInvoiceAgreement({ title: "T", bodyText: "B" }, { to: "", send: false })), "404 agreements_off");
  });
});

test("switched on: an agreement needs the email to go out, to an address", async () => {
  const prevUrl = env.PUBLIC_API_URL;
  (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = "https://api.example.com";
  try {
    await withSwitch(true, () => {
      const input = { agreementId: "11111111-1111-4111-8111-111111111111" };
      assert.equal(code(() => checkInvoiceAgreement(input, { to: "a@b.test", send: true })), null);
      assert.equal(code(() => checkInvoiceAgreement(input, { to: "a@b.test", send: false })), "400 agreement_needs_send");
      assert.equal(code(() => checkInvoiceAgreement(input, { to: "", send: true })), "400 contact_no_email");
      (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = undefined;
      assert.equal(code(() => checkInvoiceAgreement(input, { to: "a@b.test", send: true })), "503 agreements_unavailable");
    });
  } finally {
    (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = prevUrl;
  }
});

test("the attachment is one of the contact's agreements, or a new title and text, never both or neither", () => {
  assert.ok(invoiceAgreementInput.safeParse({ agreementId: "11111111-1111-4111-8111-111111111111" }).success);
  assert.ok(invoiceAgreementInput.safeParse({ title: "Engagement", bodyText: "Terms" }).success);
  for (const bad of [
    {},
    { agreementId: "not-a-uuid" },
    { agreementId: "11111111-1111-4111-8111-111111111111", title: "T", bodyText: "B" },
    { title: "T" },
    { title: "Bell\u0007", bodyText: "B" },
    { title: "T", bodyText: "   " },
    { title: "T", bodyText: "a\u0000b" },
    { title: "x".repeat(161), bodyText: "B" },
  ]) {
    assert.equal(invoiceAgreementInput.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

// ---- A drafted contract ({ draftId }) -----------------------------------------------------------------

const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const SENDER = { counselorId: "c-1", counselorName: "Casey Counselor", practiceName: "Northfield Admissions" };
const SECTIONS = [
  { id: "s", kind: "text", heading: "Services", body: "{{counselor_name}} guides {{student_name}} and {{family_name}} from {{date}}." },
  { id: "p", kind: "list", heading: "Prerequisites", items: ["Intake form"] },
  { id: "f", kind: "text", heading: "Fees", body: "See the invoice." },
];
type Row = Record<string, unknown>;
type PgErr = { code: string; message: string } | null;

/** A Supabase client stand-in: canned rows per table, failures on demand, and a log of every write. */
function stubDb(o: { rows?: Record<string, Row | null>; insertError?: Record<string, PgErr>; rpcError?: PgErr }) {
  const writes: string[] = [];
  const rows: Record<string, Row | null> = {
    contract_drafts: { id: DRAFT_ID, title: "Agreement for {{student_name}}", sections: SECTIONS, archived_at: null },
    pipeline_contacts: { parent_name: "Pat Parent", parent_email: "pat@families.test", student_name: "Sam Student" },
    counselor_signatures: { signer_name: "Casey Signer", kind: "typed", image_png: null, image_sha256: null },
    ...o.rows,
  };
  const from = (table: string) => {
    let op = "select";
    const result = () => {
      if (op === "insert") return { data: table === "agreements" ? { id: "ag-1" } : null, error: o.insertError?.[table] ?? null };
      if (op === "update") return { data: null, error: null };
      return { data: rows[table] ?? null, error: null };
    };
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      insert: (r: Row) => ((op = "insert"), writes.push(`insert ${table} ${JSON.stringify(r)}`), q),
      update: (r: Row) => ((op = "update"), writes.push(`update ${table} ${JSON.stringify(r)}`), q),
      maybeSingle: async () => result(),
      single: async () => result(),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
    };
    return q;
  };
  const rpc = async (name: string) => (writes.push(`rpc ${name}`), { data: null, error: o.rpcError ?? null });
  return { db: { from, rpc } as unknown as Parameters<typeof resolveInvoiceAgreement>[0], writes };
}

const withApiUrl = async (fn: () => Promise<void>) => {
  const prev = env.PUBLIC_API_URL;
  (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = "https://api.example.com";
  try {
    await fn();
  } finally {
    (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = prev;
  }
};
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    return `${e.statusCode} ${e.code}`;
  }
};

test("a draft id is a fourth strict variant", async () => {
  assert.ok(invoiceAgreementInput.safeParse({ draftId: DRAFT_ID }).success);
  assert.equal(invoiceAgreementInput.safeParse({ draftId: DRAFT_ID, title: "T", bodyText: "B" }).success, false);
  assert.equal(invoiceAgreementInput.safeParse({ draftId: "nope" }).success, false);
  await withSwitch(false, () => {
    assert.equal(code(() => checkInvoiceAgreement({ draftId: DRAFT_ID }, { to: "a@b.test", send: true })), "404 agreements_off");
  });
});

test("resolving a draft renders it for the family and the sender, writing nothing", async () => {
  const { db, writes } = stubDb({ rows: { pipeline_contacts: { parent_name: "Pat\n\n2. Fake", parent_email: "p@x.test", student_name: "  Sam   Student " } } });
  const r = await resolveInvoiceAgreement(db, "contact-1", { draftId: DRAFT_ID }, SENDER);
  assert.equal(r.id, null);
  assert.equal(r.title, "Agreement for Sam Student");
  assert.ok(r.draft?.bodyText.includes("Casey Counselor guides Sam Student and Pat 2. Fake from "), r.draft?.bodyText);
  assert.ok(!r.draft?.bodyText.includes("\n\n2. Fake"), "a name can't forge a heading");
  assert.match(r.draft!.bodyText, /Signed for Northfield Admissions by Casey Signer, [A-Z][a-z]+ \d{1,2}, \d{4}\.$/);
  assert.deepEqual(writes, []);
});

test("no parent address: the family is the student", async () => {
  const { db } = stubDb({ rows: { pipeline_contacts: { parent_name: "Pat", parent_email: "", student_name: "Sam" } } });
  const r = await resolveInvoiceAgreement(db, "contact-1", { draftId: DRAFT_ID }, SENDER);
  assert.ok(r.draft?.bodyText.includes("guides Sam and Sam from"));
});

test("a draft's refusals: archived 404, no signature 409, no sender (the cron) 409", async () => {
  assert.equal(await rejects(resolveInvoiceAgreement(stubDb({ rows: { contract_drafts: { id: DRAFT_ID, title: "T", sections: SECTIONS, archived_at: "2026-11-01" } } }).db, "c", { draftId: DRAFT_ID }, SENDER)), "404 undefined");
  assert.equal(await rejects(resolveInvoiceAgreement(stubDb({ rows: { contract_drafts: null } }).db, "c", { draftId: DRAFT_ID }, SENDER)), "404 undefined");
  assert.equal(await rejects(resolveInvoiceAgreement(stubDb({ rows: { counselor_signatures: null } }).db, "c", { draftId: DRAFT_ID }, SENDER)), "409 signature_needed");
  assert.equal(await rejects(resolveInvoiceAgreement(stubDb({}).db, "c", { draftId: DRAFT_ID })), "409 draft_contract_send_now");
});

test("missing and unknown fields are named in words", () => {
  assert.equal(contractFieldsMessage(["family_name"]), "Fill in the parent's or student's name on the family's card first");
  assert.equal(contractFieldsMessage(["student_name", "family_name"]), "Fill in the student's name and the parent's or student's name on the family's card first");
  assert.equal(contractFieldsMessage(["counselor_name"]), "Fill in your name in Settings first");
  assert.equal(contractFieldsMessage(["fee"]), "The contract uses a field Meridies doesn't know: {{fee}}");
  assert.equal(contractFieldsMessage([""]), "The contract uses a field Meridies doesn't know: an empty {{ }}");
  assert.equal(contractFieldsMessage(["Student_Name"]), "The contract uses a field Meridies doesn't know: {{Student_Name}}");
});

test("render failures map to 400s before anything is written", async () => {
  const empty = stubDb({ rows: { pipeline_contacts: { parent_name: " ", parent_email: "p@x.test", student_name: "Sam" } } });
  assert.equal(await rejects(resolveInvoiceAgreement(empty.db, "c", { draftId: DRAFT_ID }, SENDER)), "400 contract_fields_missing");
  const long = stubDb({ rows: { contract_drafts: { id: DRAFT_ID, title: "T", sections: [{ ...SECTIONS[0], body: "{{student_name}}".repeat(3000) }, SECTIONS[1], SECTIONS[2]], archived_at: null }, pipeline_contacts: { parent_name: "P", parent_email: "p@x.test", student_name: "S".repeat(40) } } });
  assert.equal(await rejects(resolveInvoiceAgreement(long.db, "c", { draftId: DRAFT_ID }, SENDER)), "400 contract_too_long");
  assert.deepEqual([...empty.writes, ...long.writes], []);
});

test("issuing a draft: save, snapshot copied from the saved row, then the link", async () => {
  await withApiUrl(async () => {
    const { db, writes } = stubDb({});
    const resolved = await resolveInvoiceAgreement(db, "c", { draftId: DRAFT_ID }, SENDER);
    const out = await issueInvoiceAgreement(db, { contactId: "c", counselorId: "c-1", input: { draftId: DRAFT_ID }, resolved });
    assert.equal(out.id, "ag-1");
    assert.equal(writes.length, 3);
    assert.match(writes[0], /^insert agreements /);
    assert.ok(writes[0].includes(JSON.stringify(resolved.draft!.bodyText)), "the rendered text is what is saved");
    assert.equal(writes[1], `insert agreement_signatures ${JSON.stringify({ agreement_id: "ag-1", signer_name: "Casey Signer", kind: "typed", image_png: null, image_sha256: null })}`);
    assert.equal(writes[2], "rpc issue_agreement_link");
  });
});

test("a failed snapshot or link voids the new agreement and the error goes on", async () => {
  await withApiUrl(async () => {
    for (const fail of [{ insertError: { agreement_signatures: { code: "23514", message: "check" } } }, { rpcError: { code: "XX000", message: "boom" } }]) {
      const { db, writes } = stubDb(fail);
      const resolved = await resolveInvoiceAgreement(db, "c", { draftId: DRAFT_ID }, SENDER);
      await assert.rejects(issueInvoiceAgreement(db, { contactId: "c", counselorId: "c-1", input: { draftId: DRAFT_ID }, resolved }));
      assert.equal(writes.at(-1), `update agreements ${JSON.stringify({ status: "void" })}`, writes.join(" | "));
    }
  });
});

test("a snapshot refused because the signature changed: voided, 409, never stamped with the new one", async () => {
  await withApiUrl(async () => {
    const { db, writes } = stubDb({ insertError: { agreement_signatures: { code: "42501", message: "rls" } } });
    const resolved = await resolveInvoiceAgreement(db, "c", { draftId: DRAFT_ID }, SENDER);
    // The saved row now differs from the one the text names.
    resolved.draft = { ...resolved.draft!, signature: { ...resolved.draft!.signature, signer_name: "Someone Earlier" } };
    assert.equal(await rejects(issueInvoiceAgreement(db, { contactId: "c", counselorId: "c-1", input: { draftId: DRAFT_ID }, resolved })), "409 signature_changed");
    assert.equal(writes.filter((w) => w.startsWith("insert agreement_signatures")).length, 1);
    assert.equal(writes.at(-1), `update agreements ${JSON.stringify({ status: "void" })}`);
  });
});

test("the service client (the cron) never signs a draft", async () => {
  await withApiUrl(async () => {
    const { db, writes } = stubDb({});
    const resolved = await resolveInvoiceAgreement(db, "c", { draftId: DRAFT_ID }, SENDER);
    assert.equal(await rejects(issueInvoiceAgreement(db, { contactId: "c", counselorId: "c-1", input: { draftId: DRAFT_ID }, resolved, service: true })), "409 draft_contract_send_now");
    assert.equal(await rejects(issueInvoiceAgreement(db, { contactId: "c", counselorId: "c-1", input: { draftId: DRAFT_ID }, resolved: { id: null, title: "T" } })), "409 draft_contract_send_now");
    assert.deepEqual(writes, []);
  });
});
