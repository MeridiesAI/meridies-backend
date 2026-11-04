// The free-text rule (AxIS security PR B, spec §3.2): short structured record fields don't flag a turn; a
// student-written value over 80 characters, a document, an essay body, a chat file, email and web pages do.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOADERS } from "../../src/lib/context/sections.js";
import { renderSection, type Section } from "../../src/lib/context/pack.js";
import { freeBlocks, hasFreeText, isFree, leaveOutFree, SHORT_FIELD_MAX } from "../../src/lib/context/freeText.js";
import { buildRosterContext } from "../../src/lib/chat.js";

/** Every chain method returns itself; awaiting it yields the table's rows (or one row for maybeSingle). */
function fakeDb(tables: Record<string, Record<string, unknown>[]>): SupabaseClient {
  return {
    from(table: string) {
      let single = false;
      const chain: Record<string, unknown> = {
        then(resolve: (r: { data: unknown; error: null }) => unknown) {
          const rows = tables[table] ?? [];
          return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(resolve);
        },
        maybeSingle() {
          single = true;
          return chain;
        },
      };
      for (const m of ["select", "eq", "order", "limit", "neq", "gte", "lte", "in"]) chain[m] = () => chain;
      return chain;
    },
  } as unknown as SupabaseClient;
}
const opts = { essayBodies: false, practiceReadsDocuments: true };
const rendered = (s: Section | null) => (s ? renderSection(s) : "");
const long = (n: number) => "x".repeat(n);

test("a college list of short names isn't free text", async () => {
  const r = await LOADERS.colleges(fakeDb({ student_colleges: [
    { name: "Massachusetts Institute of Technology", round: "EA", fit: "reach", status: "applying" },
    { name: "University of California, Los Angeles", round: "RD", fit: "target", status: "researching" },
    { name: "Pomona College", round: "ED", fit: "reach", status: "applying" },
  ] }), "s", opts);
  assert.ok(r.section?.untrusted?.every((u) => u.free === false), JSON.stringify(r.section?.untrusted));
  assert.equal(hasFreeText(rendered(r.section)), false);
});

test("an 80-character value is short and an 81-character one is free", async () => {
  assert.equal(SHORT_FIELD_MAX, 80);
  assert.equal(isFree("activity:Robotics", long(80)), false);
  assert.equal(isFree("activity:Robotics", long(81)), true);
  const at = async (n: number) => (await LOADERS.colleges(fakeDb({ student_colleges: [{ name: long(n), status: "applying" }] }), "s", opts)).section?.untrusted?.[0]?.free;
  assert.equal(await at(80), false);
  assert.equal(await at(81), true);
});

test("in shortOnly mode an activity description is left out with a note", async () => {
  const r = await LOADERS.activities(fakeDb({ activities: [
    { name: "Robotics", position: "Captain", category: "Academic", description: `Led a team of twelve that built ${long(90)}` },
    { name: "Debate", position: "Member", category: "Speech", description: "Varsity" },
  ] }), "s", opts);
  const [kept] = leaveOutFree([r.section!], () => true);
  const text = rendered(kept ?? null);
  assert.ok(!text.includes("Led a team of twelve"), text);
  assert.ok(text.includes("Varsity") && text.includes("Robotics") && text.includes("Debate"), text);
  assert.match(kept!.body, /Left out, read with get_student_record: 1 activity description/);
  assert.equal(hasFreeText(text), false);
});

test("documents are always free text", async () => {
  const r = await LOADERS.documents(fakeDb({ documents: [{
    id: "d1", filename: "transcript.pdf", title: null, kind: "transcript", available_to_llm: true, ai_access: "default", ferpa_waived: false, kind_confirmed: true,
    parsed_data: { text: "GPA 3.9" },
  }] }), "s", opts);
  assert.equal(isFree("document:transcript.pdf", "GPA 3.9"), true);
  assert.ok(hasFreeText(rendered(r.section)));
  const [kept] = leaveOutFree([r.section!], () => true);
  assert.match(kept!.body, /Left out, read with get_student_record: 1 document: transcript\.pdf/);
  assert.equal(isFree("attachment:essay.pdf", "short"), true, "a chat file");
  assert.equal(isFree("essay:My essay", "short"), true, "an essay body");
  assert.equal(isFree("essay-details", "1. My essay; status: draft"), false, "the essay list is short fields");
});

test("a 40-character intake answer is short, a 200-character one is free", async () => {
  const r = await LOADERS.intake(fakeDb({ intake_responses: [{ answers: { dreamSchool: long(40), whyCollege: long(200) } }] }), "s", opts);
  const byKey = Object.fromEntries((r.section?.untrusted ?? []).map((u) => [u.text.split(":")[0], u.free]));
  assert.deepEqual(byKey, { dreamSchool: false, whyCollege: true });
});

test("the headline is its own entry, free only when long", async () => {
  const r = await LOADERS.profile(fakeDb({ profiles: [{ full_name: "Ada Lovelace", grad_year: "2027", high_school: "Lincoln High", hometown: "Austin", headline: `Builds things ${long(80)}` }] }), "s", opts);
  const free = (r.section?.untrusted ?? []).filter((u) => u.free).map((u) => u.source);
  assert.deepEqual(free, ["headline"]);
  const [kept] = leaveOutFree([r.section!], () => true);
  assert.ok(rendered(kept ?? null).includes("Ada Lovelace"));
});

test("a counselor's own section never counts as free text", async () => {
  const r = await LOADERS.meetingNotes(fakeDb({ meeting_notes: [{ meeting_date: "2026-10-01", title: "Fall check-in", summary: long(500), tags: [] }] }), "s", opts);
  assert.equal(hasFreeText(rendered(r.section)), false);
  const [kept] = leaveOutFree([r.section!], (name) => name !== "meetingNotes");
  assert.ok(rendered(kept ?? null).includes(long(500)), "shortOnly keeps what the counselor wrote");
});

test("freeBlocks returns the unescaped text of free blocks only", () => {
  const s: Section = { name: "activities", label: "Activities", body: "", untrusted: [
    { source: "activity:Robotics", text: `Built <robots> & ${long(80)}`, free: true },
    { source: "activity-details", text: "1. Robotics", free: false },
  ] };
  const blocks = freeBlocks(renderSection(s));
  assert.deepEqual(blocks, [{ source: "activity:Robotics", text: `Built <robots> & ${long(80)}` }]);
});

test("the roster's high schools, deadlines and student tasks are short", async () => {
  const request = (rows: { high?: string; title?: string }) => ({
    profile: { role: "counselor" },
    auth: { userId: "c1" },
    db: fakeDb({
      profiles: [{ id: "s1", full_name: "Ada Lovelace", grad_year: "2027", high_school: rows.high ?? "Lincoln High School" }],
      deadlines: [{ student_id: "s1", title: rows.title ?? "UC application", school: "UCLA", type: "application", due_date: "2026-11-30", level: "high" }],
      meetings: [],
      deliverables: [{ id: "t1", student_id: "s1", title: "Ask for a letter", status: "in-progress", due_date: "2026-11-20", source: "student" }],
    }),
  }) as unknown as FastifyRequest;
  const short = await buildRosterContext(request({}));
  assert.equal(short?.freeText, false);
  assert.equal(short?.outside, true, "today's wider rule still says outside");
  assert.equal((await buildRosterContext(request({ high: long(81) })))?.freeText, true);
  assert.equal((await buildRosterContext(request({ title: long(120) })))?.freeText, true);
});

test("flagsReady probes ai_messages.outside_quotes: ready is kept, missing is asked again after 30 s", async (t) => {
  const { flagsReady, resetFlagsReadyForTest } = await import("../../src/lib/axis/failsafe.js");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  resetFlagsReadyForTest();
  let probes = 0;
  let answer: { code?: string } | null = { code: "42703" };
  const db = { from: (table: string) => ({ select: (cols: string) => ({ limit: async () => { probes++; assert.equal(`${table}.${cols}`, "ai_messages.outside_quotes"); return { error: answer }; } }) }) };
  assert.equal(await flagsReady(db), false);
  assert.equal(await flagsReady(db), false, "remembered as missing");
  assert.equal(probes, 1);
  t.mock.timers.tick(30_001);
  answer = null;
  assert.equal(await flagsReady(db), true, "asked again after 30 s");
  answer = { code: "42703" };
  assert.equal(await flagsReady(db), true, "ready is kept");
  assert.equal(probes, 2);
  resetFlagsReadyForTest();
  answer = { code: "XX000" };
  await assert.rejects(flagsReady(db), "another error is thrown, not read as missing");
  resetFlagsReadyForTest();
});
