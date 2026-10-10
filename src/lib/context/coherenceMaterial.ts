/**
 * The documents a Narrative Coherence run reads, as prompt text: every piece a
 * student wrote (essay bodies, titles, activity and award rows) sits inside an
 * escaped data block, and the cap drops whole blocks, never part of one.
 */
import { wrapUntrusted } from "./pack.js";

type Row = Record<string, unknown>;

const clip = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

/** A data-block source label from a student-written name: one line, bounded. */
export const sourceTag = (prefix: string, name: unknown): string =>
  `${prefix}:${String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80)}`;

type Block = { text: string; part: "statement" | "supplement" | "activity" | "award"; essay?: Row };

/** Keeps blocks in order; one that would pass the cap is skipped and later, smaller ones may still fit. */
export function fitBlocks<T extends { text: string }>(blocks: T[], cap: number): T[] {
  const kept: T[] = [];
  let size = 0;
  for (const b of blocks) {
    const cost = b.text.length + (kept.length ? 2 : 0);
    if (size + cost > cap) continue;
    kept.push(b);
    size += cost;
  }
  return kept;
}

export type CoherenceMaterial = {
  text: string;
  /** What actually made it into `text`. */
  sent: { statement: boolean; supplements: Row[]; activities: boolean; awards: boolean };
};

export function buildCoherenceMaterial(
  input: { statement: Row | null; supplements: Row[]; activities: Row[]; awards: Row[] },
  cap = 80_000
): CoherenceMaterial {
  const blocks: Block[] = [];
  if (input.statement) {
    blocks.push({
      part: "statement",
      text: `Personal statement:\n${wrapUntrusted(sourceTag("essay", input.statement.title || "personal statement"), clip(input.statement.body, 12_000))}`,
    });
  }
  for (const sup of input.supplements) {
    blocks.push({
      part: "supplement",
      essay: sup,
      text: `Supplement:\n${wrapUntrusted(
        sourceTag("essay", sup.title || sup.school),
        [`School: ${clip(sup.school, 200)}`, `Title: ${clip(sup.title, 200)}`, `Prompt: ${clip(sup.prompt, 600)}`, `Text: ${clip(sup.body, 6_000)}`].join("\n")
      )}`,
    });
  }
  for (const a of input.activities) {
    blocks.push({ part: "activity", text: `Activity:\n${wrapUntrusted(sourceTag("activity", a.organization || a.position), JSON.stringify(a, null, 1))}` });
  }
  for (const a of input.awards) {
    blocks.push({ part: "award", text: `Award:\n${wrapUntrusted(sourceTag("award", a.name), JSON.stringify(a, null, 1))}` });
  }
  const kept = fitBlocks(blocks, cap);
  return {
    text: kept.map((b) => b.text).join("\n\n"),
    sent: {
      statement: kept.some((b) => b.part === "statement"),
      supplements: kept.filter((b) => b.part === "supplement").map((b) => b.essay as Row),
      activities: kept.some((b) => b.part === "activity"),
      awards: kept.some((b) => b.part === "award"),
    },
  };
}
