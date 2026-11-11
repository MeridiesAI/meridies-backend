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
import { checkInvoiceAgreement, invoiceAgreementInput, withAgreementSubject } from "../../src/lib/invoiceAgreement.js";
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
