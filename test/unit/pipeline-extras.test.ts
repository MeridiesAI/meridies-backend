import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { FastifyRequest } from "fastify";
import {
  extrasUnavailable,
  pipelineExtrasReady,
  requirePipelineExtras,
  resetPipelineExtrasForTests,
  summarizeFollowups,
  toActivity,
  toFollowup,
} from "../../src/lib/pipelineExtras.js";
import { toContact } from "../../src/routes/pipeline.js";

const followup = (over: Record<string, unknown>) => ({
  id: "f",
  contact_id: "c1",
  assignee_id: "u1",
  title: "Call",
  due_on: null,
  done: false,
  done_at: null,
  created_by: "u1",
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

test("a follow-up is overdue only while it is open and past its date", () => {
  assert.equal(toFollowup(followup({ due_on: "2026-10-27" }), "2026-10-28").overdue, true);
  assert.equal(toFollowup(followup({ due_on: "2026-10-28" }), "2026-10-28").overdue, false);
  assert.equal(toFollowup(followup({ due_on: "2026-10-27", done: true }), "2026-10-28").overdue, false);
  assert.equal(toFollowup(followup({ due_on: null }), "2026-10-28").overdue, false);
});

test("the next follow-up is the one due first, undated last, and counts are per contact", () => {
  const map = summarizeFollowups(
    [
      followup({ id: "a", title: "Undated", due_on: null }),
      followup({ id: "b", title: "Later", due_on: "2026-11-05" }),
      followup({ id: "c", title: "Soonest", due_on: "2026-10-30" }),
      followup({ id: "d", contact_id: "c2", title: "Other family", due_on: "2026-10-01" }),
    ],
    "2026-10-28"
  );
  assert.equal(map.get("c1")!.openFollowups, 3);
  assert.equal(map.get("c1")!.nextFollowup!.title, "Soonest");
  assert.equal(map.get("c2")!.nextFollowup!.overdue, true);
  assert.equal(map.get("nobody"), undefined);
});

test("an undated follow-up still beats having none, and ties go to the older one", () => {
  const map = summarizeFollowups(
    [
      followup({ id: "a", title: "Newer", created_at: "2026-10-02T00:00:00Z" }),
      followup({ id: "b", title: "Older", created_at: "2026-10-01T00:00:00Z" }),
    ],
    "2026-10-28"
  );
  assert.equal(map.get("c1")!.nextFollowup!.title, "Older");
});

test("an activity names its actor only when the actor is a consultant in the workspace", () => {
  const row = { id: "1", contact_id: "c", kind: "note", body: "Spoke to mom", meta: {}, actor_id: "u1", created_at: "2026-10-28T00:00:00Z" };
  assert.equal(toActivity(row, new Map([["u1", "Dana"]])).actorName, "Dana");
  // A student who accepted the invitation, or a trigger with no session.
  assert.equal(toActivity(row, new Map()).actorName, null);
  assert.equal(toActivity({ ...row, actor_id: null }, new Map([["u1", "Dana"]])).actorName, null);
});

test("a contact read before the history migration is open, with no follow-ups", () => {
  const dto = toContact(
    {
      id: "c1",
      stage_id: "s1",
      position: 0,
      student_name: "Ada",
      info: {},
      // Midday UTC is the same calendar day in the default (New York) zone.
      stage_entered_at: "2026-10-20T16:00:00Z",
      created_at: "2026-10-20T16:00:00Z",
      updated_at: "2026-10-20T16:00:00Z",
    },
    { today: "2026-10-28", timezone: null, groups: new Map([["s1", "lead"]]) }
  );
  assert.equal(dto.status, "open");
  assert.equal(dto.source, "");
  assert.equal(dto.lastContactedAt, null);
  assert.equal(dto.openFollowups, 0);
  assert.equal(dto.nextFollowup, null);
  assert.equal(dto.daysInStage, 8);
});

// ---- Is the migration in? --------------------------------------------------

type Probe = { error: { code: string; message?: string } | null };

/** A request whose db answers each zero-row probe, counting how many were asked. */
function fakeRequest(answer: () => Probe) {
  let asked = 0;
  const request = {
    db: {
      from: () => ({
        select: () => ({
          limit: () => {
            asked += 1;
            return Promise.resolve(answer());
          },
        }),
      }),
    },
  } as unknown as FastifyRequest;
  return { request, asked: () => asked };
}

beforeEach(() => resetPipelineExtrasForTests());

test("the extras are ready once every probe is clean, and that is remembered", async () => {
  const f = fakeRequest(() => ({ error: null }));
  assert.equal(await pipelineExtrasReady(f.request), true);
  assert.equal(f.asked(), 3);
  assert.equal(await pipelineExtrasReady(f.request), true);
  assert.equal(f.asked(), 3, "a ready answer is not asked again");
});

test("a missing table or column reads as not ready, and is not re-probed for a moment", async () => {
  for (const code of ["42P01", "42703", "PGRST205"]) {
    resetPipelineExtrasForTests();
    const f = fakeRequest(() => ({ error: { code } }));
    assert.equal(await pipelineExtrasReady(f.request), false, code);
    const asked = f.asked();
    assert.equal(await pipelineExtrasReady(f.request), false);
    assert.equal(f.asked(), asked, "the missing answer is remembered briefly");
  }
});

test("a route that needs the migration answers 503 with a stable code", async () => {
  const f = fakeRequest(() => ({ error: { code: "42P01" } }));
  await assert.rejects(requirePipelineExtras(f.request), (e: unknown) => {
    const err = e as { statusCode: number; code: string };
    return err.statusCode === 503 && err.code === "pipeline_extras_unavailable";
  });
  assert.equal(extrasUnavailable().statusCode, 503);
});

test("some other database error is raised, not mistaken for a missing migration", async () => {
  const f = fakeRequest(() => ({ error: { code: "XX000", message: "boom" } }));
  await assert.rejects(pipelineExtrasReady(f.request));
});
