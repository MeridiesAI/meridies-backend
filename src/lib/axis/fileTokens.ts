/**
 * What files sent as content blocks cost in prompt tokens, as an estimate: text by length, an image flat, a PDF by
 * its pages. Used by the history budget (lib/axis/engine.ts) and the AI budget's prompt estimate (lib/aiBudget.ts).
 * Its own module so the budget gate can use it without importing the AxIS files code.
 */
import type Anthropic from "@anthropic-ai/sdk";

const PDF_PAGE_TOKENS = 2_500;
const PDF_MAX_PAGES_COUNTED = 100;
const IMAGE_TOKENS = 1_600;
const isNameChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isPdfSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0;

/** Pages in a PDF's bytes: "/Type /Page" markers (never "/Pages"), one linear scan, at most PDF_MAX_PAGES_COUNTED. */
function pdfPages(bytes: Buffer): number {
  const s = bytes.toString("latin1");
  let pages = 0;
  for (let at = s.indexOf("/Type"); at !== -1 && pages < PDF_MAX_PAGES_COUNTED; at = s.indexOf("/Type", at + 5)) {
    let i = at + 5;
    while (i < s.length && isPdfSpace(s.charCodeAt(i))) i++;
    if (s.startsWith("/Page", i) && !isNameChar(s.charCodeAt(i + 5))) pages++;
  }
  return pages;
}

/** An estimate of what files sent as files cost in prompt tokens: text by length, an image flat, a PDF by its pages. */
export function fileTokens(blocks: Anthropic.Messages.ContentBlockParam[]): number {
  let total = 0;
  for (const b of blocks) {
    if (b.type === "text") total += Math.ceil(b.text.length / 3);
    else if (b.type === "image") total += IMAGE_TOKENS;
    else if (b.type === "document" && b.source.type === "text") total += Math.ceil(b.source.data.length / 3);
    else if (b.type === "document" && b.source.type === "base64") {
      const bytes = Buffer.from(b.source.data, "base64");
      const pages = pdfPages(bytes);
      total += pages > 0 ? pages * PDF_PAGE_TOKENS : Math.ceil(bytes.length / 40);
    }
  }
  return total;
}

