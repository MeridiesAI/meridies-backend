import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCursor, encodeCursor, escapeIlike, safeIlikeTerm, searchFilters, searchQuery, searchRank } from "../../src/lib/collegesV10.js";

test("safeIlikeTerm keeps letters, digits and spaces only", () => {
  assert.equal(safeIlikeTerm("harvard; drop"), "harvard drop");
  assert.equal(safeIlikeTerm("a,b)or(c"), "a b or c");
  assert.equal(safeIlikeTerm("%_*\\:."), "");
  assert.equal(safeIlikeTerm("St. John's"), "St Johns");
  assert.equal(safeIlikeTerm("São Paulo"), "São Paulo");
  assert.equal(safeIlikeTerm("x".repeat(300)).length, 120);
});

test("escapeIlike escapes the wildcards", () => {
  assert.equal(escapeIlike("50%_off\\"), "50\\%\\_off\\\\");
});

test("searchRank: prefix, word prefix, contains, extra", () => {
  assert.equal(searchRank("Stanford University", [], [], "stan"), 0);
  assert.equal(searchRank("University of Michigan", ["UMich"], [], "umich"), 0);
  assert.equal(searchRank("University of Michigan", [], [], "mich"), 1);
  assert.equal(searchRank("Boston University", [], ["Computer Science"], "computer"), 3);
  assert.equal(searchRank("St. John's University", [], [], "st johns"), 0);
  assert.equal(searchRank("Yale University", [], [], "ya"), 0);
  assert.equal(searchRank("Yale University", [], [], "zz"), -1);
});

test("searchQuery validates and searchFilters maps", () => {
  const q = searchQuery.parse({ states: "ca,ny", control: "public", admitMax: "0.4", netPriceMax: "20000", band: "0-30000", fit: "target", hbcu: "true" });
  assert.deepEqual(searchFilters(q), {
    states: ["CA", "NY"],
    control: ["public"],
    admitRate: { min: 0, max: 0.4 },
    netPrice: { max: 20000, band: "0-30000" },
    hbcu: true,
    fit: ["target"],
  });
  assert.equal(searchQuery.safeParse({ states: "California" }).success, false);
  assert.equal(searchQuery.safeParse({ q: "x", evil: "1" }).success, false);
  assert.equal(searchQuery.safeParse({ lat: "40" }).success, false, "lat needs lng");
});

test("cursors round-trip and reject junk", () => {
  assert.equal(decodeCursor(encodeCursor(96)), 96);
  assert.equal(decodeCursor("not-a-cursor"), 0);
  assert.equal(decodeCursor(Buffer.from("o:999999").toString("base64url")), 0);
});
