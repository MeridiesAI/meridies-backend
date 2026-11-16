/**
 * Telling "this token is no good" (401) from "sign-in can't be checked right
 * now" (503, code auth_unavailable) in plugins/supabaseAuth.ts.
 *
 * The app treats only a 401 as signed out and sends the person to the login
 * page, so an outage answered as 401 logs everyone out. A key set that can't be
 * fetched, or a profile read that fails, is an outage: the caller retries.
 */

import { errors as jose } from "jose";
import { HttpError } from "./errors.js";

/** The code the app keys on: a 503 that is an outage, not a feature that isn't switched on. */
export const AUTH_UNAVAILABLE = "auth_unavailable";

export const authUnavailable = (message: string) => new HttpError(503, message, AUTH_UNAVAILABLE);

/**
 * Whether a failed `jwtVerify` is the token's fault. jose's own errors are
 * (expired, bad signature, wrong audience, malformed, no matching key), except
 * the two it raises when the key set can't be had: a fetch timeout, and its
 * generic error for a non-200 or unparseable key set response. Anything that is
 * not a jose error (a refused or reset connection, DNS) is not the token's.
 */
export function isTokenFault(err: unknown): boolean {
  if (!(err instanceof jose.JOSEError)) return false;
  return err.code !== "ERR_JWKS_TIMEOUT" && err.code !== "ERR_JOSE_GENERIC";
}

/**
 * PostgREST's own refusals of the bearer token (PGRST301: the JWT is invalid or
 * expired; PGRST303: its claims are). A profile read that fails with one of
 * these is still a bad session; any other failure is an outage.
 */
export function isTokenRejectedByDatabase(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "PGRST301" || error?.code === "PGRST303";
}
