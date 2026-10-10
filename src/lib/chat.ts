/**
 * Chat context management + the server-side tool registry.
 *
 * Two things live here, both deliberately on the backend so the frontend never
 * constructs a prompt:
 *
 *  1. CHAT_TOOLS — each "student tool" the counselor can focus the assistant on
 *     (narrative coherence, opportunity concierge, …). A tool owns its system
 *     prompt; the client only ever sends the tool's `key`.
 *  2. buildSystemPrompt — wraps the student context (built by lib/context, the
 *     one place that decides what AxIS may read about a student) in the prompt.
 *
 * The essay guardrail still binds: no tool here drafts essay prose, and the
 * base rules forbid it. Essay help stays on the bullets-only /ai/essay-advice.
 */

import type { FastifyRequest } from "fastify";
import { DEEP_MODEL, FAST_MODEL } from "./anthropic.js";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./context/pack.js";

export type ChatToolKey =
  | "general"
  | "narrative-coherence"
  | "opportunity-concierge"
  | "school-reframing"
  | "college-list"
  | "profile-review";

export type ChatTool = {
  key: ChatToolKey;
  label: string;
  /** One line shown in the tool card. */
  description: string;
  /** Short badge, e.g. NCE. */
  badge: string;
  /** Whether a student must be selected for this tool to do anything useful. */
  needsStudent: boolean;
  /** Haiku by default; the harder analytical tools earn Sonnet. */
  model: string;
  /** The tool-specific system guidance, appended to BASE_CHAT_SYSTEM. */
  guidance: string;
};

const BASE_CHAT_SYSTEM = [
  "You are AxIS (Adaptive Experience Intelligence System), the Meridies assistant",
  "for an independent college counselor.",
  "You are talking TO the counselor, about their student — never to the student.",
  "",
  "Ground every claim in the student context provided. Be specific: cite the",
  "student's own activities, essays, courses, and colleges by name. Never invent",
  "statistics, deadlines, or admissions odds — if the record doesn't say, say so.",
  "",
  "Format for a busy professional: lead with the answer, then tight bullets.",
  "Keep it conversational and brief unless asked to go deep.",
  "",
  "Hard rule: you NEVER write, draft, rewrite, or ghostwrite essay prose for the",
  "student. You may point at their own material and advise what to change. If",
  "asked to write an essay, decline and give bulleted guidance instead.",
].join("\n");

export const CHAT_TOOLS: Record<ChatToolKey, ChatTool> = {
  general: {
    key: "general",
    label: "General assistant",
    description: "Ask anything about this student or your caseload.",
    badge: "GA",
    needsStudent: false,
    model: FAST_MODEL,
    guidance:
      "Answer the counselor's question directly using whatever student context is available.",
  },
  "narrative-coherence": {
    key: "narrative-coherence",
    label: "Narrative coherence engine",
    description: "Flags where the story contradicts itself.",
    badge: "NCE",
    needsStudent: true,
    model: DEEP_MODEL,
    guidance: [
      "Focus: narrative coherence. Read across the student's activities, awards,",
      "intended major, essays (titles/prompts/status), and colleges, and surface",
      "where the story pulls in different directions or a claimed theme isn't",
      "backed by evidence. For each flag: what contradicts what, why it matters to",
      "an admissions reader, and a concrete fix that uses the student's real",
      "material. Be honest when the narrative is actually coherent.",
    ].join(" "),
  },
  "opportunity-concierge": {
    key: "opportunity-concierge",
    label: "Program & opportunity concierge",
    description: "Finds programs that fit the shape of the profile.",
    badge: "POC",
    needsStudent: true,
    model: DEEP_MODEL,
    guidance: [
      "Focus: opportunities. Suggest programs, competitions, research, or summer",
      "options that fit this student's demonstrated interests, level, and gaps.",
      "Explain the fit in one line each, and flag eligibility or timing concerns.",
      "Prefer well-known, verifiable options; never fabricate a program or deadline.",
    ].join(" "),
  },
  "school-reframing": {
    key: "school-reframing",
    label: "School-specific reframing",
    description: "Reframes the profile for one school's readers.",
    badge: "SSR",
    needsStudent: true,
    model: FAST_MODEL,
    guidance: [
      "Focus: school-specific reframing. When the counselor names a school, explain",
      "how to position THIS student for that school's known values and priorities,",
      "using the student's real activities and essays. Advise on framing only —",
      "never write the supplement.",
    ].join(" "),
  },
  "college-list": {
    key: "college-list",
    label: "College list builder",
    description: "Builds a balanced list from the profile and constraints.",
    badge: "ICLB",
    needsStudent: true,
    model: DEEP_MODEL,
    guidance: [
      "Focus: college list. Help build or pressure-test a balanced list (reach /",
      "target / likely) from the student's stats, interests, and any stated",
      "constraints. Explain each suggestion's category and fit. Be candid about",
      "reach odds; never invent acceptance rates.",
    ].join(" "),
  },
  "profile-review": {
    key: "profile-review",
    label: "Profile review",
    description: "A synthesized read of the student's whole profile.",
    badge: "PR",
    needsStudent: true,
    model: FAST_MODEL,
    guidance: [
      "Focus: whole-profile synthesis. Give the counselor a crisp read of this",
      "student's strengths, gaps, and the one or two highest-leverage moves right",
      "now, grounded in the record.",
    ].join(" "),
  },
};

export function getChatTool(key: string | null | undefined): ChatTool {
  if (key && key in CHAT_TOOLS) return CHAT_TOOLS[key as ChatToolKey];
  return CHAT_TOOLS.general;
}

/** The tool list the frontend renders (no system prompts leak to the client). */
export function chatToolCatalog() {
  return Object.values(CHAT_TOOLS).map(({ key, label, description, badge, needsStudent }) => ({
    key,
    label,
    description,
    badge,
    needsStudent,
  }));
}

/**
 * "Across the roster" (a chat with no student): the counselor's students and
 * what is due soon, so a question like "who is behind this week?" is
 * answered from the record rather than from nothing. Same RLS-bound client,
 * same cap. Names and dates only — no essays or notes for every student.
 */
export async function buildRosterContext(
  request: FastifyRequest
): Promise<{ text: string; sources: string[] } | null> {
  if (request.profile.role !== "counselor") return null;
  const db = request.db;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + 21 * 86_400_000).toISOString().slice(0, 10);

  const [roster, deadlines, meetings, tasks] = await Promise.all([
    db
      .from("profiles")
      .select("id, full_name, grad_year, high_school")
      .eq("counselor_id", request.auth.userId)
      .eq("role", "student")
      .order("full_name")
      .limit(300),
    db
      .from("deadlines")
      .select("student_id, title, school, type, due_date, level")
      .eq("done", false)
      .lte("due_date", horizon)
      .order("due_date")
      .limit(150),
    db
      .from("meetings")
      .select("student_id, title, starts_at")
      .eq("counselor_id", request.auth.userId)
      .eq("status", "scheduled")
      .gte("starts_at", now.toISOString())
      .lte("starts_at", `${horizon}T23:59:59Z`)
      .order("starts_at")
      .limit(60),
    db
      .from("deliverables")
      .select("student_id, title, status, due_date, last_activity_at")
      .neq("status", "complete")
      .lte("due_date", horizon)
      .order("due_date")
      .limit(150),
  ]);
  if (roster.error) return null;

  const names = new Map(
    ((roster.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), String(r.full_name ?? "")])
  );
  const who = (id: unknown) => names.get(String(id)) ?? "Student";
  const label = <T extends Record<string, unknown>>(rows: T[] | null) =>
    // RLS can return rows for students the counselor sees but does not hold
    // (a firm colleague's); the roster question is about their own.
    (rows ?? [])
      .filter((r) => names.has(String(r.student_id)))
      .map(({ student_id, ...rest }) => ({ student: who(student_id), ...rest }));

  const sources = ["Roster"];
  if ((deadlines.data ?? []).length || (meetings.data ?? []).length || (tasks.data ?? []).length) {
    sources.push("Calendar");
  }

  const text = JSON.stringify(
    {
      today,
      students: ((roster.data ?? []) as Record<string, unknown>[]).map((r) => ({
        name: r.full_name,
        gradYear: r.grad_year,
        highSchool: r.high_school,
      })),
      deadlinesNext3Weeks: label(deadlines.data as Record<string, unknown>[] | null),
      meetingsNext3Weeks: label(meetings.data as Record<string, unknown>[] | null),
      openTasksDueSoon: label(tasks.data as Record<string, unknown>[] | null),
    },
    null,
    1
  ).slice(0, 60_000);
  return { text, sources };
}

/**
 * Build the system prompt for a chat turn: base rules + the tool's focus + the
 * student brief (when a student is in scope). This is the whole reason tool
 * prompts live server-side — the client only picks a tool key.
 */
export function buildSystemPrompt(
  tool: ChatTool,
  studentContext: string | null,
  rosterContext: string | null = null
): string {
  const parts = [BASE_CHAT_SYSTEM, "", `Active tool: ${tool.label}. ${tool.guidance}`];
  if (!studentContext && rosterContext) {
    parts.push(
      "",
      "--- THE COUNSELOR'S ROSTER, NEXT THREE WEEKS (JSON, inside a data block) ---",
      wrapUntrusted("roster", rosterContext),
      "--- END ROSTER ---",
      "",
      UNTRUSTED_DATA_RULE
    );
  }
  if (studentContext) {
    // The context already carries the student's name inside its own data blocks.
    parts.push("", "--- STUDENT ON FILE ---", studentContext, "--- END STUDENT ---", "", UNTRUSTED_DATA_RULE);
  } else if (tool.needsStudent) {
    parts.push(
      "",
      "No student is selected. Ask the counselor to pick a student from the panel so you can ground your answer in their record."
    );
  }
  return parts.join("\n");
}

/** JSON Schema for the reasoning/planning pass shown to the counselor. */
export const REASONING_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      description: "Short first-person planning steps, e.g. 'Reviewing Sophia's 3 essays for a consistent theme.'",
      items: { type: "string", maxLength: 140 },
    },
  },
  required: ["steps"],
} as const;
