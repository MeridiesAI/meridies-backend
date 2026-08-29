import "dotenv/config";
import { z } from "zod";

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
  INVITE_FROM_EMAIL: z.string().default("MeridiesAI <onboarding@resend.dev>"),
  // Base URL of the frontend, used to build the invite accept link.
  APP_URL: z.string().url().default("https://app.meridiesai.com"),
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
