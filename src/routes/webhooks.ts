/**
 * Delivery webhooks: a message's status can move past "sent".
 *
 *   POST /webhooks/resend          Resend (Svix-signed): delivered, bounced,
 *                                  complained, delayed
 *   POST /webhooks/twilio/status   Twilio StatusCallback (X-Twilio-Signature):
 *                                  sent, delivered, undelivered, failed
 *
 * Both verify the provider's signature over the raw body before reading it,
 * match the message by provider id, and never move a status backwards
 * (a late "sent" doesn't undo "delivered").
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { unauthorized, unavailable } from "../lib/errors.js";
import { serviceClient } from "../lib/supabase.js";

type Status = "sent" | "delivered" | "bounced" | "failed";

/** Higher wins; terminal outcomes outrank "delivered" only when they arrive for an undelivered message. */
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, bounced: 3, failed: 3, cancelled: 3 };

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Svix signature: base64 HMAC-SHA256 of "<id>.<timestamp>.<body>", key = base64 part of whsec_. */
export function verifySvix(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  // Five minutes either way, against replay.
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return signature
    .split(" ")
    .map((s) => s.split(",")[1] ?? "")
    .some((sig) => sig && safeEqual(sig, expected));
}

/** Twilio: base64 HMAC-SHA1 of the full URL followed by each POST param (sorted) as key+value. */
export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return safeEqual(signature, expected);
}

export function resendStatus(type: string): { status: Status; note: string | null } | null {
  switch (type) {
    case "email.sent":
      return { status: "sent", note: null };
    case "email.delivered":
      return { status: "delivered", note: null };
    case "email.bounced":
      return { status: "bounced", note: "bounced" };
    case "email.complained":
      return { status: "bounced", note: "marked as spam by the recipient" };
    default:
      return null;
  }
}

export function twilioStatus(s: string): Status | null {
  if (s === "sent") return "sent";
  if (s === "delivered") return "delivered";
  if (s === "undelivered" || s === "failed") return "failed";
  return null;
}

async function applyStatus(provider: "resend" | "twilio", messageId: string, status: Status, providerStatus: string, note: string | null) {
  const svc = serviceClient();
  if (!svc) throw unavailable("Webhooks need the service role key");
  const { data: rows, error } = await svc
    .from("message_deliveries")
    .select("id, status")
    .eq("provider", provider)
    .eq("provider_message_id", messageId)
    .limit(5);
  if (error) throw new Error(`read delivery: ${error.code}`);
  const now = new Date().toISOString();
  for (const r of (rows ?? []) as { id: string; status: string }[]) {
    const update: Record<string, unknown> = { provider_status: providerStatus, last_event_at: now };
    if ((RANK[status] ?? 0) > (RANK[r.status] ?? 0)) {
      update.status = status;
      if (status === "delivered") update.delivered_at = now;
      if (note) update.error = note;
    }
    await svc.from("message_deliveries").update(update).eq("id", r.id);
  }
  return (rows ?? []).length;
}

export default async function webhookRoutes(app: FastifyInstance) {
  // Signatures are over the exact bytes received, so these routes keep the raw body.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/resend", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!env.RESEND_WEBHOOK_SECRET) throw unavailable("Set RESEND_WEBHOOK_SECRET to accept Resend webhooks");
    const raw = typeof request.body === "string" ? request.body : "";
    const ok = verifySvix(
      env.RESEND_WEBHOOK_SECRET,
      {
        id: request.headers["svix-id"] as string | undefined,
        timestamp: request.headers["svix-timestamp"] as string | undefined,
        signature: request.headers["svix-signature"] as string | undefined,
      },
      raw
    );
    if (!ok) throw unauthorized();
    let event: { type?: string; data?: { email_id?: string } };
    try {
      event = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "Invalid JSON" });
    }
    const mapped = resendStatus(String(event.type ?? ""));
    const id = event.data?.email_id;
    if (!mapped || !id) return { ignored: true };
    const matched = await applyStatus("resend", id, mapped.status, String(event.type), mapped.note);
    return { matched };
  });

  app.post("/twilio/status", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!env.TWILIO_AUTH_TOKEN || !env.PUBLIC_API_URL) throw unavailable("Set TWILIO_AUTH_TOKEN and PUBLIC_API_URL to accept Twilio callbacks");
    const raw = typeof request.body === "string" ? request.body : "";
    const params = Object.fromEntries(new URLSearchParams(raw));
    const url = `${env.PUBLIC_API_URL.replace(/\/+$/, "")}/webhooks/twilio/status`;
    if (!verifyTwilio(env.TWILIO_AUTH_TOKEN, url, params, request.headers["x-twilio-signature"] as string | undefined)) throw unauthorized();
    const status = twilioStatus(String(params.MessageStatus ?? ""));
    const sid = params.MessageSid;
    if (!status || !sid) return reply.code(204).send();
    await applyStatus("twilio", sid, status, String(params.MessageStatus), status === "failed" ? `Twilio: ${params.ErrorCode ?? params.MessageStatus}` : null);
    return reply.code(204).send();
  });
}
