/**
 * What a request's URL looks like in the logs.
 *
 * Query values are dropped: the OAuth callback carries a live authorization
 * code and state there, and nothing in a query string is worth keeping in
 * Railway's logs. Keys stay for debugging. The account review link carries
 * its one-time token in the path (lib/accessReview.ts), so that segment is
 * dropped too.
 */
export function loggedUrl(url: string): string {
  const [rawPath, query] = url.split("?", 2);
  const path = rawPath.replace(/^\/*access-review\/[^/]*\/?$/, "/access-review/…");
  const keys = query
    ? [...new URLSearchParams(query).keys()].map((k) => `${k}=…`).join("&")
    : "";
  return keys ? `${path}?${keys}` : path;
}

/**
 * Strip what must never sit in Railway's logs from free text: email addresses,
 * bearer tokens, JWTs (Supabase access tokens), API keys by their known
 * prefixes, phone numbers in E.164 form, and the values of URL query strings
 * (an OAuth code, a signed-URL token). Long text is cut, because an error that
 * quotes a request or a row has no business carrying a whole essay into a log.
 */
export function redactText(input: string, max = 2000): string {
  const out = input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[jwt]")
    .replace(/\b(sk-ant-[A-Za-z0-9_-]+|sk_(live|test)_[A-Za-z0-9]+|re_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9._-]{20,})/g, "[key]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+\d{10,15}\b/g, "[phone]")
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi, (_m, base: string) => `${base}?…`);
  return out.length > max ? `${out.slice(0, max)}… [${out.length - max} more characters]` : out;
}

/**
 * The `err` serializer for every log line. Pino's default copies every
 * enumerable property of an error into the log, and those are where values
 * hide: a PostgREST error's `details` ("Key (email)=(...)"), an SDK error's
 * request echo or headers. Keep the type, a redacted message and stack, and the
 * codes worth searching on; drop the rest.
 */
export type SerializedErr = { [key: string]: unknown; type: string; message: string; stack: string };

export function serializeErr(err: unknown, depth = 0): SerializedErr {
  if (err === null || typeof err !== "object") {
    return { type: typeof err, message: redactText(String(err)), stack: "" };
  }
  const e = err as Record<string, unknown> & { message?: unknown; stack?: unknown; name?: unknown };
  const out: SerializedErr = {
    type: err instanceof Error ? err.constructor.name : "Object",
    message: typeof e.message === "string" ? redactText(e.message) : "",
    stack: typeof e.stack === "string" ? redactText(e.stack, 4000) : "",
  };
  if (typeof e.name === "string" && e.name !== out.type) out.name = e.name;
  for (const k of ["code", "statusCode", "status"] as const) {
    const v = e[k];
    if (typeof v === "string") out[k] = redactText(v, 100);
    else if (typeof v === "number") out[k] = v;
  }
  if (e.cause !== undefined && e.cause !== err && depth < 3) out.cause = serializeErr(e.cause, depth + 1);
  return out;
}

/** A user-supplied URL as a log may carry it: the host only, never path or query. */
export function logHost(url: unknown): string | null {
  try {
    return new URL(String(url)).hostname || null;
  } catch {
    return null;
  }
}
