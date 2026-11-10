import { test } from "node:test";
import assert from "node:assert/strict";
import { ttlCache } from "../../src/lib/ttlCache.js";

test("reuses the loaded value until the TTL passes", async () => {
  let t = 0;
  let loads = 0;
  const c = ttlCache(1000, async () => ++loads, () => t);
  assert.equal(await c.get(), 1);
  t = 999;
  assert.equal(await c.get(), 1);
  t = 1000;
  assert.equal(await c.get(), 2);
  assert.equal(loads, 2);
});

test("concurrent callers share one load", async () => {
  let loads = 0;
  const c = ttlCache(1000, async () => {
    loads += 1;
    return loads;
  });
  const [a, b] = await Promise.all([c.get(), c.get()]);
  assert.equal(a, b);
  assert.equal(loads, 1);
});

test("a failed load is not kept", async () => {
  let n = 0;
  const c = ttlCache(1000, async () => {
    n += 1;
    if (n === 1) throw new Error("boom");
    return n;
  });
  await assert.rejects(c.get(), /boom/);
  assert.equal(await c.get(), 2);
});

test("clear forces a reload", async () => {
  let loads = 0;
  const c = ttlCache(1000, async () => ++loads);
  await c.get();
  c.clear();
  assert.equal(await c.get(), 2);
});
