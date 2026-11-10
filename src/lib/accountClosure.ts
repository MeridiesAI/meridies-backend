/**
 * Leave Meridies: closing a counselor's account after a 30-day grace period (Task 11b).
 *
 * Nothing is deleted or disconnected when a counselor asks. `public.account_closures` (20261111000004) records the
 * request; the account keeps working, read and write and with its Google/Microsoft connections, until it is purged,
 * and the counselor can cancel any time from Settings. The purge (`runClosurePurge`, POST
 * /internal/account-closures/purge) is OFF unless ACCOUNT_PURGE_ENABLED is exactly "true"; when on it re-runs the
 * shared preconditions (lib/accountDeletion.ts), revokes the account's OAuth tokens, and deletes through the same
 * path as DELETE /account. The closure row cascades with the profile, so the outcome lives in `audit_log`.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DeletionFailed, deleteAccount, deletionBlocker, type DeletionSubject } from "./accountDeletion.js";
import { brandedEmail, brandedText } from "./email.js";
import { revokeAndForget, SUITE_PROVIDERS, type SuiteProvider } from "./oauth.js";

export const CLOSURE_GRACE_DAYS = 30;
/** Accounts deleted per purge run, oldest due first. */
export const PURGE_BATCH = 5;
/** A row left `purging` this long (a crash mid-run) is taken again, and may be cancelled: every step is safe to repeat. */
export const PURGE_RECLAIM_MS = 60 * 60 * 1000;
export const PURGE_LEASE = "account-closure-purge";
const PURGE_LEASE_SECONDS = 15 * 60;
const DAY_MS = 86_400_000;

type Log = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

export type ClosureStatus = "pending" | "cancelled" | "purging" | "done" | "failed";
/**
 * A closure still under way: waiting for its date (`pending`) or being deleted right now (`purging`). `cancelled`
 * and `done` are ends; `failed` is on hold until the counselor confirms again or cancels.
 */
export const ACTIVE_CLOSURE_STATUSES = ["pending", "purging"] as const satisfies readonly ClosureStatus[];
export const isActiveClosure = (row: { status: string } | null | undefined): boolean =>
  !!row && (ACTIVE_CLOSURE_STATUSES as readonly string[]).includes(row.status);

export type ClosureRow = { status: ClosureStatus | string; requested_at: string; purge_after: string; last_error: string | null; updated_at?: string };

/** The env flag: only the exact string "true" switches the purge on. */
export const purgeFlag = (raw: string | undefined): boolean => raw === "true";

export const purgeAfterFrom = (requestedAt: Date): Date => new Date(requestedAt.getTime() + CLOSURE_GRACE_DAYS * DAY_MS);

/** Whole days until the purge, rounded up (29.5 days reads as 30); 0 once it is due. */
export function daysLeft(purgeAfter: string | Date, now = new Date()): number {
  const ms = new Date(purgeAfter).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/** A `purging` row nobody has touched for PURGE_RECLAIM_MS: its run crashed. */
export const isStalePurging = (row: { status: string; updated_at?: string }, now: Date) =>
  row.status === "purging" && Boolean(row.updated_at) && now.getTime() - Date.parse(row.updated_at!) >= PURGE_RECLAIM_MS;

/** A database without the migration. */
export const isClosureTableMissing = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205";

/**
 * What GET /account/closure answers. `status`:
 *   "none"     no closure open (never asked, or cancelled): every other field null.
 *   "pending"  waiting for its date, or being deleted right now: requestedAt, purgeAfter, daysLeft (0 once due).
 *   "on_hold"  the purge found a reason it can't close the account yet (`blockedReason`, e.g. a student still on
 *              the roster); nothing will happen until the counselor fixes it and confirms again (POST, which starts
 *              a fresh 30 days) or cancels. purgeAfter and daysLeft are null.
 * `purgeEnabled` says whether the automatic deletion is switched on at all (ACCOUNT_PURGE_ENABLED).
 */
export type ClosureView = {
  status: "none" | "pending" | "on_hold";
  requestedAt: string | null;
  purgeAfter: string | null;
  daysLeft: number | null;
  purgeEnabled: boolean;
  blockedReason: string | null;
};

export function closureView(row: ClosureRow | null, now: Date, purgeEnabled: boolean): ClosureView {
  const none: ClosureView = { status: "none", requestedAt: null, purgeAfter: null, daysLeft: null, purgeEnabled, blockedReason: null };
  if (!row) return none;
  if (row.status === "failed") {
    return { ...none, status: "on_hold", requestedAt: new Date(row.requested_at).toISOString(), blockedReason: row.last_error };
  }
  if (!isActiveClosure(row)) return none;
  return {
    status: "pending",
    requestedAt: new Date(row.requested_at).toISOString(),
    purgeAfter: new Date(row.purge_after).toISOString(),
    daysLeft: daysLeft(row.purge_after, now),
    purgeEnabled,
    blockedReason: null,
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
export function closureEmail(kind: "requested" | "cancelled", o: { purgeAfter: string | null; timeZone: string | null; appUrl: string }) {
  // No date for a cancel of a closure that was on hold: its old date has passed and means nothing now.
  const date = o.purgeAfter ? longDate(o.purgeAfter, o.timeZone) : null;
  const settings = `${o.appUrl.replace(/\/+$/, "")}/dashboard/counselor/settings`;
  const t =
    kind === "requested"
      ? {
          heading: "Your Meridies account is set to close",
          paragraphs: [
            `You asked to close your Meridies account. It will be closed on or after ${date ?? "30 days from today"}.`,
            "Until then your account keeps working as it does today, connections included. You can cancel any time before that date from Settings.",
            "We recommend exporting your data first (Settings › Export), so you keep a copy of your students' records and your practice's work.",
            "If you didn't ask for this, cancel it from Settings and reply to this email.",
          ],
          cta: { label: "Open Settings", url: settings },
        }
      : {
          heading: "Your Meridies account stays open",
          paragraphs: [
            date
              ? `You cancelled the closing of your Meridies account. It won't be closed on ${date}, and nothing in it has changed.`
              : "You cancelled the closing of your Meridies account. It won't be closed, and nothing in it has changed.",
            "If you didn't cancel it, reply to this email.",
          ],
          cta: { label: "Open Settings", url: settings },
        };
  return {
    subject: kind === "requested" ? `Your Meridies account will close on ${date ?? "a date 30 days from now"}` : "Your Meridies account stays open (closing cancelled)",
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
 * The rows this run takes: pending past its date, or `purging` left by a crashed run for PURGE_RECLAIM_MS (never
 * sooner, so two runs can't work one account); oldest date first, at most PURGE_BATCH.
 */
export function pickDue(rows: DueRow[], now: Date): DueRow[] {
  return rows
    .filter((r) => Date.parse(r.purge_after) <= now.getTime() && (r.status === "pending" || isStalePurging(r, now)))
    .sort((a, b) => Date.parse(a.purge_after) - Date.parse(b.purge_after))
    .slice(0, PURGE_BATCH);
}

export type ConnectionsResult = {
  /** Providers the account had a stored token for; every stored token is forgotten (deleted) either way. */
  forgotten: SuiteProvider[];
  /** Providers that confirmed the revoke (Google only: Microsoft has no per-app revoke call). */
  revokedAtProvider: SuiteProvider[];
};

/**
 * The account's Google/Microsoft tokens: revoked at the provider where it has a call (Google) and forgotten, with the
 * visible `integrations` rows. Best effort per provider: a provider that fails is logged (never a token) and the
 * purge goes on, since the deletion removes the stored tokens either way.
 */
export async function revokeConnections(svc: SupabaseClient, id: string, log: Log): Promise<ConnectionsResult> {
  const { data } = await svc.from("integration_tokens").select("provider").eq("owner_id", id);
  const forgotten = ((data ?? []) as Array<{ provider: string }>).map((r) => r.provider).filter((p): p is SuiteProvider => (SUITE_PROVIDERS as readonly string[]).includes(p));
  const revokedAtProvider: SuiteProvider[] = [];
  for (const provider of SUITE_PROVIDERS) {
    try {
      const r = await revokeAndForget(id, provider, log);
      if (r.revokedAtProvider) revokedAtProvider.push(provider);
      await svc.from("integrations").delete().eq("owner_id", id).eq("provider", provider);
    } catch (err) {
      log.warn({ provider, err: err instanceof Error ? err.message : String(err) }, "account closure purge: token revoke failed");
    }
  }
  return { forgotten, revokedAtProvider };
}

/**
 * Delete the accounts whose grace period is over, under the `account-closure-purge` lease. Disabled (the default):
 * touches nothing. For each row (`pickDue`): a conditional claim to `purging` on the exact row read (a cancel in
 * between wins); the profile must be a counselor; the shared preconditions again (a block marks the row `failed`
 * with the reason and emails nobody: the account stays); the `account.closure.purging` audit row (if it can't be
 * written the row is failed and nothing is deleted); the OAuth tokens revoked; the row re-checked as still `purging`;
 * then `deleteAccount` (the DELETE /account path). A deletion that fails after this point leaves the connections
 * revoked (the account itself is intact). The closure row goes with the profile, so success is the `account.closure.purged` audit row; a
 * deletion that fails marks the row `failed` (the account is intact). `remove`/`revoke` let a test stand in.
 */
export async function runClosurePurge(
  svc: SupabaseClient,
  log: Log,
  opts: {
    enabled: boolean;
    now?: Date;
    remove?: (who: DeletionSubject) => Promise<void>;
    revoke?: (id: string) => Promise<ConnectionsResult>;
  }
): Promise<PurgeOutcome> {
  if (!opts.enabled) return { ran: false, reason: "purge_disabled" };
  const now = opts.now ?? new Date();
  const remove = opts.remove ?? ((who: DeletionSubject) => deleteAccount(who, log, "closure"));
  const revoke = opts.revoke ?? ((id: string) => revokeConnections(svc, id, log));

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const lease = await svc.rpc("acquire_job_lease", { p_name: PURGE_LEASE, p_holder: holder, p_ttl_seconds: PURGE_LEASE_SECONDS });
  if (lease.error) {
    log.error({ code: lease.error.code }, "account closure purge: lease unavailable, skipped");
    return { ran: false, reason: "lease-error" };
  }
  if (lease.data !== true) return { ran: false, reason: "locked" };

  const tally = { due: 0, purged: 0, blocked: 0, failed: 0, skipped: 0 };
  try {
    // Candidates in a wider window; pickDue decides (fresh `purging` rows are left alone).
    const { data, error } = await svc
      .from("account_closures")
      .select("counselor_id, status, updated_at, requested_at, purge_after")
      .in("status", [...ACTIVE_CLOSURE_STATUSES])
      .lte("purge_after", now.toISOString())
      .order("purge_after", { ascending: true })
      .limit(PURGE_BATCH * 4);
    if (error) {
      if (isClosureTableMissing(error)) return { ran: false, reason: "migration-not-applied" };
      throw new Error(`account closure purge: due rows unreadable (${error.code ?? "?"})`);
    }
    const rows = pickDue((data ?? []) as DueRow[], now);
    tally.due = rows.length;

    for (const row of rows) {
      const id = row.counselor_id;
      let claimed = false;
      const fail = async (message: string) => {
        if (!claimed) return;
        const r = await svc.from("account_closures").update({ status: "failed", last_error: message.slice(0, 1000) }).eq("counselor_id", id).eq("status", "purging");
        if (r.error) log.error({ code: r.error.code }, "account closure purge: could not mark a row failed");
      };
      const note = (action: string, metadata: Record<string, unknown>) =>
        svc.from("audit_log").insert({ actor_id: null, action, entity_type: "profile", entity_id: id, metadata });
      try {
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
        claimed = true;

        const prof = await svc.from("profiles").select("id, role, firm_id").eq("id", id).maybeSingle();
        if (prof.error) throw new Error(`profile unreadable (${prof.error.code ?? "?"})`);
        const who = prof.data as DeletionSubject | null;
        if (!who || who.role !== "counselor") {
          // Only a counselor can ask to close; anything else is a row nobody should act on.
          await fail("Only a counselor account can be closed this way. Ask Meridies to close it.");
          await note("account.closure.blocked", { code: "not_counselor" });
          tally.blocked += 1;
          continue;
        }

        const block = await deletionBlocker(svc, who);
        if (block) {
          await fail(block.message);
          await note("account.closure.blocked", { code: block.code });
          tally.blocked += 1;
          continue;
        }

        // Recorded before the deletion: the closure row is about to cascade away with the profile. No record, no deletion.
        const purging = await note("account.closure.purging", { role: who.role, requestedAt: row.requested_at, purgeAfter: row.purge_after });
        if (purging.error) {
          await fail("The account couldn't be closed right now (its record couldn't be written). Confirm again from Settings to retry.");
          log.error({ code: purging.error.code }, "account closure purge: audit row failed, deletion skipped");
          tally.failed += 1;
          continue;
        }

        let connections: ConnectionsResult | { error: true } = { error: true };
        try {
          connections = await revoke(id);
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "account closure purge: revoking connections failed");
        }

        // Still ours? A cancel can't land on a live `purging` row, but re-check right before the deletion anyway.
        const still = await svc.from("account_closures").update({ status: "purging" }).eq("counselor_id", id).eq("status", "purging").select("counselor_id");
        if (still.error || !still.data?.length) {
          await note("account.closure.skipped", { reason: still.error ? "recheck-failed" : "no-longer-purging" });
          tally.skipped += 1;
          continue;
        }

        try {
          await remove(who);
        } catch (err) {
          const stage = err instanceof DeletionFailed ? err.stage : "unknown";
          await fail(`The account couldn't be deleted (${stage}). Confirm again from Settings to retry.`);
          await note("account.closure.failed", { stage });
          log.error({ stage }, "account closure purge: deletion failed");
          tally.failed += 1;
          continue;
        }
        await note("account.closure.purged", { role: who.role, connections });
        tally.purged += 1;
      } catch (err) {
        await fail("The account couldn't be checked for closing. Confirm again from Settings to retry.");
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
