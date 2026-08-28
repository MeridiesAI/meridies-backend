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
