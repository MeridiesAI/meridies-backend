/**
 * Student Forums (migration 20261201000001; routes/forums.ts): the rows as the API reads them and the one DTO every
 * route returns. The rules a post lives by are `lib/forumPosts.ts` (a byte copy of the demo's; never edit it here).
 *
 * A DTO never carries an author, reviewer or reporter id: `mine` says whether the caller wrote it, and the counselor's
 * note and the report time go only to someone who may see them (the author, the assigned counselor).
 */

import type { PostgrestError } from "@supabase/supabase-js";
import { HttpError, fromPostgrest } from "./errors.js";
import type { DraftResult, ForumKind, ForumPost, ForumStatus } from "./forumPosts.js";
import { firstNameOf } from "./inactivity.js";

export type ForumRow = {
  id: string;
  student_id: string;
  college_id: string;
  kind: ForumKind;
  title: string;
  body: string;
  url: string | null;
  status: ForumStatus;
  review_note: string | null;
  reported_at: string | null;
  author_first: string;
  author_year: string | null;
  created_at: string;
  updated_at: string;
  college: { id: string; slug: string; name: string };
};

export type ForumPostDto = {
  id: string;
  kind: ForumKind;
  title: string;
  body: string;
  url: string | null;
  status: ForumStatus;
  college: { id: string; slug: string; name: string };
  authorFirst: string;
  authorYear: string | null;
  mine: boolean;
  reviewNote: string | null;
  reportedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Never `reviewed_by` or `reported_by`: no client is told who reviewed or reported a post. */
export const FORUM_COLUMNS =
  "id, student_id, college_id, kind, title, body, url, status, review_note, reported_at, author_first, author_year, created_at, updated_at, college:colleges(id, slug, name)";

export const forumsUnavailable = () => new HttpError(503, "Forums isn't switched on yet", "forums_unavailable");

// A table, column or embed this build reads that isn't there yet: the migration isn't applied.
const MISSING = new Set(["42P01", "42703", "PGRST200", "PGRST202", "PGRST204", "PGRST205"]);
export const forumErr = (e: Pick<PostgrestError, "code" | "message"> | null): HttpError =>
  e?.code && MISSING.has(e.code) ? forumsUnavailable() : fromPostgrest(e);

export function rowToPost(row: ForumRow): ForumPost {
  return {
    id: row.id,
    authorId: row.student_id,
    authorFirst: row.author_first,
    authorYear: row.author_year,
    inCaseload: true,
    collegeId: row.college_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reportedAt: row.reported_at,
  };
}

export function toDto(row: ForumRow, viewerId: string, opts: { seesPrivate: boolean }): ForumPostDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    status: row.status,
    college: { id: row.college.id, slug: row.college.slug, name: row.college.name },
    authorFirst: row.author_first,
    authorYear: row.author_year,
    mine: row.student_id === viewerId,
    reviewNote: opts.seesPrivate ? row.review_note : null,
    reportedAt: opts.seesPrivate ? row.reported_at : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The byline stored on the row at create and edit: a first name (40 characters) and a four-digit class year. */
export function authorSnapshot(p: { full_name: string | null; grad_year: string | null }): { author_first: string; author_year: string | null } {
  // firstNameOf's own fallback is "Your student", which reads wrong to another student.
  return { author_first: p.full_name?.trim() ? firstNameOf(p.full_name) : "A student", author_year: p.grad_year && /^\d{4}$/.test(p.grad_year) ? p.grad_year : null };
}

export const draftError = (r: Extract<DraftResult, { ok: false }>): HttpError => new HttpError(400, r.message, `forum_${r.field}`);
