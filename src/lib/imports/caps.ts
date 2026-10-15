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

/** A header row is the first row with two or more cells, within these rows. */
export const HEADER_SEARCH_ROWS = 20;
export const MAX_COLUMNS = 300;

export const AI_CAP_CENTS = 200;
export const DRAFT_DAYS = 7;

/** Changes one row of a file may produce (a long-format file merges rows). */
export const MAX_CHANGES_PER_ITEM = 400;
export const MAX_CHANGES = 200_000;
