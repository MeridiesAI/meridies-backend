import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities } from "../../src/lib/documentText.js";
import { randomText, seeded } from "./regex-dos-helpers.js";
test("x", () => {
  const rand = seeded(62);
  const pieces = ["&lt;", "&gt;", "&quot;", "&apos;", "&amp;", "&#65;", "&#x42;", "&#X43;", "&#;", "&#x;", "&", "#", ";", "a", "lt", "x", "1"];
  for (let i = 0; i < 40000; i++) {
    const s = randomText(rand, pieces, Math.floor(rand() * 10));
    if (s === "&apos;&apos;&#X43;&lt;&amp;a1") console.log("hit", i, decodeEntities(s));
  }
});
