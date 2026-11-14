/**
 * The practice's invoice look (practice_invoice_style): a curated set, not free CSS (pure; no I/O).
 *
 * Email clients drop web fonts, so the font menu is six email-safe stacks; the pay page uses the same
 * ones. A sent invoice keeps the look it went out with (`pipeline_invoices.style_snapshot`).
 */

import { z } from "zod";

export const FONT_KEYS = ["serif", "sans", "modern", "classic", "humanist", "mono"] as const;
export type FontKey = (typeof FONT_KEYS)[number];

export const FONTS: Record<FontKey, { label: string; stack: string }> = {
  serif: { label: "Serif (Georgia)", stack: "Georgia,'Times New Roman',serif" },
  sans: { label: "Sans (Helvetica)", stack: "Helvetica,Arial,sans-serif" },
  modern: { label: "Modern (Trebuchet)", stack: "'Trebuchet MS',Helvetica,Arial,sans-serif" },
  classic: { label: "Classic (Palatino)", stack: "Palatino,'Palatino Linotype','Book Antiqua',Georgia,serif" },
  humanist: { label: "Humanist (Verdana)", stack: "Verdana,Geneva,sans-serif" },
  mono: { label: "Mono (Courier)", stack: "'Courier New',Courier,monospace" },
};

export const HEADER_ALIGNS = ["left", "center"] as const;
export const CORNERS = ["square", "rounded", "pill"] as const;
export const CORNER_RADIUS: Record<(typeof CORNERS)[number], { button: number; card: number }> = {
  square: { button: 0, card: 0 },
  rounded: { button: 10, card: 14 },
  pill: { button: 999, card: 20 },
};

export type InvoiceStyle = {
  /** #RRGGBB; null = the practice's own branding accent. */
  accentColor: string | null;
  fontKey: FontKey;
  headerAlign: (typeof HEADER_ALIGNS)[number];
  corner: (typeof CORNERS)[number];
  buttonLabel: string;
  footerText: string;
  showLogo: boolean;
};

export const DEFAULT_STYLE: InvoiceStyle = {
  accentColor: null,
  fontKey: "serif",
  headerAlign: "left",
  corner: "rounded",
  buttonLabel: "Pay by card",
  footerText: "",
  showLogo: true,
};

const hex = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, "Use a #RRGGBB colour");
export const styleFields = {
  accentColor: hex.nullable(),
  fontKey: z.enum(FONT_KEYS),
  headerAlign: z.enum(HEADER_ALIGNS),
  corner: z.enum(CORNERS),
  buttonLabel: z.string().trim().min(1).max(40),
  footerText: z.string().trim().max(300),
  showLogo: z.boolean(),
};

type Row = Record<string, unknown>;
/** A stored row (or none) as the style, defaults filling what isn't there. */
export function toStyle(r: Row | null | undefined): InvoiceStyle {
  if (!r) return { ...DEFAULT_STYLE };
  return {
    accentColor: typeof r.accent_color === "string" ? r.accent_color : null,
    fontKey: (FONT_KEYS as readonly string[]).includes(String(r.font_key)) ? (r.font_key as FontKey) : DEFAULT_STYLE.fontKey,
    headerAlign: r.header_align === "center" ? "center" : "left",
    corner: (CORNERS as readonly string[]).includes(String(r.corner)) ? (r.corner as InvoiceStyle["corner"]) : DEFAULT_STYLE.corner,
    buttonLabel: String(r.button_label ?? "").trim() || DEFAULT_STYLE.buttonLabel,
    footerText: String(r.footer_text ?? ""),
    showLogo: r.show_logo !== false,
  };
}

/** The columns a style writes. */
export const styleColumns = (s: Partial<InvoiceStyle>): Record<string, unknown> => ({
  ...(s.accentColor !== undefined ? { accent_color: s.accentColor } : {}),
  ...(s.fontKey !== undefined ? { font_key: s.fontKey } : {}),
  ...(s.headerAlign !== undefined ? { header_align: s.headerAlign } : {}),
  ...(s.corner !== undefined ? { corner: s.corner } : {}),
  ...(s.buttonLabel !== undefined ? { button_label: s.buttonLabel } : {}),
  ...(s.footerText !== undefined ? { footer_text: s.footerText } : {}),
  ...(s.showLogo !== undefined ? { show_logo: s.showLogo } : {}),
});

/** What is stored on the invoice at send: the style as the family saw it. Read back with `styleFromSnapshot`. */
export const snapshotOf = (s: InvoiceStyle): Record<string, unknown> => ({ ...s });

/** A stored snapshot, validated; null when there is none or it isn't a style (the invoice then uses the default look). */
export function styleFromSnapshot(v: unknown): InvoiceStyle | null {
  if (!v || typeof v !== "object") return null;
  const r = z.object(styleFields).strict().safeParse(v);
  return r.success ? r.data : null;
}
