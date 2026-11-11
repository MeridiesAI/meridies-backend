import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { mapEventsCsv } from "../../src/lib/ingest/events.js";
import { parseCsv } from "../../src/lib/ingest/ipeds.js";

// The checked-in seed files for the Events Hub (scripts/ingest/data/events-*.csv).
// These are curated by hand from organizers' own pages, so the checks here are
// about shape and hygiene. They deliberately do not look at dates: a season's
// file goes stale on its own and past events simply stop showing.
const dataDir = new URL("../../scripts/ingest/data/", import.meta.url);
const seedFiles = readdirSync(dataDir)
  .filter((f) => /^events-.+\.csv$/.test(f))
  .sort();

test("events seed: the 2026-27 file is checked in and listed in the README", () => {
  assert.ok(seedFiles.includes("events-2026-27.csv"), `found: ${seedFiles.join(", ") || "none"}`);
  const readme = readFileSync(new URL("README.md", dataDir), "utf8");
  for (const f of seedFiles) assert.ok(readme.includes(`\`${f}\``), `${f} is not listed in scripts/ingest/data/README.md`);
});

for (const file of seedFiles) {
  const rows = () => parseCsv(readFileSync(new URL(file, dataDir), "utf8"));

  test(`events seed (${file}): maps with no errors`, () => {
    const { ok, errors } = mapEventsCsv(rows());
    assert.deepEqual(errors, []);
    assert.ok(ok.length >= 1);
    assert.equal(ok.length, rows().length, "every row mapped");
  });

  test(`events seed (${file}): each row on the organizer's own https page, with its source and the day it was read`, () => {
    const raw = rows();
    const { ok } = mapEventsCsv(raw);
    for (const { row, line } of ok) {
      const where = `line ${line} (${row.name})`;
      // Counselor events are counselors'; a college fair is for students and families too.
      assert.ok(["conference", "workshop", "webinar", "college-fair"].includes(row.kind), `${where}: kind ${row.kind}`);
      assert.equal(row.audience, row.kind === "college-fair" ? "everyone" : "counselor", where);
      assert.equal(row.photo_key, row.kind, `${where}: photo_key should match the kind`);
      assert.ok(row.topics.length > 0, `${where}: give at least one topic`);
      assert.equal(row.source, "csv", where);

      for (const [col, value] of [["url", row.url], ["source_url", row.source_url]] as const) {
        const url = new URL(value);
        assert.equal(url.protocol, "https:", `${where}: ${col} must be https`);
        assert.ok(url.pathname.replace(/\/+$/, "") !== "", `${where}: ${col} must be the event's page, not a homepage`);
        assert.ok(!/(^|\.)example\.(org|com)$/.test(url.hostname), `${where}: placeholder ${col}`);
      }
      assert.match(row.last_verified_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/, `${where}: checked_on`);
      assert.ok(row.last_verified_at.slice(0, 10) <= row.start_date, `${where}: checked after the event started? then it has no business in the file`);

      // A blank place would load as the loader's "Online" default, which is wrong for an in-person event.
      assert.ok((raw[line - 2]?.place ?? "").trim() !== "", `${where}: place is blank (it would load as "Online")`);
      assert.ok((raw[line - 2]?.time_zone ?? "").trim() !== "", `${where}: time_zone is blank (it would load as America/New_York)`);
      assert.ok((row.description ?? "").length > 0, `${where}: needs a short description from the organizer's page`);
      assert.ok((row.description ?? "").length <= 400, `${where}: keep the description short`);
    }
  });

  test(`events seed (${file}): no two rows are the same event`, () => {
    const { ok } = mapEventsCsv(rows());
    const keys = ok.map((o) => o.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate (name, host, start_date)");
  });
}
