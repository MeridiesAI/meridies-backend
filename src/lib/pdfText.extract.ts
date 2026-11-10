import { getResolvedPDFJS } from "unpdf";
import { PDFJS_OPTIONS } from "./pdfText.options.js";

type GetDocument = (params: { data: Uint8Array } & typeof PDFJS_OPTIONS) => ReturnType<Awaited<ReturnType<typeof getResolvedPDFJS>>["getDocument"]>;

/** The parts of a PDF.js text item this file reads. Marked-content entries have none of them. */
type TextPiece = { str?: unknown; hasEOL?: boolean; height?: number; transform?: number[] };

const baselineOf = (it: TextPiece): number | null => (Array.isArray(it.transform) && typeof it.transform[5] === "number" ? it.transform[5] : null);
const heightOf = (it: TextPiece): number => (typeof it.height === "number" && it.height > 0 ? it.height : Array.isArray(it.transform) ? Math.abs(it.transform[3] ?? 0) : 0);

/**
 * One page's text with its line breaks. PDF.js hands back text runs, not lines: `hasEOL` marks the end of one, and
 * a run on a different baseline starts one even where `hasEOL` is missing (more than half a line's height away, so
 * a superscript stays on its line). Runs on one line are joined by a single space. Always ends in one newline.
 * Joining every run with a space, as this used to, turned a whole resume into one line.
 */
export function pageTextFromItems(items: ReadonlyArray<object>): string {
  let out = "";
  let prev: TextPiece | null = null;
  const endLine = () => {
    if (out !== "" && !out.endsWith("\n")) out = out.replace(/[ \t]+$/, "") + "\n";
  };
  for (const raw of items) {
    const it = raw as TextPiece;
    if (typeof it.str !== "string") continue; // marked content, not text
    if (prev && !prev.hasEOL && it.str.trim() !== "") {
      const a = baselineOf(prev);
      const b = baselineOf(it);
      if (a !== null && b !== null && Math.abs(a - b) > 0.5 * Math.max(heightOf(prev), heightOf(it), 1)) endLine();
    }
    let s = it.str;
    if (out === "" || out.endsWith("\n") || /[ \t]$/.test(out)) s = s.replace(/^[ \t]+/, "");
    else if (!/^[ \t]/.test(s)) out += " ";
    out += s;
    if (s.trim() !== "") prev = it;
    if (it.hasEOL) endLine();
  }
  return out.replace(/\s+$/, "") + "\n";
}

/** Text of the first `maxPages` pages, cut at `maxChars`. Runs in whatever thread calls it: the pool calls it inside a worker. */
export async function extractInThisThread(bytes: Uint8Array, maxPages: number, maxChars: number, getDocumentOverride?: GetDocument): Promise<{ text: string; pages: number }> {
  const getDocument: GetDocument = getDocumentOverride ?? (await getResolvedPDFJS()).getDocument;
  // PDF.js refuses a Buffer (a Uint8Array subclass); hand it a plain view of the same bytes.
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // destroy() lives on the loading task in PDF.js 6, not on the document proxy.
  const task = getDocument({ data, ...PDFJS_OPTIONS });
  try {
    const pdf = await task.promise;
    const pages = Math.min(pdf.numPages, maxPages);
    let text = "";
    for (let i = 1; i <= pages && text.length < maxChars; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += pageTextFromItems(content.items);
      page.cleanup();
    }
    return { text: text.slice(0, maxChars), pages };
  } finally {
    await task.destroy();
  }
}
