/**
 * Contracts (migration 20261124000005): PDF and DOCX files the practice keeps in a library and attaches to an
 * invoice (pure parts here; the routes are routes/contracts.ts).
 *
 * The files live in the private `contracts` bucket under `<practice id>/<uuid>.<pdf|docx>`; the API names every
 * object and signs the upload URL, and reads a file back before saving it (size, real type by its bytes, and
 * the SHA-256 that goes into the agreement's text). Attaching one makes a regular agreement bound to the file
 * (the database's guard writes its text, "Contract file: <name> / File SHA-256: <hash>"), so the family's
 * typed-name acceptance is bound to those exact bytes.
 */

import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { z } from "zod";
import { HttpError } from "./errors.js";

export const CONTRACT_BUCKET = "contracts";
export const CONTRACT_MAX_BYTES = 10 * 1024 * 1024;
/** A PDF at most this big also goes as an attachment on the invoice email. */
export const CONTRACT_ATTACH_MAX_BYTES = 5 * 1024 * 1024;
export const CONTRACT_UPLOAD_EXPIRES_IN = 7200;
/** Registered (unarchived) contracts a practice keeps. */
export const CONTRACT_LIBRARY_MAX = 100;

export const CONTRACT_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
} as const;
export type ContractType = keyof typeof CONTRACT_TYPES;
const TYPE_OF_EXT: Record<string, ContractType> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const contractsUnavailable = () => new HttpError(503, "Contracts aren't switched on yet", "contracts_unavailable");

export const contractUploadBody = z
  .object({
    contentType: z.enum(Object.keys(CONTRACT_TYPES) as [ContractType, ...ContractType[]]),
    sizeBytes: z.number().int().positive().max(CONTRACT_MAX_BYTES, "A contract can be at most 10 MB"),
  })
  .strict();

export const contractRegisterBody = z
  .object({ path: z.string().min(1).max(200), name: z.string().trim().min(1).max(160) })
  .strict();

export const contractObjectPath = (practiceId: string, contentType: ContractType) => `${practiceId}/${randomUUID()}.${CONTRACT_TYPES[contentType]}`;

const OBJECT_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx)$/;

/** The path's type when it is exactly an object the API could have named in this practice's folder; else null. */
export function ownContractPath(path: unknown, practiceId: string): ContractType | null {
  if (typeof path !== "string") return null;
  const m = OBJECT_PATH.exec(path);
  return m && m[1] === practiceId ? (TYPE_OF_EXT[m[2]!] ?? null) : null;
}

/** The type the bytes really are: a PDF starts "%PDF-"; a DOCX is a zip holding word/document.xml. Anything else null. */
export function sniffContract(bytes: Uint8Array): ContractType | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    try {
      // Only the one entry is inflated, and only when it isn't absurd (a zip bomb).
      const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" && f.originalSize <= 20 * 1024 * 1024 });
      if (files["word/document.xml"]) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } catch {
      return null;
    }
  }
  return null;
}

export const sha256OfBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type ContractDTO = {
  id: string;
  name: string;
  mime: ContractType;
  sizeBytes: number;
  sha256: string;
  archivedAt: string | null;
  createdAt: string;
};
type Row = Record<string, unknown>;
export const toContractDTO = (r: Row): ContractDTO => ({
  id: String(r.id),
  name: String(r.name),
  mime: String(r.mime) as ContractType,
  sizeBytes: Number(r.size_bytes),
  sha256: String(r.sha256),
  archivedAt: (r.archived_at as string | null) ?? null,
  createdAt: String(r.created_at),
});

/** The file name an invoice email attaches: the contract's name, with its extension. */
export const attachmentName = (name: string, mime: ContractType): string => {
  const ext = CONTRACT_TYPES[mime];
  const clean = name.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 100) || "Contract";
  return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
};
