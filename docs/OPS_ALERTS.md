# Basic alerts (no outside service)

The Privacy Policy promises basic alerts for errors and suspicious activity. Two parts, neither adds a subprocessor:

## A. Emails from the API (lib/opsAlerts.ts)

Switch on in Railway, Variables: `OPS_ALERTS_ENABLED=true`. Optional: `ALERT_EMAIL` (defaults to `COMPANY_CONTACT_EMAIL`).
Needs Resend to be configured (it is the same sender every other email uses).

| Kind | Trips at | What it usually means |
|---|---|---|
| server_errors | 10 in 5 min | a bug or an outage |
| auth_failures | 40 in 5 min | a burst of bad or expired sign-ins (HTTP 401) |
| rate_limited | 150 in 5 min | a flood of requests (HTTP 429) |
| bad_signatures | 5 in 10 min | fake webhook calls (Stripe signature refused) |

One email per kind per hour at most. An email holds counts and a place to look: never a name, address or request body.
Counted in memory per process: with several replicas each counts its own traffic.

Not counted: failed password logins. They happen at Supabase Auth, not here. Look in Supabase, Authentication, Logs, and
keep Supabase's own rate limits on (Authentication, Rate Limits).

## C. Railway's own notifications (dashboard only, nothing in code)

In the Railway project: turn on notifications for deploy failures and crashes (Project Settings, Notifications, or
Observability, Monitors; the menu names move around). The service already has a health check (`/health`) and restarts on
failure (railway.json), so a crash loop shows up as failed deploys.

## Check it works

With `OPS_ALERTS_ENABLED=true` on a non-production copy, call any protected route 40 times with a bad token; the
`auth_failures` email arrives once, and not again for an hour.
