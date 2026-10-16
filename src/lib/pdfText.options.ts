/**
 * Options for every PDF.js load (lib/pdfText.extract.ts). isEvalSupported false is the
 * CVE-2024-4367 guard (this build has no eval path at all; the flag keeps it that way if a
 * later version brings one back). Scripting stays off, as PDF.js defaults.
 */
export const PDFJS_OPTIONS = {
  isEvalSupported: false,
  enableScripting: false,
  disableFontFace: true,
  useSystemFonts: false,
} as const;
