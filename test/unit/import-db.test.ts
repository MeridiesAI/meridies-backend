import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWorkerRole, WrongWorkerRoleError } from "../../src/lib/imports/db.js";

const fake = (user: string) => ({
  query: async (_sql: string) => ({ rows: [{ current_user: user }] }),
});

test("the import_worker login is accepted", async () => {
  await assertWorkerRole(fake("import_worker"));
});

test("the postgres superuser login is refused", async () => {
  await assert.rejects(assertWorkerRole(fake("postgres")), WrongWorkerRoleError);
});

test("the service role login is refused", async () => {
  await assert.rejects(assertWorkerRole(fake("service_role")), /import_worker/);
});
