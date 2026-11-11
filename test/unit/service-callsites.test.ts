import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every file that reaches past RLS (service client or the import pool). Adding
// one means deciding whether it acts for a counselor outside their own request
// and, if so, checking approval when it runs (src/lib/access.ts). Then add it here.
const REVIEWED = [
  // lib/parentNotice.ts: inside a student's own POST/PATCH /me/guardians; the service role reads their counselor's
  // name and email (for the notice and its Reply-To) and records the delivery. No counselor acts, so no approval check.
  "lib/parentNotice.ts",
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
  // lib/axis/drafts/state.ts: inside an approved counselor's own AxIS turn, writes that conversation's state and
  // draft_rows (a column clients can't write, 20261112000001) in one update keyed on id, owner_id = the caller and
  // the updated_at the caller's own RLS read returned; the draft holds only what the caller's turn put there.
  // lib/eventsDiscovery.ts: the weekly job acts for no counselor; it writes only Meridies-wide hub_events
  // rows from colleges' public pages. routes/events.ts: "Refresh events" runs inside an approved
  // counselor's own request (requireRole) and writes only those same public rows.
  // routes/collegesV10.ts: "Look up info & photo" (POST /:id/lookup) runs inside an approved counselor's own
  // request (authenticate refuses an unapproved counselor; requireRole("counselor") ran) after their RLS client
  // loaded the college; the service role reads and writes only that one Meridies-wide college_photos row (and
  // the photo bucket copy of it) and that one college_site_info row (what the school's own site says about
  // applying; the library code is handed these reads and writes and holds no client), and never replaces a photo.
  // Also POST /list-builder/add: inside a student's own request (requireRole("student") and the practice's student-AI
  // switch ran; the schools were inserted on the student's own RLS client). The service role is handed to
  // lib/studentListFit.ts, which sets ONE column, `fit`, on the rows that request just inserted (keyed on the row,
  // the student and added_by = the student). The tag is computed from the student's own numbers; nothing in the
  // request chooses it (the body is strict). The database refuses a student-set fit, which is why the server writes it.
  // lib/listLearning.ts: list-builder learning (20261119000001), inside the caller's own request after its route
  // authorized them (resolveStudentId, or the row their own RLS client just wrote or deleted). The service role only
  // reads the student's counselor's firm and its exclude_from_learning flag, reads that student's own impression rows,
  // and inserts rows of ids and labels into the two logging tables, which no client can read or write. It acts for
  // no counselor outside their request, returns nothing to the client, and writes nothing a user can see.
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
  // routes/preferences.ts: inside an approved counselor's own request (authenticate; the role is re-read per
  // request), reads only counselor_note of the catalog preference_cards rows the caller's RLS client already
  // returned, by id. No caller-supplied id, no student data; a follow-up migration takes the column out of
  // the client SELECT grant.
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
  // lib/parentInvites.ts (parent accounts, 20261123000002): only redeemParentInvite, from the public POST
  // /parent-invites/accept. It acts for no counselor. It creates an auth user for exactly the address the
  // database's parent_invite_preview returned for that token's hash (the token only reached that inbox), then calls
  // parent_invite_redeem (EXECUTE to service_role only), which re-checks everything in one transaction; on any
  // refusal it deletes that just-made user. No client id reaches the service role.
  "lib/parentInvites.ts",
  // lib/parentToCounselor.ts: inside a parent account's own request (authenticate + requireRole("parent"),
  // allowParent). The counselor is the one parent_children returned on the caller's own client (the live guardian
  // link), asked isCounselorApproved before reading their address; it writes or reads only inbound_messages rows
  // whose provider_message_id carries the caller's own id.
  "lib/parentToCounselor.ts",
  // lib/axisTrash.ts: acts for no counselor. The hourly purge (from the scheduled sweep) deletes trash rows past
  // 30 days; account deletion (DELETE /account, the caller's own id) deletes the trash it made and about it. Both
  // remove only the student-documents objects the database hands back as needed by nothing.
  "lib/axisTrash.ts",
  // lib/handInValues.ts: stampConfirmed marks hand-in values confirmed on one tracker check, from
  // POST /tasks/:id/checks/:checkId/values/confirm after requireRole("counselor"), resolveStudentId(..., "edit"),
  // the check read on the caller's own client (so it is theirs to see) and the printed values compared. The column
  // has no client grant (20261108000005); the profile write itself runs on the caller's client.
  "lib/handInValues.ts",
  // routes/branding.ts: inside an approved counselor's own request (authenticate + requireRole("counselor")), after a
  // firm scope's owner/admin check on their RLS client (a solo counselor's scope is their own id). The service role only
  // touches the public branding bucket, which has no client write policy, and only under that scope's own folder: it
  // mints a signed upload URL for a path the API names, reads back an object a save names (only once ownBrandingPath
  // put it in the caller's folder) and removes one a save replaced, cleared or that wasn't the image it claimed.
  "routes/branding.ts",
  // routes/studentAvatar.ts: a student's profile picture, inside the student's own request or their approved primary
  // counselor's (authenticate, resolveStudentId(..., "edit"), then the caller's own RLS client read the student's row
  // and the counselor_id check ran). The service role only touches the private student-banners bucket under that
  // student's own folder: it mints a signed upload URL for a path the API names (the insert policy is student-self
  // only), reads back the object a save names (isOwnAvatarPath first), removes the photo a save replaced or cleared,
  // one that wasn't a JPEG, and the student's own abandoned avatar-*.jpg uploads. profiles.avatar_url is written on
  // the caller's own client. The signed read URLs come from lib/studentAvatar.ts's signAvatarUrls.
  "routes/studentAvatar.ts",
  // routes/students.ts: GET /students, GET/PATCH /students/:id hand the service client to signAvatarUrls
  // (lib/studentAvatar.ts) to sign read URLs for the photos of exactly the rows the caller's own RLS query returned;
  // a stored reference is honoured only inside the row's own student folder. Nothing is written. routes/auth.ts
  // (listed below) does the same for the caller's own row in GET and PATCH /auth/me.
  "routes/students.ts",
  // lib/driveExport.ts: only the DRIVE_EXPORT_FAKE test double (refused at boot outside development/test) reads the
  // caller's own integration_tokens row (scopes and account email, keyed on the caller's id from the approved
  // counselor's request, never decrypted) to stand in for Google. The real client goes through lib/oauth.ts.
  "lib/driveExport.ts",
  // lib/accountDeletion.ts: deleteAccount runs inside the account's own request (DELETE /account) or for the
  // closure purge (lib/accountClosure.ts, handed the client by routes/internal.ts behind CRON_SECRET and
  // ACCOUNT_PURGE_ENABLED); it removes only that account's own trash, AI counters and auth user. Approval isn't asked:
  // a pending or revoked counselor may still leave.
  "lib/accountDeletion.ts",
  // routes/agreements.ts: the public /agree/:token page (nobody signed in). The hashed token decides; it reads only
  // the agreement that token names, its contact's email, the practice's name and its counselor's email, asks
  // approvedCounselorIds for the agreement's counselor first, and writes only through accept_agreement (EXECUTE to
  // service_role only), which re-checks the token, its expiry and the agreement's status under a row lock. The
  // counselor routes run on the caller's own client.
  "routes/agreements.ts",
  // lib/catalogProposalsRun.ts: the catalog proposer acts for no counselor (POST /internal/catalog/propose behind
  // CRON_SECRET, or the local-only script). It reads one school's public catalog row, its curated policies and
  // supplements, and inserts only PENDING catalog_change_proposals rows (proposed_by null), which clients can't
  // write; nothing curated changes until a catalog editor approves through review_catalog_proposal.
  "lib/catalogProposalsRun.ts",
  // routes/calendarIcal.ts: the subscribed calendar feed. GET /calendar/ical/:token.ics is public: the hashed token
  // decides, and lib/calendarIcal.ts (handed the client) asks approvedCounselorIds for the token's counselor before
  // building anything, then names that counselor's own caseload (fullCaseloadStudentIds) in every student-spanning
  // query (buildCalendarFeed throws without one, never runs unscoped); it writes only that token row's
  // last_fetched_at. The authenticated GET/POST/DELETE run inside an approved counselor's own request
  // (authenticate + requireRole) and read or write only the caller's own calendar_feed_tokens row, keyed by
  // request.auth.userId; the table has no client grant.
  "routes/calendarIcal.ts",
  // lib/inactivityAlerts.ts: runInactivityPass rides on the scheduled sweep (acts for no request); it asks
  // approvedCounselorIds before anything, reads each approved counselor's own roster by profiles.counselor_id, and
  // writes only student_inactivity_alerts and that counselor's own notification and email (a first name and a number
  // of days). touchLastActive stamps the caller's own profiles.last_active_at, keyed by the row authenticate loaded.
  "lib/inactivityAlerts.ts",
  // lib/essayNotice.ts: inside a student's own request, after their RLS client saved the essay: tells only the
  // caller's own counselor (profiles.counselor_id from the row authenticate loaded, never a request value) after
  // asking isCounselorApproved; writes one notification (no essay text) and reads that counselor's settings and email.
  "lib/essayNotice.ts",
  // routes/reports.ts: approve-send, inside an approved counselor's own request (authenticate + requireRole), after
  // resolveStudentId(edit) and their own RLS client claimed the report and wrote the message rows; the service role
  // writes only the audit_log row naming the caller and that report (no student data).
  "routes/reports.ts",
  // lib/booking.ts: student booking, inside a student's own request (authenticate + requireRole("student")): the
  // counselor is the caller's own profiles.counselor_id (the row authenticate loaded, never a request value), asked
  // isCounselorApproved first (fail closed), then booking_settings.enabled; reads only that counselor's
  // booking_settings, active booking_meeting_types, scheduled meetings' start and end, and which calendar providers
  // they connected (integration_tokens.provider only). Only free slot times are returned. Writes nothing.
  "lib/booking.ts",
  // routes/publicBooking.ts: public, the slug decides. resolvePublicLink reads the one booking_settings row whose
  // public_slug it is and asks isCounselorApproved (fail closed), booking on and the link on before anything else;
  // every later read and write is keyed by that counselor (their types, meetings' and public bookings' times,
  // calendar providers, name, firm and logo) or by the public_bookings row this request just reserved. It writes
  // that row (book_public_slot, service role only), the counselor's notification, and the pipeline card through
  // public_booking_to_pipeline. routes/booking.ts: inside an approved counselor's own request (authenticate +
  // requireRole), writes only public_slug on the caller's own settings row (a column clients can't write).
  "routes/publicBooking.ts",
  "routes/booking.ts",
  "lib/accountability.ts", "lib/aiBudget.ts", "lib/anthropic.ts", "lib/axis/attachments.ts", "lib/axis/drafts/state.ts", "lib/axis/llm.ts", "lib/caseloadTransfer.ts", "lib/documentClaim.ts", "lib/documentExtraction.ts", "lib/email.ts", "lib/eventsDiscovery.ts", "lib/heartbeat.ts", "lib/highSchoolProfile.ts", "lib/profileUpdateDocument.ts", "lib/imports/jobs.ts",
  "lib/imports/files.ts", "lib/imports/heldAddresses.ts", "lib/imports/invitations.ts", "lib/imports/mapping.ts", "lib/imports/retention.ts", "lib/imports/stage.ts",
  "lib/ingest/linkCheck.ts", "lib/ingest/run.ts", "lib/limits.ts", "lib/listLearning.ts", "lib/myInvitations.ts", "lib/newStudentIntake.ts", "lib/oauth.ts", "lib/practiceSettings.ts",
  "lib/replyRouting.ts", "lib/research/accept.ts", "lib/research/run.ts", "lib/submissionReview.ts", "lib/supabase.ts",
  "lib/sweepSchedule.ts", "routes/accessReview.ts", "routes/account.ts", "routes/auth.ts",
  "routes/collegeIntel.ts", "routes/collegesV10.ts", "routes/communication.ts", "routes/events.ts", "routes/health.ts", "routes/integrations.ts",
  "routes/internal.ts", "routes/kpi.ts", "routes/messaging.ts", "routes/kpiUnsubscribe.ts", "routes/pay.ts", "routes/pipelineStripe.ts", "routes/preferences.ts", "routes/pipelineUnsubscribe.ts", "routes/stripeWebhook.ts", "routes/webhooks.ts",
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
