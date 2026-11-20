/**
 * Plan billing: the one price formula. Used by the checkout, the "this raises your bill" prompt and the tests, so
 * the screen and Stripe can never disagree.
 *
 * Graduated, per month: students 1 to 6 are a flat $99 together, then $13 each for students 7 to 25, $10 each for
 * 26 to 50, and $7 each from 51. Annual is ten months' price. This mirrors the Stripe prices with lookup keys
 * `meridies_monthly` and `meridies_annual`; Stripe is the source of truth for what is charged, this is for display
 * and for checks. NEVER send these numbers to a founding or custom account's screen.
 */

export type BillingInterval = "month" | "year";

/** Amounts are whole US dollars. */
export const BASE_PRICE = 99;
export const BASE_STUDENTS = 6;
const TIERS: { upTo: number; each: number }[] = [
  { upTo: 25, each: 13 },
  { upTo: 50, each: 10 },
  { upTo: Infinity, each: 7 },
];

/** What a plan bills for: never fewer than one student. */
export function billableQuantity(activeStudents: number): number {
  return Math.max(1, Math.floor(Number.isFinite(activeStudents) ? activeStudents : 0));
}

/** Monthly price in dollars for this many students. */
export function monthlyPrice(activeStudents: number): number {
  const q = billableQuantity(activeStudents);
  let total = BASE_PRICE;
  let from = BASE_STUDENTS;
  for (const tier of TIERS) {
    if (q <= from) break;
    const upTo = Math.min(q, tier.upTo);
    total += (upTo - from) * tier.each;
    from = tier.upTo;
  }
  return total;
}

/** Price for one billing period: a year is ten months. */
export function periodPrice(activeStudents: number, interval: BillingInterval): number {
  const monthly = monthlyPrice(activeStudents);
  return interval === "year" ? monthly * 10 : monthly;
}

export type PriceChange = { from: number; to: number; direction: "up" | "down" | "same" };

/** The before and after of adding or removing students, for the confirm prompt. */
export function priceChange(fromStudents: number, toStudents: number, interval: BillingInterval): PriceChange {
  const from = periodPrice(fromStudents, interval);
  const to = periodPrice(toStudents, interval);
  return { from, to, direction: to > from ? "up" : to < from ? "down" : "same" };
}
