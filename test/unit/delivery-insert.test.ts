import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import {
  MISSING_COLUMN_TTL_MS,
  insertDelivery,
  isMissingColumn,
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

// ---- meeting_id (20261023090001), alongside invitation_id ------------------------

/** A table missing some of the optional columns; Postgres names one per error. */
function tableMissing(missing: string[]) {
  const calls: Row[] = [];
  const insert = async (row: Row) => {
    calls.push(row);
    const col = missing.find((c) => c in row);
    if (col) return { data: null, error: { code: "42703", message: `column "${col}" of relation "message_deliveries" does not exist` } };
    return { data: { id: `d${calls.length}` }, error: null };
  };
  return { calls, insert };
}

test("meeting_id missing on its own: retried without it, invitation_id untouched", async () => {
  resetDeliveryColumnCache();
  const t = tableMissing(["meeting_id"]);
  const r = await insertDelivery(t.insert, { to_email: "a@x", meeting_id: "m1", invitation_id: "i1" }, 0);
  assert.equal(r.error, null);
  assert.equal(t.calls.length, 2);
  assert.equal("meeting_id" in t.calls[1]!, false);
  assert.equal(t.calls[1]!.invitation_id, "i1");
  assert.equal(isMissingColumn({ code: "PGRST204", message: "Could not find the 'meeting_id' column" }, "meeting_id"), true);
  assert.equal(isMissingColumn({ code: "42703", message: "column meeting_idx does not exist" }, "meeting_id"), false);
});

test("both columns missing: each is dropped in turn and the row is still written", async () => {
  resetDeliveryColumnCache();
  const t = tableMissing(["invitation_id", "meeting_id"]);
  const r = await insertDelivery(t.insert, { to_email: "a@x", meeting_id: "m1", invitation_id: "i1" }, 0);
  assert.equal(r.error, null, "the delivery row is not lost");
  assert.equal(t.calls.length, 3);
  assert.deepEqual(t.calls[2], { to_email: "a@x" });

  // Both misses are remembered: the next insert leaves both out up front.
  const again = tableMissing(["invitation_id", "meeting_id"]);
  await insertDelivery(again.insert, { to_email: "b@x", meeting_id: "m2", invitation_id: "i2" }, 1000);
  assert.equal(again.calls.length, 1);
});

test("each column's miss is cached on its own", async () => {
  resetDeliveryColumnCache();
  const t = tableMissing(["meeting_id"]);
  await insertDelivery(t.insert, { meeting_id: "m1" }, 0);
  // invitation_id was never found missing, so it is still sent.
  const both = tableMissing([]);
  await insertDelivery(both.insert, { meeting_id: "m2", invitation_id: "i2" }, 1000);
  assert.equal(both.calls.length, 1);
  assert.equal(both.calls[0]!.invitation_id, "i2");
  assert.equal("meeting_id" in both.calls[0]!, false, "meeting_id still cached as missing");
  // After the TTL meeting_id is tried again.
  const later = tableMissing([]);
  await insertDelivery(later.insert, { meeting_id: "m3" }, MISSING_COLUMN_TTL_MS + 1);
  assert.equal(later.calls[0]!.meeting_id, "m3");
});
