/**
 * Every passage AxIS shows the model gets a number ([S1], [S2], ...) for this
 * turn. The model cites by number; the answer is checked against the ledger
 * afterwards, so a citation can only point at something that was really read.
 */
import { wrapUntrusted } from "../context/pack.js";
import type { RetrievedChunk, SourceKind } from "./ports.js";

/** One passage's share of the prompt. A longer passage is cut at a sentence. */
export const PASSAGE_CHARS = 2_500;
/** All passages in one turn. Past it, new passages are refused and the tool says so. */
export const TURN_SOURCE_CHARS = 30_000;

export type LedgerSource = {
  id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  documentId: string | null;
  page: number | null;
  updatedAt: string | null;
  /** The text the model saw, kept server-side for the verification pass. */
  text: string;
};

export type Citation = Omit<LedgerSource, "text"> & { excerpt: string };

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+\n/g, "\n").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${stop > max * 0.6 ? cut.slice(0, stop + 1) : cut}…`;
}

export class SourceLedger {
  private byKey = new Map<string, LedgerSource>();
  private byId = new Map<string, LedgerSource>();
  private chars = 0;

  get size(): number {
    return this.byId.size;
  }

  get(id: string): LedgerSource | undefined {
    return this.byId.get(id.toUpperCase());
  }

  all(): LedgerSource[] {
    return [...this.byId.values()];
  }

  /**
   * Adds passages and returns the rendered block for the prompt. A passage
   * already on the ledger keeps its number and is not shown twice; a passage
   * that would pass the turn budget is left out and counted in `skipped`.
   */
  add(chunks: RetrievedChunk[]): { rendered: string; ids: string[]; skipped: number } {
    const lines: string[] = [];
    const ids: string[] = [];
    let skipped = 0;
    for (const c of chunks) {
      const key = `${c.source}:${c.chunkId}`;
      const known = this.byKey.get(key);
      if (known) {
        ids.push(known.id);
        lines.push(`[${known.id}] already shown above.`);
        continue;
      }
      const text = clip(c.text, PASSAGE_CHARS);
      if (!text) continue;
      if (this.chars + text.length > TURN_SOURCE_CHARS) {
        skipped++;
        continue;
      }
      const src: LedgerSource = {
        id: `S${this.byId.size + 1}`,
        kind: c.source,
        title: c.title.slice(0, 200) || "Untitled",
        url: c.url ?? null,
        documentId: c.documentId,
        page: c.page ?? null,
        updatedAt: c.updatedAt ?? null,
        text,
      };
      this.chars += text.length;
      this.byKey.set(key, src);
      this.byId.set(src.id, src);
      ids.push(src.id);
      lines.push(renderSource(src));
    }
    return { rendered: lines.join("\n\n"), ids, skipped };
  }
}

/** The id and kind are ours (trusted); the title and the text are not, so both stay inside the data block. */
export function renderSource(s: LedgerSource): string {
  const where = [s.page ? `page ${s.page}` : null, s.updatedAt ? `updated ${s.updatedAt.slice(0, 10)}` : null]
    .filter(Boolean)
    .join(", ");
  return `[${s.id}] (${s.kind}${where ? `, ${where}` : ""})\n${wrapUntrusted(`title: ${s.title}`, s.text)}`;
}

const CITE = /\[(S\d{1,3})\]/gi;

/** The answer's citations that resolve, in first-cited order, and the ones that don't. */
export function resolveCitations(text: string, ledger: SourceLedger): { citations: Citation[]; invalid: string[] } {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  const invalid = new Set<string>();
  for (const m of text.matchAll(CITE)) {
    const id = m[1]!.toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const src = ledger.get(id);
    if (!src) {
      invalid.add(id);
      continue;
    }
    const { text: full, ...rest } = src;
    citations.push({ ...rest, excerpt: clip(full, 280) });
  }
  return { citations, invalid: [...invalid] };
}

/** What is stored: the answer with citations that point at nothing removed. */
export function dropInvalidCitations(text: string, invalid: string[]): string {
  if (!invalid.length) return text;
  const bad = new Set(invalid);
  return text.replace(CITE, (whole, id: string) => (bad.has(id.toUpperCase()) ? "" : whole)).replace(/ {2,}/g, " ");
}

/** Old turns cite an old ledger; their markers would mislead the next turn, so history drops them. */
export function stripCitations(text: string): string {
  return text.replace(CITE, "").replace(/ {2,}/g, " ").trim();
}
