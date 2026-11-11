import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extractResearchActivity, extractSeenPages } from "../../src/lib/anthropic.js";

const fixture: { content: unknown[] } = JSON.parse(
  readFileSync(new URL("../fixtures/research/activities-response.json", import.meta.url), "utf8")
);

test("queries come from search and fetch tool uses, in order", () => {
  const { queries } = extractResearchActivity(fixture.content);
  assert.deepEqual(queries, [
    "marine biology summer program high school",
    "ocean research volunteer teens",
    "https://www.whoi.edu/education/high-school/",
    "https://example.org/gone",
  ]);
});
test("URLs come from search results and fetches (de-duplicated); errors and unknown blocks add none", () => {
  const { seenUrls } = extractResearchActivity(fixture.content);
  assert.deepEqual(seenUrls, [
    "https://www.whoi.edu/education/high-school/",
    "https://example.org/marine-camp#apply",
  ]);
});
test("an errored search result contributes nothing", () => {
  const out = extractResearchActivity([{ type: "web_search_tool_result", tool_use_id: "x", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }]);
  assert.deepEqual(out, { queries: [], seenUrls: [] });
});
test("an unknown block, null and odd shapes do not throw", () => {
  const out = extractResearchActivity([null, 3, "x", { type: "mystery", url: "https://x.org" }, { type: "server_tool_use", input: null }, { type: "web_fetch_tool_result", content: null }, { type: "web_search_tool_result", content: [null, { url: 5 }] }]);
  assert.deepEqual(out, { queries: [], seenUrls: [] });
});

test("a server tool use for another tool contributes nothing", () => {
  const out = extractResearchActivity([
    { type: "server_tool_use", name: "code_execution", input: { query: "q", url: "https://x.org" } },
    { type: "server_tool_use", name: "web_search", input: { url: "https://x.org" } },
    { type: "server_tool_use", name: "web_fetch", input: { query: "q" } },
  ]);
  assert.deepEqual(out, { queries: [], seenUrls: [] });
});

test("seen pages carry the title the search result or fetch gave them; odd shapes add nothing", () => {
  const pages = extractSeenPages([
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.org/x", title: "Alpha College | Admissions" }, { url: "https://b.org", title: "" }, null, { url: 3 }] },
    { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://b.org", content: { type: "document", title: "Beta University" } } },
    { type: "web_fetch_tool_result", content: { type: "web_fetch_tool_error", url: "https://c.org" } },
    { type: "web_search_tool_result", content: [{ url: "https://a.org/x", title: "Later title" }] },
  ]);
  assert.deepEqual(pages, [
    { url: "https://a.org/x", title: "Alpha College | Admissions" },
    { url: "https://b.org", title: "Beta University" },
  ]);
  assert.deepEqual(extractSeenPages(fixture.content).map((p) => p.url), extractResearchActivity(fixture.content).seenUrls);
});
