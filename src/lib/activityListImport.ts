/**
 * An activity list in a student's Files, offered to the Activities sheet (`POST
 * /application/activities/from-document`). It proposes rows and stores nothing: a person adds each one they
 * confirm through the sheet's own routes (the counselor's Application page) or `POST /profile-updates/file` (the
 * student's Profile Updates), the same proposal pattern as a Profile Update from a document.
 *
 * A spreadsheet (.xlsx, .csv) with the Common App's columns is read here, without a model: its header row names
 * the columns ("Activity type", "Position", "Organization", "Description", "Grades", "Hours per week", "Weeks per
 * year", and the usual variants), and every row becomes a proposal checked by `parseDraft` like any chat turn. Any
 * other file (PDF, Word, a photo) goes to AxIS through `proposalsFromDocument`, under its usual gates.
 */

import type { FastifyRequest } from "fastify";
import { hasAnthropic } from "../env.js";
import { SENSITIVE_DOCUMENT_KINDS } from "./context/documentAi.js";
import { extractorFor } from "./documentExtraction.js";
import { badRequest, fromPostgrest, HttpError, notFound } from "./errors.js";
import { parseInWorker } from "./imports/parse.js";
import { proposalsFromDocument } from "./profileUpdateDocument.js";
import { ACTIVITY_TYPES, missingFields, parseDraft, summaryOf, type Proposal } from "./profileUpdates.js";
import { downloadCapped } from "./storageDownload.js";
import { DOCUMENTS_BUCKET, isDocumentsBucket, isSafeStoragePathShape } from "./storagePath.js";
import { MAX_REVIEW_BYTES } from "./submissionReview.js";

type Row = Record<string, unknown>;

/** The sheet holds 30 rows; a list longer than that is offered up to the cap. */
const MAX_ROWS = 30;

type Field = "category" | "position" | "organization" | "description" | "grades" | "hours" | "weeks";

const HEADERS: [Field, RegExp][] = [
  ["category", /^(?:activity\s*)?(?:type|category)$/],
  ["position", /^(?:position(?:\s*\/\s*leadership)?(?:\s*description)?|role|leadership(?:\s*role)?|title|position\s*\/\s*role)$/],
  ["organization", /^(?:organi[sz]ation(?:\s*name)?|org(?:\s*name)?|activity(?:\s*name)?|club(?:\s*\/\s*team)?|team|name)$/],
  ["description", /^(?:(?:activity\s*)?description|details|what\s+(?:i|you)\s+did|accomplishments|description\s*(?:\/|and|&)\s*accomplishments)$/],
  ["grades", /^(?:(?:participation\s*)?grades?(?:\s*levels?)?|years?|grades?\s*participated)$/],
  ["hours", /^(?:hours?|hrs?)\s*(?:per|\/|a)\s*(?:week|wk)$/],
  ["weeks", /^(?:weeks?|wks?)\s*(?:per|\/|a)\s*(?:year|yr)$/],
];

const norm = (s: string) =>
  s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[:*#.]/g, " ").replace(/\s+/g, " ").trim();

/** Which column holds which field; null unless it names an organization or a position and one more field. */
export function mapHeaders(headers: string[]): Partial<Record<Field, number>> | null {
  const map: Partial<Record<Field, number>> = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    const hit = HEADERS.find(([, re]) => re.test(n));
    if (hit && map[hit[0]] === undefined) map[hit[0]] = i;
  });
  const named = map.organization !== undefined || map.position !== undefined;
  return named && Object.keys(map).length >= 2 ? map : null;
}

const TYPE_WORDS: [RegExp, (typeof ACTIVITY_TYPES)[number]][] = [
  [/volunteer|community service|service/, "Community Service (Volunteer)"],
  [/varsity|jv/, "Athletics: JV/Varsity"],
  [/club sport|athletic|sport/, "Athletics: Club"],
  [/\bjob\b|work|paid|employ/, "Work (paid)"],
  [/student gov|politic|council/, "Student Govt./Politics"],
  [/debate|speech|model un/, "Debate/Speech"],
  [/theat|drama/, "Theater/Drama"],
  [/choir|vocal|sing/, "Music: Vocal"],
  [/band|orchestra|instrument|music/, "Music: Instrumental"],
  [/journal|newspaper|yearbook|publication/, "Journalism/Publication"],
  [/computer|coding|technology|programming/, "Computer/Technology"],
  [/math|science/, "Science/Math"],
];

/** "Robotics" → "Robotics", "community service" → "Community Service (Volunteer)"; null when it can't tell. */
export function activityType(value: string): (typeof ACTIVITY_TYPES)[number] | null {
  const v = norm(value);
  if (!v) return null;
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = ACTIVITY_TYPES.find((t) => key(t) === key(value));
  if (exact) return exact;
  const prefix = ACTIVITY_TYPES.find((t) => norm(t).startsWith(v) || v.startsWith(norm(t).split(/[ :(/]/)[0]!) && v.length >= 4);
  if (prefix && ACTIVITY_TYPES.filter((t) => norm(t).startsWith(v)).length <= 1) return prefix;
  return TYPE_WORDS.find(([re]) => re.test(v))?.[1] ?? null;
}

/** "10, 11, 12", "10-12", "9th–12th", "Grades 9 and 10", "PG": the sheet's grade values, in order. */
export function gradeList(value: string): string[] {
  const v = value.replace(/(\d+)(?:st|nd|rd|th)\b/gi, "$1");
  const out = new Set<string>();
  for (const m of v.matchAll(/\b(9|10|11|12)\s*(?:-|–|—|to|through)\s*(9|10|11|12)\b/gi)) {
    for (let g = Number(m[1]); g <= Number(m[2]); g++) out.add(String(g));
  }
  for (const m of v.matchAll(/\b(9|10|11|12)\b/g)) out.add(m[1]!);
  if (/\bpg\b|post[-\s]?grad/i.test(v)) out.add("PG");
  return ["9", "10", "11", "12", "PG"].filter((g) => out.has(g));
}

/** A spreadsheet's rows as proposals; [] when no sheet has an activity header row. */
export function sheetProposals(sheets: { headers: string[]; rows: string[][] }[]): Proposal[] {
  for (const sheet of sheets) {
    // The header is usually the first row; a title row above it ("Jordan's activities") is skipped.
    const candidates = [sheet.headers, ...sheet.rows.slice(0, 4)];
    const at = candidates.findIndex((r) => mapHeaders(r) !== null);
    if (at < 0) continue;
    const map = mapHeaders(candidates[at]!)!;
    const body = at === 0 ? sheet.rows : sheet.rows.slice(at);
    const out: Proposal[] = [];
    const seen = new Set<string>();
    for (const row of body) {
      const cell = (f: Field) => (map[f] === undefined ? "" : String(row[map[f]!] ?? "").trim());
      if (!cell("organization") && !cell("position")) continue;
      const draft = parseDraft({
        kind: "activity",
        category: activityType(cell("category")),
        position: cell("position"),
        organization: cell("organization"),
        description: cell("description"),
        gradeLevels: gradeList(cell("grades")),
        hoursPerWeek: cell("hours").replace(/[^\d.]/g, ""),
        weeksPerYear: cell("weeks").replace(/[^\d.]/g, ""),
      });
      const key = summaryOf(draft).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ draft, missing: missingFields(draft) });
      if (out.length >= MAX_ROWS) break;
    }
    if (out.length > 0) return out;
  }
  return [];
}

export type ActivityProposal = Proposal & { onSheet: boolean };

const same = (a: unknown, b: unknown) =>
  String(a ?? "").toLowerCase().replace(/\s+/g, " ").trim() === String(b ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Mark proposals the sheet already has: the same organization, and the same position or none stated. */
export function markOnSheet(proposals: Proposal[], existing: Row[], honors: Row[] = []): ActivityProposal[] {
  return proposals.map((p) => {
    const d = p.draft;
    const onSheet =
      d.kind === "honor"
        ? honors.some((h) => same(h.name, d.title))
        : existing.some((r) => same(r.organization ?? r.name, d.organization) && (!d.position || !r.position || same(r.position, d.position)));
    return { ...p, onSheet };
  });
}

/**
 * Proposals from one of the student's files. The caller has already shown it can edit `studentId`. The file is
 * read on the caller's own client: a documents-bucket object of a safe path, at most 10 MB, never a sensitive kind.
 */
export async function activityProposalsFromDocument(
  request: FastifyRequest,
  studentId: string,
  documentId: string
): Promise<{ filename: string; read: "sheet" | "ai"; proposals: ActivityProposal[] }> {
  const { data: doc, error } = await request.db.from("documents").select("*").eq("id", documentId).maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!doc || doc.student_id !== studentId) throw notFound("That file isn't in this student's documents");
  if ((SENSITIVE_DOCUMENT_KINDS as readonly string[]).includes(String(doc.kind))) {
    throw badRequest("That file is a kind Meridies doesn't read for activities.");
  }
  const filename = String(doc.filename ?? "file");
  const mime = (doc.mime_type as string | null) ?? null;

  const [acts, hons] = await Promise.all([
    request.db.from("activities").select("organization, name, position").eq("student_id", studentId).limit(100),
    request.db.from("awards").select("name").eq("student_id", studentId).limit(100),
  ]);
  if (acts.error) throw fromPostgrest(acts.error);
  if (hons.error) throw fromPostgrest(hons.error);

  if (extractorFor(mime, filename) === "sheet") {
    if (!doc.storage_path || !isDocumentsBucket(doc.bucket) || !isSafeStoragePathShape(String(doc.storage_path))) {
      throw badRequest("Meridies couldn't open that file.");
    }
    const dl = await downloadCapped(request.db, DOCUMENTS_BUCKET, String(doc.storage_path), MAX_REVIEW_BYTES);
    if (dl.status === "too-large") throw badRequest("That file is too large to read (10 MB at most).");
    if (dl.status === "error") throw badRequest("Meridies couldn't open that file.");
    const parsed = await parseInWorker(new Uint8Array(dl.bytes.buffer, dl.bytes.byteOffset, dl.bytes.byteLength), filename, { maxRows: 200 });
    if (!parsed.ok) throw badRequest("Meridies couldn't read that spreadsheet.");
    const found = sheetProposals(parsed.sheets);
    if (found.length > 0) return { filename, read: "sheet", proposals: markOnSheet(found, (acts.data ?? []) as Row[]) };
    // A spreadsheet without the usual columns: AxIS can still read it, below.
  }

  if (!hasAnthropic) throw new HttpError(503, "Reading this kind of file for activities isn't switched on yet", "activity_import_unavailable");
  const proposals = await proposalsFromDocument(request, documentId, studentId);
  return { filename, read: "ai", proposals: markOnSheet(proposals, (acts.data ?? []) as Row[], (hons.data ?? []) as Row[]) };
}
