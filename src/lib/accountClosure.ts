/**
 * Leave Meridies: closing a counselor's account after a 30-day grace period (Task 11b).
 *
 * Nothing is deleted when a counselor asks. `public.account_closures` (20261111000004) records the request; the
 * account keeps working, read and write, until `purge_after`, and the counselor can cancel any time from Settings.
 * The purge (`runClosurePurge`, POST /internal/account-closures/purge) is OFF unless ACCOUNT_PURGE_ENABLED is
 * exactly "true"; when on it re-runs the shared preconditions (lib/accountDeletion.ts) and deletes through the same
 * path as DELETE /account. The closure row cascades with the profile, so the outcome lives in `audit_log`.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DeletionFailed, deleteAccount, deletionBlocker, type DeletionSubject } from "./accountDeletion.js";
import { brandedEmail, brandedText } from "./email.js";

export const CLOSURE_GRACE_DAYS = 30;
/** Accounts deleted per purge run, oldest due first. */
export const PURGE_BATCH = 5;
/** A row left `purging` this long (a crash mid-run) is taken again: every deletion step is safe to repeat. */
export const PURGE_RECLAIM_MS = 60 * 60 * 1000;
export const PURGE_LEASE = "account-closure-purge";
const PURGE_LEASE_SECONDS = 15 * 60;
const DAY_MS = 86_400_000;

type Log = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

export type ClosureStatus = "pending" | "cancelled" | "purging" | "done" | "failed";
export type ClosureRow = { status: ClosureStatus | string; requested_at: string; purge_after: string; last_error: string | null };

/** The env flag: only the exact string "true" switches the purge on. */
export const purgeFlag = (raw: string | undefined): boolean => raw === "true";

export const purgeAfterFrom = (requestedAt: Date): Date => new Date(requestedAt.getTime() + CLOSURE_GRACE_DAYS * DAY_MS);

/** Whole days until the purge, rounded up (29.5 days reads as 30); 0 once it is due. */
export function daysLeft(purgeAfter: string | Date, now = new Date()): number {
  const ms = new Date(purgeAfter).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/** A database without the migration. */
export const isClosureTableMissing = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205";

export type ClosureView = {
  status: "none" | "pending";
  requestedAt: string | null;
  purgeAfter: string | null;
  daysLeft: number | null;
  /** Whether the automatic deletion is switched on at all (ACCOUNT_PURGE_ENABLED), so the app can say so. */
  purgeEnabled: boolean;
  /** Why the purge held the account back (a student still on the roster...), when it did; the closure stays open. */
  blockedReason: string | null;
};

/**
 * What GET /account/closure answers. A closure is open (`pending`) while it is waiting, being purged, or was held
 * back by a precondition (`failed`, with `blockedReason`); no row or a cancelled one is `none`.
 */
export function closureView(row: ClosureRow | null, now: Date, purgeEnabled: boolean): ClosureView {
  if (!row || !["pending", "purging", "failed"].includes(row.status)) {
    return { status: "none", requestedAt: null, purgeAfter: null, daysLeft: null, purgeEnabled, blockedReason: null };
  }
  return {
    status: "pending",
    requestedAt: new Date(row.requested_at).toISOString(),
    purgeAfter: new Date(row.purge_after).toISOString(),
    daysLeft: daysLeft(row.purge_after, now),
    purgeEnabled,
    blockedReason: row.status === "failed" ? row.last_error : null,
  };
}

function longDate(iso: string, timeZone: string | null): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: tz }).format(new Date(iso));
  try {
    return fmt(timeZone || "UTC");
  } catch {
    return fmt("UTC");
  }
}

/** The counselor's confirmation emails. No student names, no counts: only the account's own dates. */
export function closureEmail(kind: "requested" | "cancelled", o: { purgeAfter: string; timeZone: string | null; appUrl: string }) {
  const date = longDate(o.purgeAfter, o.timeZone);
  const settings = `${o.appUrl.replace(/\/+$/, "")}/dashboard/counselor/settings`;
  const t =
    kind === "requested"
      ? {
          heading: "Your Meridies account is set to close",
          paragraphs: [
            `You asked to close your Meridies account. It will be closed on or after ${date}.`,
            "Until then your account keeps working as it does today. You can cancel any time before that date from Settings.",
            "We recommend exporting your data first (Settings › Export), so you keep a copy of your students' records and your practice's work.",
            "Any Google or Microsoft connection on your account has been disconnected. Connect it again from Settings if you need it before you leave.",
            "If you didn't ask for this, cancel it from Settings and reply to this email.",
          ],
          cta: { label: "Open Settings", url: settings },
        }
      : {
          heading: "Your Meridies account stays open",
          paragraphs: [
            `You cancelled the closing of your Meridies account. It won't be closed on ${date}, and nothing has changed in it.`,
            "If you didn't cancel it, reply to this email.",
          ],
          cta: { label: "Open Settings", url: settings },
        };
  return {
    subject: kind === "requested" ? `Your Meridies account will close on ${date}` : "Your Meridies account stays open (closing cancelled)",
    html: brandedEmail(t),
    text: brandedText(t),
    template: kind === "requested" ? "account-closure-requested" : "account-closure-cancelled",
  };
}

export type PurgeOutcome =
  | { ran: false; reason: "purge_disabled" | "locked" | "lease-error" | "migration-not-applied" }
  | { ran: true; due: number; purged: number; blocked: number; failed: number; skipped: number };

type DueRow = { counselor_id: string; status: string; updated_at: string; requested_at: string; purge_after: string };

/**
 * Delete the accounts whose grace period is over: at most PURGE_BATCH, oldest due first, under the
 * `account-closure-purge` lease. Disabled (the default): touches nothing. For each row: the shared preconditions
 * again (a block marks it `failed` with the reason, emails nobody, and the account stays), a conditional claim to
 * `purging`, an audit row, then `deleteAccount` (the DELETE /account path). The closure row goes with the profile,
 * so success is the `account.closure.purged` audit row; a deletion that fails marks the row `failed`.
 * `deps` lets a test stand in for the deletion.
 */
export async function runClosurePurge(
  svc: SupabaseClient,
  log: Log,
  opts: { enabled: boolean; now?: Date; remove?: (who: DeletionSubject) => Promise<void> }
): Promise<PurgeOutcome> {
  if (!opts.enabled) return { ran: false, reason: "purge_disabled" };
  const now = opts.now ?? new Date();
  const remove = opts.remove ?? ((who: DeletionSubject) => deleteAccount(who, log, "closure"));

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const lease = await svc.rpc("acquire_job_lease", { p_name: PURGE_LEASE, p_holder: holder, p_ttl_seconds: PURGE_LEASE_SECONDS });
  if (lease.error) {
    log.error({ code: lease.error.code }, "account closure purge: lease unavailable, skipped");
    return { ran: false, reason: "lease-error" };
  }
  if (lease.data !== true) return { ran: false, reason: "locked" };

  const tally = { due: 0, purged: 0, blocked: 0, failed: 0, skipped: 0 };
  try {
    const stale = new Date(now.getTime() - PURGE_RECLAIM_MS).toISOString();
    const { data, error } = await svc
      .from("account_closures")
      .select("counselor_id, status, updated_at, requested_at, purge_after")
      .lte("purge_after", now.toISOString())
      .or(`status.eq.pending,and(status.eq.purging,updated_at.lt.${stale})`)
      .order("purge_after", { ascending: true })
      .limit(PURGE_BATCH);
    if (error) {
      if (isClosureTableMissing(error)) return { ran: false, reason: "migration-not-applied" };
      throw new Error(`account closure purge: due rows unreadable (${error.code ?? "?"})`);
    }
    const rows = (data ?? []) as DueRow[];
    tally.due = rows.length;

    for (const row of rows) {
      const id = row.counselor_id;
      const fail = async (message: string) =>
        svc.from("account_closures").update({ status: "failed", last_error: message.slice(0, 1000) }).eq("counselor_id", id).eq("status", "purging");
      try {
        const prof = await svc.from("profiles").select("id, role, firm_id").eq("id", id).maybeSingle();
        if (prof.error) throw new Error(`profile unreadable (${prof.error.code ?? "?"})`);
        if (!prof.data) {
          tally.skipped += 1;
          continue;
        }
        const who = prof.data as DeletionSubject;

        // Claim it first, conditional on the row being exactly what was read, so a cancel in between wins.
        const claim = await svc
          .from("account_closures")
          .update({ status: "purging", last_error: null })
          .eq("counselor_id", id)
          .eq("status", row.status)
          .eq("updated_at", row.updated_at)
          .select("counselor_id");
        if (claim.error) throw new Error(`claim failed (${claim.error.code ?? "?"})`);
        if (!claim.data?.length) {
          tally.skipped += 1;
          continue;
        }

        const block = await deletionBlocker(svc, who);
        if (block) {
          await fail(block.message);
          await svc.from("audit_log").insert({ actor_id: null, action: "account.closure.blocked", entity_type: "profile", entity_id: id, metadata: { code: block.code } });
          tally.blocked += 1;
          continue;
        }

        // Recorded before the deletion: the closure row is about to cascade away with the profile.
        await svc.from("audit_log").insert({
          actor_id: null,
          action: "account.closure.purging",
          entity_type: "profile",
          entity_id: id,
          metadata: { role: who.role, requestedAt: row.requested_at, purgeAfter: row.purge_after },
        });
        try {
          await remove(who);
        } catch (err) {
          const stage = err instanceof DeletionFailed ? err.stage : "unknown";
          await fail(`The account couldn't be deleted (${stage}). It will not be retried until the closure is confirmed again.`);
          await svc.from("audit_log").insert({ actor_id: null, action: "account.closure.failed", entity_type: "profile", entity_id: id, metadata: { stage } });
          log.error({ stage }, "account closure purge: deletion failed");
          tally.failed += 1;
          continue;
        }
        await svc.from("audit_log").insert({ actor_id: null, action: "account.closure.purged", entity_type: "profile", entity_id: id, metadata: { role: who.role } });
        tally.purged += 1;
      } catch (err) {
        await fail("The account couldn't be checked for closing. It will not be retried until the closure is confirmed again.");
        log.error({ err: err instanceof Error ? err.message : String(err) }, "account closure purge: row failed");
        tally.failed += 1;
      }
    }
  } finally {
    const rel = await svc.rpc("release_job_lease", { p_name: PURGE_LEASE, p_holder: holder });
    if (rel.error) log.warn({ code: rel.error.code }, "account closure purge: lease release failed");
  }
  log.info(tally, "account closure purge finished");
  return { ran: true, ...tally };
}
