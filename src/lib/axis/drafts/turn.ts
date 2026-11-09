/**
 * The start of every AxIS turn, for the activity draft (spec 4.1).
 *
 * Reads the conversation's draft and its cards' statuses, then decides what this message is to it:
 *  - after the switch question, a yes drops the old draft and starts one for the other student;
 *  - after the expiry line, a yes restores the expired fields; anything else lets them go;
 *  - an open draft with no counselor message for 30 minutes expires (with a line when a row was still being
 *    filled in, silently when only cards were left; those stay valid);
 *  - an open draft sorts the message: cancel (a code-written reply, no model), continue (a code-written status,
 *    no model), draft (the Clerk with the draft block) or unrelated (answered as usual, then the reminder).
 * Every counselor message moves the draft's clock.
 */
import type { FastifyRequest } from "fastify";
import type { Understanding } from "../nlu.js";
import type { OpContext } from "../ops/run.js";
import { LINES } from "./lines.js";
import { sourcesFor, type SourceSet } from "./provenance.js";
import { isCancel, isFileNow, isYes, sortMessage } from "./sorter.js";
import { closeDraft, dismissCards, DRAFT_TTL_MS, emptyDraft, isOpen, isStale, loadDraft, openDraft, patchHeader, syncCards, type Draft } from "./state.js";
import type { DraftTurn } from "./write.js";

/** What the turn's log line says about the draft. */
export type DraftLog = "none" | "opened" | "continued" | "unrelated" | "expired" | "closed:saved" | "closed:cancelled" | "closed:timeout";

export type DraftStart = {
  turn: DraftTurn;
  /** A line the reply starts with (the expiry line). */
  lead: string | null;
  /** A reply written in code, with no model call (cancel). Continue's reply is written by the engine after filing. */
  reply: string | null;
  log: DraftLog;
  /** The student's name the lines use, kept even when the draft closes this turn. */
  name: string;
};

const DROPPED = "Dropped with the activity draft.";

const pendingCards = (d: Draft) => [...new Set(d.rows.filter((r) => r.status === "card" && r.card_id).map((r) => r.card_id!))];

export async function startDraftTurn(o: {
  request: FastifyRequest;
  conversationId: string;
  content: string;
  u: Pick<Understanding, "intent" | "scores" | "attributes">;
  now: Date;
  messageId?: string;
  onOperation: OpContext["onOperation"];
  studentName: (id: string) => string;
}): Promise<DraftStart> {
  const { request, content, now } = o;
  const d = await loadDraft(request, o.conversationId).catch(() => emptyDraft(false));
  await syncCards(request, d).catch(() => undefined);
  const ops = { request, onOperation: o.onOperation };
  const nowIso = now.toISOString();
  const name = d.header?.student_name ?? "";
  let restored = false;
  let verdict: DraftTurn["verdict"] = "none";
  let lead: string | null = null;
  let reply: string | null = null;
  let log: DraftLog = d.header ? "continued" : "none";

  const h = d.header;
  if (h?.switch_to) {
    if (isYes(content)) {
      const to = h.switch_to;
      await dismissCards(ops, d, pendingCards(d), DROPPED);
      closeDraft(d);
      openDraft(d, { kind: "activity", student_id: to.student_id, student_name: to.name, opened_at: nowIso, updated_at: nowIso, ...(o.messageId ? { opened_msg: o.messageId } : {}) });
      d.switchAccepted = true;
      d.notes.push({ kind: "opened" });
      verdict = "draft";
      log = "opened";
    } else patchHeader(d, { switch_to: undefined });
  }

  if (verdict === "none" && d.header?.expired_at) {
    if (isYes(content) && now.getTime() - Date.parse(d.header.expired_at) <= DRAFT_TTL_MS) {
      // Restored: AxIS asks for what is missing again rather than filing blanks at once.
      patchHeader(d, { expired_at: undefined, asked: undefined });
      restored = true;
      verdict = "draft";
      log = "continued";
    } else {
      closeDraft(d);
      log = "closed:timeout";
    }
  } else if (verdict === "none" && d.header && isOpen(d) && isStale(d, now)) {
    if (d.rows.some((r) => r.status === "collecting")) {
      patchHeader(d, { expired_at: nowIso });
      d.notes.push({ kind: "expired" });
      lead = LINES.expired;
      log = "expired";
    } else {
      // Only cards were left: they stay valid and the draft closes without a line.
      closeDraft(d);
      log = "closed:timeout";
    }
  } else if (verdict === "none" && d.header && isOpen(d)) {
    const v = sortMessage(content, o.u, d);
    if (v === "cancel" || isCancel(content)) {
      const who = d.header.student_name;
      await dismissCards(ops, d, pendingCards(d), DROPPED);
      closeDraft(d);
      d.notes.push({ kind: "cancelled" });
      reply = LINES.cancelled(who);
      log = "closed:cancelled";
    } else {
      verdict = v;
      log = v === "unrelated" ? "unrelated" : "continued";
    }
  }
  if (d.header && !d.header.expired_at) patchHeader(d, { updated_at: nowIso });

  const sets = new Map<string, SourceSet>();
  const turn: DraftTurn = {
    draft: d,
    verdict,
    now,
    messageId: o.messageId,
    message: content,
    sources: (sid) => sets.get(sid) ?? (sets.set(sid, sourcesFor(request, o.conversationId, sid)), sets.get(sid)!),
    studentName: o.studentName,
    fileNow: isFileNow(content),
    askedBefore: !restored && !!d.header?.asked,
  };
  return { turn, lead, reply, log, name: name || d.header?.student_name || "" };
}
