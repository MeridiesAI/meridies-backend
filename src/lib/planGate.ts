/**
 * The plan gate in the sign-in step (plugins/supabaseAuth.ts): what a Consultant's plan lets a request do.
 * Pure. Only a Consultant is ever gated, and only with BILLING_ENABLED=true.
 *
 *   locked      (needs_plan, not_started, locked, closure_due)  every route is closed except those marked `allowPending`
 *                                                   (who-am-I, billing, terms, the account's own export and deletion)
 *   read-only   (read_only, canceled)               reading is fine; anything that changes data is closed
 *   otherwise   open
 */

import { accessFor, type PlanRow } from "./billingPlan.js";
import { HttpError } from "./errors.js";

export type GateResult = "locked" | "read_only" | null;

const isRead = (method: string) => method === "GET" || method === "HEAD";

export function planGate(plan: PlanRow | null, now: Date, method: string, allowPending: boolean | undefined): GateResult {
  if (allowPending === true) return null;
  const access = accessFor(plan, now);
  if (access.locked) return "locked";
  if (!access.canEdit && !isRead(method)) return "read_only";
  return null;
}

export function planGateError(result: Exclude<GateResult, null>, plan: PlanRow | null, now: Date): HttpError {
  if (result === "locked") {
    if (!plan || plan.status === "none") {
      return new HttpError(403, "Choose a plan to start using Meridies.", "plan_required");
    }
    const starts = plan?.access_starts_at;
    if (starts && now.getTime() < new Date(starts).getTime()) {
      return new HttpError(403, "Your access hasn't started yet.", "plan_not_started");
    }
    return new HttpError(403, "Your account is locked until the payment is fixed. You can still update billing and export your data.", "plan_locked");
  }
  return new HttpError(403, "Your account is read-only until the payment is fixed.", "plan_read_only");
}
