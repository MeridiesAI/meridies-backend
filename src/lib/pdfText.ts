/**
 * PDF text extraction for the type guess and for AxIS (spec §4.3.2). PDFs are hostile input:
 * each one is read in its own worker thread with a memory cap, terminated at the time limit,
 * at most two at once; the rest wait in a FIFO queue (high priority first: the type guess at
 * import, which gives up after `waitMs` rather than hold an import). Nothing is logged but codes.
 */
import { Worker } from "node:worker_threads";
import { getResolvedPDFJS } from "unpdf";

export const PDF_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxPages: 50,
  maxChars: 200_000,
  timeoutMs: 10_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  concurrency: 2,
} as const;

export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: "too-large" | "timeout" | "memory" | "unreadable" | "busy" };

type Job = {
  bytes: Uint8Array;
  maxPages: number;
  timeoutMs: number;
  workerUrl: URL;
  priority: "high" | "normal";
  resolve: (r: PdfTextResult) => void;
  giveUp: NodeJS.Timeout | null;
};

// Under tsx (dev, tests) the worker is the .ts file and inherits tsx through execArgv.
const here = import.meta.url;
const DEFAULT_WORKER = new URL(here.endsWith(".ts") ? "./pdfText.worker.ts" : "./pdfText.worker.js", here);

const waiting: Job[] = [];
let running = 0;

export function pdfQueueStats(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}

/** Priorities of the jobs now waiting, front of the queue first (an inspection point for tests). */
export function pdfQueueWaitingPriorities(): Array<"high" | "normal"> {
  return waiting.map((j) => j.priority);
}

export async function bundledPdfjsVersion(): Promise<string> {
  const pdfjs = (await getResolvedPDFJS()) as { version?: string };
  return String(pdfjs.version ?? "0.0.0");
}

export function extractPdfText(
  bytes: Uint8Array,
  opts: { maxPages?: number; priority?: "high" | "normal"; waitMs?: number; timeoutMs?: number; workerUrl?: URL } = {}
): Promise<PdfTextResult> {
  if (bytes.byteLength > PDF_LIMITS.maxBytes) return Promise.resolve({ ok: false, reason: "too-large" });
  return new Promise((resolve) => {
    const job: Job = {
      bytes,
      maxPages: Math.min(opts.maxPages ?? PDF_LIMITS.maxPages, PDF_LIMITS.maxPages),
      timeoutMs: opts.timeoutMs ?? PDF_LIMITS.timeoutMs,
      workerUrl: opts.workerUrl ?? DEFAULT_WORKER,
      priority: opts.priority ?? "normal",
      resolve,
      giveUp: null,
    };
    if (opts.waitMs !== undefined) {
      job.giveUp = setTimeout(() => {
        const i = waiting.indexOf(job);
        if (i >= 0) {
          waiting.splice(i, 1);
          resolve({ ok: false, reason: "busy" });
        }
      }, opts.waitMs);
    }
    if (job.priority === "high") {
      const firstNormal = waiting.findIndex((j) => j.priority === "normal");
      waiting.splice(firstNormal < 0 ? waiting.length : firstNormal, 0, job);
    } else {
      waiting.push(job);
    }
    pump();
  });
}

function pump(): void {
  while (running < PDF_LIMITS.concurrency && waiting.length > 0) {
    const job = waiting.shift()!;
    if (job.giveUp) clearTimeout(job.giveUp);
    running++;
    run(job).then((r) => {
      running--;
      job.resolve(r);
      pump();
    });
  }
}

/**
 * The loader flags a worker needs to start (tsx's --import under dev and tests). Everything else
 * in process.execArgv (a test runner's TLS or heap flags, say) is refused by Worker, so is dropped.
 */
function workerExecArgv(argv: readonly string[] = process.execArgv): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (/^--(import|require|loader|experimental-loader)=/.test(a)) out.push(a);
    else if (/^--(import|require|loader|experimental-loader)$/.test(a) && i + 1 < argv.length) out.push(a, argv[++i]!);
  }
  return out;
}

function run(job: Job): Promise<PdfTextResult> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (r: PdfTextResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (worker) void worker.terminate();
      resolve(r);
    };
    try {
      worker = new Worker(job.workerUrl, {
        workerData: { bytes: job.bytes, maxPages: job.maxPages, maxChars: PDF_LIMITS.maxChars },
        resourceLimits: {
          maxOldGenerationSizeMb: PDF_LIMITS.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: PDF_LIMITS.maxYoungGenerationSizeMb,
        },
        execArgv: workerExecArgv(),
      });
    } catch {
      finish({ ok: false, reason: "unreadable" });
      return;
    }
    // The limit is enforced by killing the thread, not by abandoning a promise.
    timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), job.timeoutMs);
    worker.on("message", (m: { ok: boolean; text?: string; pages?: number }) =>
      finish(m.ok ? { ok: true, text: String(m.text ?? ""), pages: Number(m.pages ?? 0) } : { ok: false, reason: "unreadable" })
    );
    worker.on("error", (err: NodeJS.ErrnoException) =>
      finish({ ok: false, reason: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "unreadable" })
    );
    worker.on("exit", () => finish({ ok: false, reason: "unreadable" }));
  });
}
