// Seasonal stage emails: lib/stageTemplates.ts, {student} in a blast, and what a queued blast says about its draft.
// Nothing here reaches a database or a network.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { blastTemplate, joinNames } from "../../src/lib/blasts.js";
import { fillTemplate } from "../../src/lib/crm.js";
import { toBlast } from "../../src/lib/serialize.js";
import { classYearsOf, columnProbe, sameClasses, stageUnavailable, validMonthDay } from "../../src/lib/stageTemplates.js";

// ---- the month and day rule, the same as the table's CHECK --------------------------------------

test("a month and day that exist in some year are valid, Feb 29 included", () => {
  assert.ok(validMonthDay(1, 31));
  assert.ok(validMonthDay(2, 29));
  assert.ok(validMonthDay(4, 30));
  assert.ok(validMonthDay(12, 31));
  for (const [m, d] of [
    [2, 30],
    [4, 31],
    [6, 31],
    [9, 31],
    [11, 31],
    [0, 1],
    [13, 1],
    [1, 0],
    [1, 32],
    [1.5, 1],
    [1, 1.5],
    [Number.NaN, 1],
  ] as const) {
    assert.ok(!validMonthDay(m, d), `${m}/${d}`);
  }
});

test("the rule agrees with the days each month has, every month", () => {
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 1; m <= 12; m++) {
    assert.ok(validMonthDay(m, days[m - 1]), `last day of ${m}`);
    assert.ok(!validMonthDay(m, days[m - 1] + 1), `one past the last day of ${m}`);
  }
});

// ---- class years ------------------------------------------------------------------------------

test("two lists of class years match as sets, whatever the order or spacing", () => {
  assert.ok(sameClasses(["2027"], ["2027"]));
  assert.ok(sameClasses(["2027", "2028"], ["2028", " 2027 "]));
  assert.ok(sameClasses(["2027", "2027"], ["2027"]));
  assert.ok(sameClasses([], []));
  assert.ok(!sameClasses(["2027"], ["2028"]));
  assert.ok(!sameClasses(["2027"], ["2027", "2028"]));
  assert.ok(!sameClasses(["2027"], []));
});

test("a stored blast's class years come from its filters, and nothing else is trusted", () => {
  assert.deepEqual(classYearsOf({ classYears: ["2027", "2028"], colleges: [], statuses: [] }), ["2027", "2028"]);
  assert.deepEqual(classYearsOf({ classYears: [2027] }), ["2027"]);
  for (const bad of [null, undefined, {}, "2027", { classYears: "2027" }, { classYears: null }, []]) {
    assert.deepEqual(classYearsOf(bad), [], JSON.stringify(bad));
  }
});

// ---- {student} --------------------------------------------------------------------------------

test("{student} is filled, and reads 'your student' where a sender has none", () => {
  assert.equal(fillTemplate("Hi {first}, about {student}.", { first: "Rosa", student: "Sophia" }), "Hi Rosa, about Sophia.");
  assert.equal(fillTemplate("About {student}.", { first: "Rosa" }), "About your student.");
  assert.equal(fillTemplate("About {student}.", { student: "  " }), "About your student.");
  assert.equal(fillTemplate("{student}'s plan, {student}'s year", { student: "Ana" }), "Ana's plan, Ana's year");
  // The older two still behave as before.
  assert.equal(fillTemplate("Hi {first}, {me}", {}), "Hi there, ");
  assert.equal(fillTemplate("{me}", { me: " Dr. Reyes " }), "Dr. Reyes");
});

test("a blast's copy fills {first}, {student} and {me}, and never leaves a brace in front of a family", () => {
  const t = blastTemplate({
    subject: "Starting {student}'s college search",
    body: "Hi {first},\n\nA note about {student}.\n\nWarmly,\n{me}",
    counselorName: "Ana Reyes",
    first: "Rosa",
    student: "Sophia",
  });
  assert.equal(t.subject, "Starting Sophia's college search");
  assert.equal(t.heading, t.subject);
  assert.deepEqual(t.paragraphs, ["Hi Rosa,", "A note about Sophia.", "Warmly,\nAna Reyes"]);

  const none = blastTemplate({ subject: "About {student}", body: "Hi {first},\n\nx", counselorName: null, first: "", student: "" });
  assert.equal(none.subject, "About your student");
  for (const text of [none.subject, ...none.paragraphs]) assert.ok(!/[{}]/.test(text), text);
});

test("siblings on one parent address are named together", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Ana"]), "Ana");
  assert.equal(joinNames(["Ana", "Luis"]), "Ana and Luis");
  assert.equal(joinNames(["Ana", "Luis", "Maya"]), "Ana, Luis and Maya");
});

// ---- what a queued blast says about itself ---------------------------------------------------

test("a queued blast reports its classes and the draft it came from; an older row reports neither", () => {
  const row = {
    id: "b1",
    subject: "s",
    body: "b",
    audience_kind: "filters",
    channel: "email",
    status: "scheduled",
    recipient_type: "parents",
    filters: { classYears: ["2028"], colleges: [], statuses: [] },
    source_template_id: "7f0a9c52-6d3e-4f5b-8a10-2b9c4d5e6f70",
    created_at: "2026-11-06T00:00:00Z",
  };
  const dto = toBlast(row);
  assert.deepEqual(dto.classYears, ["2028"]);
  assert.equal(dto.templateId, "7f0a9c52-6d3e-4f5b-8a10-2b9c4d5e6f70");
  assert.equal(dto.recipientType, "parents");

  const old = toBlast({ ...row, filters: undefined, source_template_id: undefined });
  assert.deepEqual(old.classYears, []);
  assert.equal(old.templateId, null);
});

// ---- the migration probe ---------------------------------------------------------------------

/** A database that answers the zero-row probe with `error`, counting how often it is asked. */
function stubDb(error: { code: string; message: string } | null) {
  const asked = { n: 0 };
  const db = {
    from: () => ({
      select: () => ({
        limit: async () => {
          asked.n += 1;
          return { error };
        },
      }),
    }),
  };
  return { db: db as unknown as SupabaseClient, asked };
}

test("the probe: present is true and kept, missing is false and remembered a while", async () => {
  const present = stubDb(null);
  const ready = columnProbe("email_templates", "stage");
  assert.equal(await ready(present.db), true);
  assert.equal(await ready(present.db), true);
  assert.equal(present.asked.n, 1, "a ready answer is kept for the process");

  const missing = stubDb({ code: "42703", message: "column email_templates.stage does not exist" });
  const absent = columnProbe("email_templates", "stage");
  assert.equal(await absent(missing.db), false);
  assert.equal(await absent(missing.db), false);
  assert.equal(missing.asked.n, 1, "a missing answer is remembered for 30 s, not asked every request");
});

test("any other database error is a real fault, never read as 'not switched on'", async () => {
  const broken = stubDb({ code: "57014", message: "canceling statement due to statement timeout" });
  const probe = columnProbe("email_blasts", "source_template_id");
  await assert.rejects(() => probe(broken.db), (err: unknown) => (err as { statusCode?: number }).statusCode === 500);
});

test("without the migration the stage routes say so, with a code a client can branch on", () => {
  const err = stageUnavailable();
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "stage_templates_unavailable");
});
