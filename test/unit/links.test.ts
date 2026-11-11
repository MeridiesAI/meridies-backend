import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  checkLink,
  fetchReadablePage,
  fileKindOf,
  isBlockedAddress,
  LINK_ERRORS,
  LINK_MAX_CHARS,
  normalizeLink,
  prepareLink,
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

// ---- A pasted link: what it becomes, and the reason each bad one gets -------------------

/** The `code` an HttpError carries, or the error itself when it isn't one. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return "resolved";
}

test("prepareLink adds https:// to a bare address and leaves a full one alone", () => {
  assert.equal(prepareLink("  bucknell.edu "), "https://bucknell.edu");
  assert.equal(prepareLink("www.bucknell.edu/admissions"), "https://www.bucknell.edu/admissions");
  assert.equal(prepareLink("admissions.cornell.edu/apply?x=1"), "https://admissions.cornell.edu/apply?x=1");
  assert.equal(prepareLink("//cdn.example.edu/a"), "https://cdn.example.edu/a");
  assert.equal(prepareLink("https://www.bucknell.edu"), "https://www.bucknell.edu");
  assert.equal(prepareLink("http://www.bucknell.edu"), "http://www.bucknell.edu");
  // A host with a port reads as a scheme to URL; it is a host, and the port rule refuses it later.
  assert.equal(prepareLink("localhost:3000"), "https://localhost:3000");
  assert.equal(prepareLink("www.bucknell.edu:8080/x"), "https://www.bucknell.edu:8080/x");
  // Not addresses: left for validateUrl to refuse.
  assert.equal(prepareLink("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(prepareLink("not a url"), "not a url");
  assert.throws(() => prepareLink("   "), (e: { code?: string }) => e.code === "link_empty");
  assert.throws(() => prepareLink(`https://a.edu/${"a".repeat(LINK_MAX_CHARS)}`), (e: { code?: string }) => e.code === "link_too_long");
});

test("normalizeLink: every refusal carries its own code and sentence, before any request", async () => {
  let opened = 0;
  const restoreResolver = linkTesting.useResolver(async (host) => {
    if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
    if (host.endsWith(".invalid")) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return [PUBLIC];
  });
  const restoreOpener = linkTesting.useOpener(async () => {
    opened += 1;
    return fakeResponse(200, { "content-type": "text/html" });
  });
  try {
    const cases: [string, string][] = [
      ["", "link_empty"],
      ["not a url", "link_invalid"],
      ["abc", "link_invalid"],
      ["ftp://ftp.example.edu/file", "link_scheme"],
      ["javascript:alert(1)", "link_scheme"],
      ["data:text/html,hi", "link_scheme"],
      ["mailto:admissions@bucknell.edu", "link_scheme"],
      ["https://user:pass@www.bucknell.edu", "link_credentials"],
      ["http://www.bucknell.edu:8080/", "link_port"],
      ["http://127.0.0.1:4424/health", "link_port"],
      ["http://127.0.0.1/", "link_private"],
      ["http://localhost/", "link_private"],
      ["http://169.254.169.254/latest/meta-data", "link_private"],
      ["http://10.0.0.1/", "link_private"],
      ["http://[::1]/", "link_private"],
      ["http://[::ffff:127.0.0.1]/", "link_private"],
      ["192.168.1.1", "link_private"],
      ["https://no-such-host.invalid/", "link_dns"],
      [`https://www.bucknell.edu/${"a".repeat(2100)}`, "link_too_long"],
    ];
    for (const [raw, code] of cases) {
      assert.equal(await codeOf(normalizeLink(raw)), code, raw.slice(0, 60));
    }
    assert.equal(opened, 0, "validation alone never opens a connection");
    for (const code of new Set(cases.map(([, c]) => c))) {
      const sentence = LINK_ERRORS[code as keyof typeof LINK_ERRORS];
      assert.match(sentence, /^[A-Z].*\.$/, code);
      assert.doesNotMatch(sentence, /ENOTFOUND|ECONN|undefined|\bnull\b/, code);
    }

    assert.deepEqual(await normalizeLink("bucknell.edu"), { url: "https://bucknell.edu/", domain: "bucknell.edu" });
    assert.deepEqual(await normalizeLink(" https://www.bucknell.edu/admissions "), {
      url: "https://www.bucknell.edu/admissions",
      domain: "bucknell.edu",
    });
  } finally {
    restoreResolver();
    restoreOpener();
  }
});

test("reading a pasted link: a dead page, a file, a refusing site and an outage each say which", async () => {
  const restoreResolver = linkTesting.useResolver(async () => [PUBLIC]);
  const pages: Record<string, () => PinnedResponse> = {
    "/gone": () => fakeResponse(404, { "content-type": "text/html" }, "nope"),
    "/removed": () => fakeResponse(410, {}),
    "/private": () => fakeResponse(403, {}),
    "/busy": () => fakeResponse(503, {}),
    "/cds": () => fakeResponse(200, { "content-type": "application/pdf" }, "%PDF-1.7"),
    "/loop": () => fakeResponse(302, { location: "/loop" }),
    "/nowhere": () => fakeResponse(302, {}),
    "/to-metadata": () => fakeResponse(302, { location: "http://169.254.169.254/latest" }),
  };
  const restoreOpener = linkTesting.useOpener(async (hop) => {
    if (hop.url.pathname === "/down") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (hop.url.pathname === "/slow") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return (pages[hop.url.pathname] ?? (() => fakeResponse(200, { "content-type": "text/html" }, "<p>ok</p>")))();
  });
  try {
    const expect: [string, string][] = [
      ["/gone", "link_not_found"],
      ["/removed", "link_not_found"],
      ["/private", "link_refused"],
      ["/busy", "link_http_error"],
      ["/cds", "link_not_page"],
      ["/loop", "link_redirects"],
      ["/nowhere", "link_redirects"],
      ["/to-metadata", "link_private"],
      ["/down", "link_unreachable"],
      ["/slow", "link_timeout"],
    ];
    for (const [path, code] of expect) {
      assert.equal(await codeOf(fetchReadablePage(`https://www.example.edu${path}`)), code, path);
    }
    await assert.rejects(fetchReadablePage("https://www.example.edu/busy"), /an error \(503\)/);
    assert.equal((await fetchReadablePage("https://www.example.edu/fine")).domain, "example.edu");
  } finally {
    restoreResolver();
    restoreOpener();
  }
});

test("fileKindOf names a link to a file by its path, and only by its path", () => {
  assert.equal(fileKindOf("https://www.bucknell.edu/files/cds_2023.pdf"), "a PDF");
  assert.equal(fileKindOf("https://www.bucknell.edu/files/CDS.PDF?dl=1"), "a PDF");
  assert.equal(fileKindOf("https://x.edu/a/brochure.docx"), "a Word file");
  assert.equal(fileKindOf("https://x.edu/campus.jpg"), "an image");
  assert.equal(fileKindOf("https://www.bucknell.edu/admissions"), null);
  assert.equal(fileKindOf("https://www.bucknell.edu/"), null);
  assert.equal(fileKindOf("https://www.bucknell.edu/v1.2/apply"), null);
  assert.equal(fileKindOf("https://www.bucknell.edu/page.html"), null);
  assert.equal(fileKindOf("https://www.bucknell.edu/apply?file=x.pdf"), null);
  assert.equal(fileKindOf("not a url"), null);
});
