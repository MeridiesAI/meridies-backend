import assert from "node:assert/strict";
import { test } from "node:test";
import { getOp, riskOf } from "../../src/lib/axis/ops/registry.js";

test("AxIS can mark a meeting's notes sent, and undo it", () => {
  const def = getOp("meetings.mark_notes_sent");
  assert.ok(def, "op exists");
  const id = "11111111-1111-4111-8111-111111111111";
  const on = def.input.parse({ meeting_id: id, sent: true });
  assert.deepEqual(def.request(on), { method: "POST", url: `/meetings/${id}/notes-sent` });
  const off = def.input.parse({ meeting_id: id, sent: false });
  assert.deepEqual(def.request(off), { method: "DELETE", url: `/meetings/${id}/notes-sent` });
  assert.equal(riskOf(def, on), "auto");
  assert.deepEqual(def.undo?.(on, {}, null), { op: "meetings.mark_notes_sent", input: { meeting_id: id, sent: false } });
});
