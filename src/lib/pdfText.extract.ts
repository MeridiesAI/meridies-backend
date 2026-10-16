import { getResolvedPDFJS } from "unpdf";
import { PDFJS_OPTIONS } from "./pdfText.options.js";

/** Text of the first `maxPages` pages, cut at `maxChars`. Runs in whatever thread calls it: the pool calls it inside a worker. */
export async function extractInThisThread(bytes: Uint8Array, maxPages: number, maxChars: number): Promise<{ text: string; pages: number }> {
  const { getDocument } = await getResolvedPDFJS();
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
      text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
      page.cleanup();
    }
    return { text: text.slice(0, maxChars), pages };
  } finally {
    await task.destroy();
  }
}
