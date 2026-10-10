import assert from "node:assert/strict";
import { test } from "node:test";
import { accessStatusOf, approvedCounselorIds, blockedAsPending, isCounselorApproved } from "../../src/lib/access.js";
import { accountPending } from "../../src/lib/errors.js";
import { toMeridiesUser, type Profile } from "../../src/lib/serialize.js";

const pending = { role: "counselor" as const, counselor_approved_at: null };
const approved = { role: "counselor" as const, counselor_approved_at: "2026-10-10T00:00:00Z" };
const student = { role: "student" as const, counselor_approved_at: null };

/** A stand-in for the service client: records the ids asked for, answers with `result`. */
function fakeSvc(result: { data: { id: string }[] | null; error: { code?: string } | null }) {
  const asked: string[][] = [];
  const q = {
    select: () => q,
    in: (_col: string, ids: string[]) => { asked.push(ids); return q; },
    eq: () => q,
    not: () => Promise.resolve(result),
  };
  return { svc: { from: () => q } as never, asked };
}

test("status: students have none, counselors are pending until approved", () => {
  assert.equal(accessStatusOf(student), null);
  assert.equal(accessStatusOf(pending), "pending");
  assert.equal(accessStatusOf(approved), "approved");
});

test("a pending counselor is blocked unless the route opts in", () => {
  assert.equal(blockedAsPending(pending, undefined), true);
  assert.equal(blockedAsPending(pending, false), true);
  assert.equal(blockedAsPending(pending, true), false);
});

test("approved counselors and students are never blocked by the gate", () => {
  assert.equal(blockedAsPending(approved, undefined), false);
  assert.equal(blockedAsPending(student, undefined), false);
});

test("the pending error carries a code the app can branch on", () => {
  const err = accountPending();
  assert.equal(err.statusCode, 403);
  assert.equal(err.code, "account_pending");
});

test("the user DTO carries accessStatus", () => {
  const base: Profile = {
    id: "u1", full_name: "A", email: "a@test.local", role: "counselor", role_confirmed: true,
    onboarding_step: 0, onboarding_complete: false, counselor_id: null, firm_id: null, avatar_url: null,
    phone: null, timezone: null, title: null, headline: null, hometown: null, high_school: null,
    grad_year: null, profile: null, counselor_approved_at: null,
  };
  assert.equal(toMeridiesUser(base).accessStatus, "pending");
  assert.equal(toMeridiesUser({ ...base, counselor_approved_at: "2026-10-10T00:00:00Z" }).accessStatus, "approved");
  assert.equal(toMeridiesUser({ ...base, role: "student" }).accessStatus, null);
});

test("approvedCounselorIds returns only the ids the database says are approved", async () => {
  const { svc, asked } = fakeSvc({ data: [{ id: "a" }], error: null });
  const set = await approvedCounselorIds(svc, ["a", "b", "a"]);
  assert.deepEqual([...set], ["a"]);
  assert.deepEqual(asked, [["a", "b"]]);
});

test("no ids, no query", async () => {
  const { svc, asked } = fakeSvc({ data: [], error: null });
  assert.equal((await approvedCounselorIds(svc, [])).size, 0);
  assert.equal(asked.length, 0);
});

test("an errored read throws: it is never read as approved or as not approved", async () => {
  const { svc } = fakeSvc({ data: null, error: { code: "57014" } });
  await assert.rejects(() => isCounselorApproved(svc, "a"), /approval read failed/);
});
