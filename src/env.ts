import "dotenv/config";
import { z } from "zod";
import { proxyTrust } from "./lib/proxyTrust.js";

/** `KEY=` in a .env file means unset, not an invalid empty value. */
function blankIsUnset<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema);
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  SUPABASE_URL: z.string().url("SUPABASE_URL must be the project URL"),
  SUPABASE_ANON_KEY: z.string().min(20, "SUPABASE_ANON_KEY is required"),
  // Optional: only needed for work a user may not perform as themselves.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  // Import pipeline jobs (save, undo, apply held data) run on a direct
  // Postgres connection that must log in as the restricted `import_worker`
  // role, through Supabase's SESSION pooler (never the transaction pooler).
  // Optional: unset, import commit/undo/apply answer 503.
  IMPORT_DATABASE_URL: blankIsUnset(z.string().url().optional()),
  // Held-data expiry (30 days) and its 7-day warning emails, run by the
  // import sweep. Off unless "true": counselors can't act on held data until
  // the "Ready to apply" page ships.
  IMPORT_HOLD_EXPIRY_ENABLED: blankIsUnset(z.enum(["true", "false"]).optional()),
  // Who sees the step-2 Import page (upload, mapping, review). "pilot" (the
  // default) opens it only to the practices in IMPORTS_PILOT; "all" to every
  // approved counselor; "off" to nobody. "Ready to apply" is never gated.
  IMPORTS_ROLLOUT: blankIsUnset(z.enum(["off", "pilot", "all"]).default("pilot")),
  // Comma-separated practice ids: a firm's id, or a solo counselor's own
  // profile id. Changing it needs a redeploy.
  IMPORTS_PILOT: blankIsUnset(z.string().max(4000).optional()),
  // Kill switch for the AI column mapping. "off" leaves header presets,
  // saved templates and the counselor's own mapping.
  IMPORTS_AI: blankIsUnset(z.enum(["on", "off"]).default("on")),
  // Time saved: activity heartbeats are recorded only when "true". Stays off in
  // production until the privacy policy line about time tracking is live.
  KPI_TRACKING_ENABLED: blankIsUnset(z.enum(["true", "false"]).default("false")),
  // Footer of the monthly Time saved emails: the postal address when there is one,
  // else the contact email. These are relationship emails about the customer's own
  // account (no promotion), so a postal address is optional; add one before any
  // marketing email.
  COMPANY_POSTAL_ADDRESS: blankIsUnset(z.string().min(5).max(300).optional()),
  COMPANY_CONTACT_EMAIL: blankIsUnset(z.string().email().default("team@meridiesai.com")),

  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  // Test double for research (no model, no web). Works only with NODE_ENV
  // development or test; the server refuses to start otherwise, and warns
  // whenever it is on (lib/research/bootGuard.ts).
  RESEARCH_FAKE: blankIsUnset(z.enum(["fixture"]).optional()),

  // Outbound email (student invitations). Optional: without the key, invite
  // creation still works but the email is skipped and logged, rather than
  // failing the request.
  RESEND_API_KEY: z.string().min(10).optional(),
  // "Display Name <address@domain>". Until a domain is verified in Resend, the
  // only deliverable default is Resend's shared onboarding address.
  INVITE_FROM_EMAIL: z.string().default("Meridies <onboarding@resend.dev>"),
  // Local development only: send every email to a Mailpit catcher (the local
  // Supabase stack runs one at http://127.0.0.1:54324) instead of Resend, so
  // invites can be opened without mailing anyone. Ignored in production.
  DEV_MAIL_URL: blankIsUnset(z.string().url().optional()),
  // Base URL of the frontend, used to build the invite accept link.
  APP_URL: z.string().url().default("https://app.meridiesai.com"),

  // Outbound SMS (Twilio REST, no SDK). Optional: without a complete set, an
  // SMS is recorded as `queued` in message_deliveries and never claimed sent.
  // A sender is either a number (E.164) or a Messaging Service; the service
  // wins when both are set.
  TWILIO_ACCOUNT_SID: blankIsUnset(
    z.string().regex(/^AC[0-9a-fA-F]{32}$/, "TWILIO_ACCOUNT_SID must look like AC…").optional()
  ),
  TWILIO_AUTH_TOKEN: blankIsUnset(z.string().min(16).optional()),
  TWILIO_FROM_NUMBER: blankIsUnset(
    z.string().regex(/^\+[1-9]\d{7,14}$/, "TWILIO_FROM_NUMBER must be E.164, e.g. +15551234567").optional()
  ),
  TWILIO_MESSAGING_SERVICE_SID: blankIsUnset(
    z.string().regex(/^MG[0-9a-fA-F]{32}$/, "TWILIO_MESSAGING_SERVICE_SID must look like MG…").optional()
  ),

  // Scheduled accountability sweep. CRON_SECRET authenticates
  // POST /internal/accountability/sweep (a Railway cron service); unset, that
  // route returns 503. SWEEP_INTERVAL_MINUTES additionally runs the sweep
  // in-process on every replica — a lease row keeps runs from overlapping.
  CRON_SECRET: blankIsUnset(z.string().min(32, "CRON_SECRET must be at least 32 characters").optional()),
  SWEEP_INTERVAL_MINUTES: blankIsUnset(z.coerce.number().int().min(5).max(1440).optional()),

  // Delivery webhooks (routes/webhooks.ts). RESEND_WEBHOOK_SECRET is the
  // signing secret Resend shows for the endpoint (whsec_...); unset, the Resend
  // webhook answers 503. PUBLIC_API_URL is this API's public origin: Twilio is
  // told to report status there, and its signature is computed over that URL.
  RESEND_WEBHOOK_SECRET: blankIsUnset(z.string().regex(/^whsec_[A-Za-z0-9+/=]+$/, "RESEND_WEBHOOK_SECRET must look like whsec_...").optional()),
  PUBLIC_API_URL: blankIsUnset(z.string().url().optional()),
  // How many proxies stand between the internet and this process (Railway's
  // edge: one). Unset: one on Railway and in development, none elsewhere in
  // production (lib/proxyTrust.ts). request.ip is the address the outermost
  // trusted proxy saw; the X-Forwarded-For entries a client wrote itself are
  // never trusted. 0 trusts no header (direct exposure).
  TRUST_PROXY_HOPS: blankIsUnset(z.coerce.number().int().min(0).max(5).optional()),
  // Where counselor access requests are sent for review (lib/accessReview.ts).
  ACCESS_REVIEW_EMAIL: blankIsUnset(z.string().email().optional()),

  // College Scorecard (api.data.gov key, free). Optional: unset, the catalog
  // ingest (POST /internal/ingest/scorecard, scripts/ingest/scorecard.ts)
  // answers 503 and the catalog stays as it is.
  SCORECARD_API_KEY: blankIsUnset(z.string().min(8).optional()),
  // Events Hub discovery (POST /internal/events/discover, weekly): how many of
  // the colleges most listed across rosters it checks per run. Default 30.
  EVENTS_DISCOVERY_COLLEGES: blankIsUnset(z.coerce.number().int().min(1).max(100).optional()),

  // Google / Microsoft OAuth (lib/oauth.ts). All optional: a provider whose
  // client id + secret are unset answers 503 on /integrations/:provider/*, and
  // nothing else in the API depends on it. The redirect URI registered with
  // each provider is an APP page, built from APP_URL:
  //   <APP_URL>/dashboard/counselor/data-hub/callback/<provider>
  // That page posts the code to the authenticated /integrations/:provider/complete.
  GOOGLE_CLIENT_ID: blankIsUnset(z.string().min(10).optional()),
  GOOGLE_CLIENT_SECRET: blankIsUnset(z.string().min(10).optional()),
  GOOGLE_PICKER_API_KEY: blankIsUnset(z.string().min(10).optional()),
  GOOGLE_PROJECT_NUMBER: blankIsUnset(z.string().regex(/^\d{6,20}$/, "GOOGLE_PROJECT_NUMBER must be the Cloud project number").optional()),
  GOOGLE_PICKER_MAX_FILES: blankIsUnset(z.coerce.number().int().min(1).max(50).default(10)),
  MICROSOFT_PICKER_MAX_FILES: blankIsUnset(z.coerce.number().int().min(1).max(50).default(10)),
  MICROSOFT_CLIENT_ID: blankIsUnset(z.string().min(10).optional()),
  MICROSOFT_CLIENT_SECRET: blankIsUnset(z.string().min(10).optional()),
  // "common" (work + personal accounts), "organizations", or a tenant id.
  MICROSOFT_TENANT: blankIsUnset(
    z.string().regex(/^[A-Za-z0-9.-]{1,100}$/, "MICROSOFT_TENANT must be a tenant id or alias").default("common")
  ),
  // 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts OAuth tokens
  // at rest with AES-256-GCM. Rotating it strands stored tokens: every
  // counselor has to reconnect.
  INTEGRATION_TOKEN_KEY: blankIsUnset(
    z
      .string()
      .refine(
        (v) => Buffer.from(v, "base64").length === 32,
        "INTEGRATION_TOKEN_KEY must be 32 bytes, base64-encoded"
      )
      .optional()
  ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail loud at boot, not at 2am in a request handler.
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const trustProxy = proxyTrust(process.env, env.TRUST_PROXY_HOPS, env.NODE_ENV);
export const hasServiceRole = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
export const hasImportWorker = Boolean(env.IMPORT_DATABASE_URL);
export const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
export const hasResend = Boolean(env.RESEND_API_KEY);
export const devMailUrl = env.NODE_ENV === "production" ? undefined : env.DEV_MAIL_URL;
export const hasCronSecret = Boolean(env.CRON_SECRET);
export const hasScorecard = Boolean(env.SCORECARD_API_KEY);
export const hasTwilio = Boolean(
  env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID)
);
