/**
 * The adjudicator: the second, model stage of grounding.
 *
 * Live grounding (lib/axis/grounding.ts) checks every figure in the answer
 * against the evidence in code and marks what it can't find. Some of those
 * are fine: a figure written as words, a date the model computed from two on
 * file, general admissions knowledge ("the Common App opens August 1"). Only
 * those flagged sentences, never the whole answer, go to Haiku 5.5 at low
 * effort with the material they should rest on, and it rules on each. The
 * counselor sees what is still unsupported under the answer. It runs after
 * the answer is done, so it costs no waiting.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../context/pack.js";
import type { SentenceCheck } from "./grounding.js";
import type { SourceLedger } from "./ledger.js";
import { structured } from "./llm.js";

export type Verification = {
  checked: boolean;
  /** Figures and citations the code checked. */
  figuresChecked: number;
  unsupported: { claim: string; reason: string }[];
};

const SCHEMA = {
  type: "object",
  properties: {
    rulings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "The sentence number given." },
          verdict: { type: "string", enum: ["supported", "unsupported", "general-knowledge"] },
          reason: { type: "string", description: "One short sentence: what the material says instead, or that it doesn't say." },
        },
        required: ["index", "verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["rulings"],
  additionalProperties: false,
} as const;

const SYSTEM = [
  "You check flagged sentences from an assistant's answer against the material the answer was written from.",
  "For each sentence: supported when the material states it, or it follows by simple arithmetic or a date calculation from figures in the material;",
  "general-knowledge when it is widely published admissions or financial-aid knowledge that doesn't depend on this student or this year's figures;",
  "unsupported when the material contradicts it or doesn't contain it.",
  UNTRUSTED_DATA_RULE,
].join("\n");

const MATERIAL_CHARS = 60_000;

export async function adjudicate(o: {
  request: FastifyRequest;
  studentId: string | null;
  checks: SentenceCheck[];
  ledger: SourceLedger;
  material: string[];
  signal?: AbortSignal;
}): Promise<Verification> {
  const figuresChecked = o.checks.reduce((n, c) => n + c.figures.length + c.citations.length, 0);
  const residue = o.checks.filter((c) => c.status !== "grounded");
  if (!residue.length) return { checked: true, figuresChecked, unsupported: [] };
  let budget = MATERIAL_CHARS;
  const parts: string[] = [];
  for (const m of [...o.material, ...o.ledger.all().map((s) => `[${s.id}] ${s.text}`)]) {
    if (!m || m.length > budget) continue;
    parts.push(m);
    budget -= m.length;
  }
  const flagged = residue
    .map((c) => {
      const missing = c.figures.filter((f) => f.status === "missing").map((f) => f.text);
      const weak = c.citations.filter((x) => x.support < 0.2).map((x) => x.id);
      return `${c.index}. ${c.text}${missing.length ? `\n   figures not found: ${missing.join(", ")}` : ""}${weak.length ? `\n   citations with little overlap: ${weak.join(", ")}` : ""}`;
    })
    .join("\n");
  const out = await structured({
    request: o.request,
    module: "axis-verify",
    studentId: o.studentId,
    system: SYSTEM,
    prompt: `Material:\n${wrapUntrusted("material", parts.join("\n\n"))}\n\nFlagged sentences:\n${wrapUntrusted("answer", flagged)}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    parse: z.object({ rulings: z.array(z.object({ index: z.number().int(), verdict: z.enum(["supported", "unsupported", "general-knowledge"]), reason: z.string() })) }),
    effort: "low",
    signal: o.signal,
  });
  if (!out) return { checked: false, figuresChecked, unsupported: [] };
  const byIndex = new Map(residue.map((c) => [c.index, c]));
  const unsupported = out.rulings
    .filter((r) => r.verdict === "unsupported" && byIndex.has(r.index))
    .map((r) => ({ claim: byIndex.get(r.index)!.text.replace(/\s*\[S\d{1,3}\]/g, "").slice(0, 300), reason: r.reason.slice(0, 300) }));
  return { checked: true, figuresChecked, unsupported };
}
