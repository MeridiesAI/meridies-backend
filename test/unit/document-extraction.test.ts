import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { claimFailure, extractionState, extractorFor, LEASE_MS, leaseVerdict, MAX_ATTEMPTS, storedCopyFollowable } from "../../src/lib/documentExtraction.js";

test("each stored type has one extractor; images and unknowns have none", () => {
  assert.equal(extractorFor("application/pdf", "a.pdf"), "pdf");
  assert.equal(extractorFor(null, "Doc export.PDF"), "pdf");
  assert.equal(extractorFor("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), "text");
  assert.equal(extractorFor("text/plain", "notes.txt"), "text");
  assert.equal(extractorFor(null, "notes.md"), "text");
  assert.equal(extractorFor("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "list.xlsx"), "sheet");
  assert.equal(extractorFor("image/jpeg", "scan.jpg"), "none");
  assert.equal(extractorFor(null, "file.heic"), "none");
});

test("the state the app polls, from the row", () => {
  const at = new Date().toISOString();
  assert.equal(extractionState({ kind_confirmed: false }), "unconfirmed");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: false }), "kept-out");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "pending", extraction_requested_at: at }), "queued");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "parsing", extraction_requested_at: at }), "reading");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "parsed" }), "done");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "skipped", parse_error: "no-text" }), "empty");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "failed" }), "failed");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "pending" }), "none");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "failed", parse_error: "gave-up" }), "failed");
});

test("an expired lease is retried until the third attempt, then given up", () => {
  assert.equal(leaseVerdict({ extraction_attempts: 1 }), "retry");
  assert.equal(leaseVerdict({ extraction_attempts: 2 }), "retry");
  assert.equal(leaseVerdict({ extraction_attempts: 3 }), "give-up");
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(LEASE_MS, 120_000);
});

test("csv goes to the sheet reader, not to none", () => {
  assert.equal(extractorFor("text/csv", "a.csv"), "sheet");
  assert.equal(extractorFor(null, "list.CSV"), "sheet");
});

test("a failed claim clears the marker only when the row can no longer be extracted", () => {
  const at = new Date().toISOString();
  const base = { parse_status: "pending", extraction_requested_at: at, kind_confirmed: true, available_to_llm: true };
  assert.equal(claimFailure({ ...base, available_to_llm: false }), "clear");
  assert.equal(claimFailure({ ...base, kind_confirmed: false }), "clear");
  assert.equal(claimFailure(base), "leave");
  assert.equal(claimFailure({ ...base, parse_status: "parsing", available_to_llm: false }), "leave");
  assert.equal(claimFailure({ ...base, extraction_requested_at: null, available_to_llm: false }), "leave");
  assert.equal(claimFailure(null), "leave");
});

test("the worker follows only a canonical documents-bucket path with the service role", () => {
  const sid = "4f9c1c2e-8a0b-4c55-9d7e-0a1b2c3d4e5f";
  assert.equal(storedCopyFollowable({ bucket: "student-documents", storage_path: `${sid}/1700000000000-essay.pdf` }), true);
  assert.equal(storedCopyFollowable({ bucket: "student-documents", storage_path: "unfiled/1700000000000-a.pdf" }), true);
  assert.equal(storedCopyFollowable({ bucket: "imports", storage_path: `${sid}/a.pdf` }), false);
  assert.equal(storedCopyFollowable({ bucket: null, storage_path: `${sid}/a.pdf` }), false);
  // Each of these names another object, or another bucket, once the request URL is resolved.
  for (const path of [
    `${sid}/x/../../imports/roster.xlsx`,
    `unfiled/../${sid}/a.pdf`,
    `/${sid}/a.pdf`,
    `${sid}/%2e%2e/b.pdf`,
    `${sid}/a.pdf?x=1`,
    "not-a-uuid/a.pdf",
    "a.pdf",
    null,
  ]) {
    assert.equal(storedCopyFollowable({ bucket: "student-documents", storage_path: path }), false, String(path));
  }
});

test("spreadsheets are parsed only in the capped parse process, never in the API process", () => {
  // lib/imports/parse.ts forks the child; sheet.ts defines the parser and parseWorker.ts is the child.
  const allowed = new Set(["imports/sheet.ts", "imports/parseWorker.ts"]);
  const root = new URL("../../src/lib/", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    if (allowed.has(f.replaceAll("\\", "/"))) continue;
    const src = readFileSync(new URL(f, root), "utf8");
    assert.ok(!/\bparseSpreadsheet\b/.test(src), `${f} calls parseSpreadsheet in-process; use parseInWorker`);
  }
});
