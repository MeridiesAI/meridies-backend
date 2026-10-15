import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every file that reaches past RLS (service client or the import pool). Adding
// one means deciding whether it acts for a counselor outside their own request
// and, if so, checking approval when it runs (src/lib/access.ts). Then add it here.
const REVIEWED = [
  // lib/axis/llm.ts: writes only the ai_runs audit rows for the caller's own AxIS turn, inside their request.
  // lib/eventsDiscovery.ts: the weekly job acts for no counselor; it writes only Meridies-wide hub_events
  // rows from colleges' public pages. routes/events.ts: "Refresh events" runs inside an approved
  // counselor's own request (requireRole) and writes only those same public rows.
  // lib/imports/files.ts, mapping.ts, stage.ts: the import worker inside an approved counselor's own
  // request (authenticate + requireRole ran), p_actor = that counselor; every function re-checks
  // private.can_manage_import (which asks the approval gate). lib/imports/retention.ts: the sweep acts
  // for no counselor; it removes only raw files in the private imports bucket and staged values whose
  // time is up, as the database decides. lib/imports/invitations.ts: inside the uploader's (or a firm
  // admin's) own request, after their RLS client loaded the import, sets only invites_held_reason on that
  // one row (a hold: it can only stop invitations, never send one).
  // lib/caseloadTransfer.ts: after an approved firm admin's transfer commits (inside their request), reads the
  // addresses of exactly the profiles transfer_caseload returned, to mail them. Outbound delivery only.
  // lib/practiceSettings.ts: inside a student's own request, reads their counselor's Data & privacy row
  // (keyed by the caller's own profile, re-read from the database), and asks isCounselorApproved first.
  "lib/accountability.ts", "lib/anthropic.ts", "lib/axis/llm.ts", "lib/caseloadTransfer.ts", "lib/email.ts", "lib/eventsDiscovery.ts", "lib/heartbeat.ts", "lib/imports/jobs.ts",
  "lib/imports/files.ts", "lib/imports/invitations.ts", "lib/imports/mapping.ts", "lib/imports/retention.ts", "lib/imports/stage.ts",
  "lib/ingest/linkCheck.ts", "lib/ingest/run.ts", "lib/limits.ts", "lib/newStudentIntake.ts", "lib/oauth.ts", "lib/practiceSettings.ts",
  "lib/research/accept.ts", "lib/research/run.ts", "lib/submissionReview.ts", "lib/supabase.ts",
  "lib/sweepSchedule.ts", "routes/accessReview.ts", "routes/account.ts", "routes/auth.ts",
  "routes/collegeIntel.ts", "routes/communication.ts", "routes/events.ts", "routes/health.ts", "routes/integrations.ts",
  "routes/internal.ts", "routes/webhooks.ts",
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []
  );
}

test("every elevated-access call site has been reviewed for the approval gate", () => {
  const src = fileURLToPath(new URL("../../src", import.meta.url));
  const found = tsFiles(src)
    .filter((f) => /serviceClient\(|withWorkerTransaction\(/.test(readFileSync(f, "utf8")))
    .map((f) => relative(src, f).split("\\").join("/"))
    .sort();
  assert.deepEqual(found, [...REVIEWED].sort());
});
