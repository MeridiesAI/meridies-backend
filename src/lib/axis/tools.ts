/**
 * What AxIS can do mid-answer, for whatever the evidence planner didn't
 * foresee. Every tool reads on the caller's RLS client, and every passage it
 * returns goes through the AI guard and the ledger (so it can be cited).
 *
 * Two tools change things: `perform_action` runs an operation from the
 * catalog in lib/axis/ops (through the same API routes the app calls, as the
 * counselor), either at once or as a card the counselor confirms, and
 * propose_action files an email draft for the Communication composer.
 * `lookup` reads the ids those changes need.
 *
 * The list is fixed and ordered so the cached prompt prefix (tools come
 * first) never moves. Each tool streams its input as it is generated
 * (eager_input_streaming), so the loop can start a read-only lookup the
 * moment its block closes, before the model has finished the rest of its
 * turn; inputs are validated here with zod, since the API no longer does.
 */
import { errInfo } from "./failsafe.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { fromPostgrest } from "../errors.js";
import { resolveStudentId } from "../guards.js";
import { wrapUntrusted } from "../context/pack.js";
import type { SectionName } from "../context/profiles.js";
import type { ContextUsage } from "../context/types.js";
import { cachedStudentContext, collegeFacts, collegeFactText, isoDay, plain, upcomingItems } from "./data.js";
import type { RosterIndex } from "./entities.js";
import { filterAllowedChunks } from "./guard.js";
import { clip, type SourceLedger } from "./ledger.js";
import { keywordsOf } from "./nlu.js";
import { getConnectors, getRetrieval, type ConnectedProvider, type RetrievedChunk } from "./ports.js";
import { fusedSearch } from "./retrieval.js";
import { loadRosterRisk } from "./risk.js";
import { getOp, READ_OPS, WRITE_OPS } from "./ops/registry.js";
import { runRead, runWrite, type OperationEvent, type TurnBudget } from "./ops/run.js";

export type ProposedAction = {
  id: string;
  type: "work_item" | "email_draft";
  studentId: string | null;
  payload: Record<string, unknown>;
};

export type ToolContext = {
  request: FastifyRequest;
  conversationId: string;
  /** The student the chat is about; null in a roster chat. */
  studentId: string | null;
  roster: RosterIndex;
  ledger: SourceLedger;
  connected: ConnectedProvider[];
  retrievalReady: boolean;
  signal: AbortSignal;
  /** This turn's lookups, so the same call twice is answered from memory. */
  memo: Map<string, Promise<ToolOutput>>;
  onAction: (a: ProposedAction) => void;
  /** Shared by every call in the turn: write counts and whether outside content was read. */
  turn: TurnBudget;
  onOperation: (e: OperationEvent) => void;
};

export type ToolOutput = {
  content: string;
  isError?: boolean;
  /** Brought something new into the turn. Two rounds without anything new end the tool phase. */
  fresh: boolean;
};

export type ToolName =
  | "search_documents" | "read_document" | "search_email" | "search_connected_files" | "find_student"
  | "get_student_record" | "list_upcoming" | "rank_caseload" | "search_colleges" | "propose_action"
  | "lookup" | "perform_action";

type ToolDef = {
  name: ToolName;
  /** Safe to start before the model's turn is complete: reads only. */
  readOnly: boolean;
  label: (input: Record<string, unknown>) => string;
  tool: Anthropic.Beta.BetaTool;
  run: (ctx: ToolContext, input: unknown) => Promise<ToolOutput>;
  /** Overrides TOOL_TIMEOUT_MS: a change runs a route (and its side effects) and gets longer. */
  timeoutMs?: number;
};

/** Per tool call. A tool past it is aborted and the model is told so, rather than the turn hanging. */
export const TOOL_TIMEOUT_MS = 8_000;
export const WRITE_TIMEOUT_MS = 20_000;

/** Passages from these came from outside Meridies' own records: text in them must not steer a change. */
const OUTSIDE = new Set(["upload", "drive", "onedrive", "outlook", "gmail"]);

/** A student record built with the text of uploaded files (its documents section): outside content too. */
export const readsDocuments = (usage: Pick<ContextUsage, "used"> | null | undefined): boolean =>
  !!usage?.used.some((u) => u.section === "documents");

const SECTIONS = [
  "profile", "academics", "personal", "activities", "awards", "courses", "testScores", "colleges",
  "intake", "meetingNotes", "upcomingMeetings", "deadlines", "polygon", "tasks", "essays", "documents",
] as const satisfies readonly SectionName[];

const q = (s: unknown) => (typeof s === "string" ? plain(s, 80) : "");

/** Passages through the AI guard and onto the ledger, rendered for the model. */
async function cite(ctx: ToolContext, chunks: RetrievedChunk[], none: string): Promise<ToolOutput> {
  const { kept, dropped } = await filterAllowedChunks(ctx.request, chunks, ctx.studentId);
  const notes: string[] = [];
  const held = (dropped["ai-rule"] ?? 0) + (dropped["not-visible"] ?? 0);
  if (held) notes.push(`${held} result(s) withheld: kept out of AI by the practice's or the file's settings.`);
  if (dropped["other-student"]) notes.push(`${dropped["other-student"]} result(s) skipped: filed under a different student.`);
  if (!kept.length) return { content: [none, ...notes].join("\n"), fresh: false };
  if (kept.some((c) => OUTSIDE.has(c.source))) ctx.turn.tainted = true;
  const before = ctx.ledger.size;
  const { rendered, skipped } = ctx.ledger.add(kept);
  if (skipped) notes.push(`${skipped} more result(s) not shown: this turn's reading budget is spent.`);
  return { content: [rendered, ...notes].filter(Boolean).join("\n\n"), fresh: ctx.ledger.size > before };
}

const searchInput = z.object({ query: z.string().trim().min(2).max(300), k: z.number().int().min(1).max(10).optional() });

const DEFS: ToolDef[] = [
  {
    name: "search_documents",
    readOnly: true,
    label: (i) => `Searching documents for "${q(i.query)}"`,
    tool: {
      name: "search_documents",
      description:
        "Search the uploaded and synced files (transcripts, resumes, score reports, school profiles, letters, notes) by meaning. Returns numbered passages to cite as [S#]. Use specific terms: 'AP Calculus BC grade', not 'grades'.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in plain words." },
          k: { type: "integer", description: "How many passages, 1 to 10 (default 6)." },
        },
        required: ["query"],
      },
    },
    run: async (ctx, raw) => {
      const i = searchInput.parse(raw);
      if (!ctx.retrievalReady) return { content: "Document search isn't available yet. Say so.", fresh: false };
      const expanded = keywordsOf(i.query).join(" ");
      const chunks = await fusedSearch(ctx.request, [i.query, expanded].filter((x, n, a) => x && a.indexOf(x) === n), {
        studentId: ctx.studentId,
        k: i.k ?? 6,
        signal: ctx.signal,
      });
      return cite(ctx, chunks, "No matching passages in the files.");
    },
  },
  {
    name: "read_document",
    readOnly: true,
    label: () => "Reading the full document",
    tool: {
      name: "read_document",
      description:
        "Read more of the document a passage came from, when the passage alone isn't enough (a full transcript table, a whole letter). Pass the passage's source id, like S3.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"] },
    },
    run: async (ctx, raw) => {
      const { source_id } = z.object({ source_id: z.string().regex(/^S\d{1,3}$/i) }).parse(raw);
      const src = ctx.ledger.get(source_id);
      if (!src?.documentId) return { content: `${source_id} is not a filed document; nothing more to read.`, isError: true, fresh: false };
      const doc = await getRetrieval().read(ctx.request, { documentId: src.documentId, maxChars: 12_000, signal: ctx.signal });
      if (!doc) return { content: "That document couldn't be read.", isError: true, fresh: false };
      return cite(
        ctx,
        [{ chunkId: `full:${doc.documentId}`, documentId: doc.documentId, studentId: null, title: doc.title, text: doc.text, score: 1, source: doc.source, url: doc.url ?? null, updatedAt: doc.updatedAt ?? null }],
        "The document is empty."
      );
    },
  },
  {
    name: "search_email",
    readOnly: true,
    label: (i) => `Searching email for "${q(i.query)}"`,
    tool: {
      name: "search_email",
      description:
        "Search the counselor's connected mailbox (Outlook or Gmail) for messages with this student's family or about them. Returns numbered messages to cite as [S#].",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { query: { type: "string" }, k: { type: "integer", description: "1 to 10" } },
        required: ["query"],
      },
    },
    run: async (ctx, raw) => {
      const i = searchInput.parse(raw);
      if (!ctx.connected.length) return { content: "No mailbox is connected. Say so; the counselor connects one in Files › Connected apps.", fresh: false };
      const chunks = await getConnectors().searchMail(ctx.request, { query: i.query, studentId: ctx.studentId, k: i.k ?? 6, signal: ctx.signal });
      return cite(ctx, chunks, "No matching messages.");
    },
  },
  {
    name: "search_connected_files",
    readOnly: true,
    label: (i) => `Searching Drive and OneDrive for "${q(i.query)}"`,
    tool: {
      name: "search_connected_files",
      description: "Search Google Drive or OneDrive files that haven't been filed into Meridies yet. Use after search_documents comes back empty.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { query: { type: "string" }, k: { type: "integer", description: "1 to 10" } },
        required: ["query"],
      },
    },
    run: async (ctx, raw) => {
      const i = searchInput.parse(raw);
      if (!ctx.connected.length) return { content: "No Drive or OneDrive is connected.", fresh: false };
      const chunks = await getConnectors().searchFiles(ctx.request, { query: i.query, studentId: ctx.studentId, k: i.k ?? 5, signal: ctx.signal });
      return cite(ctx, chunks, "No matching files.");
    },
  },
  {
    name: "find_student",
    readOnly: true,
    label: (i) => `Looking up ${q(i.name)}`,
    tool: {
      name: "find_student",
      description: "Find a student on the counselor's roster by name. Returns ids to pass to get_student_record. If several match, ask the counselor which one.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    run: async (ctx, raw) => {
      const { name } = z.object({ name: z.string().trim().min(2).max(80) }).parse(raw);
      const { students, ambiguous } = ctx.roster.match(name);
      const rows = [...students.map((s) => ({ id: s.id, name: s.name })), ...ambiguous.flatMap((a) => a.candidates)].slice(0, 5);
      if (!rows.length) return { content: "No student matching that name on the roster.", fresh: false };
      return { content: rows.map((r) => `id ${r.id}: ${wrapUntrusted("roster", r.name)}`).join("\n"), fresh: true };
    },
  },
  {
    name: "get_student_record",
    readOnly: true,
    label: (i) => `Reading ${Array.isArray(i.sections) ? (i.sections as string[]).join(", ") : "the record"}`,
    tool: {
      name: "get_student_record",
      description:
        "Read sections of a student's record. In a student chat the core record is already in the system prompt; use this for a different student, or for sections not shown.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          student_id: { type: "string", description: "Omit for the student this chat is about." },
          sections: { type: "array", items: { type: "string", enum: [...SECTIONS] } },
        },
        required: ["sections"],
      },
    },
    run: async (ctx, raw) => {
      const i = z.object({ student_id: z.string().uuid().optional(), sections: z.array(z.enum(SECTIONS)).min(1).max(8) }).parse(raw);
      const target = i.student_id ?? ctx.studentId;
      if (!target) return { content: "No student given. Use find_student first.", isError: true, fresh: false };
      const id = await resolveStudentId(ctx.request, target, "view");
      const built = await cachedStudentContext(ctx.request, id, ["profile", ...i.sections.filter((s) => s !== "profile")]);
      // The documents section is the text of uploaded files: from here on a change waits for a click.
      if (readsDocuments(built)) ctx.turn.tainted = true;
      const omitted = built.omitted.map((o) => `${o.section} (${o.reason})`).join(", ");
      return { content: `${built.text || "Nothing on file for those sections."}${omitted ? `\n\nNot included: ${omitted}.` : ""}`, fresh: !!built.text };
    },
  },
  {
    name: "list_upcoming",
    readOnly: true,
    label: (i) => `Checking the next ${typeof i.days === "number" ? i.days : 14} days`,
    tool: {
      name: "list_upcoming",
      description: "Open deadlines, tasks and meetings due in the next N days (1 to 120), for one student or the whole roster. Overdue items are included.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { days: { type: "integer" }, student_id: { type: "string" } },
      },
    },
    run: async (ctx, raw) => {
      const i = z.object({ days: z.number().int().min(1).max(120).optional(), student_id: z.string().uuid().optional() }).parse(raw ?? {});
      const days = i.days ?? 14;
      const target = i.student_id ?? ctx.studentId;
      const student = target ? await resolveStudentId(ctx.request, target, "view") : null;
      const window = { from: null, to: isoDay(new Date(Date.now() + days * 86_400_000)), label: `in the next ${days} days` };
      const items = await upcomingItems(ctx.request, { studentId: student, window, meetings: true, roster: ctx.roster, limit: 80 });
      const lines = items.map(
        (it) =>
          `${it.date}${it.overdue ? " OVERDUE" : ""} ${it.kind}${it.status ? ` [${it.status}]` : ""}${student ? "" : ` ${wrapUntrusted("student", ctx.roster.get(it.studentId)?.name ?? "")}`} ${wrapUntrusted(it.kind, `${it.title}${it.detail ? ` · ${it.detail}` : ""}`)}`
      );
      return { content: lines.length ? `Today is ${isoDay()}.\n${lines.join("\n")}` : `Nothing open is due ${window.label}.`, fresh: lines.length > 0 };
    },
  },
  {
    name: "rank_caseload",
    readOnly: true,
    label: () => "Ranking the caseload",
    tool: {
      name: "rank_caseload",
      description:
        "The counselor's students ranked by how much attention they need: overdue work, deadlines in the next 14 days, days without activity and red flags, each with its reasons. Computed, not estimated; use it as given.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { limit: { type: "integer", description: "1 to 20, default 8" } } },
    },
    run: async (ctx, raw) => {
      const { limit } = z.object({ limit: z.number().int().min(1).max(20).optional() }).parse(raw ?? {});
      const ranked = (await loadRosterRisk(ctx.request, 14)).slice(0, limit ?? 8);
      if (!ranked.length) return { content: "Nobody has overdue work, a red flag or a deadline at risk in the next 14 days.", fresh: true };
      return { content: ranked.map((r, n) => `${n + 1}. ${wrapUntrusted("student", r.name)} score ${r.score}: ${wrapUntrusted("reasons", r.reasons.join("; "))}`).join("\n"), fresh: true };
    },
  },
  {
    name: "search_colleges",
    readOnly: true,
    label: (i) => `Looking up ${q(i.query)}`,
    tool: {
      name: "search_colleges",
      description:
        "Look up colleges in the Meridies catalog (U.S. Department of Education College Scorecard figures). Returns numbered entries to cite as [S#]. Figures carry their data year; say it.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "A school's name, or words like 'engineering'." },
          states: { type: "array", items: { type: "string" }, description: "Two-letter state codes." },
          limit: { type: "integer", description: "1 to 8" },
        },
        required: ["query"],
      },
    },
    run: async (ctx, raw) => {
      const i = z
        .object({ query: z.string().trim().min(2).max(120), states: z.array(z.string().regex(/^[A-Z]{2}$/)).max(10).optional(), limit: z.number().int().min(1).max(8).optional() })
        .parse(raw);
      const filters: Record<string, unknown> = i.states?.length ? { states: i.states } : {};
      const { data, error } = await ctx.request.db.rpc("search_colleges", { p_q: i.query, p_filters: filters, p_sort: null, p_limit: i.limit ?? 4, p_offset: 0 });
      if (error) throw fromPostgrest(error);
      const ids = ((data ?? []) as { college_id: string }[]).map((r) => String(r.college_id));
      if (!ids.length) return { content: "No college in the catalog matches.", fresh: false };
      const facts = await collegeFacts(ctx.request, ids);
      return cite(
        ctx,
        facts.map((f) => ({
          chunkId: `college:${f.id}`,
          documentId: null,
          studentId: null,
          title: `${f.name} (${[f.city, f.state].filter(Boolean).join(", ")})`,
          text: collegeFactText(f),
          score: 1,
          source: "catalog" as const,
          url: f.website,
        })),
        "No college in the catalog matches."
      );
    },
  },
  {
    name: "propose_action",
    readOnly: false,
    label: (i) => (i.type === "email_draft" ? "Drafting an email" : "Adding to My Work Queue"),
    tool: {
      name: "propose_action",
      description:
        "Draft an email to a student's parents or to the student, for the counselor to open in the Communication composer and send from there. Nothing is sent from here. Logistics and progress only, never essay text. (A Work Queue item is perform_action work_queue.add.)",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["email_draft"] },
          student_id: { type: "string", description: "Omit for this chat's student." },
          title: { type: "string", description: "work_item: the task. email_draft: the subject line. Up to 300 characters." },
          detail: { type: "string", description: "work_item: notes. email_draft: the body. Up to 2000 characters." },
          due_date: { type: "string", description: "YYYY-MM-DD" },
          to: { type: "string", enum: ["parents", "student"] },
        },
        required: ["type", "title"],
      },
    },
    run: async (ctx, raw) => {
      const i = z
        .object({
          type: z.enum(["work_item", "email_draft"]),
          student_id: z.string().uuid().optional(),
          title: z.string().trim().min(1).max(300),
          detail: z.string().max(2000).optional(),
          due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.enum(["parents", "student"]).optional(),
        })
        .parse(raw);
      const target = i.student_id ?? ctx.studentId;
      const studentId = target ? await resolveStudentId(ctx.request, target, "view") : null;
      if (i.type === "email_draft" && !studentId) return { content: "An email draft needs a student.", isError: true, fresh: false };
      const payload =
        i.type === "work_item"
          ? { title: i.title, detail: i.detail ?? null, dueDate: i.due_date ?? null }
          : { to: i.to ?? "parents", subject: i.title, body: i.detail ?? "" };
      const { data, error } = await ctx.request.db
        .from("axis_actions")
        .insert({ owner_id: ctx.request.auth.userId, conversation_id: ctx.conversationId, student_id: studentId, type: i.type, payload })
        .select("id")
        .single();
      if (error) throw fromPostgrest(error);
      const action: ProposedAction = { id: String(data.id), type: i.type, studentId, payload };
      ctx.onAction(action);
      return { content: `Proposed (id ${action.id}). The counselor sees a card to confirm or dismiss it; tell them it's waiting, don't say it's done.`, fresh: true };
    },
  },
  {
    name: "lookup",
    readOnly: true,
    label: (i) => `Looking up ${opWords(i.what)}`,
    tool: {
      name: "lookup",
      description:
        "Read items you may need to change, with their ids: deadlines, tasks, queue items, college list rows, pipeline contacts and stages, colleagues and more. `what` is a name marked (lookup) in the Meridies actions catalog; `input` is its input.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          what: { type: "string", enum: [...READ_OPS] },
          input: { type: "object", description: "The lookup's input, exactly as the catalog shows it." },
        },
        required: ["what"],
      },
    },
    run: async (ctx, raw) => {
      const i = z.object({ what: z.string().min(1).max(80), input: z.record(z.unknown()).optional() }).parse(raw);
      return runRead(opContext(ctx), i.what, i.input ?? {});
    },
  },
  {
    name: "perform_action",
    readOnly: false,
    label: (i) => opLabel(i.action),
    timeoutMs: WRITE_TIMEOUT_MS,
    tool: {
      name: "perform_action",
      description:
        "Change something in Meridies for the counselor: create, update, move, complete, archive, delete, send. `action` is an action name from the Meridies actions catalog and `input` its input. Actions marked * (and ~ for some inputs) wait for the counselor's Confirm; the rest take effect at once. Only do what the counselor asked for in their own words.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...WRITE_OPS] },
          input: { type: "object", description: "The action's input, exactly as the catalog shows it." },
        },
        required: ["action", "input"],
      },
    },
    run: async (ctx, raw) => {
      const i = z.object({ action: z.string().min(1).max(80), input: z.record(z.unknown()) }).parse(raw);
      return runWrite(opContext(ctx), i.action, i.input);
    },
  },
];

function opContext(ctx: ToolContext) {
  return {
    request: ctx.request, conversationId: ctx.conversationId, studentId: ctx.studentId, roster: ctx.roster, turn: ctx.turn, signal: ctx.signal,
    onOperation: ctx.onOperation,
  };
}

/** "deadlines.list" -> "deadlines"; "pipeline.stages" -> "pipeline stages". */
function opWords(name: unknown): string {
  if (typeof name !== "string") return "items";
  const [area = "", verb = ""] = name.split(".");
  const words = `${area} ${verb === "list" ? "" : verb}`.replace(/_/g, " ").trim();
  return words || "items";
}

function opLabel(name: unknown): string {
  const def = typeof name === "string" ? getOp(name) : undefined;
  if (!def) return "Making a change";
  const t = def.title.replace(/[.:].*$/, "");
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));

/**
 * Every tool, in a fixed order, minus those whose port isn't there. It only
 * changes when a mailbox is connected or the RAG port ships, so the cached
 * prefix (tools render first) holds across turns, students and counselors.
 */
export function toolList(connected: ConnectedProvider[], retrievalReady: boolean): Anthropic.Beta.BetaTool[] {
  return DEFS.filter((d) => {
    if (!connected.length && (d.name === "search_email" || d.name === "search_connected_files")) return false;
    if (!retrievalReady && (d.name === "search_documents" || d.name === "read_document")) return false;
    return true;
  }).map((d) => d.tool);
}

export function toolLabel(name: string, input: unknown): string {
  const def = BY_NAME.get(name as ToolName);
  return def ? def.label((input ?? {}) as Record<string, unknown>) : "Working";
}

export const isReadOnly = (name: string): boolean => BY_NAME.get(name as ToolName)?.readOnly ?? false;

/** Key order doesn't change what was asked. */
function stableKey(name: string, input: unknown): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return `${name}:${JSON.stringify(norm(input))}`;
}

/**
 * Runs one call under its own timeout. Errors come back as an error result the
 * model can recover from, never a thrown turn. The same read twice in a turn
 * is answered from memory.
 */
export function runTool(ctx: ToolContext, name: string, input: unknown, signal: AbortSignal): Promise<ToolOutput> {
  const def = BY_NAME.get(name as ToolName);
  if (!def) return Promise.resolve({ content: `Unknown tool ${name}.`, isError: true, fresh: false });
  const key = stableKey(name, input);
  if (def.readOnly) {
    const seen = ctx.memo.get(key);
    if (seen) return seen.then((o) => ({ ...o, content: `Same lookup as earlier in this turn:\n${o.content}`, fresh: false }));
  }
  const p = execute(ctx, def, input, signal);
  if (def.readOnly) ctx.memo.set(key, p);
  return p;
}

async function execute(ctx: ToolContext, def: ToolDef, input: unknown, parent: AbortSignal): Promise<ToolOutput> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), def.timeoutMs ?? TOOL_TIMEOUT_MS);
  try {
    const out = await Promise.race([
      def.run({ ...ctx, signal: ctl.signal }, input),
      new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
    ]);
    return { ...out, content: clip(out.content, 40_000) };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { content: `Invalid input: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}. Fix it and call again.`, isError: true, fresh: false };
    }
    if (ctl.signal.aborted && !def.readOnly) {
      return { content: "That change took too long to answer; it may or may not have gone through. Don't repeat it: tell the counselor to check.", isError: true, fresh: false };
    }
    if (ctl.signal.aborted) return { content: "That lookup took too long and was stopped. Answer with what you have, and say what you couldn't check.", isError: true, fresh: false };
    ctx.request.log.warn({ err: errInfo(err), tool: def.name }, "axis tool failed");
    const status = err && typeof err === "object" && "statusCode" in err ? (err as { statusCode: number }).statusCode : 0;
    if (status === 403 || status === 404) {
      const msg = err instanceof Error && err.message && err.message.length < 200 ? err.message : "No access to that student.";
      return { content: msg, isError: true, fresh: false };
    }
    return { content: def.readOnly ? "That lookup failed." : "That change failed; nothing to retry right now.", isError: true, fresh: false };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
}
