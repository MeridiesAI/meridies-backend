import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { checkLines, composerFields, composerProblem, hasComposerFields, readStoredLines, toStoredLines } from "../../src/lib/invoiceComposer.js";
import { acceptedMethods, BUILTIN_METHODS, builtinRows, isCustomKey, newCustomKey, recordedMethod, takesCardMethod, toMethodDTO } from "../../src/lib/paymentMethods.js";
import { PAYMENT_METHODS } from "../../src/lib/payments.js";
import { DEFAULT_STYLE, FONT_KEYS, FONTS, styleFromSnapshot, snapshotOf, toStyle, styleFields } from "../../src/lib/invoiceStyle.js";
import { esc, renderInvoiceEmailHtml, type InvoiceDocument } from "../../src/lib/invoiceDocument.js";
import { sourceFromInvoiceRow } from "../../src/lib/invoiceSettings.js";
import { usableOffsets } from "../../src/lib/invoiceSchedule.js";
import { installmentPlan, templateProblem, templateToPackage, toTemplateDTO } from "../../src/lib/packageTemplates.js";

// ---- Line items ---------------------------------------------------------------------------------

test("lines must add up to the invoice amount to the cent", () => {
  assert.deepEqual(checkLines([{ amountCents: 100_000 }, { amountCents: 50_050 }], 150_050), { ok: true });
  const bad = checkLines([{ amountCents: 100_000 }, { amountCents: 50_050 }], 150_000);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.code, "lines_sum_mismatch");
});

test("composerProblem: a mismatch, bad reminders, and a text that isn't sent are refused; nothing else is", () => {
  const lines = [{ description: "A", amountCents: 100 }];
  assert.equal(composerProblem({ amountCents: 100 }), null);
  assert.equal(composerProblem({ amountCents: 100, lines }), null);
  assert.equal(composerProblem({ amountCents: 101, lines })?.code, "lines_sum_mismatch");
  assert.equal(composerProblem({ amountCents: 100, reminders: [99] })?.code, "bad_reminders");
  assert.equal(composerProblem({ amountCents: 100, channel: "text", send: false })?.code, "text_needs_send");
});

test("every composer field is optional, so an old payload is untouched", () => {
  const body = z.object(composerFields).strict();
  assert.deepEqual(body.parse({}), {});
  assert.throws(() => body.parse({ lines: [] }));
  assert.throws(() => body.parse({ lines: [{ description: "x", amountCents: -1 }] }));
  assert.throws(() => body.parse({ cc: ["not an email"] }));
  assert.throws(() => body.parse({ channel: "fax" }));
  assert.throws(() => body.parse({ surprise: 1 }));
  assert.deepEqual(body.parse({ cc: [" A@B.com "] }).cc, ["a@b.com"]);
});

test("stored lines always carry a detail", () => {
  assert.deepEqual(toStoredLines([{ description: "A", amountCents: 1 }, { description: "B", detail: " x ", amountCents: 2 }]), [
    { description: "A", detail: null, amountCents: 1 },
    { description: "B", detail: "x", amountCents: 2 },
  ]);
});

// ---- Payment methods ----------------------------------------------------------------------------------

test("paypal is a payment method everywhere the enum is", () => {
  assert.ok(PAYMENT_METHODS.includes("paypal"));
  for (const m of BUILTIN_METHODS) assert.ok((PAYMENT_METHODS as string[]).includes(m.key), m.key);
});

test("built-ins are seeded once per practice scope; customs are recorded as other", () => {
  const rows = builtinRows({ firm_id: null, counselor_id: "c", practice_id: "c" });
  assert.deepEqual(rows.map((r) => r.key), ["card", "ach", "zelle", "paypal", "check"]);
  assert.ok(rows.every((r) => r.builtin && r.practice_id === "c"));
  const k = newCustomKey();
  assert.match(k, /^custom-[0-9a-f]{8}$/);
  assert.ok(isCustomKey(k) && !isCustomKey("zelle"));
  assert.equal(recordedMethod("zelle"), "zelle");
  assert.equal(recordedMethod(k), "other");
});

test("an invoice lists its accepted, still-enabled methods in the practice's order; none (old invoice) lists none", () => {
  const all = [
    toMethodDTO({ key: "zelle", label: "Zelle", instructions: "pay@x.com", enabled: true, builtin: true, sort: 2 }),
    toMethodDTO({ key: "card", label: "Card", enabled: true, builtin: true, sort: 0 }),
    toMethodDTO({ key: "check", label: "Check", enabled: false, builtin: true, sort: 4 }),
  ];
  assert.deepEqual(acceptedMethods(["zelle", "card", "check", "gone"], all).map((m) => m.key), ["card", "zelle"]);
  assert.deepEqual(acceptedMethods(null, all), []);
  assert.equal(takesCardMethod(null), true);
  assert.equal(takesCardMethod(["zelle"]), false);
  assert.equal(takesCardMethod(["card", "zelle"]), true);
});

// ---- Style ------------------------------------------------------------------------------------------------

test("six email-safe fonts, each a stack that ends in a generic family", () => {
  assert.equal(FONT_KEYS.length, 6);
  for (const k of FONT_KEYS) assert.match(FONTS[k].stack, /(serif|sans-serif|monospace)$/);
});

test("a stored style row reads with defaults; nonsense falls back", () => {
  assert.deepEqual(toStyle(null), DEFAULT_STYLE);
  const s = toStyle({ accent_color: "#112233", font_key: "mono", header_align: "center", corner: "pill", button_label: " Pay now ", footer_text: "Thanks", show_logo: false });
  assert.deepEqual(s, { accentColor: "#112233", fontKey: "mono", headerAlign: "center", corner: "pill", buttonLabel: "Pay now", footerText: "Thanks", showLogo: false });
  assert.equal(toStyle({ font_key: "comic-sans", corner: "blob", header_align: "right" }).fontKey, "serif");
});

test("a snapshot round-trips, and a forged one is dropped", () => {
  const s = { ...DEFAULT_STYLE, accentColor: "#abcdef", fontKey: "sans" as const };
  assert.deepEqual(styleFromSnapshot(snapshotOf(s)), s);
  assert.equal(styleFromSnapshot({ ...s, accentColor: "red; background:url(x)" }), null);
  assert.equal(styleFromSnapshot({ ...s, extra: 1 }), null);
  assert.equal(styleFromSnapshot(null), null);
  assert.throws(() => z.object(styleFields).parse({ ...s, accentColor: "#12" }));
});

// ---- Package templates --------------------------------------------------------------------------------------

const sum = (p: { amountCents: number }[]) => p.reduce((n, x) => n + x.amountCents, 0);

test("a deposit then even installments, adding up to the total with odd cents spread", () => {
  const plan = installmentPlan({ totalCents: 600_000, depositCents: 100_000, installments: 3 });
  assert.deepEqual(plan, [
    { label: "Deposit", amountCents: 100_000 },
    { label: "Installment 2 of 3", amountCents: 250_000 },
    { label: "Installment 3 of 3", amountCents: 250_000 },
  ]);
  const odd = installmentPlan({ totalCents: 100_001, depositCents: 0, installments: 3 });
  assert.deepEqual(odd.map((p) => p.amountCents), [33_334, 33_334, 33_333]);
  assert.equal(sum(odd), 100_001);
  assert.equal(odd[0]!.label, "Installment 1 of 3");
});

test("one payment is the whole package", () => {
  assert.deepEqual(installmentPlan({ totalCents: 50_000, depositCents: 0, installments: 1 }), [{ label: "Payment in full", amountCents: 50_000 }]);
});

test("every plan adds up exactly, for many shapes", () => {
  for (const total of [0, 1, 99, 100_000, 333_333, 1_000_001])
    for (const n of [1, 2, 3, 7, 12])
      for (const dep of [0, Math.floor(total / 4)]) {
        if (templateProblem({ totalCents: total, depositCents: dep, installments: n })) continue;
        const plan = installmentPlan({ totalCents: total, depositCents: dep, installments: n });
        assert.equal(plan.length, n);
        assert.equal(sum(plan), total, `${total}/${dep}/${n}`);
        assert.ok(plan.every((p) => p.amountCents >= 0));
      }
});

test("a deposit can't exceed the total or swallow a multi-part package", () => {
  assert.ok(templateProblem({ totalCents: 100, depositCents: 101, installments: 1 }));
  assert.ok(templateProblem({ totalCents: 100, depositCents: 100, installments: 3 }));
  assert.equal(templateProblem({ totalCents: 100, depositCents: 100, installments: 1 }), null);
});

test("a template copies onto a family as name, total, installments and length", () => {
  assert.deepEqual(templateToPackage({ name: "Senior year", totalCents: 600_000, installments: 3, durationMonths: 12 }), {
    packageName: "Senior year",
    totalCents: 600_000,
    installments: 3,
    durationMonths: 12,
  });
});

test("a template DTO carries its plan and a summary", () => {
  const t = toTemplateDTO({ id: "i", name: "Senior year", years_tag: "Grade 12", total_cents: 600_000, deposit_cents: 100_000, installments: 3, duration_months: null, inclusions: ["Essays"], archived_at: null, created_at: "2026-11-13T00:00:00Z" });
  assert.equal(t.plan.length, 3);
  assert.equal(t.summary, "$6,000 in 3 payments, $1,000 deposit first");
  assert.deepEqual(t.inclusions, ["Essays"]);
});

// ---- Stored rows are not trusted by the readers that run on the service role ----------------------------

test("stored lines read back only when valid and adding up to the invoice amount", () => {
  assert.deepEqual(readStoredLines([{ description: "A", detail: null, amountCents: 100 }, { description: "B", detail: "x", amountCents: 50 }], 150), [
    { description: "A", detail: null, amountCents: 100 },
    { description: "B", detail: "x", amountCents: 50 },
  ]);
  assert.equal(readStoredLines([{ description: 5, amountCents: 150 }], 150), null, "a non-string description");
  assert.equal(readStoredLines([{ description: "A", amountCents: 100 }], 150), null, "a mismatched sum");
  assert.equal(readStoredLines([{ description: "A", amountCents: 1.5 }], 1.5), null);
  assert.equal(readStoredLines([{ description: "A", amountCents: -1 }], -1), null);
  assert.equal(readStoredLines([], 0), null);
  assert.equal(readStoredLines("nope", 1), null);
  assert.equal(readStoredLines({ description: "A" }, 1), null);
});

test("an invoice row with damaged composer columns reads as a plain invoice, never throws", () => {
  const src = sourceFromInvoiceRow({ amount_cents: 150, line_items: [{ description: 5 }], accepted_methods: ["zelle", 7, "<b>"], cc: ["a@b.co", "not an email", 3], note: 4, reminders: [1] });
  assert.equal(src.lines, null);
  assert.deepEqual(src.acceptedKeys, ["zelle"]);
  assert.deepEqual(src.cc, ["a@b.co"]);
  assert.equal(src.note, null);
  assert.equal(sourceFromInvoiceRow({ amount_cents: 1 }).acceptedKeys, null);
});

test("reminder offsets from a row: whole days within 30, unique, at most five", () => {
  assert.deepEqual(usableOffsets([-3, 0, 3, 3]), [-3, 0, 3]);
  assert.deepEqual(usableOffsets([31, -31, 99, 1.5, "2", null, 7]), [7]);
  assert.deepEqual(usableOffsets("nope"), []);
  assert.equal(usableOffsets([1, 2, 3, 4, 5, 6, 7]).length, 5);
});

test("esc takes any value without throwing", () => {
  assert.equal(esc(5), "5");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc({ toString: () => "<x>" }), "&lt;x&gt;");
  const d = { practice: { name: "P", logoUrl: null, accentColor: null }, number: "1", issuedOn: "2026-11-01", dueOn: "2026-11-02", billTo: { name: "N", contactName: null, email: null },
    lines: [{ description: 5 as unknown as string, detail: null, amountCents: 100 }], subtotalCents: 100, creditAppliedCents: 0, alreadyPaidCents: 0, amountDueCents: 100, status: "due", payUrl: null, plan: null, footnote: null } as InvoiceDocument;
  assert.ok(renderInvoiceEmailHtml(d).includes(">5<"));
});

test("hasComposerFields is true for any composer field, false for an old payload", () => {
  assert.equal(hasComposerFields({}), false);
  assert.equal(hasComposerFields({ reminders: [0] }), true);
  assert.equal(hasComposerFields({ note: "" }), true);
});
