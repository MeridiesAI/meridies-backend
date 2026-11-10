/**
 * Push subscriptions for the signed-in user's own devices.
 *
 *   GET    /push/config   { available, publicKey } : the VAPID public key the browser subscribes with
 *   GET    /push          this user's registered devices (no keys)
 *   POST   /push          register a device (a re-register of the same endpoint refreshes it)
 *   DELETE /push          remove a device by endpoint (sign-out, or "turn off alerts on this device")
 *
 * Off (503 push_unavailable) until the VAPID settings and migration 20261114000001 exist. RLS limits every row to
 * its owner; the `user_id` filters here are the code-level half of the same rule. What is delivered is generic by
 * design (lib/push.ts).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env, hasPush } from "../env.js";
import { fromPostgrest, HttpError } from "../lib/errors.js";
import { limit } from "../lib/limits.js";

const MAX_DEVICES = 10;

const subscribeBody = z
  .object({
    endpoint: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "endpoint must be https"),
    keys: z.object({ p256dh: z.string().min(10).max(512), auth: z.string().min(4).max(512) }).strict(),
    userAgent: z.string().max(300).optional(),
  })
  .strict();

const removeBody = z.object({ endpoint: z.string().url().max(2048) }).strict();

function unavailable() {
  return new HttpError(503, "Push notifications aren't switched on yet", "push_unavailable");
}

export default async function pushRoutes(app: FastifyInstance) {
  app.get("/config", { preHandler: [app.authenticate, limit("push:config", 120, 60)] }, async () => ({
    available: hasPush,
    publicKey: hasPush ? (env.VAPID_PUBLIC_KEY as string) : null,
  }));

  app.get("/", { preHandler: [app.authenticate, limit("push:list", 120, 60)] }, async (request) => {
    if (!hasPush) throw unavailable();
    const { data, error } = await request.db
      .from("push_subscriptions")
      .select("id, channel, endpoint, user_agent, created_at, last_used_at")
      .eq("user_id", request.auth.userId)
      .order("created_at", { ascending: false });
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => ({
      id: r.id,
      channel: r.channel,
      endpoint: r.endpoint,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  });

  app.post("/", { preHandler: [app.authenticate, limit("push:subscribe", 30, 60)] }, async (request, reply) => {
    if (!hasPush) throw unavailable();
    const b = subscribeBody.parse(request.body);

    const { count, error: countErr } = await request.db
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", request.auth.userId)
      .neq("endpoint", b.endpoint);
    if (countErr) throw fromPostgrest(countErr);
    if ((count ?? 0) >= MAX_DEVICES) {
      throw new HttpError(409, `You can turn on alerts for up to ${MAX_DEVICES} devices. Remove one first.`, "too_many_devices");
    }

    const { error } = await request.db.from("push_subscriptions").upsert(
      {
        user_id: request.auth.userId,
        channel: "web",
        endpoint: b.endpoint,
        p256dh: b.keys.p256dh,
        auth: b.keys.auth,
        user_agent: b.userAgent ?? null,
      },
      { onConflict: "user_id,endpoint" }
    );
    if (error) throw fromPostgrest(error);
    return reply.code(201).send({ ok: true });
  });

  app.delete("/", { preHandler: [app.authenticate, limit("push:remove", 60, 60)] }, async (request, reply) => {
    const b = removeBody.parse(request.body);
    const { error } = await request.db
      .from("push_subscriptions")
      .delete()
      .eq("user_id", request.auth.userId)
      .eq("endpoint", b.endpoint);
    if (error) throw fromPostgrest(error);
    return reply.code(204).send();
  });
}
