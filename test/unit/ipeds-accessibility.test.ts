import assert from "node:assert/strict";
import { test } from "node:test";
import { disabilityColumns, parseCsv, planRow, readRow } from "../../src/lib/ingest/ipedsAccessibility.js";

const NOW = new Date("2026-11-27T00:00:00Z");

test("a quoted CSV with a BOM and CRLF is read by column name", () => {
  const rows = parseCsv('﻿UNITID,INSTNM,DISABPCT\r\n100654,"Alabama A & M, University",4.5\r\n100663,"The ""Quote"" College",-2\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!["INSTNM"], "Alabama A & M, University");
  assert.equal(rows[1]!["INSTNM"], 'The "Quote" College');
});

test("an exact figure, the 3 percent bucket, and a missing value", () => {
  const o = { pctVar: "DISABPCT", bucketVar: "DISABB", bucketCodes: ["1"] };
  assert.deepEqual(readRow({ UNITID: "1", DISABPCT: "4.5", DISABB: "" }, o), { unitid: 1, pctRegisteredDs: 4.5, pctThreeOrLess: false });
  assert.deepEqual(readRow({ UNITID: "2", DISABPCT: "", DISABB: "1" }, o), { unitid: 2, pctRegisteredDs: null, pctThreeOrLess: true });
  assert.equal(readRow({ UNITID: "3", DISABPCT: "-2", DISABB: "" }, o), null);
  assert.equal(readRow({ UNITID: "4", DISABPCT: "", DISABB: "" }, o), null);
  assert.equal(readRow({ UNITID: "5", DISABPCT: "250", DISABB: "" }, o), null);
  assert.equal(readRow({ UNITID: "x", DISABPCT: "4" }, o), null);
});

test("a new college gets a row; an existing one gets only the two percent columns; a re-run changes nothing", () => {
  const reading = { unitid: 1, pctRegisteredDs: 4.5, pctThreeOrLess: false };
  const ins = planRow(reading, "c1", undefined, NOW);
  assert.equal(ins.kind, "insert");
  if (ins.kind === "insert") {
    assert.equal(ins.row.data_source, "ipeds");
    assert.equal(ins.row.last_verified_at, NOW.toISOString());
  }
  const upd = planRow(reading, "c1", { college_id: "c1", data_source: "axis", pct_registered_ds: null, pct_three_or_less: false }, NOW);
  assert.deepEqual(upd, { kind: "update", collegeId: "c1", fields: { pct_registered_ds: 4.5, pct_three_or_less: false } });
  assert.deepEqual(planRow(reading, "c1", { college_id: "c1", data_source: "axis", pct_registered_ds: 4.5, pct_three_or_less: false }, NOW), { kind: "same" });
});

test("a wrong column name lists the disability columns that exist", () => {
  assert.deepEqual(disabilityColumns(parseCsv("UNITID,DISABPCT,OTHER\r\n1,2,3\r\n")), ["DISABPCT"]);
});
