/**
 * Where an invitation email stands, read off its message_deliveries rows.
 *
 * The row is written by lib/email.ts when the invite is sent and moved on by
 * the delivery webhooks (routes/webhooks.ts): sent, then delivered, bounced or
 * failed. The status served is the row's own, never a guess: a row that is
 * only `sent` is reported as sent, not delivered, because the provider has not
 * said so yet.
 */

import type { FastifyRequest } from "fastify";

type Row = Record<string, unknown>;

export type InviteDeliveryStatus = "queued" | "sent" | "delivered" | "bounced" | "failed" | "cancelled";

export type InviteDelivery = {
  status: InviteDeliveryStatus;
  channel: "email" | "sms";
  /** When it left (sent_at), else when the attempt was logged. */
  at: string;
  deliveredAt: string | null;
  /** Why it bounced or failed, in words a counselor can act on. Null otherwise. */
  reason: string | null;
};

const STATUSES = new Set<InviteDeliveryStatus>(["queued", "sent", "delivered", "bounced", "failed", "cancelled"]);

/**
 * The provider's error, made fit to show. Configuration errors name a server
 * setting, which is never shown to a client; anything else is capped.
 */
export function deliveryReason(status: InviteDeliveryStatus, error: unknown): string | null {
  if (status !== "bounced" && status !== "failed" && status !== "cancelled") return null;
  const raw = typeof error === "string" ? error.trim() : "";
  if (!raw) return status === "bounced" ? "The address bounced" : null;
  if (/_KEY|_SECRET|_TOKEN|unset/i.test(raw)) return "Email isn't set up on the server yet";
  return raw.length > 200 ? `${raw.slice(0, 199)}…` : raw;
}

export function toInviteDelivery(r: Row): InviteDelivery | null {
  const status = String(r.status) as InviteDeliveryStatus;
  if (!STATUSES.has(status)) return null;
  return {
    status,
    channel: r.channel === "sms" ? "sms" : "email",
    at: String(r.sent_at ?? r.created_at),
    deliveredAt: r.delivered_at ? String(r.delivered_at) : null,
    reason: deliveryReason(status, r.error),
  };
}

/** The newest attempt per invitation, from rows ordered newest first. */
export function latestByInvitation(rows: Row[]): Map<string, InviteDelivery> {
  const out = new Map<string, InviteDelivery>();
  for (const r of rows) {
    const id = r.invitation_id ? String(r.invitation_id) : null;
    if (!id || out.has(id)) continue;
    const d = toInviteDelivery(r);
    if (d) out.set(id, d);
  }
  return out;
}

/**
 * The delivery of each of these invitations, on the caller's client: RLS
 * (message_deliveries_invitation_counselor) returns only rows of invitations
 * the caller sent. Never fatal: a list of invitations still renders when the
 * status can't be read, each row's delivery null ("not known").
 */
export async function invitationDeliveries(request: FastifyRequest, invitationIds: string[]): Promise<Map<string, InviteDelivery>> {
  if (invitationIds.length === 0) return new Map();
  const { data, error } = await request.db
    .from("message_deliveries")
    .select("invitation_id, status, channel, error, sent_at, delivered_at, created_at")
    .in("invitation_id", invitationIds)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) {
    request.log.warn({ code: error.code }, "invitation delivery status unreadable");
    return new Map();
  }
  return latestByInvitation((data ?? []) as Row[]);
}
