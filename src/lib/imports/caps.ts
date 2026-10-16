/**
 * The import pipeline's limits (spec §5.1, §5.3, §7.3), in one place.
 * The SQL functions repeat the ones the database must hold on its own
 * (20 files, 5,000 rows); keep both in step.
 */

export const MAX_FILES = 20;
export const MAX_ROWS = 5000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Zip bomb guard: declared sizes in the central directory. */
export const MAX_UNCOMPRESSED_TOTAL = 100 * 1024 * 1024;
export const MAX_UNCOMPRESSED_ENTRY = 50 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 2000;

/** The parse worker's backstops for anything the size checks miss. */
export const PARSE_TIMEOUT_MS = 20_000;
export const WORKER_HEAP_MB = 256;

/**
 * Limits on what a parse may hand back, not only on what goes in. A tiny
 * XLSX can point thousands of cells at one shared string: the child holds
 * one string, but its answer would carry a copy per cell. So the child
 * counts characters before it answers, and the parent stops reading (and
 * kills the child) past the byte budget whatever the child says.
 *
 * - MAX_CELL_CHARS: Excel's own limit on a cell; no import field needs more.
 * - MAX_PARSED_CHARS: headers and cells of every file in one import, in all
 *   (5,000 rows of 50 columns at 32 characters a cell). Registration and
 *   staging both hand each file what is left of it.
 * - MAX_PARSE_OUTPUT_BYTES: the answer as JSON on its pipe.
 */
export const MAX_CELL_CHARS = 32_767;
export const MAX_PARSED_CHARS = 8_000_000;
export const MAX_PARSE_OUTPUT_BYTES = 32 * 1024 * 1024;

/** A header row is the first row with two or more cells, within these rows. */
export const HEADER_SEARCH_ROWS = 20;
export const MAX_COLUMNS = 300;
/**
 * A header's text is cut to this many characters when the sheet is read. A
 * real header is a few words; the cap bounds every header check (the
 * sensitive-category rules, the presets, the mask) on the main thread, after
 * the parse child's timeout no longer applies.
 */
export const MAX_HEADER_CHARS = 500;

export const AI_CAP_CENTS = 200;
export const DRAFT_DAYS = 7;

/** Changes one row of a file may produce (a long-format file merges rows). */
export const MAX_CHANGES_PER_ITEM = 400;
export const MAX_CHANGES = 200_000;
