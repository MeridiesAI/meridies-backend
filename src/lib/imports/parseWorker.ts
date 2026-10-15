/**
 * The parse process's entry point (spec §5.2, §7.3). parse.ts forks it with
 * a heap cap and kills it at a wall-clock timeout. It reads one file from
 * the IPC channel, answers once and exits; it has no network work to do and
 * no secrets in its environment.
 */

import { parseSpreadsheet } from "./sheet.js";

type Input = { bytes: Uint8Array; fileName: string; maxRows: number };

process.once("message", (input: Input) => {
  parseSpreadsheet(input.bytes, input.fileName, input.maxRows)
    .catch(() => ({ ok: false as const, detectedType: "unknown" as const, reason: "unreadable" as const }))
    .then((out) => process.send?.(out, () => process.exit(0)));
});
