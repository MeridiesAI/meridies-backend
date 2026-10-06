/**
 * Payment Tracker arithmetic (demo lib/payments.ts, v8).
 *
 * Nothing here is stored. A family's balances and statuses are read from its
 * package, invoices and payments every time: payments settle the oldest
 * invoice first, and an invoice past its due date with money still owed is
 * overdue. All amounts are integer cents.
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
  /** Derived: how much of it the payments have settled. */
  paidCents: number;
  state: InvoiceState;
};

export type PaymentDTO = {
  id: string;
  amountCents: number;
  receivedOn: string;
  method: PaymentMethod;
  note: string | null;
  createdAt: string;
};

export type AccountDTO = {
  contactId: string;
  packageName: string;
  totalCents: number;
  installments: number;
  invoices: InvoiceDTO[];
  payments: PaymentDTO[];
  billedCents: number;
  paidCents: number;
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
    createdAt: String(r.created_at),
  };
}

/** Settle the oldest invoice first, and read each one's state from that. */
export function deriveAccount(pkg: Row, invoiceRows: Row[], paymentRows: Row[], today: string): AccountDTO {
  const invoices = invoiceRows.map(toInvoiceRow);
  const payments = paymentRows.map(toPaymentDTO).sort((a, b) => a.receivedOn.localeCompare(b.receivedOn));

  const live = invoices
    .filter((i) => !i.voidedAt)
    .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.createdAt.localeCompare(b.createdAt));
  const paidCents = payments.reduce((n, p) => n + p.amountCents, 0);
  let pool = paidCents;
  const settled = new Map<string, { paid: number; state: InvoiceState }>();
  for (const inv of live) {
    const paid = Math.min(inv.amountCents, pool);
    pool -= paid;
    const state: InvoiceState = paid >= inv.amountCents ? "paid" : inv.dueOn < today ? "overdue" : "open";
    settled.set(inv.id, { paid, state });
  }

  const out: InvoiceDTO[] = invoices
    .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.createdAt.localeCompare(b.createdAt))
    .map(({ createdAt: _c, ...inv }) => {
      const s = settled.get(inv.id);
      return { ...inv, paidCents: s?.paid ?? 0, state: s?.state ?? "void" };
    });

  const billedCents = live.reduce((n, i) => n + i.amountCents, 0);
  const overdueCents = out
    .filter((i) => i.state === "overdue")
    .reduce((n, i) => n + i.amountCents - i.paidCents, 0);
  const next = out
    .filter((i) => i.state === "open" || i.state === "overdue")
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];

  const totalCents = num(pkg.total_cents);
  const installments = Math.max(1, num(pkg.installments));
  const status: AccountStatus =
    live.length === 0 ? "not-invoiced" : overdueCents > 0 ? "overdue" : billedCents - paidCents > 0 ? "due" : "paid-up";
  const left = Math.max(0, totalCents - billedCents);
  const remaining = Math.max(1, installments - live.length);

  return {
    contactId: String(pkg.contact_id),
    packageName: String(pkg.package_name),
    totalCents,
    installments,
    invoices: out,
    payments: payments.reverse(),
    billedCents,
    paidCents,
    balanceCents: billedCents - paidCents,
    overdueCents,
    status,
    nextDue: next ? { invoiceId: next.id, dueOn: next.dueOn, owedCents: next.amountCents - next.paidCents } : null,
    suggestedInstallmentCents: Math.round(left / remaining),
    suggestedLabel: live.length === 0 ? "Deposit" : `Installment ${live.length + 1} of ${installments}`,
  };
}

export function totals(accounts: AccountDTO[]) {
  return accounts.reduce(
    (t, a) => ({
      contractedCents: t.contractedCents + a.totalCents,
      collectedCents: t.collectedCents + a.paidCents,
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
