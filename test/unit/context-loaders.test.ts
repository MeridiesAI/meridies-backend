import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOADERS } from "../../src/lib/context/sections.js";

type Call = { table: string; select: string; inIds?: string[] };

/** A recording stand-in for the query builder: every chain method returns itself; awaiting it yields the rows. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>, calls: Call[]): SupabaseClient {
  return {
    from(table: string) {
      const call: Call = { table, select: "" };
      const chain: Record<string, unknown> = {
        select(s: string) { call.select = s; calls.push(call); return chain; },
        in(_col: string, ids: string[]) { call.inIds = ids; return chain; },
        then(resolve: (r: { data: unknown; error: null }) => unknown) {
          const rows = tables[table] ?? [];
          const picked = call.inIds ? rows.filter((r) => call.inIds?.includes(String(r.id))) : rows;
          // Return only the selected columns, so a column the loader didn't ask for can't leak into the result.
          const cols = call.select.split(",").map((c) => c.trim().split(":")[0] ?? "");
          return Promise.resolve({ data: picked.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => cols.includes(k)))), error: null }).then(resolve);
        },
      };
      for (const m of ["eq", "order", "limit", "neq", "gte", "maybeSingle"]) chain[m] = () => chain;
      return chain;
    },
  } as unknown as SupabaseClient;
}

const doc = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  id, filename: `${id}.pdf`, title: null, kind, available_to_llm: true, ai_access: "default", ferpa_waived: false, kind_confirmed: true,
  parsed_data: { text: `TEXT-${id}` }, ...over,
});

test("documents loader reads parsed text only for the documents the rule allows", async () => {
  const calls: Call[] = [];
  const db = fakeDb({
    documents: [
      doc("t1", "transcript"),
      doc("kept", "transcript", { available_to_llm: false }),
      doc("letter", "recommendation-letter", { ferpa_waived: true }),
      doc("o1", "other"),
      doc("big", "resume", { parsed_data: { text: "x".repeat(12_001) } }),
      doc("blank", "resume", { parsed_data: {} }),
    ],
  }, calls);
  const r = await LOADERS.documents(db, "s", { essayBodies: false, practiceReadsDocuments: true });
  const meta = calls.find((c) => !c.inIds);
  assert.ok(meta && !meta.select.includes("parsed_data"), "the first query carries no parsed_data");
  const text = calls.find((c) => c.inIds);
  assert.deepEqual([...(text?.inIds ?? [])].sort(), ["big", "blank", "t1"], "parsed_data is fetched for allowed ids only");
  assert.deepEqual(r.section?.items, ["t1.pdf"]);
  assert.ok(r.section?.untrusted?.[0]?.text.includes("TEXT-t1"));
  assert.ok(!JSON.stringify(r).includes("TEXT-kept") && !JSON.stringify(r).includes("TEXT-letter") && !JSON.stringify(r).includes("TEXT-o1"));
  const reasons = Object.fromEntries((r.omitted ?? []).map((o) => [o.reason, o.count ?? 1]));
  assert.deepEqual(reasons, { budget: 1, "not-categorized": 1, "not-allowed": 2, empty: 1 });
});

test("documents loader makes no text query when nothing is allowed", async () => {
  const calls: Call[] = [];
  const db = fakeDb({ documents: [doc("o1", "other"), doc("kept", "transcript", { available_to_llm: false })] }, calls);
  const r = await LOADERS.documents(db, "s", { essayBodies: false, practiceReadsDocuments: true });
  assert.equal(calls.filter((c) => c.inIds).length, 0);
  assert.equal(r.section, null);
});

test("essays loader selects body only when asked", async () => {
  const rows = [{ title: "T", prompt: "P", school: "S", status: "drafting", word_count: 3, body: "BODY-TEXT", document_id: null }];
  for (const essayBodies of [false, true]) {
    const calls: Call[] = [];
    const r = await LOADERS.essays(fakeDb({ essays: rows }, calls), "s", { essayBodies, practiceReadsDocuments: true });
    assert.equal(calls[0]?.select.split(",").map((c) => c.trim()).includes("body"), essayBodies);
    assert.equal(JSON.stringify(r).includes("BODY-TEXT"), essayBodies);
  }
});

test("academics renders both SAT section scores", async () => {
  const row = { gpa_unweighted: null, gpa_weighted: null, gpa_scale: null, class_rank: null, class_rank_value: null, rigor_count: null,
    rigor_subjects: [], test_status: null, sat_ebrw: 740, sat_math: 710, sat_superscore: null, act_composite: null, strength_areas: [], strength_subjects: [] };
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }) } as unknown as SupabaseClient;
  const r = await LOADERS.academics(db, "s", { essayBodies: false, practiceReadsDocuments: true });
  assert.match(r.section?.body ?? "", /SAT: 1450/);
  assert.match(r.section?.body ?? "", /reading and writing: 740/);
  assert.match(r.section?.body ?? "", /SAT math: 710/);
});

import type { FastifyRequest } from "fastify";
import { buildStudentContext, type Feature } from "../../src/lib/context/index.js";

test("the login email is read only for college-list and activities", async () => {
  for (const feature of ["chat", "student-ai", "narrative-coherence", "college-list", "activities"] as Feature[]) {
    const selects: string[] = [];
    const db = {
      rpc: () => Promise.resolve({ data: [{ firm_id: null, is_admin: false }], error: null }),
      from(table: string) {
        const chain: Record<string, unknown> = {
          select(s: string) { if (table === "profiles") selects.push(s); return chain; },
          maybeSingle: () => Promise.resolve({ data: table === "profiles" ? { id: "s", counselor_id: "c", email: "login@test.local", full_name: "S" } : null, error: null }),
          then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        for (const m of ["eq", "order", "limit", "neq", "gte", "in", "is"]) chain[m] = () => chain;
        return chain;
      },
    };
    const request = { profile: { role: "counselor" }, auth: { userId: "c" }, db } as unknown as FastifyRequest;
    const ctx = await buildStudentContext(request, "s", feature);
    const readEmail = selects.includes("email");
    assert.equal(readEmail, feature === "college-list" || feature === "activities", `${feature} email read: ${readEmail}`);
    assert.equal(ctx.facts.identity.email, readEmail ? "login@test.local" : null, feature);
    assert.ok(!ctx.text.includes("login@test.local"));
  }
});
