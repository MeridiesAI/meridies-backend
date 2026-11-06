import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { markFor, readMark, restoreSentence, TRASH_COVERED, TRASH_EXCLUDED, TRASH_MISSING } from "../../src/lib/axis/ops/trash.js";
import { allOps, riskOf } from "../../src/lib/axis/ops/registry.js";
import { sampleInput } from "./axis-op-samples.js";

test("a mark round-trips and a tampered one is ignored", () => {
  const id = randomUUID();
  const mark = markFor(id);
  assert.equal(readMark(mark), id);
  assert.equal(readMark(`${randomUUID()}.${mark.split(".")[1]}`), null, "another action's signature");
  assert.equal(readMark(`${id}.${"0".repeat(64)}`), null, "a made-up signature");
  assert.equal(readMark(id), null, "no signature");
  assert.equal(readMark(undefined), null);
  assert.equal(readMark(`not-a-uuid.${mark.split(".")[1]}`), null);
});

test("each refusal reason has its sentence", () => {
  assert.equal(restoreSentence("expired"), "This can't be restored: the 30 days are up.");
  assert.equal(restoreSentence("no-access"), "This can't be restored: you no longer have access to that student.");
  assert.equal(restoreSentence("conflict"), "This can't be restored: something with the same details exists again.");
  assert.equal(restoreSentence("parent-missing"), "This can't be restored: what it belonged to has been deleted.");
  assert.equal(restoreSentence("already"), "That was already restored.");
  assert.equal(restoreSentence("not-approved"), "This can't be restored: your counselor access isn't active.");
  assert.equal(TRASH_MISSING, "AxIS can't delete things until the database update 20261110000004_axis_trash is applied.");
});

test("every DELETE op is covered by the trash or excluded with a reason", () => {
  const deletes: string[] = [];
  for (const d of allOps()) {
    if (d.kind !== "write") continue;
    const input = sampleInput(d.name);
    if (d.request(input as never).method !== "DELETE") continue;
    deletes.push(d.name);
    const covered = TRASH_COVERED.has(d.name);
    const excluded = typeof TRASH_EXCLUDED[d.name] === "string" && TRASH_EXCLUDED[d.name]!.length > 0;
    assert.ok(covered !== excluded, `${d.name}: covered or excluded, not both or neither`);
    if (covered) assert.equal(riskOf(d, input), "confirm", `${d.name} asks first`);
  }
  for (const name of TRASH_COVERED) assert.ok(deletes.includes(name), `${name} is a DELETE op in the catalog`);
  assert.ok(TRASH_COVERED.size >= 30, String(TRASH_COVERED.size));
});

test("firm.remove_member, invites.delete_import and pipeline.delete_stage are not in the catalog", () => {
  const names = new Set(allOps().map((d) => d.name));
  assert.ok(!names.has("firm.remove_member"));
  assert.ok(!names.has("invites.delete_import"));
  assert.ok(!names.has("pipeline.delete_stage"));
});

test("without the migration AxIS refuses a covered delete before anything runs", async () => {
  const { confirmOperation } = await import("../../src/lib/axis/ops/run.js");
  const { resetTrashReadyForTest } = await import("../../src/lib/axis/ops/trash.js");
  const { HttpError } = await import("../../src/lib/errors.js");
  resetTrashReadyForTest();
  let injected = 0;
  const request = {
    auth: { userId: "11111111-1111-4111-8111-111111111111", token: "t" },
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
    db: { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.axis_trash_restore" } }) },
    server: { inject: async () => (injected++, { statusCode: 200, body: "{}" }) },
  } as never;
  const row = { id: randomUUID(), student_id: null, payload: { op: "deadlines.delete", summary: "Delete a deadline", input: { deadline_id: randomUUID() } } };
  await assert.rejects(confirmOperation(request, row), (err: unknown) => err instanceof HttpError && err.statusCode === 503 && err.message === TRASH_MISSING);
  assert.equal(injected, 0, "nothing was deleted");
  resetTrashReadyForTest();
});
