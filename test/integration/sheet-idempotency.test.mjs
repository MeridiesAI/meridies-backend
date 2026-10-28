// Application sheets: a create sent twice with the same Idempotency-Key makes
// one row (a double-click, or a request retried after a dropped answer). A
// different key, or none, still adds a row, and a malformed key is refused.
import { randomUUID } from "node:crypto";
import { API, user, check, sql } from "./harness.mjs";

const c = await user("counselor-sheet-idem");
const s = await user("student-sheet-idem", "student");
await sql(`update profiles set counselor_id = '${c.id}' where id = '${s.id}'`);

function create(path, key) {
  return fetch(`${API}/application/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify({ studentId: s.id }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const count = async (table) => Number(await sql(`select count(*) from ${table} where student_id = '${s.id}'`));

for (const [path, table] of [["activities", "activities"], ["honors", "awards"]]) {
  const key = randomUUID();
  const first = await create(path, key);
  const again = await create(path, key);
  check(`${path}: the first create lands`, first.status === 201, `status ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
  check(`${path}: the repeat answers with the same row`, again.status === 200 && again.body?.id === first.body?.id, `status ${again.status} ${again.body?.id} vs ${first.body?.id}`);
  check(`${path}: one row in the table`, (await count(table)) === 1, String((await count(table))));

  // Sent at the same moment: still one row.
  const both = randomUUID();
  const [x, y] = await Promise.all([create(path, both), create(path, both)]);
  check(`${path}: two at once with one key make one row`, (await count(table)) === 2 && x.body?.id === y.body?.id, `${(await count(table))} ${x.status}/${y.status}`);

  const other = await create(path, randomUUID());
  check(`${path}: a new key adds a row`, other.status === 201 && (await count(table)) === 3, `status ${other.status}`);
  const none = await create(path);
  check(`${path}: no key still adds a row`, none.status === 201 && (await count(table)) === 4, `status ${none.status}`);
  const bad = await create(path, "not-a-uuid");
  check(`${path}: a malformed key is refused`, bad.status === 400 && (await count(table)) === 4, `status ${bad.status}`);
}
