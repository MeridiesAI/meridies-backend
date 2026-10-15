/**
 * Whether Anthropic accepts our key, as /health reports it.
 *
 * Only a refusal says anything about the key: a 401 (AuthenticationError) or
 * a 403 (PermissionDeniedError). A timeout, a dropped connection, a 429, a
 * 5xx or any other failure says Anthropic didn't answer the question, so the
 * last firm answer stands, and before any firm answer the result is null
 * ("not known yet"). An inconclusive check is retried after `failMs`, so an
 * outage doesn't turn every /health call into a models.list call.
 *
 * Pure: no env, no client. lib/anthropic.ts hands it the real call, tests a
 * fake one and a fake clock.
 */

import { AuthenticationError, PermissionDeniedError } from "@anthropic-ai/sdk";

/** true: accepted. false: refused (401/403). null: no firm answer yet. */
export type KeyStatus = boolean | null;
export type KeyCheckLog = {
  warn: (o: object, m: string) => void;
  info: (o: object, m: string) => void;
};

const DEFAULT_OK_MS = 10 * 60 * 1000;
const DEFAULT_FAIL_MS = 60 * 1000;

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("status" in err)) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * The error's class, for the log. The SDK leaves `name` as "Error" on every
 * one of its errors, so the class comes from the constructor (the rule
 * serializeErr uses). Never the message: it can echo the request.
 */
function errType(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

/** 401/403 mean Anthropic refused this key. Anything else says nothing about the key. */
export function keyRejected(err: unknown): boolean {
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) return true;
  const status = statusOf(err);
  return status === 401 || status === 403;
}

export function createKeyCheck(o: {
  /** The models.list call. May throw synchronously; that counts as inconclusive. */
  list: () => Promise<unknown>;
  now?: () => number;
  /** How long an accepted key is trusted before asking again. */
  okMs?: number;
  /** How soon to ask again after a refusal or an inconclusive check. */
  failMs?: number;
}) {
  const now = o.now ?? Date.now;
  const okMs = o.okMs ?? DEFAULT_OK_MS;
  const failMs = o.failMs ?? DEFAULT_FAIL_MS;
  let firm: KeyStatus = null;
  /** Earliest time to ask Anthropic again. Only this moves on an inconclusive check. */
  let nextAt = 0;
  let inFlight: Promise<KeyStatus> | null = null;

  function check(log?: KeyCheckLog): Promise<KeyStatus> {
    if (now() < nextAt) return Promise.resolve(firm);
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(o.list)
        .then(
          () => {
            if (firm !== true) log?.info({}, "anthropic key check: key accepted");
            firm = true;
            nextAt = now() + okMs;
          },
          (err: unknown) => {
            const status = statusOf(err);
            if (keyRejected(err)) {
              firm = false;
              log?.warn({ status, type: errType(err) }, "anthropic key check: Anthropic refused the key");
            } else {
              // Info, not warn: an outage would otherwise write a warning a minute.
              log?.info({ status, type: errType(err), kept: firm }, "anthropic key check inconclusive; keeping the last answer");
            }
            nextAt = now() + failMs;
          },
        )
        .then(() => firm)
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    check,
    /** The cached answer without asking, for a caller that can't wait. */
    peek: (): KeyStatus => firm,
  };
}

/**
 * `p`, or `fallback()` if `p` hasn't settled within `ms`. `p` keeps running
 * either way (it fills the key check's cache for the next caller). The timer
 * is cleared when `p` wins, so it never outlives the answer; it is not
 * unref'd, because a deadline must fire even when nothing else is pending.
 * A rejected `p` rejects; the key check never rejects.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
