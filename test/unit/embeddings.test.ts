import assert from "node:assert/strict";
import { test } from "node:test";
import { EMBEDDING_DIM, embed, warmEmbeddings } from "../../src/lib/embeddings.js";

// The real model, not a stand-in: the first run downloads it from the Hugging Face Hub (about 130 MB) and caches
// it, so this is the one unit test that needs the network.

const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

test("embed returns one 384-number unit vector per text, in order", { timeout: 180_000 }, async () => {
  assert.equal(await warmEmbeddings(), true);
  const texts = ["Undergraduate research with faculty", "Division I football", "A study abroad semester in Spain"];
  const vectors = await embed(texts);
  assert.equal(vectors.length, texts.length);
  for (const v of vectors) {
    assert.equal(v.length, EMBEDDING_DIM);
    assert.ok(v.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-4, "unit length");
  }
  // The same text alone gives the same vector as in a batch: a stored vector doesn't depend on its batch.
  const [alone] = await embed([texts[1]!]);
  assert.ok(dot(alone!, vectors[1]!) > 0.9999);
});

test("similar phrases score a higher cosine than unrelated ones", { timeout: 180_000 }, async () => {
  const [research, labs, football, abroad, spain] = await embed([
    "Undergraduate research opportunities with professors",
    "Students work in faculty labs on research projects",
    "Big-time college football and game-day tailgates",
    "Semester abroad programs in Europe",
    "Study in Madrid for a term",
  ]);
  assert.ok(dot(research!, labs!) > dot(research!, football!));
  assert.ok(dot(research!, labs!) > dot(research!, spain!));
  assert.ok(dot(abroad!, spain!) > dot(abroad!, labs!));
  assert.ok(dot(abroad!, spain!) > dot(abroad!, football!));
});

test("embed of nothing is nothing", async () => {
  assert.deepEqual(await embed([]), []);
});
