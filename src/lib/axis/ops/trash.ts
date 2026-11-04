/**
 * AxIS deletes are kept 30 days and restorable (20261108000003, AxIS security PR B; spec section 2).
 *
 * A covered delete (a Confirm-tier DELETE op below) runs with a mark: `dispatch` sends `x-meridies-axis-mark`, an
 * HMAC of the action id under a key made fresh in this process, and `supabaseAuth` turns a valid mark into the
 * `x-meridies-axis-action` header on `request.db`, which the database's capture trigger reads. A client can't forge
 * a mark the API honours; one that sets the database header itself (straight to PostgREST) only keeps a copy of its
 * own deletes, which only it can restore (the database's rules).
 *
 * The card's Restore runs `axis_trash_restore` on the counselor's own client.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSchemaMissing } from "../failsafe.js";

export const TRASH_MIGRATION = "20261108000003_axis_trash";
export const TRASH_MISSING = `AxIS can't delete things until the database update ${TRASH_MIGRATION} is applied.`;

/** Every Confirm-tier DELETE op whose rows the trash keeps. `axis-trash.test.ts` fails on a DELETE op in neither list. */
export const TRASH_COVERED: ReadonlySet<string> = new Set([
  "courses.delete",
  "test_scores.delete",
  "tasks.delete",
  "tasks.delete_step",
  "tasks.remove_handed_in_file",
  "deadlines.delete",
  "work_queue.delete",
  "accountability.remove_guardian",
  "meetings.delete",
  "calendar.delete_event_type",
  "calendar.delete_event",
  "meeting_notes.delete",
  "college_list.remove",
  "essays.delete",
  "application.delete_activity",
  "application.delete_honor",
  "aid.delete_award_letter",
  "aid.delete_award_item",
  "aid.delete_appeal",
  "reports.delete",
  "reports.delete_flag",
  "colleges.delete_webinar_tip",
  "events.delete",
  "resources.delete",
  "files.delete_folder",
  "files.delete_document",
  "files.delete_link",
  "outcomes.delete",
  "referrals.delete",
  "pipeline.delete_stage",
  "pipeline.delete_contact",
  "management.delete_task",
]);

/** DELETE ops the trash leaves alone, and why. */
export const TRASH_EXCLUDED: Readonly<Record<string, string>> = {
  "students.archive": "an update, already reversible",
  "pins.unpin": "instant, keeps its reversal Undo",
  "events.unsave": "instant, keeps its reversal Undo",
  "resources.unpin": "instant, keeps its reversal Undo",
  "students.clear_status": "keeps its reversal Undo (sets the status back)",
  "students.clear_card_rating": "keeps its reversal Undo (sets the rating back)",
  "strength_profile.remove_axis": "keeps its reversal Undo (a default axis is hidden, not deleted)",
  "tasks.detach_file": "keeps its reversal Undo (attaches the file again)",
  "templates.delete": "keeps its reversal Undo (writes the template again)",
  "payments.delete_payment": "keeps its reversal Undo (records the payment again)",
};

// ---- The mark ----

const KEY = randomBytes(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sign = (actionId: string) => createHmac("sha256", KEY).update(actionId).digest("hex");

/** `<action id>.<hex hmac>`, honoured only by this process. */
export function markFor(actionId: string): string {
  return `${actionId}.${sign(actionId)}`;
}

/** The action id a valid mark carries, or null (no mark, a malformed one, a forged or stale signature). */
export function readMark(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const dot = header.indexOf(".");
  if (dot < 0) return null;
  const id = header.slice(0, dot);
  const given = header.slice(dot + 1);
  if (!UUID.test(id) || !/^[0-9a-f]{64}$/.test(given)) return null;
  const want = Buffer.from(sign(id), "hex");
  const got = Buffer.from(given, "hex");
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

// ---- Is the migration in ----

let ready = false;
let missingUntil = 0;

/** A zero-row probe of the restore function: ready is kept for the process, missing is asked again after 30 s. */
export async function trashReady(db: SupabaseClient): Promise<boolean> {
  if (ready) return true;
  if (Date.now() < missingUntil) return false;
  const { error } = await db.rpc("axis_trash_restore", { p_action: "00000000-0000-0000-0000-000000000000" });
  if (!error) {
    ready = true;
    return true;
  }
  if (isSchemaMissing(error)) {
    missingUntil = Date.now() + 30_000;
    return false;
  }
  throw error;
}

/** Tests only. */
export function resetTrashReadyForTest(): void {
  ready = false;
  missingUntil = 0;
}

// ---- Restore ----

const SENTENCES: Record<string, string> = {
  expired: "This can't be restored: the 30 days are up.",
  "no-access": "This can't be restored: you no longer have access to that student.",
  conflict: "This can't be restored: something with the same details exists again.",
  "parent-missing": "This can't be restored: what it belonged to has been deleted.",
  already: "That was already restored.",
  "not-approved": "This can't be restored: your counselor access isn't active.",
};

/** The card's sentence for a refused restore. */
export function restoreSentence(reason: string): string {
  return SENTENCES[reason] ?? "This can't be restored.";
}

/** How long a confirmed delete can be restored. */
export const RESTORE_DAYS = 30;
export const restoreUntil = (confirmedAt: Date): string => new Date(confirmedAt.getTime() + RESTORE_DAYS * 86_400_000).toISOString();
