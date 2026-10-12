import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { eventKey, mapEventsCsv } from "../../src/lib/ingest/events.js";
import { parseCsv } from "../../src/lib/ingest/ipeds.js";

const sample = readFileSync(new URL("../fixtures/events-sample.csv", import.meta.url), "utf8");

const base = {
  name: "Fixture Event",
  kind: "webinar",
  host: "Fixture Host",
  start_date: "2099-01-15",
  url: "https://example.org/e",
};

test("events CSV: the sample file maps cleanly", () => {
  const { ok, errors } = mapEventsCsv(parseCsv(sample));
  assert.deepEqual(errors, []);
  assert.equal(ok.length, 3);
  const [webinar, conference, session] = ok;
  assert.equal(webinar!.row.kind, "webinar");
  assert.equal(webinar!.row.start_time, "16:00");
  assert.deepEqual(webinar!.row.topics, ["aid", "practice"]);
  assert.equal(webinar!.collegeUnitid, null);
  assert.equal(conference!.row.kind, "conference", "kind is case-insensitive");
  assert.equal(conference!.row.end_date, "2099-03-04");
  assert.equal(conference!.row.place, "Chicago, IL");
  assert.equal(conference!.row.description, null);
  assert.equal(session!.collegeUnitid, 110635);
  assert.equal(session!.row.start_time, null);
  assert.equal(session!.row.photo_key, null);
  assert.equal(session!.row.time_zone, "America/Los_Angeles");
});

test("events CSV: defaults for blank time zone and place", () => {
  const { ok, errors } = mapEventsCsv([{ ...base, time_zone: "", place: "" }]);
  assert.deepEqual(errors, []);
  assert.equal(ok[0]!.row.time_zone, "America/New_York");
  assert.equal(ok[0]!.row.place, "Online");
  assert.deepEqual(ok[0]!.row.topics, []);
});

test("events CSV: one bad row is reported with its line", () => {
  const rows = [base, { ...base, name: "Other", kind: "party" }];
  const { errors } = mapEventsCsv(rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^line 3: kind/);
});

test("events CSV: refuses what the table would refuse", () => {
  const bad: Record<string, string>[] = [
    { ...base, name: "" },
    { ...base, start_date: "2099-02-30" },
    { ...base, start_date: "15/01/2099" },
    { ...base, end_date: "2099-01-14" },
    { ...base, end_time: "17:00" },
    { ...base, start_time: "17:00", end_time: "16:00" },
    { ...base, start_time: "25:00" },
    { ...base, time_zone: "Mars/Olympus" },
    { ...base, url: "javascript:alert(1)" },
    { ...base, url: "ftp://example.org/x" },
    { ...base, topics: "aid;gossip" },
    { ...base, photo_key: "selfie" },
    { ...base, college_unitid: "abc" },
    { ...base, description: "x".repeat(1001) },
    { ...base, surprise: "column" },
  ];
  for (const row of bad) {
    const { ok, errors } = mapEventsCsv([row]);
    assert.equal(ok.length, 0, JSON.stringify(row).slice(0, 120));
    assert.ok(errors.length > 0);
  }
});

test("events CSV: a multi-day event may end earlier in the day it ends", () => {
  const { errors } = mapEventsCsv([{ ...base, end_date: "2099-01-16", start_time: "17:00", end_time: "09:00" }]);
  assert.deepEqual(errors, []);
});

test("events CSV: duplicate natural keys in one file are an error", () => {
  const { errors } = mapEventsCsv([base, { ...base, name: "  fixture   EVENT ", url: "https://example.org/other" }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /same event .* as line 2/);
});

test("events CSV: an empty file is an error", () => {
  assert.equal(mapEventsCsv([]).errors.length, 1);
});

test("eventKey ignores case and spacing", () => {
  assert.equal(eventKey(" A  b ", "Host", "2099-01-01"), eventKey("a B", "host", "2099-01-01"));
  assert.notEqual(eventKey("a", "host", "2099-01-01"), eventKey("a", "host", "2099-01-02"));
});
