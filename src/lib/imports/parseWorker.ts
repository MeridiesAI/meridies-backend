/**
 * The parse process's entry point (spec §5.2, §7.3). parse.ts forks it with
 * a heap cap and kills it at a wall-clock timeout. It reads one file from
 * the IPC channel and answers once, as JSON on fd 3 (a pipe the parent
 * counts bytes on and stops reading past MAX_PARSE_OUTPUT_BYTES), then
 * exits. It has no network work to do and no secrets in its environment.
 *
 * The answer never goes back over IPC: V8's serializer copies a string once
 * per reference, so a workbook whose cells share one string would arrive as
 * gigabytes the parent could not refuse.
 */

import { createWriteStream } from "node:fs";
import { answerJson, parseSpreadsheet, type ParseOutcome } from "./sheet.js";

type Input = { bytes: Uint8Array; fileName: string; maxRows: number; maxChars: number };

process.once("message", (input: Input) => {
  parseSpreadsheet(input.bytes, input.fileName, input.maxRows, input.maxChars)
    .catch((): ParseOutcome => ({ ok: false, detectedType: "unknown", reason: "unreadable" }))
    .then((out) => {
      const pipe = createWriteStream("", { fd: 3 });
      pipe.end(answerJson(out), () => process.exit(0));
    });
});
