/**
 * Contracts drafted in Meridies and the consultant's saved signature (migration 20261129000002; the routes are
 * routes/contractDrafts.ts, the pure model and renderer lib/contractDraft.ts).
 *
 * A draft is a title and an ordered list of sections. The outline is fixed: a text section, a list, the fee text,
 * then clauses only, so the editor and the renderer can rely on it. The signature is personal to a consultant,
 * typed or a drawn PNG: the API reads the image's own bytes (magic, header, size) and computes its SHA-256 itself,
 * never a client's.
 */

import { Buffer } from "node:buffer";
import { z } from "zod";
import type { ContractSection } from "./contractDraft.js";
import { fromPostgrest, HttpError } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

export const contractDraftsUnavailable = () => new HttpError(503, "Contract drafts aren't switched on yet", "contract_drafts_unavailable");

/** A database error as the draft routes answer it: 503 until the migration is in (either table missing), else the usual mapping. */
export const contractDraftError = (e: { code?: string; message?: string } | null): HttpError => (isResultsNotApplied(e) ? contractDraftsUnavailable() : fromPostgrest(e));

/** Unarchived drafts a practice keeps. */
export const CONTRACT_DRAFT_MAX = 100;
const SECTIONS_MAX = 40;
const ITEMS_MAX = 40;
const ITEM_MAX = 500;
const ID_MAX = 64;
/** Title, headings, bodies and list items together. */
const TOTAL_MAX = 50_000;

// A NUL can't be stored in jsonb (Postgres refuses it, which would answer 500), and no other control character belongs
// in a contract. Single-line fields take none (a tab or a line break included); a body keeps its line breaks and tabs.
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const noControls = (re: RegExp, what: string) => [(s: string) => !re.test(s), `${what} can't contain control characters`] as const;
// A lone UTF-16 surrogate (half an emoji) passes JSON but Postgres refuses it (22P02), which would answer 500.
// /\p{Cs}/u matches only an unpaired one (a pair reads as one code point); String.isWellFormed isn't in tsconfig's ES2022 lib.
const wellFormed = (what: string) => [(s: string) => !/\p{Cs}/u.test(s), `${what} has a broken character (half of an emoji or symbol). Remove it and try again`] as const;

const id = z.string().min(1).max(ID_MAX).refine(...wellFormed("A section id"));
const title = z.string().trim().min(1).max(160).refine(...noControls(LINE_CONTROL, "The title")).refine(...wellFormed("The title"));
const heading = z.string().trim().min(1).refine(...noControls(LINE_CONTROL, "A heading")).refine(...wellFormed("A heading"));
const item = z.string().trim().min(1).max(ITEM_MAX).refine(...noControls(LINE_CONTROL, "A list item")).refine(...wellFormed("A list item"));
const body = z
  .string()
  .refine((s) => s.trim().length > 0, "Can't be empty")
  .refine(...noControls(BODY_CONTROL, "A body"))
  .refine(...wellFormed("A body"));
const section = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("text"), heading, body }).strict(),
  z.object({ id, kind: z.literal("list"), heading, items: z.array(item).min(1).max(ITEMS_MAX) }).strict(),
  z.object({ id, kind: z.literal("clause"), heading, body }).strict(),
]);

// Text, list, text, then clauses (the same order the editor draws and the renderer numbers).
const OUTLINE = ["text", "list", "text"] as const;

export const contractDraftBody = z
  .object({ title, sections: z.array(section).max(SECTIONS_MAX) })
  .strict()
  .superRefine((d, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["sections"] });
    if (!OUTLINE.every((kind, i) => d.sections[i]?.kind === kind)) issue("A contract starts with a text section, a list and a text section");
    else if (d.sections.slice(OUTLINE.length).some((s) => s.kind !== "clause")) issue("Every section after the third is a clause");
    if (new Set(d.sections.map((s) => s.id)).size !== d.sections.length) issue("Section ids must be unique");
    const size = d.title.length + d.sections.reduce((n, s) => n + s.heading.length + (s.kind === "list" ? s.items.reduce((m, it) => m + it.length, 0) : s.body.length), 0);
    if (size > TOTAL_MAX) issue(`A contract can be at most ${TOTAL_MAX.toLocaleString("en-US")} characters`);
  });

export const SIGNATURE_MAX_BYTES = 61_440;
const SIGNATURE_MAX_BASE64 = (SIGNATURE_MAX_BYTES / 3) * 4;
const signerName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s), "A name can't hold control characters")
  .refine(...wellFormed("A name"));

export const signatureBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("typed"), signerName }).strict(),
  z.object({ kind: z.literal("drawn"), signerName, imagePngBase64: z.string().min(1).max(SIGNATURE_MAX_BASE64) }).strict(),
]);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/** The size a PNG's own header gives (magic, then a 13-byte IHDR chunk first, the IEND chunk last), 1-1200 wide and 1-400 tall; anything else null. */
export function sniffPng(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 33 + PNG_END.length || !PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  // A whole file ends with the IEND chunk; one cut short, or with anything after it, is not a PNG to keep.
  if (!PNG_END.every((b, i) => bytes[bytes.length - PNG_END.length + i] === b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(8) !== 13 || v.getUint32(12) !== 0x49484452) return null;
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  return width >= 1 && width <= 1200 && height >= 1 && height <= 400 ? { width, height } : null;
}

/** The PNG a drawn signature carries: canonical base64 of at most 60 KB that really is a PNG of a sane size; else null. */
export function decodeSignaturePng(base64: string): Buffer | null {
  const bytes = Buffer.from(base64, "base64");
  return bytes.length > 0 && bytes.length <= SIGNATURE_MAX_BYTES && bytes.toString("base64") === base64 && sniffPng(bytes) ? bytes : null;
}

export type ContractDraftDTO = { id: string; title: string; sections: ContractSection[]; archivedAt: string | null; createdAt: string; updatedAt: string };
export type SignatureDTO = { signerName: string; kind: "typed" | "drawn"; imageDataUrl: string | null; updatedAt: string };

export const toContractDraftDTO = (r: Record<string, unknown>): ContractDraftDTO => ({
  id: String(r.id),
  title: String(r.title),
  sections: (r.sections as ContractSection[] | null) ?? [],
  archivedAt: (r.archived_at as string | null) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/** PostgREST sends a bytea as "\x<hex>". */
const byteaBase64 = (v: unknown): string | null => (typeof v === "string" && v.startsWith("\\x") && v.length > 2 ? Buffer.from(v.slice(2), "hex").toString("base64") : null);

export const toSignatureDTO = (r: Record<string, unknown>): SignatureDTO => {
  const kind = r.kind === "drawn" ? "drawn" : "typed";
  const image = kind === "drawn" ? byteaBase64(r.image_png) : null;
  return { signerName: String(r.signer_name), kind, imageDataUrl: image ? `data:image/png;base64,${image}` : null, updatedAt: String(r.updated_at) };
};

/** The bytea literal PostgREST takes for these bytes. */
export const byteaLiteral = (bytes: Uint8Array): string => `\\x${Buffer.from(bytes).toString("hex")}`;
