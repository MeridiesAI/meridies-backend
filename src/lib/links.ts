/**
 * Upload links: fetch a URL the counselor pasted, extract the readable text,
 * and hand it to the model to aggregate what's relevant.
 *
 * This is the only place in the API that makes an HTTP request to an address a
 * user chose, which makes it the only place that can be turned into a
 * server-side request forgery. The rules below are not optional:
 *
 *   - http/https only, default ports only, no credentials in the URL
 *   - the hostname is resolved and every address checked against the private,
 *     loopback, link-local and carrier-NAT ranges before a byte is fetched
 *   - redirects are followed MANUALLY, three hops at most, and every hop is
 *     re-validated — a public URL that 302s to 169.254.169.254 is the whole
 *     attack, and `redirect: "follow"` would take it
 *   - the response is capped by time, size and content type
 *
 *   - the connection goes to the address that was checked, never to a second
 *     answer from DNS: each hop resolves once, validates every address, and
 *     the socket's lookup returns only those (`pinnedLookup`). Without the pin
 *     a name could answer a public address to the check and 127.0.0.1 to the
 *     connection (DNS rebinding). The URL's own hostname still goes out as the
 *     Host header and the TLS server name, so virtual hosts and certificates
 *     work as usual.
 */

import { lookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { badRequest } from "./errors.js";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 40_000;

const READABLE_TYPES = [
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
];

/** The 16 bytes of an IPv6 address, or null when it isn't one. */
function ipv6Bytes(address: string): number[] | null {
  let ip = address.toLowerCase().replace(/%.*$/, "");
  // A trailing dotted quad (::ffff:10.0.0.1) becomes two hex groups.
  const dotted = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = dotted[2]!.split(".").map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    ip = `${dotted[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** Ranges that must never be reachable from a user-supplied URL. */
export function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    const b = ipv6Bytes(address);
    if (!b) return true;
    const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    const v4 = (at: number) => b.slice(at, at + 4).join(".");
    if (zeros(0, 16)) return true; // ::
    if (zeros(0, 15) && b[15] === 1) return true; // ::1
    // An IPv4 address carried inside IPv6 is judged as the IPv4 address it is:
    // mapped (::ffff:0:0/96), compatible (::/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16).
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedAddress(v4(12), 4);
    if (zeros(0, 12)) return isBlockedAddress(v4(12), 4);
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isBlockedAddress(v4(12), 4);
    if (b[0] === 0x20 && b[1] === 0x02) return isBlockedAddress(v4(2), 4);
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo hides its target
    if ((b[0]! & 0xfe) === 0xfc) return true; // unique-local fc00::/7
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // site-local fec0::/10 (deprecated)
    if (b[0] === 0xff) return true; // multicast
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** The addresses a hop may connect to: every one checked, in DNS order. */
export type PinnedAddress = { address: string; family: 4 | 6 };

type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
const dnsResolve: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true });
let resolveHost: Resolve = dnsResolve;

/** URL.hostname keeps the brackets on an IPv6 literal; sockets want it bare. */
const bareHost = (hostname: string) => hostname.replace(/^\[(.*)\]$/, "$1");

async function resolvePublic(hostname: string): Promise<PinnedAddress[]> {
  const host = bareHost(hostname);
  // A literal address skips DNS but not the range check.
  const literal = isIP(host);
  if (literal) {
    if (isBlockedAddress(host, literal)) {
      throw badRequest("That address isn't reachable from Meridies");
    }
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw badRequest("That domain doesn't resolve");
  }
  if (addresses.length === 0) throw badRequest("That domain doesn't resolve");
  const pinned: PinnedAddress[] = [];
  for (const { address, family } of addresses) {
    const fam = family === 6 ? 6 : family === 4 ? 4 : isIP(address);
    if ((fam !== 4 && fam !== 6) || isBlockedAddress(address, fam)) {
      throw badRequest("That address isn't reachable from Meridies");
    }
    pinned.push({ address, family: fam });
  }
  return pinned;
}

/**
 * A socket lookup that answers only with the addresses already checked, and
 * never asks DNS. Handles both call shapes Node uses (`all` for Happy
 * Eyeballs, a single address otherwise) and a family preference.
 */
export function pinnedLookup(pinned: readonly PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const want = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    const list = want ? pinned.filter((a) => a.family === want) : [...pinned];
    if (!list.length) {
      const err = Object.assign(new Error("no checked address for this host"), { code: "ENOTFOUND" });
      callback(err, "", 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: PinnedAddress[]) => void)(null, list);
      return;
    }
    callback(null, list[0]!.address, list[0]!.family);
  };
}

/** One validated hop: the URL and the only addresses it may connect to. */
type Hop = { url: URL; pinned: PinnedAddress[] };

/** Parse + validate one hop. Throws a 400 the client can act on. */
async function validateUrl(raw: string): Promise<Hop> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("That doesn't look like a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("Only http and https links can be read");
  }
  if (url.username || url.password) {
    throw badRequest("Remove the credentials from that URL");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw badRequest("Only standard web ports can be read");
  }
  return { url, pinned: await resolvePublic(url.hostname) };
}

/** Public entry point for validation alone, used before a row is written. */
export async function normalizeLink(
  raw: string
): Promise<{ url: string; domain: string }> {
  const { url } = await validateUrl(raw);
  return { url: url.toString(), domain: url.hostname.replace(/^www\./, "") };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

export function extractText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).trim().slice(0, 300) : null;

  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}

export type FetchedPage = {
  finalUrl: string;
  domain: string;
  title: string | null;
  text: string;
  contentType: string;
  /** Characters of readable text before truncation. */
  chars: number;
  truncated: boolean;
};

/** What one request answered: status, headers, and the (unread) body. */
export type PinnedResponse = { status: number; headers: IncomingHttpHeaders; body: Readable };

type OpenOptions = { method: "GET" | "HEAD"; headers: Record<string, string>; signal: AbortSignal };
type Open = (hop: Hop, options: OpenOptions) => Promise<PinnedResponse>;

const header = (h: IncomingHttpHeaders, name: string): string | null => {
  const v = h[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
};

/**
 * One request to a validated hop, on a fresh connection whose lookup is pinned
 * to the hop's checked addresses. No redirects are followed here, no
 * connection is reused (`agent: false`), and a compressed body is inflated.
 */
export const openPinned: Open = (hop, { method, headers, signal }) =>
  new Promise<PinnedResponse>((resolve, reject) => {
    const { url, pinned } = hop;
    const secure = url.protocol === "https:";
    const req = (secure ? https : http).request(
      {
        protocol: url.protocol,
        // The name, not the address: it is the Host header and the TLS server
        // name. Where the socket goes is decided by the pinned lookup alone.
        hostname: bareHost(url.hostname),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, "Accept-Encoding": "gzip, deflate, br" },
        lookup: pinnedLookup(pinned),
        agent: false,
        signal,
      },
      (res: IncomingMessage) => {
        const encoding = (header(res.headers, "content-encoding") ?? "").trim().toLowerCase();
        let body: Readable = res;
        if (method !== "HEAD") {
          const inflate =
            encoding === "gzip" || encoding === "x-gzip"
              ? zlib.createGunzip()
              : encoding === "deflate"
                ? zlib.createInflate()
                : encoding === "br"
                  ? zlib.createBrotliDecompress()
                  : null;
          if (inflate) {
            res.on("error", (e) => inflate.destroy(e));
            body = res.pipe(inflate);
          }
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      }
    );
    req.on("error", reject);
    req.end();
  });

let open: Open = openPinned;

/**
 * Test seams: swap DNS resolution and the request opener. Each returns a
 * function that restores the real one. Never called outside tests.
 */
export const linkTesting = {
  useResolver(fn: Resolve): () => void {
    resolveHost = fn;
    return () => {
      resolveHost = dnsResolve;
    };
  },
  useOpener(fn: Open): () => void {
    open = fn;
    return () => {
      open = openPinned;
    };
  },
};

const isAbort = (err: unknown) =>
  err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

/** Read a body up to MAX_BYTES; past that, stop and drop the rest. */
async function readCapped(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > MAX_BYTES) break;
    chunks.push(buf);
  }
  body.destroy();
  return Buffer.concat(chunks);
}

/**
 * Fetch and extract. Follows redirects by hand so each hop is re-validated
 * (and re-pinned), and never returns more than MAX_TEXT_CHARS of text to a prompt.
 */
export async function fetchReadablePage(rawUrl: string): Promise<FetchedPage> {
  let current = await validateUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // One deadline per hop, covering the body as well as the headers.
    const signal = AbortSignal.timeout(TIMEOUT_MS);

    let res: PinnedResponse;
    try {
      res = await open(current, {
        method: "GET",
        signal,
        headers: {
          // Identify the crawler honestly; some sites rightly block blanks.
          "User-Agent": "Meridies-LinkReader/1.0 (+https://meridiesai.com)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
      });
    } catch (err) {
      throw badRequest(isAbort(err) ? "That page took too long to respond" : "Couldn't reach that page");
    }

    if (res.status >= 300 && res.status < 400) {
      res.body.destroy();
      const location = header(res.headers, "location");
      if (!location) throw badRequest("That link redirects nowhere");
      if (hop === MAX_REDIRECTS) throw badRequest("That link redirects too many times");
      // Re-validate the target: this is the hop an SSRF attempt rides on.
      current = await validateUrl(new URL(location, current.url).toString());
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      res.body.destroy();
      throw badRequest(`That page returned ${res.status}`);
    }

    const contentType = (header(res.headers, "content-type") ?? "").toLowerCase();
    if (!READABLE_TYPES.some((t) => contentType.includes(t))) {
      res.body.destroy();
      throw badRequest(
        "That link isn't a readable web page. Upload a PDF as a document instead."
      );
    }

    const declared = Number(header(res.headers, "content-length") ?? 0);
    if (declared > MAX_BYTES) {
      res.body.destroy();
      throw badRequest("That page is too large to read");
    }

    // Stream with a hard cap: content-length is a claim, not a promise.
    let raw: string;
    try {
      raw = (await readCapped(res.body)).toString("utf8");
    } catch (err) {
      res.body.destroy();
      throw badRequest(isAbort(err) ? "That page took too long to respond" : "Couldn't read that page");
    }
    const isHtml = contentType.includes("html") || contentType.includes("xml");
    const { title, text } = isHtml
      ? extractText(raw)
      : { title: null, text: raw.replace(/\s+/g, " ").trim() };

    return {
      finalUrl: current.url.toString(),
      domain: current.url.hostname.replace(/^www\./, ""),
      title,
      text: text.slice(0, MAX_TEXT_CHARS),
      contentType,
      chars: text.length,
      truncated: text.length > MAX_TEXT_CHARS,
    };
  }

  throw badRequest("That link redirects too many times");
}

export type LinkCheck = {
  /** ok: answers 2xx. broken: 404/410, or the name no longer resolves. blocked: the site refuses or drops robots (401/403/429, no answer) or errs (5xx), so we can't say. */
  status: "ok" | "broken" | "blocked";
  code: number | null;
  finalUrl: string | null;
};

/**
 * Does this link still answer? The resource library's weekly check. Same
 * per-hop validation and pinning as fetchReadablePage, but HEAD (GET when a
 * site refuses HEAD) and the body is never read. A site that blocks robots is
 * "blocked", not "broken": nothing is deleted on the strength of a 403.
 */
export async function checkLink(rawUrl: string): Promise<LinkCheck> {
  let current: Hop;
  try {
    current = await validateUrl(rawUrl);
  } catch {
    return { status: "broken", code: null, finalUrl: null };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const at = current.url.toString();
    let res: PinnedResponse | null = null;
    for (const method of ["HEAD", "GET"] as const) {
      try {
        res = await open(current, {
          method,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          // The conventional crawler form, still naming us: several government
          // sites (CSAC) refuse a bare bot string and answer this one.
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Meridies-LinkCheck/1.0; +https://meridiesai.com)",
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          },
        });
      } catch {
        res = null;
      }
      res?.body.destroy();
      // Some servers answer HEAD with 403/405/501 and GET with 200.
      if (res && method === "HEAD" && [403, 405, 501].includes(res.status)) continue;
      break;
    }
    // The name resolved and the address is public, but nothing answered: sites
    // like studentaid.gov drop automated requests. We can't say it's gone.
    if (!res) return { status: "blocked", code: null, finalUrl: at };

    if (res.status >= 300 && res.status < 400) {
      const location = header(res.headers, "location");
      if (!location || hop === MAX_REDIRECTS) return { status: "broken", code: res.status, finalUrl: at };
      try {
        current = await validateUrl(new URL(location, current.url).toString());
      } catch {
        return { status: "broken", code: res.status, finalUrl: at };
      }
      continue;
    }
    if (res.status >= 200 && res.status < 300) return { status: "ok", code: res.status, finalUrl: at };
    if (res.status === 404 || res.status === 410) return { status: "broken", code: res.status, finalUrl: at };
    return { status: "blocked", code: res.status, finalUrl: at };
  }
  return { status: "broken", code: null, finalUrl: current.url.toString() };
}
