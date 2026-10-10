import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlocked, keepCandidates, type Candidate } from "../../src/lib/research/citations.js";

const ok = async () => ({ status: "ok" as const });
const broken = async () => ({ status: "broken" as const });

const one = (url: string, title: string | null = null): Candidate[] => [{ title: "X", summary: "s", sources: [{ url, title }] }];

test("blocked domains and their subdomains", () => {
  assert.ok(isBlocked("https://www.niche.com/x", ["niche.com"]));
  assert.ok(isBlocked("https://blog.essayshark.com/a", ["essayshark.com"]));
  assert.ok(!isBlocked("https://nichemath.org/a", ["niche.com"]));
});
test("only URLs seen in the run are kept", async () => {
  const out = await keepCandidates(
    [{ title: "A", summary: "s", sources: [{ url: "https://a.org/x", title: null }, { url: "https://invented.org/y", title: null }] }],
    { seenUrls: ["https://a.org/x"] }, [], ok
  );
  assert.deepEqual(out[0].sources.map((s) => s.url), ["https://a.org/x"]);
  assert.ok(out[0].checkedAt);
});
test("a candidate with no surviving source is dropped", async () => {
  const out = await keepCandidates([{ title: "B", summary: "s", sources: [{ url: "https://niche.com/z", title: null }] }],
    { seenUrls: ["https://niche.com/z"] }, ["niche.com"], ok);
  assert.equal(out.length, 0);
});
test("broken links are dropped", async () => {
  const out = await keepCandidates([{ title: "C", summary: "s", sources: [{ url: "https://c.org", title: null }] }],
    { seenUrls: ["https://c.org"] }, [], broken);
  assert.equal(out.length, 0);
});

test("trailing slash and fragment differences still match", async () => {
  const a = await keepCandidates(one("https://a.org/x/"), { seenUrls: ["https://a.org/x"] }, [], ok);
  assert.equal(a.length, 1);
  const b = await keepCandidates(one("https://a.org/x#apply"), { seenUrls: ["https://a.org/x/"] }, [], ok);
  assert.equal(b.length, 1);
});
test("scheme and host case do not matter; http and https are the same page", async () => {
  const a = await keepCandidates(one("HTTPS://Example.ORG/x"), { seenUrls: ["https://example.org/x"] }, [], ok);
  assert.equal(a.length, 1);
  const b = await keepCandidates(one("http://example.org/x"), { seenUrls: ["https://example.org/x"] }, [], ok);
  assert.equal(b.length, 1);
  const c = await keepCandidates(one("https://example.org/x"), { seenUrls: ["HTTP://EXAMPLE.org/x"] }, [], ok);
  assert.equal(c.length, 1);
});
test("a different path or query string does not match", async () => {
  assert.equal((await keepCandidates(one("https://a.org/y"), { seenUrls: ["https://a.org/x"] }, [], ok)).length, 0);
  assert.equal((await keepCandidates(one("https://a.org/x?id=2"), { seenUrls: ["https://a.org/x?id=1"] }, [], ok)).length, 0);
  assert.equal((await keepCandidates(one("https://a.org/x"), { seenUrls: ["https://a.org/x?id=1"] }, [], ok)).length, 0);
});
test("only http and https URLs can be kept", async () => {
  for (const u of ["javascript:alert(1)", "data:text/html,hi", "ftp://a.org/x", "not a url"]) {
    const out = await keepCandidates(one(u), { seenUrls: [u] }, [], ok);
    assert.equal(out.length, 0, u);
  }
});
test("blocked domain match is case-insensitive and covers subdomains", () => {
  assert.ok(isBlocked("https://WWW.Niche.COM/x", ["niche.com"]));
  assert.ok(isBlocked("https://a.b.niche.com/x", ["Niche.com"]));
  assert.ok(!isBlocked("https://notniche.com/x", ["niche.com"]));
  assert.ok(isBlocked("not a url", []));
});
test("check runs once per normalized URL, and never for unseen or blocked URLs", async () => {
  const calls: string[] = [];
  const check = async (url: string) => {
    calls.push(url);
    return { status: "ok" as const };
  };
  const out = await keepCandidates(
    [
      { title: "A", summary: "s", sources: [{ url: "https://a.org/x", title: null }, { url: "https://unseen.org/q", title: null }, { url: "https://niche.com/n", title: null }] },
      { title: "B", summary: "s", sources: [{ url: "https://a.org/x/#top", title: "Again" }, { url: "HTTP://A.org/x", title: null }] },
    ],
    { seenUrls: ["https://a.org/x", "https://niche.com/n"] }, ["niche.com"], check
  );
  assert.equal(calls.length, 1);
  assert.equal(out.length, 2);
  assert.equal(out[1].sources.length, 2);
});
test("a throwing check drops that source without failing the run", async () => {
  const check = async (url: string) => {
    if (url.includes("bad")) throw new Error("boom");
    return { status: "ok" as const };
  };
  const out = await keepCandidates(
    [{ title: "A", summary: "s", sources: [{ url: "https://bad.org/x", title: null }, { url: "https://good.org/x", title: "G" }] }],
    { seenUrls: ["https://bad.org/x", "https://good.org/x"] }, [], check
  );
  assert.deepEqual(out[0].sources, [{ url: "https://good.org/x", title: "G" }]);
});
test("kept sources are copied unchanged", async () => {
  const out = await keepCandidates(one("https://a.org/x/#frag", "<b>T</b>"), { seenUrls: ["https://a.org/x"] }, [], ok);
  assert.deepEqual(out[0].sources, [{ url: "https://a.org/x/#frag", title: "<b>T</b>" }]);
});
