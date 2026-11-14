/**
 * Passing the card processing fee to the family (INVOICE_CARD_FEE_ENABLED; off by default, droppable).
 *
 * Surcharge rules vary by state, so this ships dark: with the flag off no fee is ever computed, shown or
 * charged, whatever an invoice says. With it on, an invoice marked `pass_card_fee` asks a family who pays
 * BY CARD for a little more, so the practice nets the invoice amount: Stripe's standard US card pricing
 * (2.9% + 30 cents) is grossed up, `gross = ceil((net + 30) / (1 - 0.029))`. Every other way to pay is
 * the plain amount. The payment that gets recorded is the invoice amount, never the fee (the webhook
 * records `payment_intent` amount minus the metadata's fee). Pure.
 */

import { env } from "../env.js";

export const CARD_FEE_PERCENT = 0.029;
export const CARD_FEE_FIXED_CENTS = 30;

export const cardFeeEnabled = (): boolean => env.INVOICE_CARD_FEE_ENABLED === "true";

/** What a card must charge so that, after Stripe's cut, `netCents` is left. 0 owed: 0. */
export function grossUpCents(netCents: number): number {
  if (netCents <= 0) return 0;
  return Math.ceil((netCents + CARD_FEE_FIXED_CENTS) / (1 - CARD_FEE_PERCENT));
}

/** The fee on top of an owed amount, or 0 when the flag is off, the invoice doesn't pass it on, or nothing is owed. */
export function cardFeeCents(owedCents: number, passCardFee: boolean | null | undefined, enabled: boolean = cardFeeEnabled()): number {
  if (!enabled || !passCardFee || owedCents <= 0) return 0;
  return grossUpCents(owedCents) - owedCents;
}
