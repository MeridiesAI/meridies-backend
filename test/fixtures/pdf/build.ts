/** Minimal, valid PDFs built in memory for the extractor's tests. Object 1 is the catalog. */
export function buildPdf(objects: string[]): Buffer {
  let out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** One text line per page, Helvetica. `extraCatalog` is spliced into the catalog dict. PDF.js drops text past the page edge, so a very long line needs a wide `mediaBox`. */
export function textPdf(pages: string[], opts: { extraCatalog?: string; extraObjects?: string[]; fontDict?: string; mediaBox?: string } = {}): Buffer {
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then per page: page obj + content obj, then extras.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R ${opts.extraCatalog ?? ""} >>`,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`,
    opts.fontDict ?? "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((line, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${esc(line)}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${opts.mediaBox ?? "0 0 612 792"}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  return buildPdf([...objects, ...(opts.extraObjects ?? [])]);
}

/**
 * One page of several lines, Helvetica, each placed with an absolute text matrix 16 pt below the one before.
 * An entry that is an array shows its runs side by side on that one line (separate text items on one baseline),
 * the way a resume made of several styled runs per line does. `textPdf` is one line per page and so can't show this.
 */
export function multiLinePdf(lines: Array<string | string[]>): Buffer {
  const stream = [
    "BT /F1 12 Tf",
    ...lines.flatMap((line, i) =>
      (Array.isArray(line) ? line : [line]).map((run, j) => `1 0 0 1 ${72 + j * 120} ${720 - i * 16} Tm (${esc(run)}) Tj`)
    ),
    "ET",
  ].join("\n");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ]);
}

/** A PDF whose open action is JavaScript that would set a global if it ever ran. */
export function javascriptPdf(): Buffer {
  const jsId = 6; // after catalog, pages, font, one page, one content
  return textPdf(["Has a script"], {
    extraCatalog: `/OpenAction ${jsId} 0 R /Names << /JavaScript << /Names [(m) ${jsId} 0 R] >> >>`,
    extraObjects: ["<< /S /JavaScript /JS (globalThis.__meridiesMarker = 1;) >>"],
  });
}

/** CVE-2024-4367's shape: script smuggled into a font's FontMatrix. */
export function fontMatrixPdf(): Buffer {
  return textPdf(["Crafted font"], {
    fontDict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontMatrix [1 0 0 1 0 (0\\); globalThis.__meridiesMarker = 1; //)] >>",
  });
}
