import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import { isResultsNotApplied, resultsUnavailable } from "../../src/lib/resultsAvailability.js";

test("a missing column or table before the migration is 'not applied'", () => {
  for (const code of ["PGRST204", "PGRST205", "42703", "42P01", "42883", "PGRST200", "PGRST202"]) {
    assert.equal(isResultsNotApplied({ code }), true, code);
  }
});

test("the old status CHECK refusing 'not-awarded' reads as not applied", () => {
  const error = {
    code: "23514",
    message: 'new row for relation "scholarship_matches" violates check constraint "scholarship_matches_status_check"',
  };
  assert.equal(isResultsNotApplied(error), true);
});

test("other errors are not mistaken for it", () => {
  assert.equal(isResultsNotApplied(null), false);
  assert.equal(isResultsNotApplied({}), false);
  assert.equal(isResultsNotApplied({ code: "42501" }), false);
  assert.equal(isResultsNotApplied({ code: "23514", message: 'violates check constraint "essays_status_check"' }), false);
  assert.equal(resultsUnavailable({ code: "23505" }), null);
});

test("not applied answers 503 with a stable code", () => {
  const err = resultsUnavailable({ code: "42703" });
  assert.ok(err instanceof HttpError);
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "college_results_unavailable");
  assert.match(err.message, /switched on/);
});
