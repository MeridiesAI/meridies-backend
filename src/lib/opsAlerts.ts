/**
 * Basic operational alerts (Privacy Policy: alerts for errors and suspicious activity), with NO outside service: the API
 * counts a few kinds of event in memory and emails the company address through Resend, which is already a subprocessor.
 *
 *   server_errors  5xx answers                         a bug or an outage
 *   auth_failures  401 answers                         a burst of bad or expired tokens (someone probing)
 *   rate_limited   429 answers                         a flood of requests
 *   bad_signatures a webhook refused for its signature someone posting fake Stripe events
 *
 * Failed PASSWORD logins happen at Supabase, not here, so they are not counted: Supabase Auth's own logs and its rate
 * limits cover them (docs/OPS_ALERTS.md says where to look).
 *
 * What an alert says: the kind, the count, the window and the time. Never a path with ids, a body, a header, an address
 * or a name. Per process: with more than one replica each counts its own traffic (the thresholds then act per replica).
 * Off unless OPS_ALERTS_ENABLED is exactly "true".
 */

export type AlertKind = "server_errors" | "auth_failures" | "rate_limited" | "bad_signatures";

export type Rule = { threshold: number; windowMs: number; what: string; look: string };

const MIN = 60_000;

export const RULES: Record<AlertKind, Rule> = {
  server_errors: {
    threshold: 10,
    windowMs: 5 * MIN,
    what: "server errors (HTTP 5xx)",
    look: "Railway, Deployments, then Logs: filter for level error around this time.",
  },
  auth_failures: {
    threshold: 40,
    windowMs: 5 * MIN,
    what: "requests refused for a bad or expired sign-in (HTTP 401)",
    look: "Railway Logs: filter for 401. A few come from expired sessions; a sudden burst from one source is worth a look.",
  },
  rate_limited: {
    threshold: 150,
    windowMs: 5 * MIN,
    what: "requests refused for going over a rate limit (HTTP 429)",
    look: "Railway Logs: filter for 429 to see which route is being hit.",
  },
  bad_signatures: {
    threshold: 5,
    windowMs: 10 * MIN,
    what: "webhook calls refused for a bad signature",
    look: "Someone may be posting fake Stripe events. Check Stripe, Developers, Webhooks for the real endpoint's health.",
  },
};

/** After an alert for a kind, the same kind stays quiet this long, so a long incident is one email an hour, not hundreds. */
export const COOLDOWN_MS = 60 * MIN;
/** The most timestamps kept per kind: a flood cannot grow memory. */
const KEEP = 1000;

export type Breach = { kind: AlertKind; count: number; windowMin: number; at: string };

export class AlertTracker {
  private events = new Map<AlertKind, number[]>();
  private lastSent = new Map<AlertKind, number>();

  constructor(private rules: Record<AlertKind, Rule> = RULES) {}

  /** Count one event. Returns a breach the first time a rule trips outside its cooldown, else null. */
  record(kind: AlertKind, now: number): Breach | null {
    const rule = this.rules[kind];
    const list = this.events.get(kind) ?? [];
    list.push(now);
    // drop what has left the window, and cap the list
    const from = now - rule.windowMs;
    let i = 0;
    while (i < list.length && list[i] < from) i++;
    const kept = list.slice(Math.max(i, list.length - KEEP));
    this.events.set(kind, kept);

    if (kept.length < rule.threshold) return null;
    const last = this.lastSent.get(kind);
    if (last !== undefined && now - last < COOLDOWN_MS) return null;
    this.lastSent.set(kind, now);
    return { kind, count: kept.length, windowMin: Math.round(rule.windowMs / MIN), at: new Date(now).toISOString() };
  }
}

/** The kind an answer counts as, if any. `url` is only used to tell a webhook's refusal apart; it is never kept. */
export function kindOf(statusCode: number, url: string): AlertKind | null {
  if (statusCode >= 500) return "server_errors";
  if (statusCode === 401) return "auth_failures";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 400 && url.startsWith("/webhooks/")) return "bad_signatures";
  return null;
}

export function alertText(b: Breach): { subject: string; lines: string[] } {
  const rule = RULES[b.kind];
  return {
    subject: `Meridies alert: ${b.count} ${rule.what} in ${b.windowMin} minutes`,
    lines: [
      `${b.count} ${rule.what} in the last ${b.windowMin} minutes (as of ${b.at}).`,
      "",
      `Where to look: ${rule.look}`,
      "",
      `You get at most one email per kind per hour. This message holds counts only: no names, addresses or request contents.`,
    ],
  };
}
