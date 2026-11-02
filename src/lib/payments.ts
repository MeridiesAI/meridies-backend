/**
 * Payment Tracker arithmetic (demo lib/payments.ts, v8).
 *
 * Nothing here is stored. A family's balances and statuses are read from its
 * package, invoices, payments and credit refunds every time: payments settle
 * the oldest invoice first, and an invoice past its due date with money still
 * owed is overdue. All amounts are integer cents.
 *
 * Credits (20261029000001): a payment above what is left on the package is
 * recorded only when the counselor says so, and the extra is held on the
 * payment as `credit_cents`. A held credit comes off the next invoice as its
 * `credit_applied_cents` (a voided invoice gives it back), and "Mark refunded"
 * clears what is left with a `pipeline_credit_refunds` row. Nothing is ever
 * refunded automatically. An overpayment recorded before credits existed
 * shows as credit too, so it never reads as more to bill.
 */

type Row = Record<string, unknown>;

export type PaymentMethod = "card" | "ach" | "check" | "zelle" | "other";
export const PAYMENT_METHODS: PaymentMethod[] = ["card", "ach", "check", "zelle", "other"];

export type InvoiceState = "paid" | "open" | "overdue" | "void";
export type AccountStatus = "not-invoiced" | "paid-up" | "due" | "overdue";

export type InvoiceDTO = {
  id: string;
  number: string;
  label: string;
  amountCents: number;
  issuedOn: string;
  dueOn: string;
  sentTo: string | null;
  sentAt: string | null;
  voidedAt: string | null;
  /** Credit taken off this invoice; it asks the family for amount minus this. */
  creditAppliedCents: number;
  /** Derived: how much of the amount due the payments have settled. */
  paidCents: number;
  state: InvoiceState;
};

export type PaymentDTO = {
  id: string;
  amountCents: number;
  receivedOn: string;
  method: PaymentMethod;
  note: string | null;
  /** The part of this payment held as credit (above what the package had left). */
  creditCents: number;
  createdAt: string;
};

export type RefundDTO = { id: string; amountCents: number; refundedOn: string; note: string | null; createdAt: string };

export type AccountDTO = {
  contactId: string;
  packageName: string;
  totalCents: number;
  installments: number;
  /** How long the package runs, in months; null when nobody said. */
  durationMonths: number | null;
  invoices: InvoiceDTO[];
  payments: PaymentDTO[];
  refunds: RefundDTO[];
  billedCents: number;
  /** Paid toward the package: payments minus what they hold as credit, plus credit applied to invoices. */
  paidCents: number;
  /** Money received minus credit refunded. */
  collectedCents: number;
  /** Package total minus paid, never below zero. */
  remainingCents: number;
  /** Held credit not yet applied or refunded. */
  creditCents: number;
  /** What a new invoice may bill: the package total not yet on a live invoice (0 once paid in full). */
  billableCents: number;
  /** Money received that no invoice has used yet (paid ahead); it comes off the next invoice. */
  unappliedCents: number;
  canInvoice: boolean;
  invoiceBlockedReason: string | null;
  /** Billed minus paid. Negative when a family has paid ahead. */
  balanceCents: number;
  overdueCents: number;
  status: AccountStatus;
  /** The next unpaid invoice by due date. */
  nextDue: { invoiceId: string; dueOn: string; owedCents: number } | null;
  /** What is left of the package over what is left of the plan. */
  suggestedInstallmentCents: number;
  /** Label the next invoice would carry: "Deposit", "Installment 2 of 3". */
  suggestedLabel: string;
};

const num = (v: unknown) => Number(v ?? 0);

export function toInvoiceRow(r: Row) {
  return {
    id: String(r.id),
    number: String(r.number),
    label: String(r.label),
    amountCents: num(r.amount_cents),
    creditAppliedCents: num(r.credit_applied_cents),
    issuedOn: String(r.issued_on),
    dueOn: String(r.due_on),
    sentTo: (r.sent_to as string | null) ?? null,
    sentAt: (r.sent_at as string | null) ?? null,
    voidedAt: (r.voided_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export function toPaymentDTO(r: Row): PaymentDTO {
  return {
    id: String(r.id),
    amountCents: num(r.amount_cents),
    receivedOn: String(r.received_on),
    method: String(r.method) as PaymentMethod,
    note: (r.note as string | null) ?? null,
    creditCents: num(r.credit_cents),
    createdAt: String(r.created_at),
  };
}

export function toRefundDTO(r: Row): RefundDTO {
  return {
    id: String(r.id),
    amountCents: num(r.amount_cents),
    refundedOn: String(r.refunded_on),
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

/** Settle the oldest invoice first, and read each one's state from that. */
export function deriveAccount(pkg: Row, invoiceRows: Row[], paymentRows: Row[], today: string, refundRows: Row[] = []): AccountDTO {
  const invoices = invoiceRows.map(toInvoiceRow);
  const payments = paymentRows.map(toPaymentDTO).sort((a, b) => a.receivedOn.localeCompare(b.receivedOn));
  const refunds = refundRows.map(toRefundDTO).sort((a, b) => b.refundedOn.localeCompare(a.refundedOn));

  const live = invoices
    .filter((i) => !i.voidedAt)
    .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.createdAt.localeCompare(b.createdAt));
  const receivedCents = payments.reduce((n, p) => n + p.amountCents, 0);
  const heldCents = payments.reduce((n, p) => n + p.creditCents, 0);
  const appliedCents = live.reduce((n, i) => n + i.creditAppliedCents, 0);
  const refundedCents = refunds.reduce((n, r) => n + r.amountCents, 0);
  // Cash toward invoices is what payments brought in beyond what they hold as credit.
  let pool = receivedCents - heldCents;
  const settled = new Map<string, { paid: number; state: InvoiceState }>();
  for (const inv of live) {
    const due = inv.amountCents - inv.creditAppliedCents;
    const paid = Math.min(due, pool);
    pool -= paid;
    const state: InvoiceState = paid >= due ? "paid" : inv.dueOn < today ? "overdue" : "open";
    settled.set(inv.id, { paid, state });
  }

  const out: InvoiceDTO[] = invoices
    .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.createdAt.localeCompare(b.createdAt))
    .map(({ createdAt: _c, ...inv }) => {
      const s = settled.get(inv.id);
      return { ...inv, paidCents: s?.paid ?? 0, state: s?.state ?? "void" };
    });

  const owed = (i: InvoiceDTO) => i.amountCents - i.creditAppliedCents - i.paidCents;
  const billedCents = live.reduce((n, i) => n + i.amountCents, 0);
  const overdueCents = out.filter((i) => i.state === "overdue").reduce((n, i) => n + owed(i), 0);
  const openOwedCents = out.filter((i) => i.state === "open" || i.state === "overdue").reduce((n, i) => n + owed(i), 0);
  const next = out
    .filter((i) => i.state === "open" || i.state === "overdue")
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];

  const totalCents = num(pkg.total_cents);
  const installments = Math.max(1, num(pkg.installments));
  const towardPackage = receivedCents - heldCents + appliedCents;
  // An overpayment from before credits existed (credit_cents 0) is credit too.
  const unmarkedExcess = Math.max(0, towardPackage - totalCents);
  const paidCents = towardPackage - unmarkedExcess;
  const remainingCents = Math.max(0, totalCents - paidCents);
  const creditCents = Math.max(0, heldCents - appliedCents - refundedCents + unmarkedExcess);
  // Billable: the part of the package no live invoice bills yet. Money paid
  // ahead and held credit come off the next invoice (planInvoice), so it asks
  // for the package total minus what's paid.
  const billableCents = remainingCents <= 0 ? 0 : Math.max(0, totalCents - billedCents);
  const invoiceBlockedReason =
    remainingCents <= 0
      ? "This package is paid in full. There's nothing left to invoice."
      : billableCents <= 0
        ? "Everything left on this package is already on open invoices."
        : null;
  const status: AccountStatus =
    remainingCents <= 0 && totalCents > 0
      ? "paid-up"
      : live.length === 0
        ? "not-invoiced"
        : overdueCents > 0
          ? "overdue"
          : openOwedCents > 0
            ? "due"
            : "paid-up";
  const plansLeft = Math.max(1, installments - live.length);

  return {
    contactId: String(pkg.contact_id),
    packageName: String(pkg.package_name),
    totalCents,
    installments,
    durationMonths: pkg.duration_months == null ? null : num(pkg.duration_months),
    invoices: out,
    payments: payments.reverse(),
    refunds,
    billedCents,
    paidCents,
    collectedCents: receivedCents - refundedCents,
    remainingCents,
    creditCents,
    billableCents,
    unappliedCents: Math.max(0, pool),
    canInvoice: invoiceBlockedReason === null,
    invoiceBlockedReason,
    balanceCents: billedCents - paidCents,
    overdueCents,
    status,
    nextDue: next ? { invoiceId: next.id, dueOn: next.dueOn, owedCents: owed(next) } : null,
    suggestedInstallmentCents: billableCents <= 0 ? 0 : plansLeft <= 1 ? billableCents : Math.round(billableCents / plansLeft),
    suggestedLabel: live.length === 0 ? "Deposit" : `Installment ${live.length + 1} of ${installments}`,
  };
}

/** How much of a payment would be above what the package has left. */
export function planPayment(a: AccountDTO, amountCents: number): { overpaymentCents: number } {
  return { overpaymentCents: Math.max(0, amountCents - a.remainingCents) };
}

export type InvoicePlan =
  | { ok: true; grossCents: number; creditAppliedCents: number; alreadyPaidCents: number; amountDueCents: number }
  | { ok: false; reason: string; code: "nothing_to_invoice" | "over_billable" | "already_covered"; billableCents: number };

/**
 * An invoice billing `grossCents` of the package. Held credit comes off it
 * first (stored as "Credit applied"), then money already paid ahead
 * ("Already paid", which settles it like any payment). Refused past what's
 * billable, and when payments already cover it with no credit to record.
 */
export function planInvoice(a: AccountDTO, grossCents: number): InvoicePlan {
  if (!a.canInvoice) return { ok: false, code: "nothing_to_invoice", reason: a.invoiceBlockedReason ?? "Nothing to invoice", billableCents: 0 };
  if (grossCents > a.billableCents) {
    return { ok: false, code: "over_billable", reason: `That's more than the ${formatUsd(a.billableCents)} left to bill on this package.`, billableCents: a.billableCents };
  }
  const creditAppliedCents = Math.min(a.creditCents, grossCents);
  const alreadyPaidCents = Math.min(a.unappliedCents, grossCents - creditAppliedCents);
  const amountDueCents = grossCents - creditAppliedCents - alreadyPaidCents;
  if (amountDueCents <= 0 && creditAppliedCents === 0) {
    return { ok: false, code: "already_covered", reason: "Payments already cover this amount. There's nothing to invoice yet.", billableCents: a.billableCents };
  }
  return { ok: true, grossCents, creditAppliedCents, alreadyPaidCents, amountDueCents };
}

export function totals(accounts: AccountDTO[]) {
  return accounts.reduce(
    (t, a) => ({
      contractedCents: t.contractedCents + a.totalCents,
      collectedCents: t.collectedCents + a.collectedCents,
      outstandingCents: t.outstandingCents + Math.max(0, a.balanceCents),
      overdueCents: t.overdueCents + a.overdueCents,
    }),
    { contractedCents: 0, collectedCents: 0, outstandingCents: 0, overdueCents: 0 }
  );
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

/** "6 months", "1 year", "2 years", "18 months". */
export function describeDuration(months: number): string {
  if (months % 12 === 0) {
    const years = months / 12;
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return `${months} month${months === 1 ? "" : "s"}`;
}

/** "Payment 2 of 6 for Senior package ($3,000 over 6 months)"; null for a one-payment package. */
export function planLine(a: Pick<AccountDTO, "packageName" | "totalCents" | "installments" | "durationMonths">, nth: number): string | null {
  if (a.installments <= 1) return null;
  const span = a.durationMonths ? ` over ${describeDuration(a.durationMonths)}` : "";
  return `Payment ${Math.min(nth, a.installments)} of ${a.installments} for ${a.packageName} (${formatUsd(a.totalCents)}${span}).`;
}
