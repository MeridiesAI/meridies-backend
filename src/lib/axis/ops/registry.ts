/**
 * Every operation AxIS can run, and the catalog text the model reads.
 *
 * The groups are listed in a fixed order and the catalog is rendered once,
 * so it sits in the cached system prompt and never moves the cache. Adding an
 * operation means adding it to a catalog file below; the tools, the prompt
 * and the confirmation routes pick it up from here.
 */
import type { OpDef, OpGroup, Risk } from "./types.js";
import { applicationEssays, applicationSheets, collegeList } from "./catalog/application.js";
import { colleges, events, resources } from "./catalog/colleges.js";
import { deadlines } from "./catalog/deadlines.js";
import { files } from "./catalog/files.js";
import { outcomes, recommendations, referrals } from "./catalog/outcomes.js";
import { payments, pipeline } from "./catalog/pipeline.js";
import { firm, management, settings } from "./catalog/practice.js";
import { accountability, tasks } from "./catalog/tasks.js";
import { invites, newStudents, rosterImports } from "./catalog/invites.js";
import { pins, preferenceCards, strengthProfile, students } from "./catalog/students.js";
import { workQueue } from "./catalog/workQueue.js";

export const GROUPS: readonly OpGroup[] = [
  students, strengthProfile, pins, preferenceCards,
  invites, newStudents, rosterImports,
  tasks, deadlines, workQueue, accountability,
  collegeList, applicationEssays, applicationSheets,
  colleges, events, resources,
  files,
  outcomes, referrals, recommendations,
  pipeline, payments,
  management, firm, settings,
];

const ALL: OpDef[] = GROUPS.flatMap((g) => g.ops);
const BY_NAME = new Map<string, OpDef>(ALL.map((d) => [d.name, d]));
const HEADING = new Map<string, string>(GROUPS.flatMap((g) => g.ops.map((d) => [d.name, g.heading] as const)));

export const allOps = (): readonly OpDef[] => ALL;
export const getOp = (name: string): OpDef | undefined => BY_NAME.get(name);
export const headingOf = (name: string): string => HEADING.get(name) ?? "Meridies";

/** Names in catalog order: the enums on the two tools. */
export const READ_OPS: readonly string[] = ALL.filter((d) => d.kind === "read").map((d) => d.name);
export const WRITE_OPS: readonly string[] = ALL.filter((d) => d.kind === "write").map((d) => d.name);

/** A write's tier for this input. Reads have none; an op without one asks first. */
export function riskOf(def: OpDef, input: unknown): Risk {
  if (typeof def.risk === "function") return def.risk(input);
  return def.risk ?? "confirm";
}

let rendered: string | null = null;

/**
 * The catalog in the system prompt. One line per operation:
 *   `deadlines.create* {input}: what it does`
 * `lookup` names come first in each group; `*` marks the ones that wait for
 * the counselor's Confirm, `~` the ones that do for some inputs.
 */
export function catalogText(): string {
  if (rendered) return rendered;
  const lines: string[] = [
    "Meridies actions",
    "lookup(what, input) reads the items below marked (lookup) and returns their ids. perform_action(action, input) runs the rest.",
    "* = waits for the counselor to click Confirm on a card. ~ = waits for some inputs (noted in the line). Everything else takes effect at once and the counselor can Undo it.",
    "Inputs are JSON with exactly the keys shown; ? marks optional keys; ids are UUIDs from a lookup or find_student.",
  ];
  for (const g of GROUPS) {
    lines.push("", `## ${g.heading}`);
    for (const d of g.ops) {
      const mark = d.kind === "read" ? " (lookup)" : typeof d.risk === "function" ? "~" : riskOf(d, {}) === "confirm" ? "*" : "";
      lines.push(`${d.name}${mark} ${d.doc}: ${d.title}`);
    }
  }
  rendered = lines.join("\n");
  return rendered;
}
