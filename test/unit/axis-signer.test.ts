import assert from "node:assert/strict";
import { test } from "node:test";
import { signerLine, buildSystemPrompt, getChatTool } from "../../src/lib/chat.js";
import { systemBlocks } from "../../src/lib/axis/engine.js";

test("signerLine names the counselor and forbids the placeholder", () => {
  const line = signerLine({ full_name: "Jordan Rivera", title: "Lead Counselor" });
  assert.match(line, /Jordan Rivera \(Lead Counselor\)/);
  assert.match(line, /Sign anything you draft for them .* as Jordan Rivera/);
  assert.match(line, /\[Counselor name\]/);
});

test("signerLine without a name still forbids a placeholder", () => {
  for (const p of [null, undefined, { full_name: "  " }]) {
    const line = signerLine(p);
    assert.match(line, /no name line/);
    assert.doesNotMatch(line, /counselor you work for/);
  }
});

test("v2 system context carries the signer after today and the record", () => {
  const blocks = systemBlocks("RECORD", null, null, new Date("2026-10-12T00:00:00Z"), signerLine({ full_name: "Jordan Rivera" }));
  const context = blocks[1].text;
  assert.match(context, /^Today is 2026-10-12\./);
  assert.match(context, /The counselor you work for is Jordan Rivera\./);
  // The stable block stays the same for every counselor, so its cache is shared.
  assert.doesNotMatch(blocks[0].text, /Jordan Rivera/);
});

test("v1 system prompt carries the signer", () => {
  const prompt = buildSystemPrompt(getChatTool("general"), null, null, signerLine({ full_name: "Jordan Rivera" }));
  assert.match(prompt, /as Jordan Rivera/);
});
