/**
 * The Contact Pipeline's history and follow-ups (migration 20261028000003):
 * `pipeline_activities`, `pipeline_followups`, and the contact's `source`,
 * `status`, `lost_reason` and `last_contacted_at`.
 *
 * Until it is applied, the board keeps working on the older columns and the
 * routes that need the new tables answer 503 `pipeline_extras_unavailable`
 * instead of a 500. Ready is remembered for the process; missing for 30
 * seconds, so applying the migration is noticed without a restart (the same
 * shape as `lib/deliveryInsert.ts`).
 */

import type { FastifyRequest } from "fastify";
import { crmError } from "./crm.js";
import { HttpError } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;

export const CONTACT_EXTRA_COLUMNS = "source, status, lost_reason, last_contacted_at";
export const ACTIVITY_COLUMNS = "id, contact_id, kind, body, meta, actor_id, created_at";
export const FOLLOWUP_COLUMNS = "id, contact_id, assignee_id, title, due_on, done, done_at, created_by, created_at";

/** What a counselor writes by hand; every other kind is written by a trigger. */
export const MANUAL_ACTIVITY_KINDS = ["note", "call", "meeting", "email"] as const;

const MISSING_RECHECK_MS = 30_000;
let ready = false;
let missingAt = 0;

export function extrasUnavailable(): HttpError {
  return new HttpError(503, "History and follow-ups aren't switched on yet", "pipeline_extras_unavailable");
}

/** A zero-row read of everything the migration adds. */
export async function pipelineExtrasReady(request: FastifyRequest): Promise<boolean> {
  if (ready) return true;
  if (Date.now() - missingAt < MISSING_RECHECK_MS) return false;
  const [contacts, followups, activities] = await Promise.all([
    request.db.from("pipeline_contacts").select(CONTACT_EXTRA_COLUMNS).limit(0),
    request.db.from("pipeline_followups").select("id").limit(0),
    request.db.from("pipeline_activities").select("id").limit(0),
  ]);
  const error = contacts.error ?? followups.error ?? activities.error;
  if (!error) {
    ready = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    missingAt = Date.now();
    return false;
  }
  throw crmError(error);
}

/** For routes that cannot work without the migration. */
export async function requirePipelineExtras(request: FastifyRequest): Promise<void> {
  if (!(await pipelineExtrasReady(request))) throw extrasUnavailable();
}

/** Test seam: forget what was learned about the schema. */
export function resetPipelineExtrasForTests(): void {
  ready = false;
  missingAt = 0;
}

// ---- Serializers -----------------------------------------------------------

export function toActivity(r: Row, names: Map<string, string>) {
  const actorId = (r.actor_id as string | null) ?? null;
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    kind: String(r.kind),
    body: String(r.body ?? ""),
    meta: (r.meta as Record<string, unknown> | null) ?? {},
    actorId,
    // Null for the system, and for a student (a converted contact's own acceptance).
    actorName: actorId ? (names.get(actorId) ?? null) : null,
    createdAt: String(r.created_at),
  };
}

export type ActivityDTO = ReturnType<typeof toActivity>;

export function toFollowup(r: Row, today: string) {
  const dueOn = (r.due_on as string | null) ?? null;
  const done = r.done === true;
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    assigneeId: (r.assignee_id as string | null) ?? null,
    title: String(r.title),
    dueOn,
    done,
    doneAt: (r.done_at as string | null) ?? null,
    overdue: !done && dueOn !== null && dueOn < today,
    createdAt: String(r.created_at),
  };
}

export type FollowupDTO = ReturnType<typeof toFollowup>;

export type FollowupSummary = {
  openFollowups: number;
  nextFollowup: FollowupDTO | null;
};

export const NO_FOLLOWUPS: FollowupSummary = { openFollowups: 0, nextFollowup: null };

/** Open follow-ups per contact: how many, and the one due first (undated last). */
export function summarizeFollowups(rows: Row[], today: string): Map<string, FollowupSummary> {
  const byContact = new Map<string, FollowupDTO[]>();
  for (const r of rows) {
    const f = toFollowup(r, today);
    const list = byContact.get(f.contactId);
    if (list) list.push(f);
    else byContact.set(f.contactId, [f]);
  }
  const out = new Map<string, FollowupSummary>();
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31") || a.createdAt.localeCompare(b.createdAt));
    out.set(contactId, { openFollowups: list.length, nextFollowup: list[0] ?? null });
  }
  return out;
}
