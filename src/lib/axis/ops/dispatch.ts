/**
 * Runs an operation's request against this API, in-process, as the counselor.
 *
 * `app.inject` sends the request through the whole Fastify stack with the
 * counselor's own bearer token: rate limits, `authenticate` (and with it the
 * approval gate), the route's checks, its side effects and RLS on its queries.
 * AxIS can therefore never do more than the counselor could do by clicking,
 * and a rule added to a route later applies to AxIS without anyone
 * remembering to copy it here.
 *
 * Two backstops sit in front of that, because the catalog is the only thing
 * standing between a model's choice and a request:
 *  - paths AxIS must never call (itself, chat, auth, account deletion, AI and
 *    machine routes) are refused whatever the catalog says;
 *  - a request about an essay never carries prose (the essay guardrail).
 */
import type { FastifyRequest } from "fastify";
import { badRequest, forbidden } from "../../errors.js";
import type { OpCall } from "./types.js";

export type Dispatched = { status: number; body: unknown };

/** Tested against the canonical path (decoded, lower case, no query), so an encoding or a case can't slip past. */
const NEVER: readonly RegExp[] = [
  /^\/axis(\/|$)/,
  /^\/chat(\/|$)/,
  /^\/auth(\/|$)/,
  /^\/ai(\/|$)/,
  /^\/me(\/|$)/,
  /^\/account(\/|$)/,
  /^\/access-review(\/|$)/,
  /^\/internal(\/|$)/,
  /^\/webhooks(\/|$)/,
  /^\/communication\/internal(\/|$)/,
  /^\/integrations\/[^/]+\/(authorize|complete)(\/|$)/,
  /^\/imports(\/|$)/,
  /^\/health(\/|$)/,
  // Essay marks: accepting one splices its replacement into the student's essay.
  /^\/essays(\/|$)/,
];

/**
 * Keys that would carry essay text, compared lower case without `_` or `-`, at
 * any depth of the body. Refused on any request whose path mentions an essay
 * or a supplement.
 */
const PROSE_KEYS = new Set([
  "body", "text", "content", "draft", "html", "prose", "essay", "essaytext", "paragraph", "markdown", "plaintext",
  "replacement", "suggestedreplacement",
]);
const ESSAY_PATH = /essay|supplement/i;
const REFUSED_PATH = "That request path isn't allowed.";

/** A catalog path segment once decoded: ids, words, hyphens. Nothing that could move the router somewhere else. */
const SEGMENT = /^[a-z0-9_~-][a-z0-9._~-]*$/i;

/**
 * The path as the router will match it: every segment percent-decoded and
 * lower-cased, the query string dropped. Throws for anything a catalog path
 * never needs (dot segments, encoded slashes or dots, `;`, `%` left after
 * decoding, empty segments), because the router and the URL parser undo
 * encodings the denylist would otherwise have to anticipate one by one:
 * `/%61xis` routes to `/axis`, `/x/%2e%2e/axis` and `/./axis` normalise to it.
 */
export function canonicalPath(url: string): string {
  const q = url.indexOf("?");
  const raw = q === -1 ? url : url.slice(0, q);
  const segs = raw.split("/");
  if (segs[0] !== "") throw badRequest(REFUSED_PATH);
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === "") {
      // One trailing slash is harmless (the app ignores it); an empty segment anywhere else is not.
      if (i === segs.length - 1 && i > 1) continue;
      throw badRequest(REFUSED_PATH);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      throw badRequest(REFUSED_PATH);
    }
    if (decoded === "." || decoded === ".." || !SEGMENT.test(decoded)) throw badRequest(REFUSED_PATH);
    out.push(decoded.toLowerCase());
  }
  if (!out.length) throw badRequest(REFUSED_PATH);
  return `/${out.join("/")}`;
}

/** A prose key anywhere in the body (nested objects and arrays included). */
function hasProseKey(v: unknown, depth = 0): boolean {
  if (depth > 8 || !v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => hasProseKey(x, depth + 1));
  return Object.entries(v as Record<string, unknown>).some(
    ([k, x]) => PROSE_KEYS.has(k.toLowerCase().replace(/[_-]/g, "")) || hasProseKey(x, depth + 1)
  );
}

export function assertAllowedCall(call: OpCall): void {
  const url = call.url;
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("..") || /[\s\\#]/.test(url) || /^\/[a-z]+:/i.test(url)) {
    throw badRequest(REFUSED_PATH);
  }
  const path = canonicalPath(url);
  if (NEVER.some((re) => re.test(path))) throw forbidden("AxIS can't do that.");
  if (ESSAY_PATH.test(path) && hasProseKey(call.body)) throw forbidden("AxIS doesn't write essay text.");
}

/** The counselor's request, replayed through the API. Never throws for an HTTP status; throws for a refused path. */
export async function dispatch(request: FastifyRequest, call: OpCall): Promise<Dispatched> {
  assertAllowedCall(call);
  const hasBody = call.body !== undefined && call.method !== "GET";
  const res = await request.server.inject({
    method: call.method,
    url: call.url,
    headers: {
      authorization: `Bearer ${request.auth.token}`,
      // Marks the request as AxIS's in the logs; routes don't branch on it.
      "x-meridies-axis": "1",
      ...(request.headers["user-agent"] ? { "user-agent": String(request.headers["user-agent"]) } : {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { payload: JSON.stringify(call.body) } : {}),
  });
  let body: unknown = null;
  if (res.body) {
    try {
      body = JSON.parse(res.body);
    } catch {
      body = null;
    }
  }
  return { status: res.statusCode, body };
}

/** What went wrong, in words fit for the model and the card. Our routes' error text is written for users. */
export function failureMessage(res: Dispatched): string {
  const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
  const msg = typeof b.error === "string" && b.error.trim() ? b.error.trim().slice(0, 300) : null;
  if (res.status === 400) {
    const details = b.details as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | undefined;
    const fields = details?.fieldErrors
      ? Object.entries(details.fieldErrors)
          .map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`)
          .join("; ")
      : "";
    const form = details?.formErrors?.join("; ") ?? "";
    return [msg ?? "The request was refused", fields, form].filter(Boolean).join(". ").slice(0, 600);
  }
  if (res.status === 401) return "The counselor's session has expired; they need to sign in again.";
  if (res.status === 403) return msg ?? "The counselor doesn't have permission to do that.";
  if (res.status === 404) return msg ?? "Not found. Check the id with a lookup.";
  if (res.status === 409) return msg ?? "That conflicts with the current state.";
  if (res.status === 429) return msg ?? "Too many requests just now. Try again in a minute.";
  return "That change failed on our side.";
}

/** A status the counselor could retry later (rate limit, outage), as opposed to a refusal. */
export const isTransient = (status: number) => status === 429 || status >= 500;
