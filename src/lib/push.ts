/**
 * Web Push: turns the in-app bell's `notifications` rows into notifications on a user's registered devices.
 *
 * - Subscriptions live in `push_subscriptions` (owner-only RLS; routes/push.ts). This file reads them with the
 *   service role.
 * - One cron (`POST /internal/push-dispatch`, every minute or two) handles every notification row with
 *   `pushed_at is null`, so each place that writes a notification reaches phones without any change of its own.
 * - Privacy: what a lock screen shows is generic by kind. A notification's own title and body can name a student or
 *   quote their work, so they are never sent; the payload carries only the label below and an in-app path.
 * - Only approved counselors get push (a pending or revoked counselor gets none), and a device the push service
 *   reports gone (404 / 410) is deleted.
 * - Off (503 push_unavailable, a no-op sweep) until the three VAPID settings exist.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyBaseLogger } from "fastify";
import { env, hasPush } from "../env.js";
import { approvedCounselorIds } from "./access.js";

// web-push is CommonJS; loading it this way works the same under tsc, tsx and the built output.
const webpush = createRequire(import.meta.url)("web-push") as typeof import("web-push");

type Log = FastifyBaseLogger;
type Row = Record<string, unknown>;

const LEASE_NAME = "push-dispatch";
const LEASE_TTL_SECONDS = 5 * 60;
/** Rows handled per run; the rest wait for the next. */
const BATCH = 200;
/** A notification older than this is marked handled without a push: a phone buzzing about an hour-old event is noise. */
const STALE_MINUTES = 60;
/** More than this many for one person in one run become a single summary push. */
const MAX_INDIVIDUAL = 3;

export type PushPayload = { title: string; body: string; href: string };
export type PushTally = { ran: boolean; handled: number; pushed: number; pruned: number; reason?: string };

const KIND_BODY: Record<string, string> = {
  deadline: "A deadline needs your attention.",
  "red-flag": "Something needs your attention.",
  report: "A report is ready.",
  invite: "There is an update on an invitation.",
  ai: "AxIS has something for you.",
  policy: "A policy update is ready.",
  scholarship: "There is a scholarship update.",
  aid: "There is a financial aid update.",
  opportunity: "There is a new opportunity.",
  system: "You have a new notification.",
};

/** The in-app address to open. Only an in-app path is ever followed; anything else opens the app's front door. */
export function safeHref(href: unknown): string {
  return typeof href === "string" && /^\/(?!\/)[^\s]*$/.test(href) && href.length <= 300 ? href : "/";
}

/** The generic payload for one notification: a label by kind, never the row's own words. */
export function payloadFor(row: { kind?: unknown; href?: unknown }): PushPayload {
  const body = KIND_BODY[String(row.kind)] ?? KIND_BODY.system;
  return { title: "Meridies", body, href: safeHref(row.href) };
}

/** Several in one run for one person: one summary that opens their notifications' own page. */
export function summaryPayload(count: number, href: unknown): PushPayload {
  return { title: "Meridies", body: `You have ${count} new notifications.`, href: count > 0 ? safeHref(href) : "/" };
}

/** A subscription the push service says is gone. */
export function isGone(statusCode: unknown): boolean {
  return statusCode === 404 || statusCode === 410;
}

let configured = false;
function configure(): void {
  if (configured) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT as string, env.VAPID_PUBLIC_KEY as string, env.VAPID_PRIVATE_KEY as string);
  configured = true;
}

type Sub = { id: string; endpoint: string; p256dh: string | null; auth: string | null; channel: string };

/** Send one payload to one device. Returns "sent", "gone" (delete it) or "failed" (keep it, try later). */
export async function sendToSubscription(sub: Sub, payload: PushPayload, log?: Log): Promise<"sent" | "gone" | "failed"> {
  if (sub.channel !== "web" || !sub.p256dh || !sub.auth) return "failed"; // fcm / apns arrive with the store apps
  try {
    configure();
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60, urgency: "normal" }
    );
    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (isGone(status)) return "gone";
    log?.warn({ status }, "push send failed");
    return "failed";
  }
}

export async function dispatchPush(svc: SupabaseClient, log: Log): Promise<PushTally> {
  if (!hasPush) return { ran: false, handled: 0, pushed: 0, pruned: 0, reason: "not-configured" };

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error: leaseErr } = await svc.rpc("acquire_job_lease", {
    p_name: LEASE_NAME,
    p_holder: holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (leaseErr) return { ran: false, handled: 0, pushed: 0, pruned: 0, reason: "lease-error" };
  if (acquired !== true) return { ran: false, handled: 0, pushed: 0, pruned: 0, reason: "locked" };

  let handled = 0;
  let pushed = 0;
  let pruned = 0;
  try {
    const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
    await svc.from("notifications").update({ pushed_at: new Date().toISOString() }).is("pushed_at", null).lt("created_at", cutoff);

    const { data: rows, error } = await svc
      .from("notifications")
      .select("id, recipient_id, kind, href, created_at")
      .is("pushed_at", null)
      .order("created_at", { ascending: true })
      .limit(BATCH);
    if (error) throw new Error(`notifications read failed (${error.code ?? "unknown"})`);
    const list = (rows ?? []) as Row[];
    if (!list.length) return { ran: true, handled, pushed, pruned };

    const userIds = [...new Set(list.map((r) => String(r.recipient_id)))];
    const { data: subs, error: subErr } = await svc
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth, channel")
      .in("user_id", userIds);
    if (subErr) throw new Error(`push_subscriptions read failed (${subErr.code ?? "unknown"})`);

    const byUser = new Map<string, Sub[]>();
    for (const s of (subs ?? []) as Row[]) {
      const k = String(s.user_id);
      byUser.set(k, [...(byUser.get(k) ?? []), s as unknown as Sub]);
    }

    // A pending or revoked counselor gets nothing: ask which of the subscribed users are counselors, then which of those are approved.
    const subscribed = [...byUser.keys()];
    const { data: roles } = subscribed.length
      ? await svc.from("profiles").select("id, role").in("id", subscribed)
      : { data: [] as Row[] };
    const counselors = ((roles ?? []) as Row[]).filter((p) => p.role === "counselor").map((p) => String(p.id));
    const approved = await approvedCounselorIds(svc, counselors);
    const blocked = new Set(counselors.filter((id) => !approved.has(id)));

    const perUser = new Map<string, Row[]>();
    for (const r of list) perUser.set(String(r.recipient_id), [...(perUser.get(String(r.recipient_id)) ?? []), r]);

    for (const [userId, items] of perUser) {
      const devices = blocked.has(userId) ? [] : (byUser.get(userId) ?? []);
      const payloads =
        items.length > MAX_INDIVIDUAL ? [summaryPayload(items.length, items[items.length - 1]?.href)] : items.map((r) => payloadFor(r));
      for (const device of devices) {
        for (const payload of payloads) {
          const result = await sendToSubscription(device, payload, log);
          if (result === "sent") pushed += 1;
          if (result === "gone") {
            await svc.from("push_subscriptions").delete().eq("id", device.id);
            pruned += 1;
            break;
          }
        }
        await svc.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", device.id);
      }
    }

    const ids = list.map((r) => String(r.id));
    const { error: markErr } = await svc.from("notifications").update({ pushed_at: new Date().toISOString() }).in("id", ids);
    if (markErr) throw new Error(`notifications mark failed (${markErr.code ?? "unknown"})`);
    handled = ids.length;
    return { ran: true, handled, pushed, pruned };
  } finally {
    const { error } = await svc.rpc("release_job_lease", { p_name: LEASE_NAME, p_holder: holder });
    if (error) log.warn({ code: error.code }, "push lease release failed");
  }
}
