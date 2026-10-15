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
 * Built, the child is dist/lib/imports/parseWorker.js. Under tsx (dev and
 * the unit tests) it is the .ts source, loaded with tsx's loader.
 * scripts/smoke/parse-worker.mjs checks the built path (CI runs it).
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PARSE_TIMEOUT_MS, WORKER_HEAP_MB } from "./caps.js";
import type { ParseOutcome } from "./sheet.js";

const fromSource = import.meta.url.endsWith(".ts");
const CHILD = fileURLToPath(new URL(fromSource ? "./parseWorker.ts" : "./parseWorker.js", import.meta.url));

export type ParseLimits = { timeoutMs?: number; heapMb?: number; maxRows: number };

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
  return new Promise<ParseOutcome>((resolve) => {
    let settled = false;
    const child = fork(CHILD, [], {
      execArgv: childArgs(heap),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const finish = (out: ParseOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(out);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detectedType: "unknown", reason: "timeout" }),
      limits.timeoutMs ?? PARSE_TIMEOUT_MS
    );
    child.once("message", (m) => finish(m as ParseOutcome));
    child.once("error", () => finish({ ok: false, detectedType: "unknown", reason: "unreadable" }));
    child.once("exit", (code, signal) =>
      finish({
        ok: false,
        detectedType: "unknown",
        // V8 aborts (SIGABRT, exit 134) or traps (SIGTRAP) on heap exhaustion.
        reason: signal === "SIGABRT" || signal === "SIGTRAP" || code === 134 ? "memory" : "unreadable",
      })
    );
    child.send({ bytes, fileName, maxRows: limits.maxRows });
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
