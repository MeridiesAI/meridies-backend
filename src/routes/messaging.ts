/**
 * A consultant's own texting number.
 *
 *   GET  /messaging/number          { available, number | null }  what they have, and whether this deployment can buy one
 *   POST /messaging/number/search   { areaCode? } -> { numbers }  up to five US numbers that can text
 *   POST /messaging/number          { phone } -> { number }       buy that one, for this counselor
 *
 * Texts to a family go from this number, and a family's reply to it lands in
 * the app (`lib/inboundSms.ts`). One number per counselor. A purchase costs
 * real money, so it takes a number the counselor picked from a search, is
 * rate-limited, and is undone (the number released) if recording it fails.
 *
 * The row is written with the service role (clients have no write grant on
 * `consultant_phone_numbers`), keyed by the signed-in counselor and never by
 * anything in the request. Calm when not switched on: without Twilio's account
 * keys and PUBLIC_API_URL, GET says `available: false` and the others answer
 * 503 `texting_unavailable`; without the migration the same.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { fromPostgrest, HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { consumeRateLimit, limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { serviceClient } from "../lib/supabase.js";
import { buyNumber, numbersConfigured, releaseNumber, searchNumbers, TwilioNumberError } from "../lib/twilioNumbers.js";

/** A safety stop on how many numbers this deployment will ever hold. */
const NUMBER_CAP = 200;

const unavailable = () => new HttpError(503, "Texting numbers aren't switched on yet", "texting_unavailable");

export default async function messagingRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/number", { preHandler: [...counselor, limit("messaging:number", 60, 60)] }, async (request) => {
    const { data, error } = await request.db
      .from("consultant_phone_numbers")
      .select("phone_e164, status, created_at")
      .eq("counselor_id", request.auth.userId)
      .eq("status", "active")
      .maybeSingle();
    if (error && !isResultsNotApplied(error)) throw fromPostgrest(error);
    const migrated = !error;
    const row = data as { phone_e164: string; created_at: string } | null;
    return {
      available: migrated && numbersConfigured(),
      number: row ? { phone: row.phone_e164, since: row.created_at } : null,
    };
  });

  app.post("/number/search", { preHandler: [...counselor, limit("messaging:number-search", 20, 3600)] }, async (request) => {
    if (!numbersConfigured()) throw unavailable();
    const b = z
      .object({ areaCode: z.string().regex(/^[2-9]\d{2}$/, "An area code is three digits").optional() })
      .strict()
      .parse(request.body ?? {});
    try {
      return { numbers: await searchNumbers(b.areaCode) };
    } catch (err) {
      if (err instanceof TwilioNumberError) throw new HttpError(err.status, err.message);
      throw err;
    }
  });

  app.post("/number", { preHandler: [...counselor, limit("messaging:number-buy", 5, 3600)] }, async (request, reply) => {
    if (!numbersConfigured()) throw unavailable();
    const b = z
      .object({ phone: z.string().regex(/^\+1[2-9]\d{9}$/, "Pick a number from the search") })
      .strict()
      .parse(request.body);
    const svc = serviceClient();
    if (!svc) throw unavailable();
    const me = request.auth.userId;

    // Read as the caller (RLS) so a database without the migration reads as "not switched on".
    const mine = await request.db.from("consultant_phone_numbers").select("phone_e164").eq("counselor_id", me).maybeSingle();
    if (mine.error) {
      if (isResultsNotApplied(mine.error)) throw unavailable();
      throw fromPostgrest(mine.error);
    }
    if (mine.data) throw new HttpError(409, "You already have a texting number", "number_exists");

    const held = await svc.from("consultant_phone_numbers").select("counselor_id", { count: "exact", head: true }).eq("status", "active");
    if (held.error) throw fromPostgrest(held.error);
    if ((held.count ?? 0) >= NUMBER_CAP) throw unavailable();

    // One purchase attempt a minute per counselor, so a double-click can't buy two.
    if (!(await consumeRateLimit(`number-buy:${me}`, 1, 60))) {
      throw new HttpError(429, "Already working on a number for you. Give it a moment.");
    }

    let bought: { sid: string; phone: string };
    try {
      bought = await buyNumber(b.phone);
    } catch (err) {
      if (err instanceof TwilioNumberError) throw new HttpError(err.status, err.message);
      throw err;
    }

    const ins = await svc.from("consultant_phone_numbers").insert({ counselor_id: me, phone_e164: bought.phone, twilio_sid: bought.sid });
    if (ins.error) {
      // Never keep a number nobody can use: give it back.
      await releaseNumber(bought.sid).catch((e) => request.log.error({ err: e instanceof Error ? e.message : String(e) }, "could not release a number after a failed save"));
      if (ins.error.code === "23505") {
        // The primary key is "this counselor already has one"; the unique number is "someone else just took it".
        if (/phone_e164/.test(ins.error.message)) throw new HttpError(409, "That number was just taken. Search again.", "number_taken");
        throw new HttpError(409, "You already have a texting number", "number_exists");
      }
      throw fromPostgrest(ins.error);
    }
    request.log.info({ counselor: me }, "texting number activated");
    if (!env.TWILIO_MESSAGING_SERVICE_SID) {
      request.log.warn("TWILIO_MESSAGING_SERVICE_SID unset: the number is not under a registered A2P campaign");
    }
    return reply.code(201).send({ number: { phone: bought.phone, since: new Date().toISOString() } });
  });
}
