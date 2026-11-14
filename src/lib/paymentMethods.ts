/**
 * The ways a practice tells families they can pay (practice_payment_methods): five built-ins seeded on
 * first read and the practice's own (pure; no I/O). Only "card" goes through Stripe Checkout; every other
 * method is paid outside Meridies and recorded with Record (a custom one is recorded as `other`, its
 * label in the payment's note).
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";

export type BuiltinKey = "card" | "ach" | "zelle" | "paypal" | "check";
export const BUILTIN_METHODS: Array<{ key: BuiltinKey; label: string; instructions: string; sort: number }> = [
  { key: "card", label: "Card", instructions: "", sort: 0 },
  { key: "ach", label: "Bank transfer", instructions: "", sort: 1 },
  { key: "zelle", label: "Zelle", instructions: "", sort: 2 },
  { key: "paypal", label: "PayPal", instructions: "", sort: 3 },
  { key: "check", label: "Check", instructions: "", sort: 4 },
];
export const MAX_CUSTOM_METHODS = 20;

export const isCustomKey = (key: string) => key.startsWith("custom-");
export const newCustomKey = () => `custom-${randomBytes(4).toString("hex")}`;

export const methodInstructions = z.string().trim().max(500);
export const methodLabel = z.string().trim().min(1).max(60);

export type PaymentMethodDTO = { key: string; label: string; instructions: string; enabled: boolean; builtin: boolean; sort: number };

type Row = Record<string, unknown>;
export const toMethodDTO = (r: Row): PaymentMethodDTO => ({
  key: String(r.key),
  label: String(r.label),
  instructions: String(r.instructions ?? ""),
  enabled: r.enabled !== false,
  builtin: r.builtin === true,
  sort: Number(r.sort ?? 0),
});

/** The built-ins as rows to insert for a practice that has none yet. */
export const builtinRows = (scope: { firm_id: string | null; counselor_id: string; practice_id: string }) =>
  BUILTIN_METHODS.map((m) => ({ ...scope, key: m.key, label: m.label, instructions: m.instructions, enabled: true, builtin: true, sort: m.sort }));

/**
 * The methods an invoice lists: the accepted keys, in the practice's order, only those still enabled.
 * An invoice from before the composer (null) lists none: it shows the Pay by card button alone, as it always did.
 */
export function acceptedMethods(accepted: string[] | null | undefined, all: PaymentMethodDTO[]): PaymentMethodDTO[] {
  if (!accepted) return [];
  const want = new Set(accepted);
  return all.filter((m) => want.has(m.key) && m.enabled).sort((a, b) => a.sort - b.sort);
}

/** Whether card is an accepted way to pay: an invoice with no list takes cards, as it always did. */
export const takesCardMethod = (accepted: string[] | null | undefined): boolean => accepted == null || accepted.includes("card");

/** The payment method a recorded payment of this key is stored under. */
export const recordedMethod = (key: string): "card" | "ach" | "zelle" | "paypal" | "check" | "other" =>
  (["card", "ach", "zelle", "paypal", "check"] as const).find((k) => k === key) ?? "other";
