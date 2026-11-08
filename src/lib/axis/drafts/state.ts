/**
 * The activity draft's saved state (spec 4.1; plan review 11/8 items 1, 2 and 5).
 *
 * One draft per conversation: a small header in `ai_conversations.state.draft` (who it is for, when it opened, what
 * AxIS last asked for) and its rows in `ai_conversations.draft_rows` (each activity's values, their sources, its
 * card). Only the server writes the rows (the service client; 20261112000001 revokes the client's grant), and a
 * save is a compare-and-set on the conversation's `updated_at`: when another turn wrote first, the draft is
 * reloaded and this turn's own changes (`touched`) are applied on top, so concurrent turns lose nothing.
 *
 * Card statuses aren't pushed here by the Confirm route: each turn reads them back (`syncCards`), so a Confirm or a
 * Dismiss clicked between turns, or while a turn runs, is seen on the next one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { serviceClient } from "../../supabase.js";
import { isSchemaMissing } from "../failsafe.js";
import type { DialogueState } from "../nlu.js";
import type { OpContext, OperationPayload } from "../ops/run.js";
import { ACTIVITY_FIELDS, freeTextKey, type ActivityField } from "./normalize.js";

export const DRAFT_TTL_MS = 30 * 60 * 1000;
export const MAX_DRAFT_ROWS = 10;
const ROW_KEY = /^r([1-9]|10)$/;

const fieldSchema = z.enum(ACTIVITY_FIELDS as [ActivityField, ...ActivityField[]]);

export const draftHeaderSchema = z.object({
  kind: z.literal("activity"),
  student_id: z.string().min(1).max(64),
  student_name: z.string().max(200),
  opened_at: z.string().max(40),
  updated_at: z.string().max(40),
  opened_msg: z.string().max(64).optional(),
  asked: z.object({ at: z.string().max(40), fields: z.array(fieldSchema).max(10), after_msg: z.string().max(64) }).optional(),
  expired_at: z.string().max(40).optional(),
  switch_to: z.object({ student_id: z.string().max(64), name: z.string().max(200) }).optional(),
});
export type DraftHeader = z.infer<typeof draftHeaderSchema>;

export type ValueSource = { label: string; outside: boolean };
export type RowStatus = "collecting" | "card" | "saved" | "dismissed" | "skipped" | "failed";
export type DraftRow = {
  key: string;
  op: "add" | "update";
  activity_id?: string;
  fields: Partial<Record<ActivityField, unknown>>;
  sources: Partial<Record<ActivityField, ValueSource>>;
  read_as: Partial<Record<ActivityField, string>>;
  status: RowStatus;
  card_id?: string;
  message?: string;
};

const sourceSchema = z.object({ label: z.string().max(120), outside: z.boolean() });
const draftRowSchema = z.object({
  key: z.string().regex(ROW_KEY),
  op: z.enum(["add", "update"]),
  activity_id: z.string().max(64).optional(),
  fields: z.record(z.unknown()),
  sources: z.record(sourceSchema),
  read_as: z.record(z.string().max(200)),
  status: z.enum(["collecting", "card", "saved", "dismissed", "skipped", "failed"]),
  card_id: z.string().max(64).optional(),
  message: z.string().max(300).optional(),
});

export type DraftNote = {
  kind: "filed" | "replaced" | "saved" | "rejected" | "missing" | "failed" | "refused-student" | "refused-unrelated" | "cancelled" | "opened" | "expired";
  key?: string;
  field?: string;
  reason?: string;
};

/** What this turn changed, so a save that lost a race can re-apply exactly that on top of the other turn's write. */
export type Touched = {
  header: Set<keyof DraftHeader>;
  rows: Map<string, { fields: Set<ActivityField>; status: boolean; created: boolean }>;
  closed: boolean;
};

export type Draft = {
  /** The draft_rows column exists (20261112000001). */
  ready: boolean;
  /** The conversation's updated_at as this turn read it: the compare-and-set key. */
  version: string | null;
  header: DraftHeader | null;
  rows: DraftRow[];
  notes: DraftNote[];
  touched: Touched;
  /** The conversation had a draft when the turn started (its save must then come from the turn, not the route). */
  hadHeader: boolean;
  /** This turn the counselor said yes to starting a draft for another student. Never saved. */
  switchAccepted?: boolean;
};

const emptyTouched = (): Touched => ({ header: new Set(), rows: new Map(), closed: false });

// ---- Readiness ----------------------------------------------------------------------------------------

let readyOk = false;
let missingUntil = 0;

/** Whether ai_conversations.draft_rows exists. Cached once seen; a miss is re-checked after 30 seconds. */
export async function draftsReady(db: FastifyRequest["db"]): Promise<boolean> {
  if (readyOk) return true;
  if (Date.now() < missingUntil) return false;
  const { error } = await db.from("ai_conversations").select("draft_rows").limit(0);
  if (!error) return (readyOk = true);
  if (isSchemaMissing(error)) {
    missingUntil = Date.now() + 30_000;
    return false;
  }
  throw error;
}

/** For tests. */
export function resetDraftsReady(): void {
  readyOk = false;
  missingUntil = 0;
}

// ---- Load and save ------------------------------------------------------------------------------------

/** The conversation's draft, its header and version from one read. A broken header or row is dropped. */
export async function loadDraft(request: FastifyRequest, conversationId: string): Promise<Draft> {
  const ready = await draftsReady(request.db).catch(() => false);
  const { data, error } = await request.db
    .from("ai_conversations")
    .select(ready ? "updated_at, state, draft_rows" : "updated_at, state")
    .eq("id", conversationId)
    .maybeSingle();
  const row = (error ? null : data) as Record<string, unknown> | null;
  const state = (row?.state ?? null) as Record<string, unknown> | null;
  const parsed = draftHeaderSchema.safeParse(state?.draft);
  const header = parsed.success ? parsed.data : null;
  const rawRows = ready && header && Array.isArray(row?.draft_rows) ? (row!.draft_rows as unknown[]) : [];
  const rows = rawRows.flatMap((r) => {
    const ok = draftRowSchema.safeParse(r);
    return ok.success ? [ok.data as DraftRow] : [];
  });
  return {
    ready, version: typeof row?.updated_at === "string" ? row.updated_at : null, header, rows: rows.slice(0, MAX_DRAFT_ROWS),
    notes: [], touched: emptyTouched(), hadHeader: header !== null,
  };
}

const anyCollecting = (d: Draft) => d.rows.some((r) => r.status === "collecting");

/**
 * Saves the dialogue state with the draft's header, and its rows, in one write through the server's client, only if
 * nobody wrote the conversation since this turn read it. On a lost race it reloads, merges this turn's changes and
 * tries once more. Answers whether the draft was kept; never throws. `draft` is updated in place to what was saved.
 */
export async function saveDraft(
  request: FastifyRequest,
  conversationId: string,
  state: DialogueState,
  draft: Draft,
  db: SupabaseClient | null = serviceClient()
): Promise<boolean> {
  try {
    const { draft: _old, ...plain } = state as DialogueState & { draft?: unknown };
    if (!draft.ready || !db) {
      // No column or no server client: the dialogue state still saves; the draft can't.
      await request.db.from("ai_conversations").update({ state: plain }).eq("id", conversationId);
      return !anyCollecting(draft) && !draft.rows.some((r) => r.status === "card");
    }
    const write = async (d: Draft): Promise<string | null> => {
      if (!d.version) return null;
      const { data, error } = await db
        .from("ai_conversations")
        .update({ state: { ...plain, ...(d.header ? { draft: d.header } : {}) }, draft_rows: d.header && d.rows.length ? d.rows : null })
        .eq("id", conversationId)
        .eq("owner_id", request.auth.userId)
        .eq("updated_at", d.version)
        .select("updated_at");
      if (error) throw error;
      const hit = ((data ?? []) as { updated_at?: unknown }[])[0];
      return hit ? String(hit.updated_at) : null;
    };
    let version = await write(draft);
    if (version === null) {
      const fresh = await loadDraft(request, conversationId);
      const merged = mergeDraft(fresh, draft);
      if (!merged) return false;
      version = await write(merged);
      if (version === null) return false;
      Object.assign(draft, { header: merged.header, rows: merged.rows });
    }
    draft.version = version;
    return true;
  } catch (err) {
    request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "axis draft not saved");
    return false;
  }
}

/**
 * `fresh` (what another turn saved) with `ours`'s own changes applied: the header keys it touched, and per row the
 * fields and status it touched. A row this turn started whose key the other turn used for another activity moves to
 * the next free key. Null when the two can't be joined (two different students, or more than 10 rows).
 */
export function mergeDraft(fresh: Draft, ours: Draft): Draft | null {
  const out: Draft = { ...fresh, rows: fresh.rows.map((r) => structuredClone(r)), notes: ours.notes, touched: ours.touched, hadHeader: ours.hadHeader };
  if (ours.touched.closed && !ours.header) return { ...out, header: null, rows: [] };
  if (!out.header) out.header = ours.header ? { ...ours.header } : null;
  else if (ours.header) {
    if (ours.header.student_id !== out.header.student_id) return null;
    const h = out.header as Record<string, unknown>;
    for (const k of ours.touched.header) {
      const v = (ours.header as Record<string, unknown>)[k];
      if (v === undefined) delete h[k];
      else h[k] = structuredClone(v);
    }
  }
  for (const [key, t] of ours.touched.rows) {
    const mine = ours.rows.find((r) => r.key === key);
    if (!mine) continue;
    let theirs = out.rows.find((r) => r.key === key);
    if (t.created && theirs && freeTextKey(String(theirs.fields.organization ?? "")) !== freeTextKey(String(mine.fields.organization ?? ""))) {
      const next = freeKey(out.rows.map((r) => r.key));
      if (!next) return null;
      out.rows.push({ ...structuredClone(mine), key: next });
      continue;
    }
    if (!theirs) {
      if (out.rows.length >= MAX_DRAFT_ROWS) return null;
      out.rows.push(structuredClone(mine));
      continue;
    }
    for (const f of t.fields) {
      if (mine.fields[f] === undefined) {
        delete theirs.fields[f];
        delete theirs.sources[f];
        delete theirs.read_as[f];
      } else {
        theirs.fields[f] = structuredClone(mine.fields[f]);
        if (mine.sources[f]) theirs.sources[f] = { ...mine.sources[f]! };
        if (mine.read_as[f] !== undefined) theirs.read_as[f] = mine.read_as[f];
        else delete theirs.read_as[f];
      }
    }
    if (t.status) {
      theirs = Object.assign(theirs, { status: mine.status, card_id: mine.card_id, message: mine.message, activity_id: mine.activity_id ?? theirs.activity_id });
    }
  }
  return out;
}

const freeKey = (used: string[]): string | null => {
  for (let n = 1; n <= MAX_DRAFT_ROWS; n++) if (!used.includes(`r${n}`)) return `r${n}`;
  return null;
};

// ---- Changing a draft (every change is recorded in `touched`) -----------------------------------------

export function touchHeader(d: Draft, key: keyof DraftHeader): void {
  d.touched.header.add(key);
}

const rowTouch = (d: Draft, key: string) => {
  let t = d.touched.rows.get(key);
  if (!t) d.touched.rows.set(key, (t = { fields: new Set(), status: false, created: false }));
  return t;
};

/** Opens (or replaces) the draft with this header. */
export function openDraft(d: Draft, header: DraftHeader): void {
  d.header = header;
  d.touched.closed = false;
  for (const k of Object.keys(header) as (keyof DraftHeader)[]) touchHeader(d, k);
}

/** Sets header fields (undefined deletes one). */
export function patchHeader(d: Draft, patch: Partial<DraftHeader>): void {
  if (!d.header) return;
  const h = d.header as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
    touchHeader(d, k as keyof DraftHeader);
  }
}

/** A new row under the next free key. Check `canAddRow` first: an eleventh row throws. */
export function newRow(d: Draft, op: "add" | "update", activityId?: string): DraftRow {
  const key = freeKey(d.rows.map((r) => r.key));
  if (!key) throw new Error("a draft holds 10 activities");
  const row: DraftRow = { key, op, ...(activityId ? { activity_id: activityId } : {}), fields: {}, sources: {}, read_as: {}, status: "collecting" };
  d.rows.push(row);
  const t = rowTouch(d, key);
  t.created = true;
  t.status = true;
  return row;
}

export const canAddRow = (d: Draft) => d.rows.length < MAX_DRAFT_ROWS;

export function setValue(d: Draft, row: DraftRow, field: ActivityField, value: unknown, source: ValueSource, readAs?: string): void {
  row.fields[field] = value;
  row.sources[field] = source;
  if (readAs !== undefined) row.read_as[field] = readAs;
  else delete row.read_as[field];
  rowTouch(d, row.key).fields.add(field);
}

export function setStatus(d: Draft, row: DraftRow, status: RowStatus, extra: { card_id?: string; message?: string; activity_id?: string } = {}): void {
  row.status = status;
  if ("card_id" in extra) row.card_id = extra.card_id;
  if ("message" in extra) row.message = extra.message;
  if (extra.activity_id) row.activity_id = extra.activity_id;
  rowTouch(d, row.key).status = true;
}

/** Ends the draft: no header, no rows. */
export function closeDraft(d: Draft): void {
  d.header = null;
  d.rows = [];
  d.touched.closed = true;
}

/** A row still being filled in, or waiting on its card. */
export const isOpen = (d: Draft): boolean => d.header !== null && d.rows.some((r) => r.status === "collecting" || r.status === "card");

/** No counselor message for longer than the draft lives. */
export const isStale = (d: Draft, now: Date): boolean => d.header !== null && now.getTime() - Date.parse(d.header.updated_at) > DRAFT_TTL_MS;

/** A draft with nothing left to collect or confirm is closed. */
export function closeIfDone(d: Draft): void {
  if (d.header && !isOpen(d) && !d.header.expired_at && !d.header.switch_to) closeDraft(d);
}

/** Every value's source that is someone else's words (a chat file, a student document). */
export const anyOutside = (row: DraftRow): boolean => Object.values(row.sources).some((s) => s?.outside === true);

// ---- Cards --------------------------------------------------------------------------------------------

type ActionRow = { id: string; status: string; result: unknown };

/** Reads back the draft's cards: Confirm, Dismiss and Undo the counselor clicked since the draft was saved. */
export async function syncCards(request: FastifyRequest, d: Draft): Promise<void> {
  const ids = [...new Set(d.rows.filter((r) => r.status === "card" && r.card_id).map((r) => r.card_id!))];
  if (!ids.length) return;
  const { data, error } = await request.db.from("axis_actions").select("id, status, result").in("id", ids);
  if (error) return;
  const byId = new Map(((data ?? []) as ActionRow[]).map((a) => [String(a.id), a]));
  for (const row of d.rows) {
    if (row.status !== "card" || !row.card_id) continue;
    const a = byId.get(row.card_id);
    if (!a || a.status === "pending") continue;
    const result = (a.result ?? {}) as { rows?: unknown; message?: unknown };
    const outcomes = Array.isArray(result.rows) ? (result.rows as { key?: unknown; ok?: unknown; id?: unknown; message?: unknown }[]) : null;
    const mine = outcomes?.find((o) => o.key === row.key);
    if (a.status === "confirmed" || a.status === "executed") {
      if (outcomes && !mine) setStatus(d, row, "skipped");
      else if (mine && mine.ok !== true) {
        const message = typeof mine.message === "string" ? mine.message.slice(0, 300) : "It wasn't saved.";
        setStatus(d, row, "failed", { message });
        d.notes.push({ kind: "failed", key: row.key, reason: message });
      } else {
        setStatus(d, row, "saved", typeof mine?.id === "string" ? { activity_id: mine.id } : {});
        d.notes.push({ kind: "saved", key: row.key });
      }
    } else if (a.status === "failed") {
      const message = typeof mine?.message === "string" ? mine.message : typeof result.message === "string" ? result.message : "It wasn't saved.";
      setStatus(d, row, "failed", { message: message.slice(0, 300) });
      d.notes.push({ kind: "failed", key: row.key, reason: message.slice(0, 300) });
    } else {
      // dismissed, or confirmed and then undone
      setStatus(d, row, "dismissed");
    }
  }
}

/** A stored card as the app sees it, with a new status: never its stored input. */
function cardEvent(stored: Record<string, unknown>, status: OperationPayload["status"], message: string): OperationPayload {
  return {
    op: String(stored.op ?? ""),
    area: String(stored.area ?? ""),
    summary: String(stored.summary ?? ""),
    details: Array.isArray(stored.details) ? stored.details.map(String) : [],
    warning: typeof stored.warning === "string" ? stored.warning : null,
    reason: stored.reason === "outside-content" || stored.reason === "many-changes" ? stored.reason : null,
    status,
    undoable: false,
    message,
    ...(Array.isArray(stored.rows) ? { rows: stored.rows as NonNullable<OperationPayload["rows"]> } : {}),
  };
}

/**
 * Dismisses the draft's cards that are still pending, with a reason the app shows, and tells the app. Answers how
 * many it dismissed: a card the counselor confirmed or dismissed first doesn't count (plan review item 1).
 */
export async function dismissCards(ctx: Pick<OpContext, "request" | "onOperation">, _d: Draft, ids: string[], message: string): Promise<number> {
  if (!ids.length) return 0;
  const { data, error } = await ctx.request.db
    .from("axis_actions")
    .update({ status: "dismissed", decided_at: new Date().toISOString(), result: { ok: false, message } })
    .in("id", ids)
    .eq("status", "pending")
    .select("id, student_id, payload");
  if (error) return 0;
  const rows = (data ?? []) as { id: string; student_id: string | null; payload: Record<string, unknown> }[];
  for (const r of rows) {
    ctx.onOperation({ id: String(r.id), type: "operation", studentId: r.student_id ?? null, payload: cardEvent(r.payload ?? {}, "dismissed", message) });
  }
  return rows.length;
}
