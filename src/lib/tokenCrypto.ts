/**
 * Encryption at rest for OAuth tokens.
 *
 * AES-256-GCM with a fresh 96-bit IV per value and the auth tag stored beside
 * the ciphertext, so a tampered row fails to decrypt rather than yielding a
 * different token. The format is versioned (`v1.<iv>.<tag>.<ct>`, base64url)
 * so a later key rotation can tell old rows from new ones.
 *
 * The key comes from INTEGRATION_TOKEN_KEY and never touches the database.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.js";

const ALGORITHM = "aes-256-gcm";

function key(): Buffer {
  if (!env.INTEGRATION_TOKEN_KEY) {
    throw new Error("INTEGRATION_TOKEN_KEY is not set");
  }
  return Buffer.from(env.INTEGRATION_TOKEN_KEY, "base64");
}

export const hasTokenKey = (): boolean => Boolean(env.INTEGRATION_TOKEN_KEY);

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptToken(sealed: string): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || ct === undefined) {
    throw new Error("Unrecognised token ciphertext");
  }
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
