/**
 * Chat context management + the server-side tool registry.
 *
 * Two things live here, both deliberately on the backend so the frontend never
 * constructs a prompt:
 *
 *  1. CHAT_TOOLS — each "student tool" the counselor can focus the assistant on
 *     (narrative coherence, opportunity concierge, …). A tool owns its system
 *     prompt; the client only ever sends the tool's `key`.
 *  2. buildStudentContext — assembles the student's record into a compact,
 *     token-budgeted brief, under the caller's RLS (so private notes the caller
 *     can't see are never in the prompt).
 *
 * The essay guardrail still binds: no tool here drafts essay prose, and the
 * base rules forbid it. Essay help stays on the bullets-only /ai/essay-advice.
 */

import type { FastifyRequest } from "fastify";
import { DEEP_MODEL, FAST_MODEL } from "./anthropic.js";

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
  "You are Meridies, the assistant for an independent college counselor.",
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
 * Assemble the student's record into a compact brief. Runs under the caller's
 * RLS-scoped client, so anything the caller can't see (e.g. another counselor's
 * private notes) is never pulled in. Capped so a big roster can't blow the
 * context window.
 */
export async function buildStudentContext(
  request: FastifyRequest,
  studentId: string
): Promise<string | null> {
  const db = request.db;
  const [profile, academics, activities, awards, essays, colleges, notes, polygon, deadlines] =
    await Promise.all([
      db
        .from("profiles")
        .select("full_name, grad_year, high_school, hometown, headline, profile")
        .eq("id", studentId)
        .maybeSingle(),
      db.from("student_academics").select("*").eq("student_id", studentId).maybeSingle(),
      db
        .from("activities")
        .select("name, position, organization, category, hours_per_week, description")
        .eq("student_id", studentId)
        .order("sort_order")
        .limit(30),
      db
        .from("awards")
        .select("name, level, year")
        .eq("student_id", studentId)
        .order("sort_order")
        .limit(30),
      db
        .from("essays")
        .select("title, prompt, school, status, word_count")
        .eq("student_id", studentId)
        .limit(30),
      db
        .from("student_colleges")
        .select("name, round, fit, status")
        .eq("student_id", studentId)
        .order("sort_order")
        .limit(40),
      db
        .from("meeting_notes")
        .select("meeting_date, title, summary, tags")
        .eq("student_id", studentId)
        .order("meeting_date", { ascending: false })
        .limit(8),
      db
        .from("student_polygon_axes")
        .select("label, score, max_score, note")
        .eq("student_id", studentId)
        .order("sort_order"),
      db
        .from("deadlines")
        .select("title, school, type, due_date, level, done")
        .eq("student_id", studentId)
        .order("due_date")
        .limit(20),
    ]);

  if (!profile.data) return null;

  return JSON.stringify(
    {
      student: profile.data,
      academics: academics.data,
      activities: activities.data,
      awards: awards.data,
      essays: essays.data,
      colleges: colleges.data,
      meetingNotes: notes.data,
      profileStrength: polygon.data,
      deadlines: deadlines.data,
    },
    null,
    1
  ).slice(0, 60_000);
}

/**
 * Build the system prompt for a chat turn: base rules + the tool's focus + the
 * student brief (when a student is in scope). This is the whole reason tool
 * prompts live server-side — the client only picks a tool key.
 */
export function buildSystemPrompt(
  tool: ChatTool,
  studentContext: string | null,
  studentName: string | null
): string {
  const parts = [BASE_CHAT_SYSTEM, "", `Active tool: ${tool.label}. ${tool.guidance}`];
  if (studentContext) {
    parts.push(
      "",
      `--- STUDENT ON FILE${studentName ? `: ${studentName}` : ""} (JSON) ---`,
      studentContext,
      "--- END STUDENT ---"
    );
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
