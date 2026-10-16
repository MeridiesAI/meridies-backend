import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  checkLink,
  fetchReadablePage,
  isBlockedAddress,
  linkTesting,
  openPinned,
  pinnedLookup,
  type PinnedAddress,
  type PinnedResponse,
} from "../../src/lib/links.js";

// A server on loopback: the address a rebinding attack wants to reach.
let port = 0;
const hits: { host: string | undefined; path: string | undefined }[] = [];
const server = createServer((req, res) => {
  hits.push({ host: req.headers.host, path: req.url });
  if (req.url === "/gz") {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.end(gzipSync("inflated body"));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<title>Loopback</title><p>secret</p>");
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

const PUBLIC: PinnedAddress = { address: "93.184.215.14", family: 4 };

/** Answers `first` once, then the loopback address forever: a rebinding name. */
function rebindingResolver(first: { address: string; family: number }[]) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return calls === 1 ? first : [{ address: "127.0.0.1", family: 4 }];
  };
  return { fn, calls: () => calls };
}

const fakeResponse = (status: number, headers: IncomingHttpHeaders, body = ""): PinnedResponse => ({
  status,
  headers,
  body: Readable.from([Buffer.from(body)]),
});

test("blocked ranges, including IPv4 carried inside IPv6", () => {
  for (const [ip, fam] of [
    ["127.0.0.1", 4], ["10.1.2.3", 4], ["169.254.169.254", 4], ["100.64.0.1", 4], ["198.18.0.1", 4], ["0.0.0.0", 4],
    ["::1", 6], ["::", 6], ["fe80::1", 6], ["fd00::1", 6], ["ff02::1", 6],
    ["::ffff:127.0.0.1", 6], ["::ffff:7f00:1", 6], ["::ffff:a9fe:a9fe", 6], ["64:ff9b::a00:1", 6],
    ["2002:7f00:1::", 6], ["2001:0:1::1", 6], ["not-an-ip", 6], ["1.2.3", 4],
  ] as const) {
    assert.equal(isBlockedAddress(ip, fam), true, ip);
  }
  for (const [ip, fam] of [["93.184.215.14", 4], ["8.8.8.8", 4], ["2606:4700::6810:84e5", 6], ["::ffff:8.8.8.8", 6]] as const) {
    assert.equal(isBlockedAddress(ip, fam), false, ip);
  }
});

test("pinnedLookup answers only with the checked addresses, in both call shapes", () => {
  const pinned: PinnedAddress[] = [PUBLIC, { address: "2606:4700::6810:84e5", family: 6 }];
  const lookup = pinnedLookup(pinned);
  lookup("evil.example", { all: true }, (err, addrs) => {
    assert.equal(err, null);
    assert.deepEqual(addrs, pinned);
  });
  lookup("evil.example", {}, (err, addr, fam) => {
    assert.equal(err, null);
    assert.equal(addr, PUBLIC.address);
    assert.equal(fam, 4);
  });
  lookup("evil.example", { family: 6 }, (_err, addr) => assert.equal(addr, "2606:4700::6810:84e5"));
  pinnedLookup([PUBLIC])("evil.example", { family: 6 }, (err) => assert.ok(err));
});

test("openPinned connects to the pinned address, never to DNS, and keeps the Host", async () => {
  hits.length = 0;
  // .invalid never resolves (RFC 6761): reaching the server proves the pin was used.
  const url = new URL(`http://rebind.invalid:${port}/page?x=1`);
  const res = await openPinned(
    { url, pinned: [{ address: "127.0.0.1", family: 4 }] },
    { method: "GET", headers: {}, signal: AbortSignal.timeout(5000) }
  );
  assert.equal(res.status, 200);
  res.body.destroy();
  assert.deepEqual(hits, [{ host: `rebind.invalid:${port}`, path: "/page?x=1" }]);
});

test("openPinned inflates a compressed body", async () => {
  const res = await openPinned(
    { url: new URL(`http://gz.invalid:${port}/gz`), pinned: [{ address: "127.0.0.1", family: 4 }] },
    { method: "GET", headers: {}, signal: AbortSignal.timeout(5000) }
  );
  const chunks: Buffer[] = [];
  for await (const c of res.body) chunks.push(c as Buffer);
  assert.equal(Buffer.concat(chunks).toString(), "inflated body");
});

test("DNS rebinding: a private second answer is never connected to (fetchReadablePage)", async () => {
  const resolver = rebindingResolver([PUBLIC]);
  const seen: PinnedAddress[][] = [];
  const restoreResolver = linkTesting.useResolver(resolver.fn);
  const restoreOpener = linkTesting.useOpener(async (hop) => {
    seen.push(hop.pinned);
    return fakeResponse(200, { "content-type": "text/html" }, "<title>ok</title>hello");
  });
  try {
    const page = await fetchReadablePage("http://rebind.example/");
    assert.equal(page.title, "ok");
    assert.equal(resolver.calls(), 1, "one resolution per hop, the one that was checked");
    assert.deepEqual(seen, [[PUBLIC]]);
  } finally {
    restoreResolver();
    restoreOpener();
  }
});

test("DNS rebinding: every redirect hop is resolved once, checked, and pinned", async () => {
  const answers: Record<string, { address: string; family: number }[]> = {
    "a.example": [PUBLIC],
    "b.example": [{ address: "8.8.8.8", family: 4 }],
    "c.example": [{ address: "10.0.0.5", family: 4 }],
  };
  const resolved: string[] = [];
  const seen: PinnedAddress[][] = [];
  const restoreResolver = linkTesting.useResolver(async (host) => {
    resolved.push(host);
    return answers[host] ?? [];
  });
  const restoreOpener = linkTesting.useOpener(async (hop) => {
    seen.push(hop.pinned);
    if (hop.url.hostname === "a.example") return fakeResponse(302, { location: "http://b.example/next" });
    if (hop.url.hostname === "b.example") return fakeResponse(301, { location: "http://c.example/" });
    return fakeResponse(200, { "content-type": "text/plain" }, "should never be reached");
  });
  try {
    await assert.rejects(fetchReadablePage("http://a.example/"), /isn't reachable/);
    assert.deepEqual(resolved, ["a.example", "b.example", "c.example"]);
    assert.deepEqual(seen, [[PUBLIC], [{ address: "8.8.8.8", family: 4 }]], "c.example was never opened");
    const check = await checkLink("http://a.example/");
    assert.equal(check.status, "broken");
  } finally {
    restoreResolver();
    restoreOpener();
  }
});

test("a name with any private answer is refused before a request is made", async () => {
  let opened = 0;
  const restoreResolver = linkTesting.useResolver(async () => [PUBLIC, { address: "127.0.0.1", family: 4 }]);
  const restoreOpener = linkTesting.useOpener(async () => {
    opened += 1;
    return fakeResponse(200, { "content-type": "text/html" });
  });
  try {
    await assert.rejects(fetchReadablePage("http://mixed.example/"), /isn't reachable/);
    assert.equal((await checkLink("http://mixed.example/")).status, "broken");
    assert.equal(opened, 0);
  } finally {
    restoreResolver();
    restoreOpener();
  }
});

test("an abort while the body is unread does not crash, and a reader sees it", async () => {
  const slow = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    // never ends
  });
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
  const slowPort = (slow.address() as AddressInfo).port;
  try {
    const controller = new AbortController();
    const res = await openPinned(
      { url: new URL(`http://slow.invalid:${slowPort}/`), pinned: [{ address: "127.0.0.1", family: 4 }] },
      { method: "GET", headers: {}, signal: controller.signal }
    );
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(async () => {
      for await (const _ of res.body) void _;
    });
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});

test("a 2 MB page of unclosed tags is read without holding the event loop (the review's attack)", async () => {
  // A student pastes a link to a page that is "<a" (or "<script", or "<!--")
  // repeated to the 2 MB cap with no closing token. The old regular
  // expressions took minutes on this; the page must be read in well under a
  // second, and other work must keep running while it is.
  const restoreResolver = linkTesting.useResolver(async () => [PUBLIC]);
  for (const unit of ["<a", "<script", "<!--", "<style", "<title"]) {
    const body = unit.repeat(Math.ceil(2_000_000 / unit.length)).slice(0, 2_000_000);
    const restoreOpener = linkTesting.useOpener(async () => fakeResponse(200, { "content-type": "text/html" }, body));
    try {
      const started = performance.now();
      const page = await fetchReadablePage("https://attacker.example/x");
      const ms = performance.now() - started;
      assert.ok(ms < 1000, `${unit} page took ${ms.toFixed(0)} ms`);
      assert.equal(page.domain, "attacker.example");
    } finally {
      restoreOpener();
    }
  }
  restoreResolver();
});
