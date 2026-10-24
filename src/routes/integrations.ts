/**
 * Suite integrations.
 *
 * Both suites ask in two steps: Connect is identity plus files (Google: drive.file, only the
 * files the counselor picks; Microsoft: Files.Read.All until PR B moves it to the picker), and
 * Calendar is added on request (`?add=calendar`). Neither lights up mail. The granular provider
 * values (`common-app`, `scoir`, `csv`, ...) stay for the imports that really
 * are separate things.
 *
 * `google` and `microsoft` connect through a real OAuth handshake
 * (lib/oauth.ts): `GET /:provider/authorize` returns the consent URL, the
 * provider redirects the browser to an app page, that page POSTs the code and
 * state to the authenticated `POST /:provider/complete`, and the tokens
 * land encrypted in `integration_tokens` — a service-role-only table — never in
 * `integrations.config`. The `integrations` row is the visible grant, and its
 * `scopes` are what the provider actually returned.
 *
 * The other providers still only record a grant with `PUT /:provider`; nothing
 * syncs for them.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { badRequest, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { importNameRestricted } from "../lib/context/documentAi.js";
import { guessText, requestExtraction } from "../lib/documentExtraction.js";
import { guessKind, importFields } from "../lib/documentGuess.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { enforceQuota, limit } from "../lib/limits.js";
import {
  accessTokenFor,
  beginAuthorization,
  completeAuthorization,
  connectedAccountEmail,
  GOOGLE_SCOPE,
  microsoftConsentUrl,
  MSA_TENANT_ID,
  hasScope,
  pickerConfigProblem,
  providerLabel,
  revokeAndForget,
  SUITE_PROVIDERS,
  unavailableReason,
  type SuiteProvider,
} from "../lib/oauth.js";
import { toDocument, toIntegration } from "../lib/serialize.js";
import { isActiveContentFile } from "../lib/storagePath.js";
import { serviceClient } from "../lib/supabase.js";
import {
  assertFileId,
  downloadRemoteFile,
  getRemoteFile,
  listRemoteFiles,
} from "../lib/suiteApi.js";
import { assertOwnFolder, assertSameStudentTree, studentFolderId } from "./files.js";

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

const completeBody = z
  .object({
    code: z.string().min(1).max(4096),
    state: z.string().min(1).max(512),
  })
  .strict();

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
        "recommendation-letter", "activity-list", "iep-504", "counselor-only",
      ])
      .optional(),
    availableToLlm: z.boolean().optional(),
  })
  .strict();

const GRANT_COLUMNS = "id, provider, status, scopes, last_synced_at, last_error, updated_at";
const BUCKET = "student-documents";

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
    const accounts = new Map<string, { email: string | null; connectedAt: string | null; scopes: string[] }>();
    if (db) {
      const { data } = await db
        .from("integration_tokens")
        .select("provider, account_email, created_at, scopes")
        .eq("owner_id", request.auth.userId);
      for (const r of data ?? []) {
        accounts.set(String(r.provider), {
          email: (r.account_email as string | null) ?? null,
          connectedAt: (r.created_at as string | null) ?? null,
          scopes: (r.scopes as string[] | null) ?? [],
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
        calendarEnabled: account ? account.scopes.some((s) => /calendar\.events$|calendars\.readwrite$/i.test(s)) : false,
        driveGranted: account ? account.scopes.some((s) => /drive\.file$|files\.read/i.test(s)) : false,
        // Until the Railway variables are set the app hides the Drive button (Elvin, 10/15).
        pickerReady:
          provider === "google" &&
          reason === null &&
          pickerConfigProblem({ clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_PICKER_API_KEY, projectNumber: env.GOOGLE_PROJECT_NUMBER }) === null,
        maxFiles: provider === "google" ? env.GOOGLE_PICKER_MAX_FILES : env.MICROSOFT_PICKER_MAX_FILES,
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
      const { add } = z.object({ add: z.enum(["calendar"]).optional() }).strict().parse(request.query ?? {});
      return { url: await beginAuthorization(request.auth.userId, provider, { add: add ?? null }) };
    }
  );

  /**
   * Finish a sign-in. The provider redirected the browser to an app page, not
   * here; that page runs under the counselor's session and posts what it was
   * handed. The state is consumed only if the caller started it, so a consent
   * link someone else began can't attach this counselor's account to theirs.
   * There is deliberately no unauthenticated GET callback.
   */
  app.post(
    "/:provider/complete",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("integrations:complete", 20, 60, "You're finishing sign-ins very fast."),
      ],
    },
    async (request) => {
      const { provider } = suiteParam.parse(request.params);
      const body = completeBody.parse(request.body);
      const { scopes } = await completeAuthorization(
        request.auth.userId,
        provider,
        body.code,
        body.state,
        request.log
      );
      return { connected: true, provider, scopes };
    }
  );

  // ---- Files -----------------------------------------------------------------

  /**
   * What the browser needs to open Google Picker (spec §4.2). The API key is public by nature and
   * restricted in Google Cloud; no token or secret is returned. The browser gets its own
   * drive.file-only token from Google.
   */
  app.get(
    "/google/picker-config",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("integrations:picker-config", 60, 60),
      ],
    },
    async (request) => {
      const problem = pickerConfigProblem({ clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_PICKER_API_KEY, projectNumber: env.GOOGLE_PROJECT_NUMBER });
      if (problem) throw new HttpError(503, problem, "picker_not_configured");
      const token = await accessTokenFor(request.auth.userId, "google"); // 409 google_disconnected / google_reconnect
      if (!hasScope(token, GOOGLE_SCOPE.driveFile)) {
        throw new HttpError(409, "Meridies needs access to the files you pick. Connect Google again and leave Drive ticked.", "drive_not_granted");
      }
      return {
        clientId: env.GOOGLE_CLIENT_ID,
        apiKey: env.GOOGLE_PICKER_API_KEY,
        appId: env.GOOGLE_PROJECT_NUMBER,
        accountEmail: token.accountEmail,
        maxFiles: env.GOOGLE_PICKER_MAX_FILES,
      };
    }
  );

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
   * to the live file so the task tracker can see later edits. No text is read
   * at import. With no `kind` the file arrives unconfirmed and kept out of AI,
   * with a server guess of its type (a label only; the text it read is dropped);
   * the counselor confirms it later and text extraction runs then. A named kind
   * is confirmed at once and extracted unless kept out.
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
        // Anywhere in another student's folder tree, not just its top folder: a
        // custom subfolder carries no student_id, and whoever is handed that tree
        // (a caseload transfer) must never be handed this student's file with it.
        await assertSameStudentTree(request, folder, studentId);
        folderId = b.folderId;
      } else {
        folderId = await studentFolderId(request, studentId);
      }

      await enforceQuota(request.auth.userId, "uploads", "day", 500, "You've registered a lot of files today.");

      let file;
      try {
        file = await getRemoteFile(request.auth.userId, provider, b.fileId, b.driveId ?? null, request.log);
      } catch (err) {
        if (provider === "google" && err instanceof HttpError && err.code === "not_found") {
          const email = (await connectedAccountEmail(request.auth.userId, "google")) ?? "your connected Google account";
          throw new HttpError(
            409,
            `Meridies can't open that file. It may have been picked with a different Google account, or it's no longer available. Pick it again with ${email}.`,
            "picked_file_unavailable"
          );
        }
        throw err;
      }
      const download = await downloadRemoteFile(request.auth.userId, provider, file, request.log);
      if (isActiveContentFile(download.filename, download.mimeType)) {
        throw badRequest("SVG and HTML files can't be added. Save it as a PDF or an image instead.");
      }
      // The guess reads a little text in memory and drops it; nothing from it is stored but the label.
      const guess = b.kind === undefined
        ? guessKind({
            filename: file.name,
            mimeType: file.mimeType,
            text: await guessText(
              new Uint8Array(download.bytes.buffer, download.bytes.byteOffset, download.bytes.byteLength),
              download.mimeType,
              download.filename
            ),
          })
        : guessKind({ filename: file.name, mimeType: file.mimeType, text: null });
      const fields = importFields({ kind: b.kind, availableToLlm: b.availableToLlm, guess });

      const safeName = download.filename.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180);
      const storagePath = `${studentId}/${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
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
          kind: fields.kind,
          kind_confirmed: fields.kind_confirmed,
          kind_guess: fields.kind_guess,
          source: "integration",
          available_to_llm: fields.available_to_llm,
          uploaded_by: request.auth.userId,
          parse_status: "pending",
          parsed_data: {},
          extraction_requested_at: fields.requestExtraction ? new Date().toISOString() : null,
          extraction_attempts: 0,
          extraction_lease_until: null,
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
        // The student reads this log: a restricted file's name stays out of it.
        metadata: importNameRestricted(String(data.kind ?? "other"), guess) ? { source: provider } : { filename: download.filename, source: provider },
      });

      if (fields.requestExtraction) requestExtraction([String(data.id)], request.log);

      return reply.code(201).send(toDocument(data as Row));
    }
  );

  // ---- Grants ----------------------------------------------------------------

  /**
   * Record a grant for a provider that has no handshake. Google and Microsoft
   * are refused here: their grant is written by the OAuth completion, from the
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
      let consentUrl: string | null = null;
      if (provider === "microsoft") {
        const { data: grant } = await request.db
          .from("integrations")
          .select("config")
          .eq("owner_id", request.auth.userId)
          .eq("provider", "microsoft")
          .maybeSingle();
        const config = (grant?.config ?? {}) as { microsoftAccount?: unknown; tenantId?: unknown };
        consentUrl = microsoftConsentUrl(
          config.microsoftAccount === "personal" ? MSA_TENANT_ID : typeof config.tenantId === "string" ? config.tenantId : null
        );
      }
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
        // Microsoft only: the page where that consent is removed (personal accounts vs work or school).
        consentUrl,
      };
    }
  );
}
