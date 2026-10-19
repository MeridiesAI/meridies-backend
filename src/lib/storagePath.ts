/**
 * The one shape a `documents` row may point at in Storage.
 *
 * Every uploaded file lives in the private `student-documents` bucket under
 * `<first>/<rest>`, where <first> is what the uploader filed into (a student
 * id, a folder id, their own id) or `unfiled`; the bucket's insert policy
 * (20261011000001) decides the same. A client registers the row after the
 * upload and names the path itself, so the path is client-supplied data and
 * is checked here before it is stored and again before anything downloads it.
 *
 * What is refused, and why:
 *   - any other bucket: imports, AxIS attachments and banners have their own
 *     rules and are never a document;
 *   - a leading or trailing "/", an empty segment, "." or "..": storage-js
 *     strips leading slashes and the request URL resolves dot segments, so
 *     "/x" or "a/../x" is a different row that reaches the object "x";
 *   - "?", "#", a backslash, control characters and a percent-encoded dot,
 *     slash or backslash: each can make the request URL name another object.
 */

export const DOCUMENTS_BUCKET = "student-documents";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const MAX_STORAGE_PATH = 500;

/** The path's shape alone, whatever its first segment: what a download checks before it follows a row. */
export function isSafeStoragePathShape(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > MAX_STORAGE_PATH) return false;
  if (path !== path.trim()) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\?#]/.test(path)) return false;
  if (/%(2e|2f|5c)/i.test(path)) return false;
  const segments = path.split("/");
  if (segments.length < 2) return false;
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

/**
 * A path an authenticated user could have uploaded: the shape above, and a
 * first segment that is a uuid or `unfiled`, as the bucket's insert policy
 * requires. The API refuses anything else at registration, and the database
 * refuses it from a client (private.document_storage_path_ok, 20261024000041).
 */
export function isSafeStoragePath(path: unknown): path is string {
  if (!isSafeStoragePathShape(path)) return false;
  const first = path.split("/")[0]!;
  return first === "unfiled" || UUID.test(first);
}

/** The bucket a row may name: only the documents bucket (null/undefined means it). */
export function isDocumentsBucket(bucket: unknown): boolean {
  return bucket === undefined || bucket === null || bucket === DOCUMENTS_BUCKET;
}

/**
 * Files a browser runs script from when it renders them: SVG and HTML/XHTML. The documents bucket
 * has no type allowlist (task attachments, the Colleges tab and Drive imports take any type, so a
 * bucket list would refuse files uploaded today), so registration refuses these instead: a
 * student's crafted SVG never reaches a counselor's file list, the viewer or a signed link.
 * Decided on the declared type and on the name, since either is what a viewer goes by.
 */
const ACTIVE_TYPES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml"]);
const ACTIVE_EXTENSIONS = /\.(svgz?|html?|xht(ml)?)$/i;

export function isActiveContentFile(filename: string, mimeType: string | null | undefined): boolean {
  const type = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  return ACTIVE_TYPES.has(type) || ACTIVE_EXTENSIONS.test(filename.trim());
}
