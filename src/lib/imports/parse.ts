/**
 * Parse a file in a separate process (spec §5.2, §7.3): a heap cap, a
 * wall-clock timeout, and the zip and XML checks inside. A breach kills the
 * process; the file fails with a message, the rest of the import continues.
 *
 * A process, not a worker thread: a worker's resourceLimits are silently
 * overridden by a process-wide --max-old-space-size (NODE_OPTIONS, which
 * hosts commonly set), so the cap would be a promise rather than a limit.
 * The child gets its own --max-old-space-size, an environment holding only
 * PATH (no keys, no NODE_OPTIONS), no stdin, and the parent never prints
 * what it writes.
 *
 * The heap flag protects the child, not this process. So the file goes in
 * over IPC, but the answer comes back as JSON on a pipe (fd 3) whose bytes
 * are counted as they arrive: past MAX_PARSE_OUTPUT_BYTES the parent stops
 * reading and kills the child, whatever the child meant to send. What does
 * arrive is checked against ParseOutcome's shape and the character budget
 * before anyone uses it. (Over advanced IPC a workbook whose cells share one
 * string would arrive as one copy per cell: gigabytes from a small file.)
 *
 * Built, the child is dist/lib/imports/parseWorker.js. Under tsx (dev and
 * the unit tests) it is the .ts source, loaded with tsx's loader.
 * scripts/smoke/parse-worker.mjs checks the built path (CI runs it).
 */

import { fork } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_PARSE_OUTPUT_BYTES,
  MAX_PARSED_CHARS,
  PARSE_TIMEOUT_MS,
  WORKER_HEAP_MB,
} from "./caps.js";
import { PARSE_FAILURES, type ParseOutcome } from "./sheet.js";

const fromSource = import.meta.url.endsWith(".ts");
const CHILD = fileURLToPath(new URL(fromSource ? "./parseWorker.ts" : "./parseWorker.js", import.meta.url));

export type ParseLimits = {
  timeoutMs?: number;
  heapMb?: number;
  maxRows: number;
  /** What is left of the import's character budget; MAX_PARSED_CHARS by default. */
  maxChars?: number;
  /** The answer's byte budget on its pipe; MAX_PARSE_OUTPUT_BYTES by default (tests lower it). */
  maxOutputBytes?: number;
};

const cell = z.string().max(MAX_CELL_CHARS);
const sheetShape = z
  .object({
    name: z.string().max(60),
    headerRow: z.number().int().positive(),
    headers: z.array(cell).max(MAX_COLUMNS),
    rows: z.array(z.array(cell)),
    rowNumbers: z.array(z.number().int().positive()),
    date1904: z.boolean(),
  })
  .strict();
const outcomeShape = z.union([
  z.object({ ok: z.literal(true), detectedType: z.enum(["csv", "xlsx"]), sheets: z.array(sheetShape).min(1), chars: z.number().int().nonnegative() }).strict(),
  z.object({ ok: z.literal(false), detectedType: z.enum(["csv", "xlsx", "unknown"]), reason: z.enum(PARSE_FAILURES) }).strict(),
]);

/**
 * The child's answer, trusted only once it has the outcome's shape and
 * stays inside the limits it was given: rows padded to the header width,
 * one row number per row, at most maxRows rows, and the characters it
 * claims (counted again here) within the budget.
 */
export function checkOutcome(raw: unknown, maxRows: number, maxChars: number): ParseOutcome | null {
  const parsed = outcomeShape.safeParse(raw);
  if (!parsed.success) return null;
  const out = parsed.data;
  if (!out.ok) return out;
  let rows = 0;
  let chars = 0;
  for (const s of out.sheets) {
    if (s.rows.length !== s.rowNumbers.length) return null;
    rows += s.rows.length;
    for (const h of s.headers) chars += h.length;
    for (const r of s.rows) {
      if (r.length !== s.headers.length) return null;
      for (const c of r) chars += c.length;
    }
  }
  if (rows > maxRows || chars !== out.chars) return null;
  if (chars > maxChars) return { ok: false, detectedType: out.detectedType, reason: "too-large-unpacked" };
  return out;
}

/**
 * At most this many parse processes per API instance; the rest wait their
 * turn (the timeout starts when a file's own process starts). Without it a
 * burst of registrations would fork a 256 MB process each.
 */
export const MAX_CONCURRENT_PARSES = 3;
let running = 0;
const waiting: Array<() => void> = [];

async function slot(): Promise<() => void> {
  if (running >= MAX_CONCURRENT_PARSES) await new Promise<void>((r) => waiting.push(r));
  running += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running -= 1;
    waiting.shift()?.();
  };
}

/** For tests: processes running now. */
export const parsesRunning = () => running;

function childArgs(heapMb: number): string[] {
  const args = [`--max-old-space-size=${heapMb}`, "--max-semi-space-size=16", "--stack-size=4000"];
  if (fromSource) args.push("--import", import.meta.resolve("tsx"));
  return args;
}

export async function parseInWorker(bytes: Uint8Array, fileName: string, limits: ParseLimits): Promise<ParseOutcome> {
  const release = await slot();
  try {
    return await parseOnce(bytes, fileName, limits);
  } finally {
    release();
  }
}

function parseOnce(bytes: Uint8Array, fileName: string, limits: ParseLimits): Promise<ParseOutcome> {
  const heap = limits.heapMb ?? WORKER_HEAP_MB;
  const maxChars = Math.max(0, limits.maxChars ?? MAX_PARSED_CHARS);
  const maxBytes = limits.maxOutputBytes ?? MAX_PARSE_OUTPUT_BYTES;
  return new Promise<ParseOutcome>((resolve) => {
    let settled = false;
    const child = fork(CHILD, [], {
      execArgv: childArgs(heap),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      serialization: "advanced",
      // fd 3: the answer, as JSON. fd 4: IPC, for the file going in only.
      stdio: ["ignore", "ignore", "ignore", "pipe", "ipc"],
    });
    const answer = child.stdio[3] as Readable;
    const chunks: Buffer[] = [];
    let received = 0;
    const finish = (out: ParseOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      answer.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(out);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detectedType: "unknown", reason: "timeout" }),
      limits.timeoutMs ?? PARSE_TIMEOUT_MS
    );
    answer.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      // Stop reading the moment the answer outgrows its budget.
      if (received > maxBytes) return finish({ ok: false, detectedType: "unknown", reason: "too-large-unpacked" });
      chunks.push(chunk);
    });
    answer.on("error", () => finish({ ok: false, detectedType: "unknown", reason: "unreadable" }));
    child.once("error", () => finish({ ok: false, detectedType: "unknown", reason: "unreadable" }));
    // 'close' comes after the child has exited and its pipe has ended.
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        return finish({
          ok: false,
          detectedType: "unknown",
          // V8 aborts (SIGABRT, exit 134) or traps (SIGTRAP) on heap exhaustion.
          reason: signal === "SIGABRT" || signal === "SIGTRAP" || code === 134 ? "memory" : "unreadable",
        });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return finish({ ok: false, detectedType: "unknown", reason: "unreadable" });
      }
      finish(checkOutcome(raw, limits.maxRows, maxChars) ?? { ok: false, detectedType: "unknown", reason: "unreadable" });
    });
    child.send({ bytes, fileName, maxRows: limits.maxRows, maxChars });
  });
}

/** What the counselor reads when a file fails (spec §8). */
export function parseFailureMessage(reason: string, fileName: string): string {
  const name = fileName.length > 80 ? `${fileName.slice(0, 77)}...` : fileName;
  switch (reason) {
    case "not-spreadsheet":
      return `${name} isn't a spreadsheet`;
    case "legacy-xls":
      return `${name} is an old Excel file. Save it as .xlsx or CSV.`;
    case "macro":
      return `${name} contains macros. Save it as a plain .xlsx or CSV.`;
    case "too-large-unpacked":
      return `${name} couldn't be read (too large when unpacked)`;
    case "cell-too-long":
      return `${name} has a cell longer than 32,767 characters`;
    case "import-too-large":
      return `${name} would make this import too large to read. Import it on its own.`;
    case "external-links":
      return `${name} couldn't be read (it links to other files)`;
    case "unsafe-xml":
      return `${name} couldn't be read (it contains settings we don't accept)`;
    case "too-many-rows":
      return `${name} has more than 5,000 rows. Split it into smaller files.`;
    case "too-many-columns":
      return `${name} has too many columns`;
    case "empty":
      return `${name} has no rows to import`;
    case "timeout":
      return `${name} couldn't be read (it took too long)`;
    case "memory":
      return `${name} couldn't be read (too large)`;
    case "wide":
      return "This sheet has one column per student; export it with one row per student";
    case "too-large":
      return `${name} is over 25 MB`;
    default:
      return `${name} couldn't be read`;
  }
}
