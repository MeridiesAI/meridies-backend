/**
 * OAuth 2.0 for the Google and Microsoft suites — authorization code + PKCE.
 *
 * One consent per provider covers files, mail and calendar, which is what the
 * brief asks for. The handshake:
 *
 *   1. `beginAuthorization` mints a random `state` and a PKCE verifier, stores
 *      sha256(state) bound to the signed-in user with a ten-minute expiry, and
 *      returns the provider's consent URL.
 *   2. The provider redirects the browser to an APP page
 *      (<APP_URL>/dashboard/counselor/data-hub/callback/:provider), never to
 *      this API. That page runs under the counselor's Meridies session and
 *      POSTs {code, state} to the authenticated /integrations/:provider/complete.
 *      `completeAuthorization` consumes the state only if it belongs to the
 *      caller (DELETE ... WHERE owner_id = caller RETURNING, so it works once),
 *      exchanges the code with the verifier, and stores the tokens encrypted in
 *      `integration_tokens` — never in `integrations.config`.
 *   3. `accessTokenFor` hands a live access token to the feature code,
 *      refreshing it when it is within a minute of expiry. Refreshes are
 *      serialized per grant, because Microsoft rotates refresh tokens.
 *
 * Plain fetch, no SDKs. Provider error bodies are logged by their `error` code
 * only and never returned to a client: they can echo request parameters.
 *
 * Why the callback is not an API route: a browser redirect from Google or
 * Microsoft carries no Meridies session, so an unauthenticated callback could
 * only trust the state row — and an attacker could start a sign-in on their own
 * account and hand the consent link to a counselor, whose Google/Microsoft
 * tokens would then land on the attacker's Meridies account. Requiring the
 * signed-in user to match the state's owner closes that.
 *
 * Everything here runs on the service client.
 */

import { createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";
import { badRequest, conflict, HttpError, unavailable } from "./errors.js";
import { serviceClient } from "./supabase.js";
import { decryptToken, encryptToken, hasTokenKey } from "./tokenCrypto.js";

export const SUITE_PROVIDERS = ["google", "microsoft"] as const;
export type SuiteProvider = (typeof SUITE_PROVIDERS)[number];

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

/**
 * Google: Drive read-only (listing and importing a file the counselor picks,
 * and reading a shared Doc's `modifiedTime` for the tracker), Drive per-file
 * (creating supplement Docs), Gmail send,
 * Calendar events (including creating the Meet conference), plus identity.
 */
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly",
  // Create the student's supplement Docs (v7/v10 Application page). drive.file
  // only reaches files this app created, so it adds no read of anything else.
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

/**
 * Microsoft identity platform v2. `Files.Read.All` rather than `Files.Read`
 * because the file the tracker watches is usually the student's own Word
 * document shared with the counselor, and `Files.Read` only reaches the
 * counselor's own drive. It is still a delegated, read-only permission a user
 * can consent to without an admin.
 */
const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "User.Read",
  "Files.Read.All",
  "Mail.Send",
  "Calendars.ReadWrite",
];

type ProviderConfig = {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  extraAuthorizeParams: Record<string, string>;
};

function providerConfig(provider: SuiteProvider): ProviderConfig | null {
  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
    return {
      label: "Google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      scopes: GOOGLE_SCOPES,
      // offline + consent: the only way Google reliably issues a refresh token.
      extraAuthorizeParams: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      },
    };
  }
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) return null;
  const tenant = encodeURIComponent(env.MICROSOFT_TENANT);
  return {
    label: "Microsoft",
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    scopes: MICROSOFT_SCOPES,
    extraAuthorizeParams: { response_mode: "query", prompt: "select_account" },
  };
}

export const providerLabel = (p: SuiteProvider) => (p === "google" ? "Google" : "Microsoft");

/** Why this provider can't be used right now, or null when it can. */
export function unavailableReason(provider: SuiteProvider): string | null {
  const label = providerLabel(provider);
  if (!providerConfig(provider)) {
    return `${label} isn't set up on this server yet (missing ${
      provider === "google" ? "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET" : "MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET"
    }).`;
  }
  if (!hasTokenKey()) return `${label} sign-in needs INTEGRATION_TOKEN_KEY to store tokens safely.`;
  if (!serviceClient()) return `${label} sign-in needs SUPABASE_SERVICE_ROLE_KEY to store tokens.`;
  return null;
}

function configured(provider: SuiteProvider) {
  const reason = unavailableReason(provider);
  if (reason) throw unavailable(reason);
  // unavailableReason has proven all four are present.
  return {
    config: providerConfig(provider) as ProviderConfig,
    db: serviceClient() as NonNullable<ReturnType<typeof serviceClient>>,
  };
}

/**
 * The app page the provider sends the browser back to. Register exactly this
 * with Google / Microsoft; it must be byte-identical in the authorize request
 * and the token exchange, so both build it here.
 */
export function redirectUri(provider: SuiteProvider): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/dashboard/counselor/data-hub/callback/${provider}`;
}

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const sha256B64Url = (v: string) => createHash("sha256").update(v).digest("base64url");

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
};

async function readTokenResponse(res: Response): Promise<TokenResponse> {
  try {
    return (await res.json()) as TokenResponse;
  } catch {
    return {};
  }
}

// ---- 1. Consent URL ---------------------------------------------------------

export async function beginAuthorization(userId: string, provider: SuiteProvider): Promise<string> {
  const { config, db } = configured(provider);

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url"); // 64 chars, within 43–128

  // Opportunistic cleanup: expired states are useless and the table is tiny.
  await db.from("integration_oauth_states").delete().lt("expires_at", new Date().toISOString());

  const { error } = await db.from("integration_oauth_states").insert({
    state_hash: sha256Hex(state),
    owner_id: userId,
    provider,
    code_verifier_enc: encryptToken(verifier),
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw new HttpError(500, "Couldn't start the sign-in");

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    code_challenge: sha256B64Url(verifier),
    code_challenge_method: "S256",
    ...config.extraAuthorizeParams,
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

// ---- 2. Completion ------------------------------------------------------------

/** The id_token came straight from the token endpoint over TLS, so its payload
 *  may be read without re-verifying the signature (OIDC Core 3.1.3.7). */
function idTokenClaims(idToken: string | undefined): Record<string, unknown> {
  if (!idToken) return {};
  const payload = idToken.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function microsoftIdentity(accessToken: string): Promise<{ id: string | null; email: string | null }> {
  try {
    const res = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }
    );
    if (!res.ok) return { id: null, email: null };
    const me = (await res.json()) as { id?: string; mail?: string | null; userPrincipalName?: string };
    return { id: me.id ?? null, email: me.mail ?? me.userPrincipalName ?? null };
  } catch {
    return { id: null, email: null };
  }
}

/**
 * Consume the caller's own state, exchange the code, store the tokens, record
 * the grant. Every failure is an HttpError with a counselor-readable message;
 * a state that belongs to someone else reads exactly like one that was used.
 */
export async function completeAuthorization(
  userId: string,
  provider: SuiteProvider,
  code: string,
  state: string,
  log: { warn: (obj: object, msg: string) => void }
): Promise<{ scopes: string[] }> {
  const { config, db } = configured(provider);

  // owner_id in the WHERE clause is the CSRF binding: another user's state is
  // neither matched nor consumed.
  const { data: pending, error: stateError } = await db
    .from("integration_oauth_states")
    .delete()
    .eq("state_hash", sha256Hex(state))
    .eq("provider", provider)
    .eq("owner_id", userId)
    .select("owner_id, code_verifier_enc, expires_at")
    .maybeSingle();
  if (stateError) throw new HttpError(500, "Couldn't finish the sign-in. Try again.");
  if (!pending) {
    throw badRequest(
      `That ${config.label} sign-in was already used, or was started from a different Meridies account. Start again from Connected apps.`
    );
  }
  const ownerId = userId;
  if (new Date(String(pending.expires_at)).getTime() < Date.now()) {
    throw badRequest("That sign-in took longer than ten minutes. Start again.");
  }

  const res = await postForm(config.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: decryptToken(String(pending.code_verifier_enc)),
    ...(provider === "microsoft" ? { scope: config.scopes.join(" ") } : {}),
  });
  const token = await readTokenResponse(res);
  if (!res.ok || !token.access_token) {
    log.warn({ provider, status: res.status, error: token.error ?? null }, "oauth code exchange failed");
    throw new HttpError(502, `${config.label} didn't accept the sign-in. Try connecting again.`);
  }

  const granted = (token.scope ?? "").split(/\s+/).filter(Boolean);
  const claims = idTokenClaims(token.id_token);
  let accountId = typeof claims.sub === "string" ? claims.sub : null;
  let accountEmail = typeof claims.email === "string" ? claims.email : null;
  if (provider === "microsoft") {
    // Graph's /me id is what lastModifiedBy.user.id is compared against.
    const me = await microsoftIdentity(token.access_token);
    accountId = me.id ?? accountId;
    accountEmail = me.email ?? accountEmail ?? (typeof claims.preferred_username === "string" ? claims.preferred_username : null);
  }

  const { error: saveError } = await db.from("integration_tokens").upsert(
    {
      owner_id: ownerId,
      provider,
      account_id: accountId,
      account_email: accountEmail?.slice(0, 320) ?? null,
      access_token_enc: encryptToken(token.access_token),
      refresh_token_enc: token.refresh_token ? encryptToken(token.refresh_token) : null,
      scopes: granted,
      expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    },
    { onConflict: "owner_id,provider" }
  );
  if (saveError) throw new HttpError(500, "The sign-in worked but couldn't be saved. Try again.");

  // The visible grant: what the provider actually returned, not what we asked.
  const { error: grantError } = await db.from("integrations").upsert(
    {
      owner_id: ownerId,
      provider,
      status: "connected",
      scopes: granted,
      last_error: null,
    },
    { onConflict: "owner_id,provider" }
  );
  if (grantError) throw new HttpError(500, "The sign-in worked but couldn't be recorded. Try again.");

  return { scopes: granted };
}

// ---- 3. Live access tokens ----------------------------------------------------

export type LiveToken = {
  accessToken: string;
  accountId: string | null;
  accountEmail: string | null;
  scopes: string[];
};

async function markGrantBroken(ownerId: string, provider: SuiteProvider, message: string) {
  const db = serviceClient();
  if (!db) return;
  await db
    .from("integrations")
    .update({ status: "error", last_error: message })
    .eq("owner_id", ownerId)
    .eq("provider", provider);
}

type TokenRow = Record<string, unknown>;

async function readTokenRow(
  db: NonNullable<ReturnType<typeof serviceClient>>,
  ownerId: string,
  provider: SuiteProvider,
  label: string
): Promise<TokenRow> {
  const { data: row, error } = await db
    .from("integration_tokens")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new HttpError(500, "Couldn't read the connection");
  if (!row) throw conflict(`${label} isn't connected. Connect it under App Integrations first.`);
  return row as TokenRow;
}

function isFresh(row: TokenRow): boolean {
  const expiresAt = row.expires_at ? new Date(String(row.expires_at)).getTime() : 0;
  return expiresAt - REFRESH_MARGIN_MS > Date.now();
}

function liveFromRow(row: TokenRow): LiveToken {
  return {
    accessToken: decryptToken(String(row.access_token_enc)),
    accountId: (row.account_id as string | null) ?? null,
    accountEmail: (row.account_email as string | null) ?? null,
    scopes: (row.scopes as string[] | null) ?? [],
  };
}

/**
 * Refreshes in flight, one per grant. Microsoft rotates the refresh token on
 * every use, so two concurrent refreshes in this process would send the same
 * token twice and the loser would read `invalid_grant` as a revocation. A
 * second caller joins the first refresh instead.
 */
const refreshing = new Map<string, Promise<LiveToken>>();

/**
 * A usable access token for `ownerId`'s grant. Refreshes within a minute of
 * expiry (or when `force` is set after a 401). A refresh the provider refuses
 * marks the grant `error` so the Connected apps card says "reconnect" instead
 * of every feature failing mysteriously — unless the row shows another
 * refresher (another replica) already rotated it, in which case its token is
 * used.
 */
export async function accessTokenFor(
  ownerId: string,
  provider: SuiteProvider,
  opts: { force?: boolean } = {}
): Promise<LiveToken> {
  const { config, db } = configured(provider);
  const key = `${provider}:${ownerId}`;

  const inFlight = refreshing.get(key);
  if (inFlight) return inFlight;

  const row = await readTokenRow(db, ownerId, provider, config.label);
  if (!opts.force && isFresh(row)) return liveFromRow(row);

  // Re-check after the read: another caller may have started meanwhile.
  const joined = refreshing.get(key);
  if (joined) return joined;

  const run = refreshGrant(db, config, ownerId, provider, row).finally(() => {
    refreshing.delete(key);
  });
  refreshing.set(key, run);
  return run;
}

async function refreshGrant(
  db: NonNullable<ReturnType<typeof serviceClient>>,
  config: ProviderConfig,
  ownerId: string,
  provider: SuiteProvider,
  row: TokenRow
): Promise<LiveToken> {
  const label = config.label;

  if (!row.refresh_token_enc) {
    const message = `${label} access expired and can't be renewed. Reconnect ${label}.`;
    await markGrantBroken(ownerId, provider, message);
    throw conflict(message);
  }

  const res = await postForm(config.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: decryptToken(String(row.refresh_token_enc)),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...(provider === "microsoft" ? { scope: config.scopes.join(" ") } : {}),
  });
  const token = await readTokenResponse(res);
  if (!res.ok || !token.access_token) {
    // Before calling the grant broken, look again: a refresh on another
    // replica may have rotated the token we just spent. Ciphertext carries a
    // random IV, so any rewrite of the row changes it.
    const latest = await readTokenRow(db, ownerId, provider, label).catch(() => null);
    if (
      latest &&
      (latest.refresh_token_enc !== row.refresh_token_enc ||
        latest.access_token_enc !== row.access_token_enc) &&
      isFresh(latest)
    ) {
      return liveFromRow(latest);
    }

    const revoked = token.error === "invalid_grant";
    const message = revoked
      ? `${label} access was revoked or has lapsed. Reconnect ${label}.`
      : `${label} couldn't renew access just now.`;
    if (revoked) await markGrantBroken(ownerId, provider, message);
    throw revoked ? conflict(message) : unavailable(message);
  }

  const update: Record<string, unknown> = {
    access_token_enc: encryptToken(token.access_token),
    expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
  };
  // Microsoft rotates refresh tokens; Google usually doesn't send a new one.
  if (token.refresh_token) update.refresh_token_enc = encryptToken(token.refresh_token);
  if (token.scope) update.scopes = token.scope.split(/\s+/).filter(Boolean);
  const { error: saveError } = await db
    .from("integration_tokens")
    .update(update)
    .eq("owner_id", ownerId)
    .eq("provider", provider);
  if (saveError && token.refresh_token) {
    // The old refresh token is now spent and the new one wasn't kept: the
    // next refresh will fail, so say so now rather than later.
    const message = `${label} access was renewed but couldn't be saved. Reconnect ${label}.`;
    await markGrantBroken(ownerId, provider, message);
  }

  const live = liveFromRow(row);
  return {
    ...live,
    scopes: (update.scopes as string[] | undefined) ?? live.scopes,
    accessToken: token.access_token,
  };
}

/** Whether the grant includes a scope, matched case-insensitively (Microsoft
 *  echoes scopes back with a resource prefix and its own casing). */
export function hasScope(token: LiveToken, scope: string): boolean {
  const want = scope.toLowerCase();
  return token.scopes.some((s) => {
    const have = s.toLowerCase();
    return have === want || have.endsWith(`/${want}`);
  });
}

export function requireScope(token: LiveToken, provider: SuiteProvider, scope: string, what: string) {
  if (!hasScope(token, scope)) {
    throw conflict(
      `Your ${providerLabel(provider)} connection doesn't allow ${what}. Reconnect and leave that permission ticked.`
    );
  }
}

// ---- Disconnect ---------------------------------------------------------------

/**
 * Revoke at the provider where that exists, then delete the tokens. Google has
 * a revocation endpoint. The Microsoft identity platform does not offer one for
 * a single app's refresh token, so for Microsoft the tokens are destroyed here
 * and the counselor is told to remove the app's consent in their account.
 */
export async function revokeAndForget(
  ownerId: string,
  provider: SuiteProvider,
  log: { warn: (obj: object, msg: string) => void }
): Promise<{ revokedAtProvider: boolean }> {
  const db = serviceClient();
  if (!db) return { revokedAtProvider: false };

  const { data: row } = await db
    .from("integration_tokens")
    .select("access_token_enc, refresh_token_enc")
    .eq("owner_id", ownerId)
    .eq("provider", provider)
    .maybeSingle();

  let revokedAtProvider = false;
  if (row && provider === "google" && hasTokenKey()) {
    try {
      const sealed = (row.refresh_token_enc as string | null) ?? String(row.access_token_enc);
      const res = await postForm("https://oauth2.googleapis.com/revoke", { token: decryptToken(sealed) });
      // 400 invalid_token means it was already dead — revoked either way.
      revokedAtProvider = res.ok || res.status === 400;
    } catch (err) {
      log.warn({ provider, err: err instanceof Error ? err.message : "unknown" }, "token revoke failed");
    }
  }

  await db.from("integration_tokens").delete().eq("owner_id", ownerId).eq("provider", provider);
  await db.from("integration_oauth_states").delete().eq("owner_id", ownerId).eq("provider", provider);
  return { revokedAtProvider };
}

export function assertSuiteProvider(value: string): SuiteProvider {
  if ((SUITE_PROVIDERS as readonly string[]).includes(value)) return value as SuiteProvider;
  throw badRequest("Only Google and Microsoft connect through sign-in");
}
