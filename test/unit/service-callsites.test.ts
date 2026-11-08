import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every file that reaches past RLS (service client or the import pool). Adding
// one means deciding whether it acts for a counselor outside their own request
// and, if so, checking approval when it runs (src/lib/access.ts). Then add it here.
const REVIEWED = [
  // lib/profileUpdateDocument.ts: inside a student's own request; the service role only reads their counselor's
  // practice switch (documentReadingAllowed) to decide whether AI may read the file. The file itself is read on
  // the student's own client.
  // lib/highSchoolProfile.ts: inside an approved user's own request (authenticate refuses an unapproved
  // counselor) after resolveStudentId and their RLS client loaded the school; the service role only fills a
  // Meridies-wide high_schools.school_profile_url left empty, with a URL the research cited and checkLink
  // passed, and stamps profile_lookup_at.
  // lib/axis/llm.ts: writes only the ai_runs audit rows for the caller's own AxIS turn, inside their request.
  // lib/aiBudget.ts: service-only budget counters, prices and the ceiling email (profile ids and roles, no names);
  // no student data. Its RPCs are EXECUTE to service_role only (20261108000002).
  // lib/axis/attachments.ts: after an approved counselor's own AxIS or /chat turn, writes a chat file's stored text
  // (columns clients can't write), only to rows the caller's own RLS read returned, keyed on id, owner_id = the
  // caller and the chat.
  // lib/eventsDiscovery.ts: the weekly job acts for no counselor; it writes only Meridies-wide hub_events
  // rows from colleges' public pages. routes/events.ts: "Refresh events" runs inside an approved
  // counselor's own request (requireRole) and writes only those same public rows.
  // routes/collegesV10.ts: "Look up info & photo" (POST /:id/lookup) runs inside an approved counselor's own
  // request (authenticate refuses an unapproved counselor; requireRole("counselor") ran) after their RLS client
  // loaded the college; the service role reads and writes only that one Meridies-wide college_photos row (and
  // the photo bucket copy of it) and that one college_site_info row (what the school's own site says about
  // applying; the library code is handed these reads and writes and holds no client), and never replaces a photo.
  // lib/imports/files.ts, mapping.ts, stage.ts: the import worker inside an approved counselor's own
  // request (authenticate + requireRole ran), p_actor = that counselor; every function re-checks
  // private.can_manage_import (which asks the approval gate). lib/imports/retention.ts: the sweep acts
  // for no counselor; it removes only raw files in the private imports bucket and staged values whose
  // time is up, as the database decides. lib/imports/invitations.ts: inside the uploader's (or a firm
  // admin's) own request, after their RLS client loaded the import: counts that uploader's import items for
  // the review (numbers only), sets or lifts invites_held_reason on that one row (lifting only after Meridies
  // approved another of the same counselor's imports), and takes a per-counselor send lease.
  // lib/imports/heldAddresses.ts: inside an approved counselor's own request, reads only invitations whose
  // counselor_id is the caller (or the uploader of an import the caller's client loaded) and the import items
  // tied to them, to refuse an invitation; it writes nothing and returns nothing to the client but a refusal.
  // lib/caseloadTransfer.ts: after an approved firm admin's transfer commits (inside their request), reads the
  // addresses of exactly the profiles transfer_caseload returned, to mail them. Outbound delivery only.
  // lib/documentExtraction.ts: after a counselor's confirmation inside their request, and on recovery; re-checks isCounselorApproved per row and writes only that row's text.
  // lib/practiceSettings.ts: inside a student's own request, reads their counselor's Data & privacy row
  // (keyed by the caller's own profile, re-read from the database), and asks isCounselorApproved first.
  // lib/documentClaim.ts: inside the caller's own request, after authenticate; asks Storage whether an object is
  // at a path the caller may file into, and removes the object of a documents row the caller just deleted.
  // lib/myInvitations.ts: inside a student's own request, after authenticate + requireRole("student"): finds pending
  // invitations to that account's confirmed address (never returns a token) and accepts one by running
  // accept_invitation as the student; asks approvedCounselorIds first.
  // routes/kpi.ts: inside an approved counselor's own request (authenticate + requireRole), after
  // assertOwnsSubject on the caller's RLS client; calls kpi_heartbeat with p_counselor = the caller only,
  // and writes only the caller's own kpi_baselines row. lib/kpi/monthly.ts: the cron job acts for no one
  // request; it asks approvedCounselorIds before finalizing or emailing anyone, and reads/writes only kpi_*
  // rows plus recipients' sign-in emails. routes/kpiUnsubscribe.ts: public, the hashed token decides; it only
  // switches that one row's monthly_email off.
  // routes/pipelineUnsubscribe.ts: public, the hashed token decides; it only stamps that one contact's
  // email_opted_out_at. The sequence dispatcher (lib/pipelineSequences.ts) is handed its client by the
  // cron route in routes/internal.ts and asks approvedCounselorIds before sending for anyone.
  // routes/pipelineStripe.ts: inside an approved counselor's own request (authenticate + requireRole), after
  // their RLS client's crm_my_workspace said they run the practice (Connect) or can see it (status); writes only
  // that practice's practice_stripe_accounts row, which clients have no write grant on. routes/pay.ts: public,
  // the hashed pay token decides; reads only that invoice, its family's billing rows and the practice's Stripe
  // account, asks approvedCounselorIds for the contact's counselor before opening a Checkout, writes nothing.
  // routes/stripeWebhook.ts: acts for no counselor; Stripe's signature decides, and it writes only a card
  // payment against the invoice named in a session taken on that invoice's own practice account, refunded
  // amounts on such payments, the matching practice_stripe_accounts flags, and stripe_webhook_events.
  // lib/replyRouting.ts: mints and reads the reply address for one (counselor, family member) target. Inside an
  // approved counselor's own request or a job already scoped to them; the caller has shown the counselor may write
  // to that contact/student (RLS-bound read) before asking, and it never takes an id from a client. Writes only
  // messaging_routes, which clients cannot touch. The inbound side (lib/inboundEmail.ts) is handed the client by
  // routes/webhooks.ts (Resend's signature decides) and asks isCounselorApproved for the route's counselor.
  // routes/messaging.ts: inside an approved counselor's own request (authenticate + requireRole); writes only the
  // caller's own consultant_phone_numbers row, keyed by request.auth.userId (never a request value), after buying
  // the number they picked, and releases the number if that write fails. lib/inboundSms.ts is handed the client by
  // routes/webhooks.ts (Twilio's signature decides) and asks isCounselorApproved for the number's counselor.
  // lib/collegeMediaLookup.ts: the automatic photo/logo lookup acts for no counselor; it reads a school's public
  // home page and writes only Meridies-wide college_photos / college_logos rows (and their public bucket copies),
  // never replacing what a school has. Queued from GET /colleges/media inside a signed-in request, bounded by a
  // small in-process queue and a week between tries per school.
  "lib/collegeMediaLookup.ts",
  // lib/studentToCounselor.ts: inside a student's own request (authenticate + requireRole("student")): reads the
  // address of the caller's own counselor (profiles.counselor_id from the row authenticate loaded, never a request
  // value) after asking isCounselorApproved, and writes or reads only inbound_messages rows keyed by the caller's id.
  "lib/studentToCounselor.ts",
  // lib/axisTrash.ts: acts for no counselor. The hourly purge (from the scheduled sweep) deletes trash rows past
  // 30 days; account deletion (DELETE /account, the caller's own id) deletes the trash it made and about it. Both
  // remove only the student-documents objects the database hands back as needed by nothing.
  "lib/axisTrash.ts",
  // lib/handInValues.ts: stampConfirmed marks hand-in values confirmed on one tracker check, from
  // POST /tasks/:id/checks/:checkId/values/confirm after requireRole("counselor"), resolveStudentId(..., "edit"),
  // the check read on the caller's own client (so it is theirs to see) and the printed values compared. The column
  // has no client grant (20261108000005); the profile write itself runs on the caller's client.
  "lib/handInValues.ts",
  // routes/calendarIcal.ts: the subscribed calendar feed. GET /calendar/ical/:token.ics is public: the hashed token
  // decides, and lib/calendarIcal.ts (handed the client) asks approvedCounselorIds for the token's counselor before
  // building anything, then names that counselor's own caseload (fullCaseloadStudentIds) in every student-spanning
  // query (buildCalendarFeed throws without one, never runs unscoped); it writes only that token row's
  // last_fetched_at. The authenticated GET/POST/DELETE run inside an approved counselor's own request
  // (authenticate + requireRole) and read or write only the caller's own calendar_feed_tokens row, keyed by
  // request.auth.userId; the table has no client grant.
  "routes/calendarIcal.ts",
  "lib/accountability.ts", "lib/aiBudget.ts", "lib/anthropic.ts", "lib/axis/attachments.ts", "lib/axis/llm.ts", "lib/caseloadTransfer.ts", "lib/documentClaim.ts", "lib/documentExtraction.ts", "lib/email.ts", "lib/eventsDiscovery.ts", "lib/heartbeat.ts", "lib/highSchoolProfile.ts", "lib/profileUpdateDocument.ts", "lib/imports/jobs.ts",
  "lib/imports/files.ts", "lib/imports/heldAddresses.ts", "lib/imports/invitations.ts", "lib/imports/mapping.ts", "lib/imports/retention.ts", "lib/imports/stage.ts",
  "lib/ingest/linkCheck.ts", "lib/ingest/run.ts", "lib/limits.ts", "lib/myInvitations.ts", "lib/newStudentIntake.ts", "lib/oauth.ts", "lib/practiceSettings.ts",
  "lib/replyRouting.ts", "lib/research/accept.ts", "lib/research/run.ts", "lib/submissionReview.ts", "lib/supabase.ts",
  "lib/sweepSchedule.ts", "routes/accessReview.ts", "routes/account.ts", "routes/auth.ts",
  "routes/collegeIntel.ts", "routes/collegesV10.ts", "routes/communication.ts", "routes/events.ts", "routes/health.ts", "routes/integrations.ts",
  "routes/internal.ts", "routes/kpi.ts", "routes/messaging.ts", "routes/kpiUnsubscribe.ts", "routes/pay.ts", "routes/pipelineStripe.ts", "routes/pipelineUnsubscribe.ts", "routes/stripeWebhook.ts", "routes/webhooks.ts",
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
