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
 *   request.profile - the caller's profiles row, loaded once per request
 */

import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../env.js";
import { userClient } from "../lib/supabase.js";
import { unauthorized } from "../lib/errors.js";
import type { Profile } from "../lib/serialize.js";

const ISSUER = `${env.SUPABASE_URL}/auth/v1`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

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

    let userId: string;
    let email: string | undefined;
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        // Supabase stamps "authenticated" as the audience for signed-in users.
        audience: "authenticated",
      });
      if (!payload.sub) throw new Error("token has no subject");
      userId = payload.sub;
      email = typeof payload.email === "string" ? payload.email : undefined;
    } catch {
      // Never echo the reason: it tells an attacker which half was wrong.
      throw unauthorized("Your session has expired. Sign in again.");
    }

    request.auth = { userId, email, token };
    request.db = userClient(token);

    // The role lives in the database, not the token — a token minted before a
    // role change would otherwise keep its old permissions.
    const { data, error } = await request.db
      .from("profiles")
      .select(
        "id, full_name, email, role, role_confirmed, onboarding_step, onboarding_complete, " +
          "counselor_id, firm_id, avatar_url, phone, timezone, title, headline, hometown, " +
          "high_school, grad_year, profile"
      )
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      request.log.error({ err: error }, "failed to load profile for authenticated user");
      throw unauthorized("Could not load your account");
    }
    if (!data) {
      // The auth user exists but handle_new_user never landed a profile row.
      throw unauthorized("Your account isn't set up yet. Sign in again.");
    }

    request.profile = data as unknown as Profile;
  });
});
