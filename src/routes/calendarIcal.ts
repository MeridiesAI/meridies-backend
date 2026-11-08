/**
 * A counselor's calendar, subscribed from Google / Apple / Outlook.
 *
 *   GET    /calendar/ical/:token.ics   public: the .ics (the token in the path is the credential)
 *   GET    /calendar/ical              the caller's feed: exists, createdAt, rotatedAt, lastFetchedAt (never the URL)
 *   POST   /calendar/ical              make the URL, or replace it (the old one stops at once); the URL is shown ONCE
 *   DELETE /calendar/ical              revoke: the URL stops working
 *
 * Absolute paths, like routes/pay.ts. The public route has no user, so it reads
 * with the service role: it finds the counselor by the token's sha256, and
 * lib/calendarIcal.ts asks approvedCounselorIds and names the counselor's own
 * caseload in every query (never unscoped). Every refusal (a malformed, unknown,
 * revoked or rotated token, an unapproved counselor) is the same 404 with the
 * same body. Rate limited by address and by token (`enforceRateLimit`). The
 * authenticated routes write only the caller's own row, keyed by
 * request.auth.userId. Before migration 20261111000002 the authenticated routes
 * answer 503 `calendar_feed_unavailable` and the feed URL 404s.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { env } from "../env.js";
import { isMissingTable } from "../lib/calendarFeed.js";
import { counselorFeedIcs, FEED_TOKEN, feedUrls, hashFeedToken, newFeedToken } from "../lib/calendarIcal.js";
import { HttpError, fromPostgrest } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { enforceRateLimit, limit } from "../lib/limits.js";
import { serializeErr } from "../lib/requestLog.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

/** Fetches of one feed URL an hour (a calendar app polls every 15-60 minutes; a few apps per counselor). */
export const ICAL_TOKEN_PER_HOUR = 60;
/** Fetches from one address an hour, any token: generous, since Google's and Apple's fetchers share addresses. */
export const ICAL_IP_PER_HOUR = 600;

const unavailable = () =>
  new HttpError(503, "The calendar subscription isn't switched on yet", "calendar_feed_unavailable");

const ns = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export default async function calendarIcalRoutes(app: FastifyInstance) {
  const headers = (reply: FastifyReply) =>
    reply.header("Referrer-Policy", "no-referrer").header("X-Robots-Tag", "noindex");
  const notFound = (reply: FastifyReply) =>
    headers(reply).code(404).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Not found\n");

  app.get(
    "/calendar/ical/:file",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { file } = request.params as { file: string };
      await enforceRateLimit(`calendar:ical:ip:${request.ip}`, ICAL_IP_PER_HOUR, 3600);
      const m = /^(.+)\.ics$/.exec(file);
      const token = m?.[1] ?? "";
      if (!FEED_TOKEN.test(token)) return notFound(reply);
      const hash = hashFeedToken(token);
      await enforceRateLimit(`calendar:ical:token:${hash}`, ICAL_TOKEN_PER_HOUR, 3600);

      const svc = serviceClient();
      if (!svc) return notFound(reply);
      let body: string | null;
      let counselorId: string;
      try {
        const { data, error } = await svc
          .from("calendar_feed_tokens")
          .select("counselor_id, last_fetched_at")
          .eq("token_hash", hash)
          .maybeSingle();
        if (error) {
          if (isMissingTable(error)) return notFound(reply);
          throw new Error(`token read failed (${error.code ?? "unknown"})`);
        }
        if (!data) return notFound(reply);
        counselorId = String((data as Row).counselor_id);
        body = await counselorFeedIcs(svc, counselorId);
      } catch (err) {
        request.log.error({ err: serializeErr(err) }, "calendar feed: could not build");
        return headers(reply).code(503).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Try again later\n");
      }
      if (body === null) return notFound(reply);

      // When it was last read, at most once a minute (a conditional update, so concurrent fetches write once).
      const since = new Date(Date.now() - 60_000).toISOString();
      const touch = await svc
        .from("calendar_feed_tokens")
        .update({ last_fetched_at: new Date().toISOString() })
        .eq("counselor_id", counselorId)
        .eq("token_hash", hash)
        .or(`last_fetched_at.is.null,last_fetched_at.lt.${since}`);
      if (touch.error) request.log.warn({ code: touch.error.code }, "calendar feed: last_fetched_at not updated");

      return headers(reply)
        .code(200)
        .header("Cache-Control", "private, max-age=300")
        .header("Content-Disposition", 'inline; filename="meridies.ics"')
        .type("text/calendar; charset=utf-8")
        .send(body);
    }
  );

  const counselorOnly = [app.authenticate, requireRole("counselor")];

  app.get("/calendar/ical", { preHandler: counselorOnly }, async (request) => {
    const svc = serviceClient();
    if (!svc) throw unavailable();
    const { data, error } = await svc
      .from("calendar_feed_tokens")
      .select("created_at, rotated_at, last_fetched_at")
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (error) {
      if (isMissingTable(error)) throw unavailable();
      throw fromPostgrest(error);
    }
    const r = data as Row | null;
    return {
      exists: Boolean(r),
      createdAt: ns(r?.created_at),
      rotatedAt: ns(r?.rotated_at),
      lastFetchedAt: ns(r?.last_fetched_at),
    };
  });

  app.post(
    "/calendar/ical",
    { preHandler: [...counselorOnly, limit("calendar:ical:mint", 10, 3600)] },
    async (request, reply) => {
      const svc = serviceClient();
      if (!svc || !env.PUBLIC_API_URL) throw unavailable();
      const me = request.auth.userId;
      const { token, hash } = newFeedToken();

      let row: Row | null = null;
      let rotated = false;
      const ins = await svc
        .from("calendar_feed_tokens")
        .insert({ counselor_id: me, token_hash: hash })
        .select("created_at, rotated_at, last_fetched_at")
        .maybeSingle();
      if (ins.error && ins.error.code !== "23505") {
        if (isMissingTable(ins.error)) throw unavailable();
        throw fromPostgrest(ins.error);
      }
      if (ins.error) {
        // There is one already: replace it, so the old URL stops working now.
        const up = await svc
          .from("calendar_feed_tokens")
          .update({ token_hash: hash, rotated_at: new Date().toISOString(), last_fetched_at: null })
          .eq("counselor_id", me)
          .select("created_at, rotated_at, last_fetched_at")
          .maybeSingle();
        if (up.error) throw fromPostgrest(up.error);
        row = up.data as Row | null;
        rotated = true;
      } else {
        row = ins.data as Row | null;
      }
      if (!row) throw unavailable();
      return reply
        .code(rotated ? 200 : 201)
        .header("Cache-Control", "no-store")
        .send({
          ...feedUrls(env.PUBLIC_API_URL, token),
          rotated,
          exists: true,
          createdAt: ns(row.created_at),
          rotatedAt: ns(row.rotated_at),
          lastFetchedAt: ns(row.last_fetched_at),
        });
    }
  );

  app.delete(
    "/calendar/ical",
    { preHandler: [...counselorOnly, limit("calendar:ical:mint", 10, 3600)] },
    async (request) => {
      const svc = serviceClient();
      if (!svc) throw unavailable();
      const { data, error } = await svc
        .from("calendar_feed_tokens")
        .delete()
        .eq("counselor_id", request.auth.userId)
        .select("counselor_id");
      if (error) {
        if (isMissingTable(error)) throw unavailable();
        throw fromPostgrest(error);
      }
      return { revoked: (data ?? []).length > 0 };
    }
  );
}
