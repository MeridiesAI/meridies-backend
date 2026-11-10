import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { HttpError } from "../../src/lib/errors.js";
import {
  DEFAULT_PRIVACY,
  assertAiAllowed,
  assertStudentAiTools,
  isStudentToolModule,
  readPracticeSettingsFor,
  toPrivacySettings,
} from "../../src/lib/practiceSettings.js";

// Students use the consultant AI tools (Build College Lists, Coherence, Activities Build, the scholarship Ask box)
// only when their counselor's practice has switched "Let students use AI tools" on. Off is the default, and every
// way of not knowing the answer is off too.

const STUDENT_TOOLS = ["narrative-coherence", "concierge", "college-list", "scholarship-match"] as const;

/** A request as the gate sees it. The unit env has no service key, so a student's switches come from the RPC. */
function student(rpc: unknown, over: { counselorId?: string | null } = {}) {
  return {
    profile: { role: "student", counselor_id: over.counselorId === undefined ? "c1" : over.counselorId },
    auth: { userId: "s1" },
    db: { rpc: async () => ({ data: rpc, error: null }) },
  } as unknown as FastifyRequest;
}
const counselor = () => ({ profile: { role: "counselor" }, auth: { userId: "c1" } }) as unknown as FastifyRequest;
const on = { ai_summaries: true, auto_parse_documents: true, student_ai_tools: true };
const off = { ai_summaries: true, auto_parse_documents: true, student_ai_tools: false };
const refused = (e: unknown) => e instanceof HttpError && e.statusCode === 403;
const refusedWithWords = (e: unknown) => refused(e) && /turned on AI tools/.test((e as HttpError).message);

test("student AI tools default off, and only a literal true turns them on", () => {
  assert.equal(DEFAULT_PRIVACY.studentAiTools, false);
  assert.equal(toPrivacySettings(null).studentAiTools, false);
  assert.equal(toPrivacySettings({}).studentAiTools, false, "a database without the column");
  assert.equal(toPrivacySettings({ student_ai_tools: "true" }).studentAiTools, false);
  assert.equal(toPrivacySettings({ student_ai_tools: null }).studentAiTools, false);
  assert.equal(toPrivacySettings({ student_ai_tools: true }).studentAiTools, true);
  assert.deepEqual({ ...toPrivacySettings(null) }, { ...DEFAULT_PRIVACY });
});

test("the four tool modules are the student tools; nothing else is", () => {
  for (const m of STUDENT_TOOLS) assert.equal(isStudentToolModule(m), true, m);
  for (const m of ["resume", "profile-summary", "link-digest", "list-explain", "chat"] as const) {
    assert.equal(isStudentToolModule(m as never), false, m);
  }
});

test("a student is refused every tool module while the switch is off", async () => {
  for (const m of STUDENT_TOOLS) {
    await assert.rejects(assertAiAllowed(student(off), m), refusedWithWords, m);
  }
});

test("a student gets every tool module once the switch is on", async () => {
  for (const m of STUDENT_TOOLS) await assertAiAllowed(student(on), m);
});

test("a student is refused when the practice's answer can't be read, or has no such switch (fail closed)", async () => {
  // An older my_practice_ai_settings() that doesn't know the key.
  await assert.rejects(assertAiAllowed(student({ ai_summaries: true, auto_parse_documents: true }), "narrative-coherence"), refusedWithWords);
  // No answer at all (not a student of an approved counselor, a read error).
  await assert.rejects(assertAiAllowed(student(null), "narrative-coherence"), refused);
  // No counselor.
  await assert.rejects(assertAiAllowed(student(on, { counselorId: null }), "narrative-coherence"), refused);
});

test("the switch changes nothing for the summary and document modules a student already used", async () => {
  await assertAiAllowed(student(off), "profile-summary");
  await assertAiAllowed(student(off), "resume");
  // Their own switches still decide those.
  await assert.rejects(assertAiAllowed(student({ ...off, ai_summaries: false }), "resume"), refused);
});

test("a counselor is never held by the student switch", async () => {
  for (const m of STUDENT_TOOLS) await assertAiAllowed(counselor(), m);
});

test("assertStudentAiTools: counselors pass without a read; a student needs the switch", async () => {
  await assertStudentAiTools(counselor());
  await assert.rejects(assertStudentAiTools(student(off)), refusedWithWords);
  await assert.rejects(assertStudentAiTools(student(null)), refused);
  await assertStudentAiTools(student(on));
});

// ---- Reading the switch on the service client (deploy order: the code can land before the column) ----

type Result = { data: unknown; error: unknown };
function fakeService(results: Result[]) {
  const selects: string[] = [];
  const client = {
    from: () => ({
      select: (cols: string) => {
        selects.push(cols);
        const next = results.shift() ?? { data: null, error: { code: "XX000" } };
        const b = { eq: () => b, maybeSingle: async () => next };
        return b;
      },
    }),
  };
  return { client, selects };
}

test("reading a practice row asks for the new column", async () => {
  const { client, selects } = fakeService([{ data: { ai_summaries: true, auto_parse_documents: false, students_see_shared_reports: true, student_ai_tools: true }, error: null }]);
  const s = await readPracticeSettingsFor(client as never, "f1", "c1");
  assert.equal(s?.studentAiTools, true);
  assert.equal(s?.autoParseDocuments, false);
  assert.equal(selects.length, 1);
  assert.match(selects[0]!, /student_ai_tools/);
});

test("before the migration the read retries without the column: summaries still answered, tools off", async () => {
  const { client, selects } = fakeService([
    { data: null, error: { code: "42703", message: 'column "student_ai_tools" does not exist' } },
    { data: { ai_summaries: false, auto_parse_documents: true, students_see_shared_reports: true }, error: null },
  ]);
  const s = await readPracticeSettingsFor(client as never, null, "c1");
  assert.equal(s?.aiSummaries, false, "the practice's other switches are still honoured");
  assert.equal(s?.studentAiTools, false);
  assert.equal(selects.length, 2);
  assert.doesNotMatch(selects[1]!, /student_ai_tools/);
});

test("any other read error is no answer, not the defaults", async () => {
  const { client, selects } = fakeService([{ data: null, error: { code: "XX000", message: "boom" } }]);
  assert.equal(await readPracticeSettingsFor(client as never, "f1", "c1"), null);
  assert.equal(selects.length, 1);
});

test("a practice with no row gets the defaults, tools off", async () => {
  const { client } = fakeService([{ data: null, error: null }]);
  const s = await readPracticeSettingsFor(client as never, "f1", "c1");
  assert.deepEqual({ ...s }, { ...DEFAULT_PRIVACY });
});
