/**
 * Narrative Coherence's documents beyond the material itself: which personal statement is "the" statement, and
 * reading in, at run time, ticked essays whose linked Google Doc hasn't been read yet (lib/essayText.ts).
 */
import type { FastifyRequest } from "fastify";
import type { UnreadDoc } from "./context/coherenceMaterial.js";
import { essayTextState, linkedGoogleDoc, readLinkedEssay, type EssayTextState } from "./essayText.js";

type Row = Record<string, unknown>;

const STATEMENT_RANK: Record<EssayTextState, number> = { read: 0, pending: 1, unreadable: 2, empty: 3 };

/**
 * The statement on file: the newest one with text, else the newest linked but not read in yet, else the newest
 * Meridies can't read; null when every statement row is empty. A Doc linked before its text is read counts as on
 * file (it used to read "Not on file"), but never displaces a statement that has text.
 */
export function pickStatement(rows: Row[]): Row | null {
  const statements = rows
    .filter((e) => e.essay_kind === "personal-statement" && essayTextState(e) !== "empty")
    .sort(
      (a, b) =>
        STATEMENT_RANK[essayTextState(a)] - STATEMENT_RANK[essayTextState(b)] ||
        String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))
    );
  return statements[0] ?? null;
}

/** Linked Docs one run reads in at most (Essays sync's own cap), four at a time as it does. */
export const RUN_READ_CAP = 25;

/**
 * Ticked essays linked to a Google Doc that hasn't been read in yet are read now, with the caller's own grant (the
 * read Essays sync does), and their rows in `essays` replaced by what the database stored. Ticked linked Docs that
 * were read before are read again if they changed since (lib/essayText.ts skips an unchanged one); if that fails the
 * text already on file is used. Returns every ticked essay that still can't be read, with why, in the order ticked:
 * the run refuses rather than quietly leave one out.
 * `select` is the caller's essay select, so a replaced row has the same shape.
 */
export async function readTicked(
  request: FastifyRequest,
  essays: Row[],
  ticked: Row[],
  opts: { select: string; read?: typeof readLinkedEssay }
): Promise<UnreadDoc[]> {
  const read = opts.read ?? readLinkedEssay;
  const problems = new Map<string, UnreadDoc>();
  const unread = (e: Row, reason: UnreadDoc["reason"], message?: string) =>
    problems.set(String(e.id), {
      part: e.essay_kind === "personal-statement" ? "statement" : "supplement",
      title: e.title,
      school: e.school,
      reason,
      message,
    });
  const waiting: Row[] = [];
  const refresh: Row[] = [];
  for (const e of ticked) {
    const state = essayTextState(e);
    if (state === "unreadable") unread(e, "unreadable");
    else if (state === "pending") waiting.push(e);
    else if ("fileId" in linkedGoogleDoc(e, request.auth.userId)) refresh.push(e);
  }
  for (const e of waiting.slice(RUN_READ_CAP)) unread(e, "too-many");
  const toRead = [...waiting.slice(0, RUN_READ_CAP), ...refresh.slice(0, Math.max(0, RUN_READ_CAP - waiting.length))];
  const mustRead = new Set(waiting);
  for (let i = 0; i < toRead.length; i += 4) {
    await Promise.all(
      toRead.slice(i, i + 4).map(async (e) => {
        const r = await read(request, e, { select: opts.select });
        if (!r.ok) return mustRead.has(e) ? unread(e, r.reason, r.message) : undefined;
        const fresh = r.row ?? e;
        const at = essays.findIndex((x) => x.id === e.id);
        if (at >= 0) essays[at] = fresh;
        const now = essayTextState(fresh);
        if (now === "unreadable" || now === "empty") unread(fresh, now);
        else if (now === "pending") unread(fresh, "failed");
      })
    );
  }
  return ticked.map((e) => problems.get(String(e.id))).filter((p): p is UnreadDoc => p !== undefined);
}
