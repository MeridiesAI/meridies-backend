/**
 * The documents a Narrative Coherence run reads, as prompt text: every piece a
 * student wrote (essay bodies, titles, activity and award rows) sits inside an
 * escaped data block, and the cap drops whole blocks, never part of one.
 */
import { wrapUntrusted } from "./pack.js";
import { essayBodyReadable } from "./sections.js";

type Row = Record<string, unknown>;

const clip = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

/**
 * The essay a Coherence run may read, or null: it has words, isn't unreadable, and passes the layer's rule for
 * essay bodies (no linked file, or the linked file came back and is not kept out of AI).
 */
export function usableEssay(e: Row | undefined): Row | null {
  if (!e) return null;
  if (!essayBodyReadable(e.document_id, e.document)) return null;
  return Number(e.word_count ?? 0) > 0 && e.text_status !== "unreadable" ? e : null;
}

/** Why a ticked document couldn't be read for a run (lib/essayText.ts's reasons, plus what the run itself finds). */
export type UnreadReason =
  | "not-linked"
  | "not-google"
  | "not-mine"
  | "not-picked"
  | "no-access"
  | "failed"
  | "unreadable"
  | "empty"
  | "too-many";

export type UnreadDoc = {
  part: "statement" | "supplement";
  title: unknown;
  school: unknown;
  reason: UnreadReason;
  /** no-access only: the connection's own message, written to the caller (lib/oauth.ts). */
  message?: string;
};

const docName = (d: UnreadDoc): string => {
  if (d.part === "statement") return "The personal statement";
  const title = String(d.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "A supplement";
  const school = String(d.school ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return school ? `${title} (${school})` : title;
};

/** What went wrong and what to do about it, in the words of whoever ran the report. */
function unreadLine(reason: UnreadReason, audience: "counselor" | "student", message?: string): { what: string; fix: string } {
  const notReadYet = "its Google Doc hasn't been read in yet";
  const askCounselor = "Ask your counselor to open your Essays so it's read in, or upload the file instead.";
  switch (reason) {
    case "not-picked":
      return audience === "student"
        ? { what: notReadYet, fix: askCounselor }
        : { what: `${notReadYet}, because Meridies can read only a Doc you picked`, fix: "In Essays, choose “Pick this Doc to keep it in sync”, then generate the report again." };
    case "not-mine":
      return audience === "student"
        ? { what: notReadYet, fix: askCounselor }
        : { what: `${notReadYet}, and only whoever linked it can read it in`, fix: "Paste the link again yourself in Essays, then generate the report again." };
    case "no-access":
      return audience === "student"
        ? { what: notReadYet, fix: askCounselor }
        : { what: notReadYet, fix: message || "Reconnect Google under App Integrations, then generate the report again." };
    case "not-google":
      return { what: "its link isn't a Google Doc, so Meridies can't read it", fix: audience === "student" ? "Upload the file instead." : "Upload the file, or pick it from Drive or OneDrive in Essays, instead." };
    case "unreadable":
      return { what: "its file can't be read (it looks like a scan or a picture of the page)", fix: "Upload a version with text." };
    case "empty":
      return { what: "its Google Doc is empty", fix: "" };
    case "too-many":
      return { what: "too many linked Docs are waiting to be read in at once", fix: "Tick fewer documents, then generate the report again." };
    case "not-linked":
      return { what: "its text is still being read", fix: "Try again in a minute." };
    case "failed":
    default:
      return { what: "Google didn't send its text", fix: "Try again in a minute." };
  }
}

/**
 * The 409 a Coherence run answers when a ticked document couldn't be read: each one named with why and what to
 * do, so the report never quietly leaves out something that was ticked.
 */
export function unreadDocsMessage(docs: UnreadDoc[], audience: "counselor" | "student"): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const d of docs.slice(0, 4)) {
    const { what, fix } = unreadLine(d.reason, audience, d.message);
    const line = `${docName(d)}: ${what}.${fix ? ` ${fix}` : ""}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const extra = docs.length - Math.min(docs.length, 4);
  const more = extra > 0 ? ` ${extra} more ticked ${extra === 1 ? "document" : "documents"} can't be read yet either.` : "";
  const untick = docs.length === 1 ? "Or untick it to run the report without it." : "Or untick them to run the report without them.";
  return `${lines.join(" ")}${more} ${untick}`;
}

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
