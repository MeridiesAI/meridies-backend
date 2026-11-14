/**
 * Texting an invoice (the composer's Text channel) reuses the consultant's own Twilio number
 * (consultant_phone_numbers, lib/twilioNumbers.ts) through `sendSms`. A practice without one gets a clear
 * 409 `texting_unavailable` instead of an invoice sent from the shared sender; the composer disables the
 * Text tab from `GET /pipeline/invoice-options` (`textAvailable`).
 */

import { HttpError } from "./errors.js";
import { serviceClient } from "./supabase.js";

export const textingUnavailable = () =>
  new HttpError(409, "Texting invoices needs your own texting number. Set one up in Settings, or send this one by email.", "texting_unavailable");

/** Whether the counselor has an active texting number of their own. Never throws: unreadable means no. */
export async function textingAvailable(counselorId: string): Promise<boolean> {
  const svc = serviceClient();
  if (!svc) return false;
  const { data, error } = await svc.from("consultant_phone_numbers").select("phone_e164").eq("counselor_id", counselorId).eq("status", "active").maybeSingle();
  return !error && Boolean(data);
}
