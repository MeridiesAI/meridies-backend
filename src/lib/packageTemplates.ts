/**
 * The practice's package library (pipeline_package_templates): the shape, and what copying one onto a
 * family means (pure; no I/O). Assigning a template COPIES it into the family's `pipeline_packages` row,
 * so `deriveAccount` is unchanged and the family's package stays editable on its own.
 */

import { z } from "zod";
import { formatUsd } from "./payments.js";

const text = (max: number) => z.string().trim().max(max);
const cents = z.number().int().min(0).max(100_000_000);

export const templateFields = {
  name: text(200).min(1),
  yearsTag: text(40).nullable().optional(),
  totalCents: cents,
  depositCents: cents.optional(),
  installments: z.number().int().min(1).max(60),
  durationMonths: z.number().int().min(1).max(120).nullable().optional(),
  inclusions: z.array(text(200).min(1)).max(20).optional(),
};

type Money = { totalCents: number; depositCents: number; installments: number };

/** Deposit within the total, and not the whole of a package paid in several parts. */
export function templateProblem(t: Money): string | null {
  if (t.depositCents > t.totalCents) return "The deposit can't be more than the package total";
  if (t.installments > 1 && t.depositCents >= t.totalCents && t.totalCents > 0) return "A deposit that covers the whole package leaves nothing for the other payments";
  return null;
}

export type PlannedPayment = { label: string; amountCents: number };

/**
 * The payments a package is paid in: the deposit first (when there is one), then the rest split evenly,
 * any odd cents going one each to the earliest of them, so the amounts add up to the total exactly.
 * Labels follow the tracker's ("Deposit", "Installment 2 of 3"); with no deposit the first is
 * "Installment 1 of N".
 */
export function installmentPlan(t: Money): PlannedPayment[] {
  const n = Math.max(1, t.installments);
  if (n === 1) return [{ label: "Payment in full", amountCents: t.totalCents }];
  const hasDeposit = t.depositCents > 0;
  const first = hasDeposit ? t.depositCents : 0;
  const evenCount = hasDeposit ? n - 1 : n;
  const rest = t.totalCents - first;
  const base = Math.floor(rest / evenCount);
  const extra = rest - base * evenCount;
  const out: PlannedPayment[] = [];
  if (hasDeposit) out.push({ label: "Deposit", amountCents: first });
  for (let i = 0; i < evenCount; i++) {
    const nth = (hasDeposit ? 1 : 0) + i + 1;
    out.push({ label: `Installment ${nth} of ${n}`, amountCents: base + (i < extra ? 1 : 0) });
  }
  return out;
}

/** The columns a family's package takes from a template. */
export function templateToPackage(t: { name: string; totalCents: number; installments: number; durationMonths: number | null }) {
  return { packageName: t.name, totalCents: t.totalCents, installments: t.installments, durationMonths: t.durationMonths };
}

export type TemplateDTO = {
  id: string;
  name: string;
  yearsTag: string | null;
  totalCents: number;
  depositCents: number;
  installments: number;
  durationMonths: number | null;
  inclusions: string[];
  archivedAt: string | null;
  createdAt: string;
  /** What the family would be asked for, payment by payment. */
  plan: PlannedPayment[];
  /** "$1,000 deposit, then 2 of $1,000" for a card's subtitle. */
  summary: string;
};

type Row = Record<string, unknown>;
export function toTemplateDTO(r: Row): TemplateDTO {
  const t = {
    totalCents: Number(r.total_cents ?? 0),
    depositCents: Number(r.deposit_cents ?? 0),
    installments: Math.max(1, Number(r.installments ?? 1)),
  };
  const plan = installmentPlan(t);
  const summary =
    plan.length === 1
      ? `${formatUsd(t.totalCents)} in one payment`
      : `${formatUsd(t.totalCents)} in ${plan.length} payments${t.depositCents > 0 ? `, ${formatUsd(t.depositCents)} deposit first` : ""}`;
  return {
    id: String(r.id),
    name: String(r.name),
    yearsTag: (r.years_tag as string | null) ?? null,
    ...t,
    durationMonths: r.duration_months == null ? null : Number(r.duration_months),
    inclusions: Array.isArray(r.inclusions) ? (r.inclusions as string[]) : [],
    archivedAt: (r.archived_at as string | null) ?? null,
    createdAt: String(r.created_at),
    plan,
    summary,
  };
}
