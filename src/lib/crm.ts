/**
 * The practice's CRM workspace: Contact Pipeline, Payment Tracker and
 * Management share it.
 *
 * A counselor in a firm works in the firm's workspace; a solo counselor in
 * their own. The database decides (`crm_my_workspace()`, migration
 * 20261005050001) and RLS enforces it on every table; this module only reads
 * the answer so routes can scope their queries and say "you're not an admin"
 * instead of returning a silent empty list.
 */

import type { FastifyRequest } from "fastify";
import { badRequest, conflict, forbidden, fromPostgrest, HttpError, notFound } from "./errors.js";

type Row = Record<string, unknown>;

export type Workspace = {
  /** Null for a solo counselor. */
  firmId: string | null;
  /** Owner/admin of the firm, or a solo counselor (who runs their own practice). */
  isAdmin: boolean;
};

export async function loadWorkspace(request: FastifyRequest): Promise<Workspace> {
  const { data, error } = await request.db.rpc("crm_my_workspace");
  if (error) throw crmError(error);
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  if (!row) throw forbidden("Only counselors have a practice workspace");
  return { firmId: (row.firm_id as string | null) ?? null, isAdmin: row.is_admin === true };
}

/**
 * Database errors from the CRM's own functions and triggers carry messages
 * written for the counselor ("A pipeline needs at least one stage"), so they
 * pass through. Anything else (a constraint name, a raw Postgres message)
 * goes through the generic mapping, which never echoes it.
 */
export function crmError(error: { code?: string; message?: string } | null): HttpError {
  const message = error?.message ?? "";
  const ours = message.length > 0 && message.length <= 200 && !/violates|relation|column|syntax|permission denied/i.test(message);
  switch (error?.code) {
    case "P0002":
      return notFound(ours ? message : "Not found");
    case "P0001":
      return conflict(ours ? message : "That can't be done right now");
    case "22023":
    case "23514":
      return ours ? badRequest(message) : fromPostgrest(error);
    case "42501":
      return ours ? forbidden(message) : forbidden();
    case "22P02":
      return badRequest("That id isn't valid");
    default:
      return fromPostgrest(error);
  }
}

/** "Hi {first}," / "{me}" slots a template carries (demo lib/emailTemplates.ts). */
export function fillTemplate(text: string, vars: { first?: string | null; me?: string | null }): string {
  return text.replace(/\{first\}/g, vars.first?.trim() || "there").replace(/\{me\}/g, vars.me?.trim() ?? "");
}

/** Today's date (YYYY-MM-DD) where the counselor is, for due and overdue. */
export function todayIn(timezone: string | null | undefined): string {
  const tz = timezone?.trim() || "America/New_York";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date()
    );
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Paragraphs for brandedEmail from a plain-text body. */
export function paragraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}
