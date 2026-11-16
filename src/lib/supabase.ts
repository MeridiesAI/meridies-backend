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
 *
 * Every client's requests carry a deadline (`withRequestTimeout`): supabase-js
 * uses a bare `fetch`, so one stalled PostgREST connection used to hold a
 * request, and every request behind the same profile read, with nothing to
 * cut it off.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";

/** How long one PostgREST, RPC, Auth or Storage-metadata call may take. */
export const SUPABASE_TIMEOUT_MS = 30_000;

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A Storage object upload or download: bounded by its size, not by a deadline (a 50 MB file is slow, not stuck). */
export function isStorageTransfer(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/storage/v1/object");
  } catch {
    return false;
  }
}

/** The caller's own signal and the deadline, whichever fires first. */
function withDeadline(caller: AbortSignal | null | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!caller) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, deadline]);
  // Node 20.0 to 20.2 have no AbortSignal.any.
  const both = new AbortController();
  for (const signal of [caller, deadline]) {
    if (signal.aborted) {
      both.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => both.abort(signal.reason), { once: true });
  }
  return both.signal;
}

/**
 * `fetch` with a deadline on every request but Storage object transfers. A
 * signal the caller passed (health's 2 s probe) still applies. An aborted call
 * comes back from supabase-js as `{ error }`, which callers already handle.
 */
export function withRequestTimeout(base: typeof fetch, ms: number = SUPABASE_TIMEOUT_MS): typeof fetch {
  return (input, init) => {
    if (isStorageTransfer(urlOf(input))) return base(input, init);
    const caller = init?.signal ?? (typeof input === "object" && "signal" in input ? input.signal : null);
    return base(input, { ...init, signal: withDeadline(caller, ms) });
  };
}

// Looked up at call time, so a test that replaces globalThis.fetch is still seen.
const timedFetch = withRequestTimeout((input, init) => fetch(input, init));

const common = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: timedFetch },
} as const;

/** `extraHeaders` reach PostgREST as request headers (the AxIS trash mark: lib/axis/ops/trash.ts). */
export function userClient(accessToken: string, extraHeaders: Record<string, string> = {}): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...common,
    global: { ...common.global, headers: { ...extraHeaders, Authorization: `Bearer ${accessToken}` } },
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

let cachedAnonClient: SupabaseClient | null = null;

/**
 * Anon key, no user token. For public RPCs a signed-out caller may run — e.g.
 * `invitation_preview`, which an invited student hits before they have an
 * account. RLS still applies; these RPCs are SECURITY DEFINER and granted to
 * `anon` deliberately.
 */
export function anonClient(): SupabaseClient {
  if (!cachedAnonClient) {
    cachedAnonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, common);
  }
  return cachedAnonClient;
}
