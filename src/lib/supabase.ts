/**
 * Supabase clients.
 *
 * `userClient` is the one nearly every route uses: the anon key plus the
 * caller's own access token, so every query runs as that user and RLS decides
 * what they may see. The backend authorizes in code *as well*, but the database
 * is the backstop — a bug in a handler cannot leak another counselor's roster.
 *
 * `serviceClient` bypasses RLS and is reserved for work a user may not do as
 * themselves: the rate limiter, spend quotas, ai_runs/audit_log writes, and
 * outbound message delivery. Never hand it a client-supplied id without
 * checking the relationship first.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";

const common = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

export function userClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...common,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

let cachedServiceClient: SupabaseClient | null = null;

/** Null when SUPABASE_SERVICE_ROLE_KEY is unset — callers must handle that. */
export function serviceClient(): SupabaseClient | null {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!cachedServiceClient) {
    cachedServiceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, common);
  }
  return cachedServiceClient;
}
