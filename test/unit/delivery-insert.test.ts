import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import {
  MISSING_COLUMN_TTL_MS,
  insertDelivery,
  isMissingInvitationColumn,
  resetDeliveryColumnCache,
} from "../../src/lib/deliveryInsert.js";
import { invitationDeliveries } from "../../src/lib/inviteDelivery.js";

type Row = Record<string, unknown>;

/** An insert against a table that may or may not have invitation_id. */
function fakeTable(hasColumn: boolean, code = "PGRST204") {
  const calls: Row[] = [];
  const insert = async (row: Row) => {
    calls.push(row);
    if (!hasColumn && "invitation_id" in row) {
      return { data: null, error: { code, message: `Could not find the 'invitation_id' column of 'message_deliveries'` } };
    }
    return { data: { id: `d${calls.length}` }, error: null };
  };
  return { calls, insert };
}

test("the column exists: one insert, invitation_id kept", async () => {
  resetDeliveryColumnCache();
  const t = fakeTable(true);
  const r = await insertDelivery(t.insert, { to_email: "a@x", invitation_id: "i1" }, 0);
  assert.equal(r.error, null);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.invitation_id, "i1");
});

test("the column is missing: retried once without it, and the row is written", async () => {
  for (const code of ["PGRST204", "42703"]) {
    resetDeliveryColumnCache();
    const t = fakeTable(false, code);
    const r = await insertDelivery(t.insert, { to_email: "a@x", invitation_id: "i1" }, 0);
    assert.equal(r.error, null);
    assert.deepEqual(r.data, { id: "d2" });
    assert.equal(t.calls.length, 2);
    assert.equal("invitation_id" in t.calls[1]!, false);
    assert.equal(t.calls[1]!.to_email, "a@x");
  }
});

test("the missing column is remembered for a few minutes, then asked again", async () => {
  resetDeliveryColumnCache();
  const t = fakeTable(false);
  await insertDelivery(t.insert, { invitation_id: "i1" }, 1000);
  await insertDelivery(t.insert, { invitation_id: "i2" }, 1000 + 60_000);
  assert.equal(t.calls.length, 3, "the second send leaves the column out up front");
  assert.equal("invitation_id" in t.calls[2]!, false);

  const migrated = fakeTable(true);
  await insertDelivery(migrated.insert, { invitation_id: "i3" }, 1000 + MISSING_COLUMN_TTL_MS + 1);
  assert.equal(migrated.calls[0]!.invitation_id, "i3", "after the TTL the column is tried again");
});

test("rows without invitation_id and other errors are not retried", async () => {
  resetDeliveryColumnCache();
  const plain = fakeTable(false);
  await insertDelivery(plain.insert, { to_email: "a@x" }, 0);
  assert.equal(plain.calls.length, 1);

  let n = 0;
  const failing = async () => {
    n += 1;
    return { data: null, error: { code: "23502", message: "null value in column invitation_id" } };
  };
  const r = await insertDelivery(failing, { invitation_id: "i1" }, 0);
  assert.equal(n, 1);
  assert.equal(r.error?.code, "23502");
  assert.equal(isMissingInvitationColumn({ code: "42703", message: "column blast_id does not exist" }), false);
});

test("GET /invites' delivery read gives an empty map (delivery: null) when the column is missing", async () => {
  const builder = {
    select: () => builder,
    in: () => builder,
    order: () => builder,
    limit: async () => ({ data: null, error: { code: "42703", message: "column message_deliveries.invitation_id does not exist" } }),
  };
  const warned: unknown[] = [];
  const request = { db: { from: () => builder }, log: { warn: (o: unknown) => warned.push(o) } } as unknown as FastifyRequest;
  const map = await invitationDeliveries(request, ["i1", "i2"]);
  assert.equal(map.size, 0);
  assert.equal(warned.length, 1);
});
