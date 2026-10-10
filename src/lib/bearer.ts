/**
 * Who a bearer token belongs to, for code that runs before `app.authenticate`
 * (the rate limiter's key). It verifies the signature against the project's
 * JWKS exactly as plugins/supabaseAuth.ts does, because an unverified subject
 * would let a caller pick their own rate-limit bucket. It decides nothing
 * about access: authenticate still verifies every request itself.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../env.js";

const ISSUER = `${env.SUPABASE_URL}/auth/v1`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

/** The token's user id when it verifies; null for no token or a bad one. */
export async function verifiedSubject(header: string | undefined): Promise<string | null> {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || scheme.toLowerCase() !== "bearer") return null;
  try {
    const { payload } = await jwtVerify(value.trim(), JWKS, { issuer: ISSUER, audience: "authenticated" });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
