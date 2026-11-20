/**
 * Supabase JWT validation.
 *
 * This project signs access tokens asymmetrically (ES256), so tokens are
 * verified locally against the project's JWKS — no round trip to the auth
 * server on every request. `jose` caches and re-fetches the key set on
 * rotation by itself.
 *
 * After verification the request carries:
 *   request.auth    - { userId, email, token }
 *   request.db      - a Supabase client bound to THAT user's token (RLS applies)
 *   request.profile - the caller's profiles row (this request's own copy),
 *                     without the `profile` jsonb (up to 300 KB of onboarding
 *                     answers): `loadProfileBlob` reads it where a route needs it
 *
 * The row is read through lib/profileCache.ts: requests from one user that are
 * in flight together share one read, and with AUTH_PROFILE_CACHE_MS above 0
 * (5000 in production) the row is reused for that long. A user's own write
 * (any request that is not GET or HEAD) drops their entry before it runs and
 * again when its response is sent.
 *
 * A counselor whose account is not approved is refused here (403,
 * code "account_pending") unless the route sets config.allowPending, and a
 * parent account (403, code "parent_account") unless it sets config.allowParent.
 *
 * Only a token that is no good answers 401. A key set that can't be fetched or
 * a profile read that fails is an outage: 503, code "auth_unavailable"
 * (lib/authFaults.ts), because the app signs a person out on a 401.
 */

import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { authProfileCacheMs, env } from "../env.js";
import { readMark } from "../lib/axis/ops/trash.js";
import { userClient } from "../lib/supabase.js";
import { billingEnabled } from "../lib/billing.js";
import { planGate, planGateError } from "../lib/planGate.js";
import type { PlanRow } from "../lib/billingPlan.js";
import { blockedAsParent, blockedAsPending } from "../lib/access.js";
import { authUnavailable, isTokenFault, isTokenRejectedByDatabase } from "../lib/authFaults.js";
import { touchLastActive } from "../lib/inactivityAlerts.js";
import { accountPending, parentAccount, unauthorized } from "../lib/errors.js";
import { ProfileCache } from "../lib/profileCache.js";
import type { AuthProfile } from "../lib/serialize.js";

const ISSUER = `${env.SUPABASE_URL}/auth/v1`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

const profiles = new ProfileCache<AuthProfile>({ ttlMs: authProfileCacheMs });
// A Consultant's plan row, for the plan gate. A user with no plan row is cached as `none`.
const plans = new ProfileCache<{ plan: PlanRow | null }>({ ttlMs: authProfileCacheMs });

/**
 * Forget a user's cached profile row, so their next request reads it again.
 * For code that changes ANOTHER user's role, approval or counselor and wants
 * it seen at once; a user's own writes are handled here already, and without
 * a call the change is seen within AUTH_PROFILE_CACHE_MS.
 */
export function evictProfile(userId: string): void {
  profiles.evict(userId);
}

const isRead = (method: string) => method === "GET" || method === "HEAD";

/** A profile read PostgREST answered with an error, carried out of the cache with that error. */
class ProfileReadFailed extends Error {
  readonly error: { code?: string; message?: string };
  constructor(error: { code?: string; message?: string }) {
    super("profile read failed");
    this.name = "ProfileReadFailed";
    this.error = error;
  }
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || scheme.toLowerCase() !== "bearer") return null;
  return value.trim() || null;
}

export default fp(async (app) => {
  // Declared up front so V8 keeps one hidden class for every request.
  app.decorateRequest("auth", null as never);
  app.decorateRequest("db", null as never);
  app.decorateRequest("profile", null as never);

  app.decorate("authenticate", async (request) => {
    const token = bearer(request.headers.authorization);
    if (!token) throw unauthorized("Missing bearer token");

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        // Supabase stamps "authenticated" as the audience for signed-in users.
        audience: "authenticated",
      }));
    } catch (err) {
      if (!isTokenFault(err)) {
        // The key set couldn't be fetched: nothing was learned about the token.
        request.log.error({ err }, "could not verify a token: the key set is unavailable");
        throw authUnavailable("Sign-in is unavailable right now. Try again in a moment.");
      }
      // Never echo the reason: it tells an attacker which half was wrong.
      throw unauthorized("Your session has expired. Sign in again.");
    }
    if (!payload.sub) throw unauthorized("Your session has expired. Sign in again.");
    const userId = payload.sub;
    const email = typeof payload.email === "string" ? payload.email : undefined;

    request.auth = { userId, email, token };
    // A delete AxIS runs for a confirmed card carries a mark only this process can make; its rows go to the trash.
    const actionId = readMark(request.headers["x-meridies-axis-mark"]);
    if (actionId) request.axisActionId = actionId;
    request.db = actionId ? userClient(token, { "x-meridies-axis-action": actionId }) : userClient(token);

    // The caller is about to change something, possibly their own row: read it fresh, and
    // let no request that follows reuse what was read before the change.
    if (!isRead(request.method)) profiles.evict(userId);

    // The role lives in the database, not the token — a token minted before a
    // role change would otherwise keep its old permissions. Keyed by the
    // token's verified subject, never by anything the client sent.
    const db = request.db;
    let profile: AuthProfile | null;
    try {
      profile = await profiles.get(userId, async () => {
        const { data, error } = await db
          .from("profiles")
          .select(
            "id, full_name, email, role, role_confirmed, onboarding_step, onboarding_complete, " +
              "counselor_id, firm_id, avatar_url, phone, timezone, title, headline, hometown, " +
              "high_school, grad_year, counselor_approved_at, last_active_at"
          )
          .eq("id", userId)
          .maybeSingle();
        if (error) throw new ProfileReadFailed(error);
        return data as unknown as AuthProfile | null;
      });
    } catch (err) {
      const cause = err instanceof ProfileReadFailed ? err.error : err;
      request.log.error({ err: cause }, "failed to load profile for authenticated user");
      // PostgREST itself refused the token (expired between our check and its own): still a bad session.
      if (err instanceof ProfileReadFailed && isTokenRejectedByDatabase(err.error)) {
        throw unauthorized("Your session has expired. Sign in again.");
      }
      // The token is good and the database didn't answer: an outage, not a sign-out.
      throw authUnavailable("We couldn't load your account just now. Try again.");
    }
    if (!profile) {
      // The auth user exists but handle_new_user never landed a profile row.
      throw unauthorized("Your account isn't set up yet. Sign in again.");
    }

    request.profile = profile;

    // Approval comes from the row in the database, never from the token. With the
    // profile cache on, a revoke holds here within AUTH_PROFILE_CACHE_MS (at once
    // with it off); RLS on request.db refuses a revoked counselor immediately
    // either way. A route opts in with config.allowPending.
    if (blockedAsPending(request.profile, request.routeOptions.config.allowPending)) {
      throw accountPending();
    }
    // A parent account reads its Parent view and nothing else; the database agrees (private.account_open).
    if (blockedAsParent(request.profile, request.routeOptions.config.allowParent)) {
      throw parentAccount();
    }

    // The plan gate (lib/planGate.ts): off unless BILLING_ENABLED=true, and only for Consultants. If the plan can't be read
    // (table not applied, a database error) the request goes through: a billing fault must not lock a paying Consultant out.
    if (billingEnabled() && request.profile.role === "counselor") {
      let plan: PlanRow | null = null;
      try {
        const row = await plans.get(userId, async () => {
          const { data, error } = await db
            .from("plan_subscriptions")
            .select("kind, status, past_due_since, money_back_used_at, access_starts_at")
            .eq("counselor_id", userId)
            .maybeSingle();
          if (error) throw error;
          return { plan: (data as PlanRow | null) ?? null };
        });
        plan = row?.plan ?? null;
      } catch (err) {
        request.log.warn({ err }, "plan gate: could not read the plan, letting the request through");
      }
      const now = new Date();
      const blocked = planGate(plan, now, request.method, request.routeOptions.config.allowPending);
      if (blocked) throw planGateError(blocked, plan, now);
    }

    // The inactivity alert's signal (lib/inactivityAlerts.ts): a student's request marks them active, at
    // most once an hour, on the service client. Started here and never awaited, so the request doesn't wait
    // on it and a failed write never fails the request.
    touchLastActive(request.profile, request.log);
  });

  // A write's own profile read ran before its change, and a read racing the write may have been
  // answered before it too: once the response is out, neither is kept. `auth` is null on a request
  // that never authenticated.
  app.addHook("onResponse", async (request) => {
    if (request.auth && !isRead(request.method)) profiles.evict(request.auth.userId);
  });
});
