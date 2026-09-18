/**
 * Invitation tokens.
 *
 * Shared by `routes/invites.ts` (one student at a time) and `routes/roster.ts`
 * (a whole imported roster), so the two cannot drift into producing links of
 * different strength.
 */

import { randomBytes } from "node:crypto";
import { env } from "../env.js";

/** Unguessable capability. base64url of 24 random bytes ≈ 192 bits. */
export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

export function appJoinUrl(token: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/join/${token}`;
}
