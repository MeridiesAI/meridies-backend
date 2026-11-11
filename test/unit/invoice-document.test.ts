import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billToOf,
  contrastOnWhite,
  familyLabel,
  invoiceStatus,
  longDate,
  readableAccent,
  renderInvoiceEmail,
  renderInvoicePageBody,
  renderPayPage,
  safeImageUrl,
  showsPayButton,
  type InvoiceDocument,
} from "../../src/lib/invoiceDocument.js";
import { deriveAccount, formatUsd, planInvoice } from "../../src/lib/payments.js";
import { invoiceOwed } from "../../src/lib/stripeConnect.js";
import { payCsp } from "../../src/routes/pay.js";

const doc = (over: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  practice: { name: "Northfield Admissions", logoUrl: null, accentColor: "#12402e" },
  number: "INV-1005",
  issuedOn: "2026-10-30",
  dueOn: "2026-11-09",
  billTo: { name: "Ava Hartwell family", contactName: "Morgan Hartwell", email: "morgan@example.com" },
  lines: [{ description: "Senior application package", detail: "Installment 2 of 3", amountCents: 200000 }],
  subtotalCents: 200000,
  creditAppliedCents: 0,
  alreadyPaidCents: 50000,
  amountDueCents: 150000,
  status: "overdue",
  payUrl: "https://api.example.com/pay/tok",
  plan: "Payment 2 of 3 for Senior application package ($6,000 over 6 months).",
  footnote: "Sent by Blair Billing through Meridies.",
  ...over,
});

// ---- Amounts: handed in, never recomputed ----------------------------------------------

test("the email and pay page show exactly the amounts they were given", () => {
  const d = doc({ creditAppliedCents: 12345, alreadyPaidCents: 50000, amountDueCents: 137655 });
  const { html, text } = renderInvoiceEmail(d);
  const page = renderInvoicePageBody(d);
  for (const out of [html, page, text]) {
    assert.ok(out.includes("$2,000"), "subtotal");
    assert.ok(out.includes(`−${formatUsd(12345)}`), "credit applied");
    assert.ok(out.includes("−$500"), "already paid");
    assert.ok(out.includes(formatUsd(137655)), "amount due");
  }
  assert.match(text, /Credit applied: −\$123\.45/);
  assert.match(text, /Amount due: \$1,376\.55/);
});

test("credit and already-paid rows appear only when there is something to show", () => {
  const { html, text } = renderInvoiceEmail(doc({ creditAppliedCents: 0, alreadyPaidCents: 0, amountDueCents: 200000 }));
  assert.doesNotMatch(html, /Credit applied|Already paid/);
  assert.doesNotMatch(text, /Credit applied|Already paid/);
});

test("a saved invoice's figures come from deriveAccount and invoiceOwed unchanged", () => {
  const pkg = { contact_id: "c1", package_name: "Senior package", total_cents: 600000, installments: 3 };
  const inv = (id: string, issued: string, due: string, amount: number) => ({
    id,
    number: id.toUpperCase(),
    label: id,
    amount_cents: amount,
    issued_on: issued,
    due_on: due,
    created_at: `${issued}T00:00:00Z`,
  });
  const account = deriveAccount(
    pkg,
    [inv("inv-1", "2026-09-01", "2026-09-10", 200000), inv("inv-2", "2026-10-30", "2026-11-09", 200000)],
    [{ id: "p1", amount_cents: 250000, received_on: "2026-09-05", method: "ach", created_at: "2026-09-05T00:00:00Z" }],
    "2026-11-10"
  );
  const { state, owedCents, invoice } = invoiceOwed(account, "inv-2");
  assert.ok(invoice);
  assert.equal(state, "overdue");
  const d = doc({
    subtotalCents: invoice.amountCents,
    creditAppliedCents: invoice.creditAppliedCents,
    alreadyPaidCents: invoice.paidCents,
    amountDueCents: owedCents,
    status: invoiceStatus(invoice.state),
  });
  assert.equal(d.alreadyPaidCents, 50000);
  assert.equal(d.amountDueCents, 150000);
  assert.match(renderInvoiceEmail(d).text, /Amount due: \$1,500\n/);
});

test("a draft takes planInvoice's split as it is", () => {
  const account = deriveAccount(
    { contact_id: "c1", package_name: "Essay package", total_cents: 100000, installments: 1 },
    [],
    [{ id: "p", amount_cents: 30000, received_on: "2026-10-01", method: "check", created_at: "2026-10-01T00:00:00Z" }],
    "2026-11-10"
  );
  const plan = planInvoice(account, 100000);
  assert.ok(plan.ok);
  const { text } = renderInvoiceEmail(
    doc({
      number: null,
      status: "due",
      subtotalCents: plan.grossCents,
      creditAppliedCents: plan.creditAppliedCents,
      alreadyPaidCents: plan.alreadyPaidCents,
      amountDueCents: plan.amountDueCents,
    })
  );
  assert.match(text, /Already paid: −\$300/);
  assert.match(text, /Amount due: \$700/);
  assert.match(text, /^Invoice · Due$/m);
});

// ---- Statuses ------------------------------------------------------------------------

test("the status pill reads Paid, Due, Overdue or Void, from the API's states", () => {
  assert.equal(invoiceStatus("open"), "due");
  assert.equal(invoiceStatus("overdue"), "overdue");
  assert.equal(invoiceStatus("paid"), "paid");
  assert.equal(invoiceStatus("void"), "void");
  for (const [status, label] of [["paid", "Paid"], ["due", "Due"], ["overdue", "Overdue"], ["void", "Void"]] as const) {
    const d = doc({ status, amountDueCents: status === "paid" || status === "void" ? 0 : 150000 });
    assert.ok(renderInvoiceEmail(d).html.includes(`>${label}</td>`), `email pill ${label}`);
    assert.ok(renderInvoicePageBody(d).includes(`class="pill p-${status}">${label}<`), `page pill ${label}`);
    assert.match(renderInvoiceEmail(d).text, new RegExp(`· ${label}$`, "m"));
  }
});

test("Pay by card shows only with a link, while something is owed on a live invoice", () => {
  assert.equal(showsPayButton(doc()), true);
  assert.equal(showsPayButton(doc({ payUrl: null })), false);
  assert.equal(showsPayButton(doc({ status: "paid", amountDueCents: 0 })), false);
  assert.equal(showsPayButton(doc({ status: "void", amountDueCents: 0 })), false);
  assert.equal(showsPayButton(doc({ amountDueCents: 0 })), false);
  const { html, text } = renderInvoiceEmail(doc());
  assert.match(html, /href="https:\/\/api\.example\.com\/pay\/tok"[^>]*>Pay \$1,500 by card</);
  assert.match(text, /Pay \$1,500 by card:\nhttps:\/\/api\.example\.com\/pay\/tok/);
  assert.doesNotMatch(renderInvoiceEmail(doc({ payUrl: null })).html, /by card/);
  // The pay page's button posts to itself.
  assert.match(renderInvoicePageBody(doc({ payUrl: "" })), /<form method="post"><button type="submit">Pay \$1,500 by card/);
});

test("void and paid say so under the total", () => {
  assert.match(renderInvoiceEmail(doc({ status: "void", amountDueCents: 0 })).text, /This invoice was cancelled\. There's nothing to pay\./);
  assert.match(renderInvoicePageBody(doc({ status: "paid", amountDueCents: 0 })), /Paid in full\. Thank you\./);
  assert.match(
    renderInvoiceEmail(doc({ number: null, status: "paid", creditAppliedCents: 200000, alreadyPaidCents: 0, amountDueCents: 0 })).text,
    /Your credit covers this invoice in full/
  );
});

// ---- Escaping --------------------------------------------------------------------------

test("family, practice, package and label text is escaped in the HTML and kept as typed in the text part", () => {
  const evil = `<img src=x onerror=alert(1)> "Q" & co`;
  const d = doc({
    practice: { name: `Ryan & Ko <b>Admissions</b>`, logoUrl: `https://cdn.example.com/l.png" onload="x`, accentColor: null },
    billTo: { name: familyLabel(evil), contactName: evil, email: `a"b@example.com` },
    lines: [{ description: `<script>pkg</script>`, detail: `</td><td>label`, amountCents: 100 }],
  });
  const { html, text } = renderInvoiceEmail(d);
  const page = renderInvoicePageBody(d);
  for (const out of [html, page]) {
    assert.doesNotMatch(out, /<img src=x|<script>|<b>Admissions|<\/td><td>label|" onload="/);
    assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt; &quot;Q&quot; &amp; co"));
    assert.ok(out.includes("Ryan &amp; Ko &lt;b&gt;Admissions&lt;/b&gt;"));
    assert.ok(out.includes("&lt;script&gt;pkg&lt;/script&gt;"));
    // The logo address is attribute-safe too.
    assert.ok(out.includes('src="https://cdn.example.com/l.png%22%20onload=%22x"'));
  }
  assert.ok(text.includes(evil));
  assert.ok(text.startsWith("Ryan & Ko <b>Admissions</b>\n"));
  assert.ok(renderPayPage(`Invoice <x>`, "").includes("<title>Invoice &lt;x&gt;</title>"));
});

test("an apostrophe in a name reads as typed", () => {
  const html = renderInvoiceEmail(doc({ billTo: { name: "O'Brien family", contactName: null, email: null } })).html;
  assert.ok(html.includes("O'Brien family"));
});

// ---- Branding --------------------------------------------------------------------------

test("no logo: the practice name in the brand serif; a logo: the image, named", () => {
  const plain = renderInvoiceEmail(doc()).html;
  assert.match(plain, /font-family:Newsreader,Georgia[^"]*">Northfield Admissions<\/span>/);
  const withLogo = renderInvoiceEmail(doc({ practice: { name: "Northfield", logoUrl: "https://x.supabase.co/l.png", accentColor: null } })).html;
  assert.match(withLogo, /<img src="https:\/\/x\.supabase\.co\/l\.png" alt="Northfield"/);
});

test("only https (or a loopback http) logo is loaded", () => {
  assert.equal(safeImageUrl("javascript:alert(1)"), null);
  assert.equal(safeImageUrl("data:image/png;base64,AAAA"), null);
  assert.equal(safeImageUrl("http://evil.example.com/l.png"), null);
  assert.equal(safeImageUrl("https://u:p@cdn.example.com/l.png"), null);
  assert.equal(safeImageUrl("http://127.0.0.1:55321/storage/v1/object/public/branding/a/logo.png"), "http://127.0.0.1:55321/storage/v1/object/public/branding/a/logo.png");
  assert.equal(safeImageUrl("https://cdn.example.com/l.png"), "https://cdn.example.com/l.png");
});

test("the accent is darkened until white text on it reads at 4.5:1; none is the app's green", () => {
  assert.equal(readableAccent(null), "#12402e");
  assert.equal(readableAccent("not a colour"), "#12402e");
  assert.equal(readableAccent("#12402E"), "#12402e");
  const yellow = readableAccent("#ffd84d");
  assert.notEqual(yellow, "#ffd84d");
  assert.ok(contrastOnWhite(yellow) >= 4.5);
  assert.ok(renderInvoiceEmail(doc({ practice: { name: "P", logoUrl: null, accentColor: "#ffd84d" } })).html.includes(`bgcolor="${yellow}"`));
});

test("the email is table-based, light-only and has no <style> or script", () => {
  const { html } = renderInvoiceEmail(doc());
  assert.match(html, /<meta name="color-scheme" content="light only">/);
  assert.doesNotMatch(html, /<style|<script|display:flex|display:grid/);
  assert.match(html, /role="presentation"/);
});

test("the pay page lets in the logo's own origin, and nothing else", () => {
  assert.doesNotMatch(payCsp(null), /img-src/);
  assert.match(payCsp("https://x.supabase.co"), /img-src https:\/\/x\.supabase\.co;/);
  assert.match(payCsp(null), /default-src 'none'/);
});

// ---- Small formatters ------------------------------------------------------------------

test("bill-to is the family, the parent and the address on the card", () => {
  assert.equal(familyLabel("Ava Hartwell"), "Ava Hartwell family");
  assert.equal(familyLabel("Rivera Family"), "Rivera Family");
  assert.equal(familyLabel("  "), "Family");
  assert.deepEqual(billToOf({ student_name: "Ava", parent_name: "Morgan", parent_email: "", student_email: "ava@x.com" }), {
    name: "Ava family",
    contactName: "Morgan",
    email: "ava@x.com",
  });
  assert.equal(longDate("2026-11-09"), "Nov 9, 2026");
});
