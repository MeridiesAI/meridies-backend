import "dotenv/config";
import { z } from "zod";

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

  ANTHROPIC_API_KEY: z.string().min(10).optional(),

  // Outbound email (student invitations). Optional: without the key, invite
  // creation still works but the email is skipped and logged, rather than
  // failing the request.
  RESEND_API_KEY: z.string().min(10).optional(),
  // "Display Name <address@domain>". Until a domain is verified in Resend, the
  // only deliverable default is Resend's shared onboarding address.
  INVITE_FROM_EMAIL: z.string().default("Meridies <onboarding@resend.dev>"),
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

  // Google / Microsoft OAuth (lib/oauth.ts). All optional: a provider whose
  // client id + secret are unset answers 503 on /integrations/:provider/*, and
  // nothing else in the API depends on it. API_PUBLIC_URL is this API's own
  // public origin, used to build the redirect URI registered with each
  // provider: <API_PUBLIC_URL>/integrations/<provider>/callback.
  GOOGLE_CLIENT_ID: blankIsUnset(z.string().min(10).optional()),
  GOOGLE_CLIENT_SECRET: blankIsUnset(z.string().min(10).optional()),
  MICROSOFT_CLIENT_ID: blankIsUnset(z.string().min(10).optional()),
  MICROSOFT_CLIENT_SECRET: blankIsUnset(z.string().min(10).optional()),
  // "common" (work + personal accounts), "organizations", or a tenant id.
  MICROSOFT_TENANT: blankIsUnset(
    z.string().regex(/^[A-Za-z0-9.-]{1,100}$/, "MICROSOFT_TENANT must be a tenant id or alias").default("common")
  ),
  API_PUBLIC_URL: blankIsUnset(z.string().url().optional()),
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

export const hasServiceRole = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
export const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
export const hasResend = Boolean(env.RESEND_API_KEY);
export const hasCronSecret = Boolean(env.CRON_SECRET);
export const hasTwilio = Boolean(
  env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID)
);
