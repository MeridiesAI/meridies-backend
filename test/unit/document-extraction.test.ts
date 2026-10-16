import assert from "node:assert/strict";
import { test } from "node:test";
import { claimFailure, extractionState, extractorFor, LEASE_MS, leaseVerdict, MAX_ATTEMPTS } from "../../src/lib/documentExtraction.js";

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
