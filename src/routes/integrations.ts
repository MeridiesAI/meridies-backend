/**
 * Suite integrations.
 *
 * One consent covers a whole provider: connecting Google lights up Drive, Gmail
 * and Calendar together rather than asking three times. The granular provider
 * values (`common-app`, `scoir`, `csv`, ...) stay for the imports that really
 * are separate things.
 *
 * This route records the *grant*, not the secret. OAuth tokens are held out of
 * band; `config` never leaves the server, and `scopes` is served so the manage
 * panel can show what was actually consented to rather than what was asked for.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { limit } from "../lib/limits.js";
import { toIntegration } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const PROVIDERS = [
  "google", "microsoft",
  "google-drive", "google-calendar", "onedrive",
  "common-app", "scoir", "maialearning", "csv", "gmail", "outlook", "twilio",
] as const;

const providerParam = z.object({ provider: z.enum(PROVIDERS) });

const connectBody = z
  .object({
    scopes: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  })
  .strict();

const statusBody = z
  .object({
    status: z.enum(["disconnected", "connected", "error", "syncing"]),
    lastError: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

export default async function integrationRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: app.authenticate }, async (request) => {
    const { data, error } = await request.db
      .from("integrations")
      .select("id, provider, status, scopes, last_synced_at, last_error, updated_at")
      .eq("owner_id", request.auth.userId)
      .order("provider")
      .limit(50);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toIntegration(r as Row));
  });

  /**
   * Record a grant. The OAuth dance itself happens outside this API; this is
   * where the result is written, which is why it only ever takes scopes.
   */
  app.put(
    "/:provider",
    { preHandler: [app.authenticate, limit("integrations:connect", 30, 60)] },
    async (request) => {
      const { provider } = providerParam.parse(request.params);
      const body = connectBody.parse(request.body ?? {});

      const { data, error } = await request.db
        .from("integrations")
        .upsert(
          {
            owner_id: request.auth.userId,
            provider,
            status: "connected",
            scopes: body.scopes ?? [],
            last_error: null,
          },
          { onConflict: "owner_id,provider" }
        )
        .select("id, provider, status, scopes, last_synced_at, last_error, updated_at")
        .single();
      if (error) throw fromPostgrest(error);
      return toIntegration(data as Row);
    }
  );

  app.patch(
    "/:provider",
    { preHandler: [app.authenticate, limit("integrations:update", 120, 60)] },
    async (request) => {
      const { provider } = providerParam.parse(request.params);
      const body = statusBody.parse(request.body);

      const values: Record<string, unknown> = {
        status: body.status,
        last_error: body.lastError ?? null,
      };
      // A successful sync is the only thing that moves the timestamp; an error
      // or a disconnect must not make the connection look freshly healthy.
      if (body.status === "connected") values.last_synced_at = new Date().toISOString();

      const { data, error } = await request.db
        .from("integrations")
        .update(values)
        .eq("owner_id", request.auth.userId)
        .eq("provider", provider)
        .select("id, provider, status, scopes, last_synced_at, last_error, updated_at")
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That integration isn't connected");
      return toIntegration(data as Row);
    }
  );

  /**
   * Disconnecting drops the row rather than flipping a flag: a revoked grant
   * should not leave a list of scopes behind claiming otherwise.
   */
  app.delete(
    "/:provider",
    { preHandler: [app.authenticate, limit("integrations:disconnect", 30, 60)] },
    async (request) => {
      const { provider } = providerParam.parse(request.params);
      const { error } = await request.db
        .from("integrations")
        .delete()
        .eq("owner_id", request.auth.userId)
        .eq("provider", provider);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}
