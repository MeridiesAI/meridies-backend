/**
 * Activity calls go through the draft (spec 4.1–4.6; plan Task 7).
 *
 * `perform_action` hands every activity op here instead of filing it. Each value is converted (normalize.ts),
 * checked against the sheet's own schema, and traced to a source (provenance.ts); what passes is merged into a draft
 * row, what doesn't is refused to the model by name, and nothing is filed yet. After the model's answer the engine
 * calls `fileIfReady`, which files one card per draft (application.add_activities, a row per activity) once every
 * row has an organization and nothing is missing or the counselor was already asked once, and a card of its own for
 * each change to a saved activity. Filing once per turn means two activities in one message make one card, never a
 * card and its replacement.
 */
import { HttpError } from "../../errors.js";
import { resolveStudentId } from "../../guards.js";
import { activityFields, activityRowLine, type BatchRow } from "../ops/catalog/application.js";
import { DETAIL_MAX, helpers, runWrite, TOO_LONG_FOR_CARD, type OpContext, type OpOutput } from "../ops/run.js";
import { missingOf } from "./lines.js";
import { ACTIVITY_FIELDS, freeTextKey, normalizeField, type ActivityField } from "./normalize.js";
import { DESCRIPTION_REFUSAL, IMAGE_ONLY_HINT, provenanceRefusal, traceDescription, traceValue, type SourceSet } from "./provenance.js";
import type { Verdict } from "./sorter.js";
import {
  anyOutside,
  canAddRow,
  closeDraft,
  dismissCards,
  isOpen,
  isOpenRow,
  newRow,
  openDraft,
  patchHeader,
  rowLabel,
  setStatus,
  setValue,
  syncCards,
  touchedFields,
  type Draft,
  type DraftRow,
} from "./state.js";

export const ACTIVITY_OPS: ReadonlySet<string> = new Set(["application.add_activity", "application.add_activities", "application.update_activity"]);

/** The longest description a draft takes: ten rows must still show every description whole on one card. */
export const DRAFT_DESCRIPTION_MAX = 1000;
const REPLACED = "Replaced by an updated card.";
const UNRELATED = "there's an open activity draft; ask the counselor to continue it";
const FULL = "a draft holds 10 activities; file this card first";
const CLOSING = "Don't say whether anything was saved, tried or needs Confirm; status lines written by the server follow your answer.";
/** The counselor asks to rename an activity: "rename it to …", "it's called …", "the organization is …". */
const RENAME = /\b(?:renamed?|call it|it'?s called|called|named|change (?:the |its )?(?:organization|org|club|name)|(?:organization|org|name) (?:is|should be)|instead of)\b/i;

export type DraftTurn = {
  draft: Draft;
  verdict: Verdict | "none";
  now: Date;
  /** The counselor's message this turn answers (it opens a draft; bare numbers trace from it on). */
  messageId?: string;
  /** That message's text: an organization already in the draft changes only when it asks for a rename. */
  message?: string;
  sources: (studentId: string) => SourceSet;
  studentName: (id: string) => string;
  /** The counselor said to file it as is ("add it", "that's all"). */
  fileNow: boolean;
  /** AxIS had already asked for the missing fields before this turn: the card is filed with blanks. */
  askedBefore: boolean;
};

const notRun = (why: string): OpOutput => ({ content: `Not done: ${why}`, isError: true, fresh: false });
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const plain = (problem: string) => problem.replace(/\s*(Ask the counselor; don't guess\.|Leave (it|category) blank\.)\s*$/, "").trim();

/** A schema refusal in plain words (never zod's text). */
function schemaProblem(field: ActivityField, value: unknown): string | null {
  const schema = field === "description" ? activityFields.description : activityFields[field as keyof typeof activityFields];
  if (!schema) return null;
  const ok = schema.safeParse(value);
  if (ok.success) return null;
  if (typeof value === "string") return `${FIELD_LABEL[field]} is too long for the sheet`;
  return `that isn't a value the sheet takes for ${FIELD_LABEL[field]}`;
}
const FIELD_LABEL: Record<ActivityField, string> = {
  organization: "organization", position: "position", category: "category", grade_levels: "grades", timing: "timing",
  hours_per_week: "hours per week", weeks_per_year: "weeks per year", continuing: "continuing", uc_category: "UC category", description: "description",
};

/** The row as a batch card row, for its line length and its input. */
function asBatchRow(r: DraftRow): BatchRow {
  const fields = Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v !== undefined));
  const sources = Object.fromEntries(Object.entries(r.sources).map(([f, s]) => [f, (s?.label ?? "your message").slice(0, 80)]));
  const readAs = Object.fromEntries(Object.entries(r.read_as).map(([f, v]) => [f, String(v).slice(0, 120)]));
  return { key: r.key, ...fields, sources, read_as: readAs } as BatchRow;
}

type Reply = { kept: Map<string, ActivityField[]>; notKept: string[]; rows: Set<string> };

/** One activity op from the model: checked and merged into the draft, never filed here. */
export async function draftWrite(ctx: OpContext, turn: DraftTurn, name: string, raw: unknown): Promise<OpOutput> {
  const d = turn.draft;
  if (turn.verdict === "unrelated") {
    d.notes.push({ kind: "refused-unrelated" });
    return notRun(UNRELATED);
  }
  const obj = isRecord(raw) ? raw : {};
  const requested = typeof obj.student_id === "string" && obj.student_id ? obj.student_id : ctx.studentId;
  if (!requested) return notRun("which student? Give student_id (from find_student).");
  let studentId: string;
  try {
    studentId = await resolveStudentId(ctx.request, requested, "edit");
  } catch (err) {
    if (err instanceof HttpError && err.statusCode < 500) return notRun(err.message);
    throw err;
  }

  // An expired draft (its line shown this turn) or one with nothing left open gives way to a new one (spec 4.1).
  if (d.header && (d.header.expired_at || !isOpen(d))) closeDraft(d);
  // Pinned to its student: nothing for anyone else while it is open (spec 4.1).
  if (d.header && d.header.student_id !== studentId) {
    patchHeader(d, { switch_to: { student_id: studentId, name: turn.studentName(studentId) } });
    d.notes.push({ kind: "refused-student" });
    return notRun(`there's an open activity draft for ${d.header.student_name}; don't add anything for another student. The counselor will be asked.`);
  }
  if (!d.header) {
    const now = turn.now.toISOString();
    openDraft(d, {
      kind: "activity", student_id: studentId, student_name: turn.studentName(studentId), opened_at: now, updated_at: now,
      ...(turn.messageId ? { opened_msg: turn.messageId } : {}),
    });
    d.notes.push({ kind: "opened" });
  }

  const op = name === "application.update_activity" ? "update" : "add";
  const items = name === "application.add_activities" ? (Array.isArray(obj.rows) ? obj.rows.filter(isRecord) : []) : [obj];
  const reply: Reply = { kept: new Map(), notKept: [], rows: new Set() };
  const sources = turn.sources(studentId);
  for (const item of items) await mergeItem(ctx, turn, sources, op, item, reply);

  const lines: string[] = [];
  for (const [key, fields] of reply.kept) if (fields.length) lines.push(`Kept in draft row ${key}: ${fields.join(", ")}.`);
  lines.push(...reply.notKept);
  for (const key of reply.rows) {
    const r = d.rows.find((x) => x.key === key);
    if (!r) continue;
    const missing = missingOf(r);
    if (r.op === "update") lines.push(`Row ${key} changes activity_id ${r.activity_id}; the server files it as a card after your answer.`);
    else if (r.status === "card") lines.push(`Row ${key} is already on its card; the server updates the card after your answer.`);
    else if (missing.length) lines.push(`Still missing in ${key}: ${missing.join(", ")}. Ask the counselor once, in one message, for just these.`);
    else lines.push(`Row ${key} is complete; the server files it as a card after your answer.`);
  }
  lines.push(CLOSING);
  const keptAny = [...reply.kept.values()].some((f) => f.length > 0);
  return { content: lines.join("\n"), isError: !keptAny && reply.notKept.length > 0, fresh: true };
}

async function mergeItem(ctx: OpContext, turn: DraftTurn, sources: SourceSet, op: "add" | "update", item: Record<string, unknown>, reply: Reply) {
  const d = turn.draft;
  const header = d.header!;
  // Only draft_row names an existing row; a batch row's own key ("r1") only reuses a row that already has it.
  const key = typeof item.draft_row === "string" ? item.draft_row : null;
  const ownKey = typeof item.key === "string" ? item.key : null;
  let row: DraftRow | undefined;
  if (op === "update") {
    const activityId = typeof item.activity_id === "string" ? item.activity_id : null;
    if (!activityId) {
      reply.notKept.push("Not kept: activity_id: use the id from application.list_sheets.");
      return;
    }
    row = d.rows.find((r) => r.op === "update" && r.activity_id === activityId && isOpenRow(r));
    if (!row) {
      if (!canAddRow(d)) return refuseRow(d, reply, typeof item.organization === "string" ? item.organization : "this change");
      row = newRow(d, "update", activityId);
      // Named by the saved activity it changes ("change Code Club"), read from the sheet as the counselor.
      const label = await savedLabel(ctx, header.student_id, activityId);
      if (label) row.label = label;
    }
  } else {
    if (key) {
      row = d.rows.find((r) => r.key === key);
      if (!row) {
        reply.notKept.push(`Not kept: there's no draft row ${key}; the rows are ${d.rows.map((r) => r.key).join(", ") || "none yet"}.`);
        return;
      }
      if (row.status === "saved") {
        reply.notKept.push(`Not kept: row ${key} is already saved; change it with application.update_activity and activity_id ${row.activity_id}.`);
        return;
      }
    }
    if (!row && ownKey) row = d.rows.find((r) => r.key === ownKey && r.op === "add" && isOpenRow(r));
    const org = normalizeField("organization", item.organization);
    const open = d.rows.filter((r) => r.op === "add" && isOpenRow(r));
    if (!row && org.ok && typeof org.value === "string") row = open.find((r) => freeTextKey(String(r.fields.organization ?? "")) === freeTextKey(org.value as string));
    if (!row && !org.ok && open.length === 1) row = open[0];
    if (!row) {
      if (!canAddRow(d)) return refuseRow(d, reply, org.ok ? String(org.value) : "this activity");
      row = newRow(d, "add");
    }
  }
  reply.rows.add(row.key);
  const kept = reply.kept.get(row.key) ?? [];
  reply.kept.set(row.key, kept);
  const tc = { openedMsg: header.opened_msg, asked: header.asked ? { fields: header.asked.fields, afterMsg: header.asked.after_msg } : undefined };

  for (const field of ACTIVITY_FIELDS) {
    if (!(field in item) || item[field] === undefined) continue;
    const raw = item[field];
    // Not given, on an add: nothing to keep. (On an update, null clears the field.)
    if (raw === null && op === "add") continue;
    const reject = (reason: string, counselor = plain(reason)) => {
      // Some reasons already open with the field's name ("position 'X' isn't…", "description must…").
      reply.notKept.push(`Not kept: ${reason.startsWith(field) ? reason : `${field}: ${reason}`}`);
      d.notes.push({ kind: "rejected", key: row!.key, field, reason, counselor, label: rowLabel(row!) });
    };
    const n = normalizeField(field, raw);
    if (!n.ok) {
      reject(n.problem);
      continue;
    }
    if (field === "description" && typeof n.value === "string" && n.value.length > DRAFT_DESCRIPTION_MAX) {
      reject(
        `it's over ${DRAFT_DESCRIPTION_MAX} characters, too long to show whole on a card. Leave it out; the counselor can paste it on the sheet.`,
        `it's over ${DRAFT_DESCRIPTION_MAX.toLocaleString("en-US")} characters, too long to show on a card; paste it on the sheet`
      );
      continue;
    }
    const bad = schemaProblem(field, n.value);
    if (bad) {
      reject(`${bad}. Ask the counselor; don't guess.`, bad);
      continue;
    }
    const trace = field === "description" ? await traceDescription(sources, String(n.value)) : await traceValue(sources, field, n.value, tc);
    if (!trace) {
      if (field === "description") reject(DESCRIPTION_REFUSAL, "it must be copied exactly from your message or the student's resume");
      else {
        const hint = (await sources.hasTranscriptsOnly()) ? `; ${IMAGE_ONLY_HINT}` : "";
        reject(`${provenanceRefusal(field, n.value)}${hint}`, `${Array.isArray(n.value) ? n.value.join(", ") : String(n.value)} isn't in your messages or the student's files`);
      }
      continue;
    }
    // An activity's organization is its name: once the draft has one, a later message replaces it only when the
    // counselor asks for a rename. A venue ("City Library, please add it now") never overwrites it (spec 1, turn 5).
    if (field === "organization" && row.op === "add" && typeof row.fields.organization === "string" &&
        freeTextKey(row.fields.organization) !== freeTextKey(String(n.value)) && !RENAME.test(turn.message ?? "")) {
      const was = row.fields.organization;
      reject(
        `organization is already '${was}'. It changes only when the counselor asks to rename it; a place where the activity happens has no field, so leave it out.`,
        `it's already ${was}; say "rename it to …" to change it`
      );
      continue;
    }
    // A card shows every line whole: a description that would make this row's line too long is refused here.
    if (field === "description" && row.op === "add") {
      const line = activityRowLine({ ...asBatchRow(row), description: String(n.value), sources: { ...asBatchRow(row).sources, description: trace.label } });
      if (line.length > DETAIL_MAX) {
        reject(`${TOO_LONG_FOR_CARD}`, "it's too long to show whole on a card with this row's other details; paste it on the sheet");
        continue;
      }
    }
    setValue(d, row, field, n.value, trace, n.readAs);
    kept.push(field);
  }
}

/** A saved activity's name (its organization, else its position), or null when it can't be read. */
async function savedLabel(ctx: OpContext, studentId: string, activityId: string): Promise<string | null> {
  const body = await helpers(ctx.request, ctx.roster).get<{ activities?: Record<string, unknown>[] }>(`/application/sheets?studentId=${encodeURIComponent(studentId)}`);
  const a = (body?.activities ?? []).find((x) => x.id === activityId);
  const name = a ? (typeof a.organization === "string" && a.organization.trim()) || (typeof a.position === "string" && a.position.trim()) : null;
  return name ? name.slice(0, 120) : null;
}

function refuseRow(d: Draft, reply: Reply, label: string) {
  reply.notKept.push(`Not kept: ${label}: ${FULL}`);
  d.notes.push({ kind: "rejected", reason: FULL, counselor: "a draft holds 10 activities; confirm this card first", label });
}

/** Files a change to a saved activity as its own card. */
async function fileUpdate(ctx: OpContext, d: Draft, r: DraftRow): Promise<void> {
  const fields = Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v !== undefined));
  if (!Object.keys(fields).length || !d.header || !r.activity_id) return;
  let filed: string | null = null;
  const out = await runWrite(ctx, "application.update_activity", { student_id: d.header.student_id, activity_id: r.activity_id, ...fields }, {
    outside: ctx.turn.tainted || anyOutside(r),
    onFiled: (id) => (filed = id),
  });
  if (filed) {
    setStatus(d, r, "card", { card_id: filed });
    d.notes.push({ kind: "filed", key: r.key });
  } else d.notes.push(filingFailed(r, out));
}

const filingFailed = (r: DraftRow, out: OpOutput) => {
  const reason = out.content.replace(/^Not done: /, "");
  return {
    kind: "failed" as const, key: r.key, reason, label: rowLabel(r),
    counselor: reason === TOO_LONG_FOR_CARD ? "it's too long to show whole on a card" : "AxIS couldn't file the card; try again",
  };
};

/**
 * After the model's answer: files what is ready. Changes to saved activities get a card each. Adds become one card
 * for the whole draft once every row has an organization and nothing is missing, or `force` (the counselor said
 * "add it") or `askedBefore` (they were asked once already). A pending card whose rows changed is replaced, unless
 * the counselor confirmed it meanwhile: then its rows are saved and this turn's corrections become update cards.
 */
export async function fileIfReady(ctx: OpContext, turn: DraftTurn, force: boolean): Promise<void> {
  const d = turn.draft;
  // No draft, or the switch question is waiting: nothing is filed for either student until it's answered.
  if (!d.header || d.header.switch_to) return;
  const touched = (r: DraftRow) => touchedFields(d, r.key).size > 0;

  for (const r of d.rows.filter((x) => x.op === "update" && (x.status === "collecting" || (x.status === "card" && touched(x))))) {
    if (r.status === "card" && r.card_id) {
      const n = await dismissCards(ctx, d, [r.card_id], REPLACED);
      if (n) d.notes.push({ kind: "replaced", key: r.key });
    }
    await fileUpdate(ctx, d, r);
  }

  const open = d.rows.filter((r) => r.op === "add" && isOpenRow(r));
  const onCard = open.filter((r) => r.status === "card");
  const changed = onCard.filter(touched);
  // A new row is filed once it has an organization and nothing is missing, or the counselor said to file it as is,
  // or they were asked once already. A row already on a card (filed with blanks or not) is always carried over.
  const ready = (r: DraftRow) => !missingOf(r).includes("organization") && (force || turn.askedBefore || missingOf(r).length === 0);
  const fresh = open.filter((r) => r.status === "collecting" && ready(r));
  if (!fresh.length && !changed.length) return;

  // One pending add card per draft: the old one is replaced, unless the counselor acted on it first.
  const carry: DraftRow[] = [];
  const pending = [...new Set(onCard.filter((r) => r.card_id).map((r) => r.card_id!))];
  if (pending.length) {
    const n = await dismissCards(ctx, d, pending, REPLACED);
    if (n > 0) {
      for (const r of onCard) {
        setStatus(d, r, "collecting", { card_id: undefined });
        carry.push(r);
      }
      d.notes.push({ kind: "replaced" });
    } else {
      // The counselor acted first (plan review item 1): read what happened, then carry this turn's corrections over.
      await syncCards(ctx.request, d);
      for (const r of changed) {
        if (r.status === "saved" && r.activity_id && canAddRow(d)) {
          const u = newRow(d, "update", r.activity_id);
          u.label = rowLabel(r);
          for (const f of touchedFields(d, r.key)) setValue(d, u, f, r.fields[f], r.sources[f] ?? { label: "your message", outside: false }, r.read_as[f]);
          await fileUpdate(ctx, d, u);
        } else if (r.status === "dismissed") {
          setStatus(d, r, "collecting");
          carry.push(r);
        }
      }
    }
  }

  const toFile = [...new Set([...carry, ...fresh])].filter((r) => r.status === "collecting");
  if (!toFile.length) return;
  let filed: string | null = null;
  const out = await runWrite(ctx, "application.add_activities", { student_id: d.header.student_id, rows: toFile.map(asBatchRow) }, {
    outside: ctx.turn.tainted || toFile.some(anyOutside),
    onFiled: (id) => (filed = id),
  });
  if (filed) {
    for (const r of toFile) setStatus(d, r, "card", { card_id: filed });
    d.notes.push({ kind: "filed" });
    // The ask is spent: a row added later is asked about once before it is filed (spec 4.1, row by row).
    patchHeader(d, { asked: undefined });
  } else for (const r of toFile) d.notes.push(filingFailed(r, out));
}
