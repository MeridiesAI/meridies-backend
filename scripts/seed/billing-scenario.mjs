// The Payment Tracker scenario the app's e2e spec checks, with every figure
// worked out by hand. Dates are offsets from "today" (the counselor's time
// zone, which the seed leaves at the default), so the scenario reads the same
// whatever day it runs.
//
// src/lib/payments.ts deriveAccount: live invoices are settled oldest first
// (issued_on, then created_at) out of the sum of every payment; an invoice not
// fully paid is overdue once its due date is before today, else open. Balance is
// billed minus paid; totals() counts only a positive balance as outstanding.
//
// Family A (Rivera): package $6,000 in 3 installments.
//   #1 $2,000 issued 40 days ago, due 30 days ago
//   #2 $2,000 issued 5 days ago, due in 10 days
//   one payment of $2,500, 20 days ago
//   Pool 2,500: #1 takes 2,000 (paid), #2 takes 500 (open: due in the future).
//   billed 4,000, paid 2,500, balance 1,500, overdue 0, status "due".
//   After voiding #2: billed 2,000, paid 2,500, balance -500, outstanding 0, status "paid-up".
//
// Family B (Okafor): package $1,000 in 1 installment.
//   #1 $1,000 issued 20 days ago, due 10 days ago
//   one payment of $400, 15 days ago
//   #1 takes 400 and is past due: overdue 600, balance 600, status "overdue".
//
// Totals strip (Contracted, Collected, Outstanding, Overdue):
//   contracted 6,000 + 1,000 = 7,000; collected 2,500 + 400 = 2,900;
//   outstanding 1,500 + 600 = 2,100; overdue 0 + 600 = 600.

export const BILLING_FAMILIES = [
  {
    key: "A",
    studentName: "Rivera Family",
    parentName: "Dana Rivera",
    package: { name: "Full application package", totalCents: 600_000, installments: 3 },
    invoices: [
      { label: "Deposit", amountCents: 200_000, issuedDaysAgo: 40, dueInDays: -30 },
      { label: "Installment 2 of 3", amountCents: 200_000, issuedDaysAgo: 5, dueInDays: 10 },
    ],
    payments: [{ amountCents: 250_000, daysAgo: 20, method: "check" }],
    expected: {
      invoiceStates: ["paid", "open"],
      invoicePaidCents: [200_000, 50_000],
      billedCents: 400_000,
      paidCents: 250_000,
      balanceCents: 150_000,
      overdueCents: 0,
      status: "due",
      afterVoidingSecond: { billedCents: 200_000, balanceCents: -50_000, overdueCents: 0, status: "paid-up" },
    },
  },
  {
    key: "B",
    studentName: "Okafor Family",
    parentName: "Chidi Okafor",
    package: { name: "Essay package", totalCents: 100_000, installments: 1 },
    invoices: [{ label: "Deposit", amountCents: 100_000, issuedDaysAgo: 20, dueInDays: -10 }],
    payments: [{ amountCents: 40_000, daysAgo: 15, method: "zelle" }],
    expected: {
      invoiceStates: ["overdue"],
      invoicePaidCents: [40_000],
      billedCents: 100_000,
      paidCents: 40_000,
      balanceCents: 60_000,
      overdueCents: 60_000,
      status: "overdue",
    },
  },
];

export const BILLING_TOTALS = {
  contractedCents: 700_000,
  collectedCents: 290_000,
  outstandingCents: 210_000,
  overdueCents: 60_000,
};

/** YYYY-MM-DD `days` from `today` (also YYYY-MM-DD), in UTC arithmetic so no zone shifts the date. */
export function shiftDate(today, days) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
