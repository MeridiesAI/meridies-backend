/**
 * The parse plan's AI fallback (spec §5.3, §7.1): for columns no template or
 * preset mapped, Haiku (FAST_MODEL, module import-mapping, through
 * runStructured) suggests a target from a fixed list. It sees masked headers,
 * column statistics and masked samples only (profile.ts modelView), wrapped
 * as untrusted data.
 *
 * Whatever comes back is filtered in code: a column it wasn't asked about,
 * a target off the list or a field import_fields doesn't hold is dropped, and
 * a score column's exam is taken from the file's own header, never from the
 * model's words. Two retries with backoff on a failed call, each charged to
 * the daily AI quota like any call; then the counselor maps by hand. Spend is
 * tracked per import and the call is skipped at the 200-cent cap.
 */

import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { FAST_MODEL, runStructured, type RunOptions } from "../anthropic.js";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../context/pack.js";
import { HttpError } from "../errors.js";
import { AI_CAP_CENTS } from "./caps.js";
import { KEY_KINDS, ROW_PARTS, ROW_TABLES, singleFields, type FieldDef } from "./fields.js";
import { SOURCE_SYSTEMS, type PlanColumn, type SourceSystem, type Target } from "./plan.js";
import { modelView, type SheetProfile } from "./profile.js";
import { costCents } from "./spend.js";
import { testKindOf } from "./values.js";

export type Unmapped = { fileId: string; sheet: SheetProfile; indexes: Set<number> };

export type AiPlanDeps = {
  run?: <T>(opts: RunOptions<T>) => Promise<T>;
  /** Adds cents to the import's spend and returns the new total. */
  addSpend: (cents: number) => Promise<number>;
  spent: number;
  sleep?: (ms: number) => Promise<void>;
};

export type AiPlanResult =
  | { manual: false; columns: Array<{ fileId: string; sheet: string; column: PlanColumn }>; sourceSystem: SourceSystem | null }
  | { manual: true; reason: string };

export const MANUAL_REASON = "Couldn't suggest a mapping. Map columns manually";
export const CAP_REASON = "AI help limit reached for this import. Finish manually";
const ATTEMPTS = 3;

/** The fixed list of targets the model chooses from. */
export function targetList(fields: FieldDef[]): string[] {
  return [
    "ignore",
    ...KEY_KINDS.map((k) => `key:${k}`),
    ...singleFields(fields).map((f) => `field:${f.table}.${f.field}`),
    ...ROW_TABLES.flatMap((t) => Object.keys(ROW_PARTS[t]).map((p) => `row:${t}.${p}`)),
    "score_column",
  ];
}

const DATE_ORDERS = ["MDY", "DMY", "YMD", "excel1900", "excel1904"] as const;

const answerSchema = z.object({
  sourceSystem: z.string().optional(),
  columns: z
    .array(
      z.object({
        sheet: z.number(),
        index: z.number(),
        target: z.string(),
        date: z.string().optional(),
        number: z.string().optional(),
        name: z.string().optional(),
      }).passthrough()
    )
    .max(2000),
}).passthrough();
type Answer = z.infer<typeof answerSchema>;

export function toolSchema(targets: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sourceSystem: { type: "string", enum: [...SOURCE_SYSTEMS] },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sheet: { type: "integer", description: "The sheet number." },
            index: { type: "integer", description: "The column index." },
            target: { type: "string", enum: targets },
            date: { type: "string", enum: [...DATE_ORDERS], description: "Only for date columns." },
            number: { type: "string", enum: ["plain", "comma-decimal"], description: "Only when numbers use a comma as the decimal point." },
            name: { type: "string", enum: ["first-last", "last-first"], description: "Only for a full-name column." },
          },
          required: ["sheet", "index", "target"],
        },
      },
    },
    required: ["columns"],
  };
}

export const SYSTEM = [
  "You map the columns of a spreadsheet a college counselor exported from another tool to the fields of a counseling app.",
  "For each column you see its header (masked as <name> when it may be a person's name), statistics and the shapes of a few values. You never see the values.",
  "Pick one target per column from the list you are given. Use ignore whenever you are not sure; a wrong mapping is worse than none.",
  "key:* targets identify the student (email, name, graduation year, high school). field:* targets fill one value per student. row:* targets are parts of a test score, course or activity when the file has one row per test, course or activity. score_column is a column whose header names one test (for example an AP or IB exam) and whose values are its scores.",
  "Never change a value: a GPA stays on its own scale. Only say how to read it: date order (MDY or DMY; a first part over 12 means DMY; whole numbers between 18000 and 60000 are Excel serial dates), comma decimals, or a Last, First name order.",
  "Guess sourceSystem only when a header names the tool; otherwise unknown.",
  UNTRUSTED_DATA_RULE,
].join(" ");

export function buildPrompt(unmapped: Unmapped[], targets: string[]): string {
  const views = unmapped.map((u, i) => modelView(u.sheet, i + 1, u.indexes));
  return [
    "Columns to map, by sheet number:",
    wrapUntrusted("import-profile", JSON.stringify(views)),
    `Targets: ${targets.join(", ")}`,
  ].join("\n");
}

function scoreExam(header: string): string {
  return header.trim().replace(/\s+(score|exam score|result)$/i, "").slice(0, 80);
}

/** The model's answer, filtered to what it was asked and what exists. */
export function toColumns(answer: Answer, unmapped: Unmapped[], fields: FieldDef[]): AiPlanResult & { manual: false } {
  const allowed = new Set(targetList(fields));
  const out: Array<{ fileId: string; sheet: string; column: PlanColumn }> = [];
  const used = new Set<string>();
  for (const a of answer.columns) {
    const u = unmapped[a.sheet - 1];
    if (!u || !Number.isInteger(a.index) || !u.indexes.has(a.index) || !allowed.has(a.target) || a.target === "ignore") continue;
    const k = `${a.sheet}:${a.index}`;
    if (used.has(k)) continue;
    used.add(k);
    const col = u.sheet.columns[a.index];
    let target: Target;
    if (a.target.startsWith("key:")) {
      target = { kind: "key", key: a.target.slice(4) as (typeof KEY_KINDS)[number] };
    } else if (a.target.startsWith("field:")) {
      const [table, field] = a.target.slice(6).split(".");
      target = { kind: "field", table: table as "student_academics", field };
    } else if (a.target.startsWith("row:")) {
      const [table, part] = a.target.slice(4).split(".");
      target = { kind: "row", table: table as "courses", group: "ai", part };
    } else {
      const exam = scoreExam(col.header);
      if (!exam || col.maskedHeader === "<name>") continue;
      target = { kind: "score_column", exam, testKind: testKindOf(exam) };
    }
    const parse: PlanColumn["parse"] = {};
    const isDate = (target.kind === "field" && target.field === "birthday") || (target.kind === "row" && target.part === "taken_on");
    if (isDate && (DATE_ORDERS as readonly string[]).includes(a.date ?? "")) parse.date = a.date as (typeof DATE_ORDERS)[number];
    if (a.number === "comma-decimal") parse.number = "comma-decimal";
    if (target.kind === "key" && target.key === "full_name" && a.name === "last-first") parse.name = "last-first";
    out.push({
      fileId: u.fileId,
      sheet: u.sheet.name,
      column: { index: a.index, target, ...(Object.keys(parse).length ? { parse } : {}), source: "ai" },
    });
  }
  const ss = (SOURCE_SYSTEMS as readonly string[]).includes(answer.sourceSystem ?? "") ? (answer.sourceSystem as SourceSystem) : null;
  return { manual: false, columns: out, sourceSystem: ss === "unknown" ? null : ss };
}

export async function aiPlan(request: FastifyRequest, unmapped: Unmapped[], fields: FieldDef[], deps: AiPlanDeps): Promise<AiPlanResult> {
  if (unmapped.length === 0) return { manual: false, columns: [], sourceSystem: null };
  const run = deps.run ?? runStructured;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const targets = targetList(fields);
  const prompt = buildPrompt(unmapped, targets);
  let spent = deps.spent;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (spent >= AI_CAP_CENTS) return { manual: true, reason: CAP_REASON };
    try {
      const answer = await run<Answer>({
        request,
        module: "import-mapping",
        system: SYSTEM,
        prompt,
        schema: toolSchema(targets),
        toolName: "map_columns",
        model: FAST_MODEL,
        maxTokens: 4096,
        validate: (v) => answerSchema.parse(v),
        onUsage: async (u) => {
          spent = await deps.addSpend(costCents(u.model, u.inputTokens, u.outputTokens));
        },
      });
      return toColumns(answer, unmapped, fields);
    } catch (err) {
      // Quota spent or the practice switched document reading off: retrying won't help.
      if (err instanceof HttpError && (err.statusCode === 429 || err.statusCode === 403)) {
        return { manual: true, reason: `${MANUAL_REASON}. ${err.message}` };
      }
      if (attempt === ATTEMPTS) break;
      await sleep(500 * 3 ** (attempt - 1));
    }
  }
  return { manual: true, reason: MANUAL_REASON };
}
