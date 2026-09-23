/**
 * Suite integrations.
 *
 * One consent covers a whole provider: connecting Google lights up Drive, Gmail
 * and Calendar together rather than asking three times. The granular provider
 * values (`common-app`, `scoir`, `csv`, ...) stay for the imports that really
 * are separate things.
 *
 * `google` and `microsoft` connect through a real OAuth handshake
 * (lib/oauth.ts): `GET /:provider/authorize` returns the consent URL, the
 * provider redirects the browser to `GET /:provider/callback`, and the tokens
 * land encrypted in `integration_tokens` — a service-role-only table — never in
 * `integrations.config`. The `integrations` row is the visible grant, and its
 * `scopes` are what the provider actually returned.
 *
 * The other providers still only record a grant with `PUT /:provider`; nothing
 * syncs for them.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { badRequest, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { enforceQuota, limit } from "../lib/limits.js";
import {
  beginAuthorization,
  completeAuthorization,
  OAuthCallbackError,
  providerLabel,
  revokeAndForget,
  SUITE_PROVIDERS,
  unavailableReason,
  type SuiteProvider,
} from "../lib/oauth.js";
import { toDocument, toIntegration } from "../lib/serialize.js";
import { serviceClient } from "../lib/supabase.js";
import {
  assertFileId,
  downloadRemoteFile,
  exportGoogleDocText,
  getRemoteFile,
  listRemoteFiles,
} from "../lib/suiteApi.js";
import { assertOwnFolder, studentFolderId } from "./files.js";

type Row = Record<string, unknown>;

const PROVIDERS = [
  "google", "microsoft",
  "google-drive", "google-calendar", "onedrive",
  "common-app", "scoir", "maialearning", "csv", "gmail", "outlook", "twilio",
] as const;

const isSuite = (p: string): p is SuiteProvider =>
  (SUITE_PROVIDERS as readonly string[]).includes(p);

const providerParam = z.object({ provider: z.enum(PROVIDERS) });
const suiteParam = z.object({ provider: z.enum(SUITE_PROVIDERS) });

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

const callbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
});

const importBody = z
  .object({
    fileId: z.string().trim().min(1).max(300),
    driveId: z.string().trim().min(1).max(300).nullable().optional(),
    studentId: z.string().uuid(),
    folderId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(300).nullable().optional(),
    kind: z
      .enum([
        "transcript", "resume", "essay", "test-report", "award-letter",
        "financial", "common-app", "other",
      ])
      .optional(),
    availableToLlm: z.boolean().optional(),
  })
  .strict();

const GRANT_COLUMNS = "id, provider, status, scopes, last_synced_at, last_error, updated_at";
const BUCKET = "student-documents";

/** Where the browser lands after consent: the Connected apps tab. */
function appReturnUrl(provider: string, result: "connected" | "error", message?: string): string {
  const url = new URL("/dashboard/counselor/data-hub", env.APP_URL);
  url.searchParams.set("integration", provider);
  url.searchParams.set("result", result);
  if (message) url.searchParams.set("message", message.slice(0, 200));
  url.hash = "apps";
  return url.toString();
}

export default async function integrationRoutes(app: FastifyInstance) {
  app.get(
    "/",
    { preHandler: [app.authenticate, limit("integrations:list", 120, 60)] },
    async (request) => {
      const { data, error } = await request.db
        .from("integrations")
        .select(GRANT_COLUMNS)
        .eq("owner_id", request.auth.userId)
        .order("provider")
        .limit(50);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => toIntegration(r as Row));
    }
  );

  /**
   * Whether each suite can be connected on this server, and — when connected —
   * which account it is. Presence only: never a client id or any token.
   */
  app.get("/providers", { preHandler: app.authenticate }, async (request) => {
    const db = serviceClient();
    const accounts = new Map<string, { email: string | null; connectedAt: string | null }>();
    if (db) {
      const { data } = await db
        .from("integration_tokens")
        .select("provider, account_email, created_at")
        .eq("owner_id", request.auth.userId);
      for (const r of data ?? []) {
        accounts.set(String(r.provider), {
          email: (r.account_email as string | null) ?? null,
          connectedAt: (r.created_at as string | null) ?? null,
        });
      }
    }
    return SUITE_PROVIDERS.map((provider) => {
      const reason = unavailableReason(provider);
      const account = accounts.get(provider) ?? null;
      return {
        provider,
        available: reason === null,
        unavailableReason: reason,
        tokensHeld: Boolean(account),
        accountEmail: account?.email ?? null,
        connectedAt: account?.connectedAt ?? null,
      };
    });
  });

  // ---- OAuth -----------------------------------------------------------------

  /** The provider consent URL. The browser navigates there; nothing is stored but the state. */
  app.get(
    "/:provider/authorize",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("integrations:authorize", 20, 60, "You're starting sign-ins very fast."),
      ],
    },
    async (request) => {
      const { provider } = suiteParam.parse(request.params);
      return { url: await beginAuthorization(request.auth.userId, provider) };
    }
  );

  /**
   * The provider's redirect. No Meridies session rides along — the consumed
   * `state` row is what says whose grant this is. Always answers with a
   * redirect back to the app, carrying a message we wrote (never the
   * provider's own error text).
   */
  app.get("/:provider/callback", async (request, reply) => {
    const parsedParams = suiteParam.safeParse(request.params);
    if (!parsedParams.success) return reply.code(404).send({ error: "Not found" });
    const provider = parsedParams.data.provider;
    const q = callbackQuery.safeParse(request.query);
    const query = q.success ? q.data : {};

    if (query.error || !query.code || !query.state) {
      const message =
        query.error === "access_denied"
          ? `You cancelled the ${providerLabel(provider)} sign-in. Nothing was connected.`
          : `${providerLabel(provider)} didn't complete the sign-in. Nothing was connected.`;
      return reply.redirect(appReturnUrl(provider, "error", message), 302);
    }

    try {
      await completeAuthorization(provider, query.code, query.state, request.log);
      return reply.redirect(appReturnUrl(provider, "connected"), 302);
    } catch (err) {
      const message =
        err instanceof OAuthCallbackError || err instanceof HttpError
          ? err.message
          : `Couldn't finish connecting ${providerLabel(provider)}. Try again.`;
      if (!(err instanceof OAuthCallbackError)) {
        request.log.error({ provider, err: err instanceof Error ? err.message : "unknown" }, "oauth callback failed");
      }
      return reply.redirect(appReturnUrl(provider, "error", message), 302);
    }
  });

  // ---- Files -----------------------------------------------------------------

  /** Drive / OneDrive files the counselor's connected account can see. */
  app.get(
    "/:provider/files",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("integrations:files", 60, 60, "You're browsing files very fast."),
      ],
    },
    async (request) => {
      const { provider } = suiteParam.parse(request.params);
      const { q } = z
        .object({ q: z.string().trim().max(200).optional() })
        .parse(request.query);
      return listRemoteFiles(request.auth.userId, provider, q || undefined, request.log);
    }
  );

  /**
   * Copy a chosen file into the student's folder as a document.
   *
   * The Storage upload runs on the caller's own client, exactly as a browser
   * upload would, so the bucket's own policies apply. The row keeps a pointer
   * to the live file so the task tracker can see later edits. A Google Doc
   * also gets its plain text in `parsed_data` — but only when the document is
   * left available to AI, because that text exists to be read into a prompt.
   */
  app.post(
    "/:provider/files/import",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("integrations:import", 30, 60, "You're importing files very fast."),
      ],
    },
    async (request, reply) => {
      const { provider } = suiteParam.parse(request.params);
      const b = importBody.parse(request.body);
      assertFileId(provider, b.fileId, b.driveId ?? null);

      const studentId = await resolveStudentId(request, b.studentId, "edit");
      let folderId: string | null = null;
      if (b.folderId) {
        const folder = await assertOwnFolder(request, b.folderId);
        if (folder.student_id && folder.student_id !== studentId) {
          throw badRequest("That folder belongs to a different student");
        }
        folderId = b.folderId;
      } else {
        folderId = await studentFolderId(request, studentId);
      }

      await enforceQuota(request.auth.userId, "uploads", "day", 500, "You've registered a lot of files today.");

      const file = await getRemoteFile(request.auth.userId, provider, b.fileId, b.driveId ?? null, request.log);
      const download = await downloadRemoteFile(request.auth.userId, provider, file, request.log);
      const availableToLlm = b.availableToLlm ?? true;
      const text = availableToLlm ? await exportGoogleDocText(request.auth.userId, file, request.log) : null;

      const safeName = download.filename.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180);
      const storagePath = `${studentId}/${Date.now()}-${safeName}`;
      const { error: storageError } = await request.db.storage
        .from(BUCKET)
        .upload(storagePath, download.bytes, { contentType: download.mimeType, upsert: false });
      if (storageError) {
        request.log.warn({ provider, err: storageError.message }, "integration import storage upload failed");
        throw new HttpError(502, "The file was read but couldn't be stored. Try again.");
      }

      const { data, error } = await request.db
        .from("documents")
        .insert({
          owner_id: request.auth.userId,
          student_id: studentId,
          folder_id: folderId,
          bucket: BUCKET,
          storage_path: storagePath,
          filename: download.filename.slice(0, 300),
          title: b.title ?? null,
          mime_type: download.mimeType,
          size_bytes: download.bytes.length,
          kind: b.kind ?? (file.kind === "document" ? "essay" : "other"),
          source: "integration",
          available_to_llm: availableToLlm,
          uploaded_by: request.auth.userId,
          parse_status: text ? "parsed" : "pending",
          parsed_data: text
            ? { text, extractedFrom: "google-docs-export", extractedAt: new Date().toISOString() }
            : {},
          external_provider: provider,
          external_file_id: file.id,
          external_drive_id: file.driveId,
          external_web_url: file.webUrl,
          external_modified_at: file.modifiedAt,
        })
        .select("*")
        .single();
      if (error) {
        await request.db.storage.from(BUCKET).remove([storagePath]);
        throw fromPostgrest(error);
      }

      // Same as a browser upload: the accountability engine reads this.
      await request.db.from("progress_events").insert({
        student_id: studentId,
        entity_type: "document",
        entity_id: data.id as string,
        event: "uploaded",
        actor_id: request.auth.userId,
        metadata: { filename: download.filename, source: provider },
      });

      return reply.code(201).send(toDocument(data as Row));
    }
  );

  // ---- Grants ----------------------------------------------------------------

  /**
   * Record a grant for a provider that has no handshake. Google and Microsoft
   * are refused here: their grant is written by the OAuth callback, from the
   * scopes the provider returned, and a hand-written one would claim access
   * that was never given.
   */
  app.put(
    "/:provider",
    { preHandler: [app.authenticate, limit("integrations:connect", 30, 60)] },
    async (request) => {
      const { provider } = providerParam.parse(request.params);
      if (isSuite(provider)) {
        throw badRequest(`${providerLabel(provider)} connects through its own sign-in. Use Connect.`);
      }
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
        .select(GRANT_COLUMNS)
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
      // `last_synced_at` is deliberately NOT touched here. Resuming a grant is
      // not a sync, and stamping it would let the UI show a "last synced" time
      // for data that never moved.

      const { data, error } = await request.db
        .from("integrations")
        .update(values)
        .eq("owner_id", request.auth.userId)
        .eq("provider", provider)
        .select(GRANT_COLUMNS)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That integration isn't connected");
      return toIntegration(data as Row);
    }
  );

  /**
   * Disconnecting drops the row rather than flipping a flag: a revoked grant
   * should not leave a list of scopes behind claiming otherwise. For Google and
   * Microsoft the tokens are revoked (where the provider allows it) and
   * deleted first.
   */
  app.delete(
    "/:provider",
    { preHandler: [app.authenticate, limit("integrations:disconnect", 30, 60)] },
    async (request) => {
      const { provider } = providerParam.parse(request.params);

      let revokedAtProvider: boolean | null = null;
      if (isSuite(provider)) {
        ({ revokedAtProvider } = await revokeAndForget(request.auth.userId, provider, request.log));
      }

      const { error } = await request.db
        .from("integrations")
        .delete()
        .eq("owner_id", request.auth.userId)
        .eq("provider", provider);
      if (error) throw fromPostgrest(error);

      return {
        deleted: true,
        revokedAtProvider,
        note:
          provider === "microsoft"
            ? "Meridies deleted its Microsoft tokens. Microsoft has no per-app revoke call; remove Meridies under your account's app permissions to withdraw consent there too."
            : null,
      };
    }
  );
}
