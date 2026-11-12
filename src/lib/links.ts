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
import { badRequest, HttpError } from "./errors.js";
import { sniffImage } from "./imageConvert.js";
import { asciiLower, replaceBlocks, replaceTags } from "./linearText.js";

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
      throw linkError("link_private");
    }
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw linkError("link_dns");
  }
  if (addresses.length === 0) throw linkError("link_dns");
  const pinned: PinnedAddress[] = [];
  for (const { address, family } of addresses) {
    const fam = family === 6 ? 6 : family === 4 ? 4 : isIP(address);
    if ((fam !== 4 && fam !== 6) || isBlockedAddress(address, fam)) {
      throw linkError("link_private");
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

/** The longest link read or saved. Past this it is nearly always a pasted tracking blob. */
export const LINK_MAX_CHARS = 2000;

/**
 * Why a link was refused or couldn't be read, each in a sentence a counselor can act on.
 * The code travels with the 400 (`{ error, code }`) so the app can branch on it.
 */
export const LINK_ERRORS = {
  link_empty: "Paste a link to a web page, starting with https://.",
  link_invalid: "That doesn't look like a web address. Paste a link like https://admissions.example.edu.",
  link_too_long: `That link is too long to read (over ${LINK_MAX_CHARS.toLocaleString("en-US")} characters). Open the page and copy its address again.`,
  link_scheme: "Only web links can be read: paste one that starts with https://.",
  link_credentials: "That link has a username or password in it. Remove them and paste it again.",
  link_port: "That link uses an unusual port. Only standard web addresses can be read.",
  link_private: "That link points to a private or local address, which isn't reachable from Meridies.",
  link_dns: "We couldn't find that website. Check the address for typos.",
  link_unreachable: "That website didn't answer. Check the link, or try again later.",
  link_timeout: "That page took too long to respond. Try again later.",
  link_redirects: "That link keeps redirecting, so it couldn't be read.",
  link_not_found: "That page wasn't found on the site. Check the link.",
  link_refused: "That site doesn't let Meridies read its pages.",
  link_http_error: "That site answered with an error. Try again later.",
  link_not_page: "That link is a file, not a web page. Download it and upload it as a document instead.",
  link_too_large: "That page is too large to read.",
  link_no_text: "That page has almost no text to read.",
} as const;

export type LinkErrorCode = keyof typeof LINK_ERRORS;

/** A 400 with the link's reason; `message` overrides the stock sentence. */
export const linkError = (code: LinkErrorCode, message: string = LINK_ERRORS[code]) =>
  new HttpError(400, message, code);

/** The error for a page that answered `status` (not 2xx, not a redirect). */
function statusError(status: number): HttpError {
  if (status === 404 || status === 410) return linkError("link_not_found");
  if (status === 401 || status === 403 || status === 429) return linkError("link_refused");
  return linkError("link_http_error", `That site answered with an error (${status}). Try again later.`);
}

/** A host with at least one dot, an optional port, then a path or nothing: "www.bucknell.edu/apply". */
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i;
const HOST_PORT = /^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+([/?#]|$)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * What a counselor pasted, trimmed and with "https://" added to a bare address
 * ("bucknell.edu", "www.bucknell.edu/apply", "//cdn.example.edu/x"), refused when
 * empty or too long. Everything else (scheme, port, credentials, the address) is
 * `validateUrl`'s. The patterns are anchored and run on at most LINK_MAX_CHARS.
 */
export function prepareLink(raw: string): string {
  const s = raw.trim();
  if (!s) throw linkError("link_empty");
  if (s.length > LINK_MAX_CHARS) throw linkError("link_too_long");
  if (s.startsWith("//")) return `https:${s}`;
  // "localhost:3000" and "www.x.edu:8080" read as a scheme to URL; they are hosts.
  if (HAS_SCHEME.test(s) && !HOST_PORT.test(s)) return s;
  if (BARE_HOST.test(s) || /^localhost(:\d+)?([/?#]|$)/i.test(s)) return `https://${s}`;
  return s;
}

/** Parse + validate one hop. Throws a 400 the client can act on. */
async function validateUrl(raw: string): Promise<Hop> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw linkError("link_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw linkError("link_scheme");
  if (url.username || url.password) throw linkError("link_credentials");
  if (url.port && url.port !== "80" && url.port !== "443") throw linkError("link_port");
  if (!url.hostname) throw linkError("link_invalid");
  return { url, pinned: await resolvePublic(url.hostname) };
}

/**
 * Public entry point for validation alone, used before a row is written. Takes
 * what the user pasted (a bare "bucknell.edu" included) and answers the URL to store.
 */
export async function normalizeLink(
  raw: string
): Promise<{ url: string; domain: string }> {
  const { url } = await validateUrl(prepareLink(raw));
  const href = url.toString();
  if (href.length > LINK_MAX_CHARS) throw linkError("link_too_long");
  return { url: href, domain: url.hostname.replace(/^www\./, "") };
}

const FILE_KINDS: Record<string, string> = {
  pdf: "a PDF",
  doc: "a Word file",
  docx: "a Word file",
  xls: "a spreadsheet",
  xlsx: "a spreadsheet",
  csv: "a spreadsheet",
  ppt: "a slide deck",
  pptx: "a slide deck",
  zip: "a zip file",
  jpg: "an image",
  jpeg: "an image",
  png: "an image",
  gif: "an image",
  webp: "an image",
  mp4: "a video",
  mov: "a video",
  mp3: "an audio file",
};

/**
 * "a PDF" when the link's path names a file the reader can't take (by its
 * extension), else null. A page that serves a PDF without saying so in its
 * path is still caught by the Content-Type check when it is read.
 */
export function fileKindOf(href: string): string | null {
  let path: string;
  try {
    path = new URL(href).pathname.toLowerCase();
  } catch {
    return null;
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return null;
  return FILE_KINDS[path.slice(dot + 1)] ?? null;
}

/** Named entities pages print in titles and copy; anything else named is left as written. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", bull: "•", hellip: "…", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", deg: "°",
};

/**
 * HTML entities to their characters, in one pass, so "&amp;#038;" stays "&#038;" (it is not decoded
 * twice). Numeric ones too: WordPress prints "&" in titles as "&#038;" (mitadmissions.org's
 * "Deadlines &#038; requirements"), and a stored title or page text used to keep the code.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      // No NUL, surrogates or code points past Unicode: keep those as written.
      if (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) return String.fromCodePoint(code);
      return whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * The first `<title ...>` and up to 300 characters before its `</title>`, the
 * way `/<title[^>]*>([\s\S]{0,300}?)<\/title>/i` finds it, without the
 * regular expression's rescans (see linearText.ts).
 */
function findTitle(html: string, lower: string): string | null {
  let from = 0;
  let gt = -1;
  let close = -1;
  for (;;) {
    const start = lower.indexOf("<title", from);
    if (start < 0) return null;
    // `[^>]*` stops at the first ">" after the tag name; a later "<title"
    // before that ">" shares it, so it is looked up once.
    if (gt < start + 6) gt = lower.indexOf(">", start + 6);
    if (gt < 0) return null;
    // The lazy `{0,300}?` ends at the first "</title>" after the ">", which
    // is also shared; no "</title>" anywhere after it means no title at all.
    if (close < gt + 1) close = lower.indexOf("</title>", gt + 1);
    if (close < 0) return null;
    if (close - (gt + 1) <= 300) return html.slice(gt + 1, close);
    from = start + 1;
  }
}

/**
 * A page's title and readable text. Linear in the page (a 2 MB body is the
 * most `readCapped` lets through): every scan here is `indexOf` from a moving
 * position, never a regular expression that rescans when its closing token is
 * missing (`<script` with no `</script>`, `<!--` with no `-->`, `<a` with no
 * `>`), which took minutes per request on the event loop every tenant shares.
 */
export function extractText(html: string): { title: string | null; text: string } {
  const rawTitle = findTitle(html, asciiLower(html));
  const title = rawTitle === null ? null : decodeEntities(rawTitle).trim().slice(0, 300);

  let body = replaceBlocks(html, "<script", "</script>", " ");
  body = replaceBlocks(body, "<style", "</style>", " ");
  body = replaceBlocks(body, "<noscript", "</noscript>", " ");
  body = replaceBlocks(body, "<!--", "-->", " ");
  body = body
    // Fixed-length alternatives: each start position is a bounded check.
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = decodeEntities(replaceTags(body, " "))
    // Every run of spaces, tabs and no-break spaces to one space, as
    // `/[ \t\u00a0]+/g` did, without rewriting the single spaces already there
    // (a page of 500,000 of them took 140 ms that way).
    .replace(/[ \t\u00a0]{2,}|[\t\u00a0]/g, " ")
    // A line holding only a space is blank: drop the space so the blank lines below collapse (a menu
    // of empty tags left "\n \n \n" runs that took a seventh of a page's stored text).
    .replace(/ ?\n ?/g, "\n")
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
        // An abort can land before anyone reads the body; an 'error' with no
        // listener would crash the process. Readers still see the error (the
        // async iterator listens for it too).
        res.on("error", () => undefined);
        body.on("error", () => undefined);
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
      throw linkError(isAbort(err) ? "link_timeout" : "link_unreachable");
    }

    if (res.status >= 300 && res.status < 400) {
      res.body.destroy();
      const location = header(res.headers, "location");
      if (!location) throw linkError("link_redirects");
      if (hop === MAX_REDIRECTS) throw linkError("link_redirects");
      // Re-validate the target: this is the hop an SSRF attempt rides on.
      current = await validateUrl(new URL(location, current.url).toString());
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      res.body.destroy();
      throw statusError(res.status);
    }

    const contentType = (header(res.headers, "content-type") ?? "").toLowerCase();
    if (!READABLE_TYPES.some((t) => contentType.includes(t))) {
      res.body.destroy();
      throw linkError("link_not_page");
    }

    const declared = Number(header(res.headers, "content-length") ?? 0);
    if (declared > MAX_BYTES) {
      res.body.destroy();
      throw linkError("link_too_large");
    }

    // Stream with a hard cap: content-length is a claim, not a promise.
    let raw: string;
    try {
      raw = (await readCapped(res.body)).toString("utf8");
    } catch (err) {
      res.body.destroy();
      throw linkError(isAbort(err) ? "link_timeout" : "link_unreachable");
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

  throw linkError("link_redirects");
}

// ---- Page metadata and one image (college lookup) ------------------------------------------

type FetchedBytes = { finalUrl: URL; contentType: string; bytes: Buffer };

/**
 * GET with the same per-hop validation, pinning and caps as fetchReadablePage,
 * for a body the caller reads as bytes. `truncate` keeps the first `maxBytes`
 * of a longer page (a `<head>` is at the top); otherwise a longer body is refused.
 */
async function fetchBytes(
  rawUrl: string,
  o: { accept: string; types: string[]; maxBytes: number; truncate: boolean }
): Promise<FetchedBytes> {
  let current = await validateUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let res: PinnedResponse;
    try {
      res = await open(current, {
        method: "GET",
        signal,
        headers: { "User-Agent": "Meridies-LinkReader/1.0 (+https://meridiesai.com)", Accept: o.accept },
      });
    } catch (err) {
      throw linkError(isAbort(err) ? "link_timeout" : "link_unreachable");
    }

    if (res.status >= 300 && res.status < 400) {
      res.body.destroy();
      const location = header(res.headers, "location");
      if (!location) throw linkError("link_redirects");
      if (hop === MAX_REDIRECTS) throw linkError("link_redirects");
      current = await validateUrl(new URL(location, current.url).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.body.destroy();
      throw statusError(res.status);
    }

    const contentType = (header(res.headers, "content-type") ?? "").toLowerCase();
    if (!o.types.some((t) => contentType.includes(t))) {
      res.body.destroy();
      throw linkError("link_not_page", "That link isn't the kind of file we can read.");
    }
    const declared = Number(header(res.headers, "content-length") ?? 0);
    if (!o.truncate && declared > o.maxBytes) {
      res.body.destroy();
      throw linkError("link_too_large", "That file is too large to read.");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.byteLength;
        if (total > o.maxBytes) {
          if (!o.truncate) throw linkError("link_too_large", "That file is too large to read.");
          chunks.push(buf.subarray(0, buf.byteLength - (total - o.maxBytes)));
          break;
        }
        chunks.push(buf);
      }
    } catch (err) {
      res.body.destroy();
      if (err instanceof Error && "statusCode" in err) throw err;
      throw linkError(isAbort(err) ? "link_timeout" : "link_unreachable");
    }
    res.body.destroy();
    return { finalUrl: current.url, contentType, bytes: Buffer.concat(chunks) };
  }
  throw linkError("link_redirects");
}

export type PageMeta = {
  finalUrl: string;
  title: string | null;
  description: string | null;
  /** The page's og:image (or twitter:image) as an absolute http(s) URL, unchecked. The first of `images`. */
  image: string | null;
  /** The icons the page declares (`<link rel="apple-touch-icon" | "icon">`), absolute http(s) URLs, unchecked. */
  icons?: PageIcon[];
  /**
   * Every image the head declares, best first, each once, as absolute http(s)
   * URLs, unchecked: og:image:secure_url, og:image, og:image:url,
   * twitter:image(:src), then <link rel="image_src">. At most MAX_IMAGE_CANDIDATES.
   */
  images?: string[];
};

const IMAGE_KEYS = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];
const MAX_IMAGE_CANDIDATES = 8;
const MAX_VALUES_PER_KEY = 6;
const MAX_LINK_TAGS = 100;

export type PageIcon = { href: string; rel: string; sizes: string | null; type: string | null };

/** One `<meta ...>` tag's attributes, read character by character so a `>` inside quotes doesn't end it. */
function readTag(html: string, from: number): { attrs: Map<string, string>; end: number } {
  const attrs = new Map<string, string>();
  const limit = Math.min(html.length, from + 2000);
  let i = from;
  while (i < limit && html[i] !== ">") {
    while (i < limit && /[\s/]/.test(html[i]!)) i += 1;
    const nameStart = i;
    while (i < limit && !/[\s=>/]/.test(html[i]!)) i += 1;
    const name = html.slice(nameStart, i).toLowerCase();
    while (i < limit && /\s/.test(html[i]!)) i += 1;
    let value = "";
    if (html[i] === "=") {
      i += 1;
      while (i < limit && /\s/.test(html[i]!)) i += 1;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        const stop = close < 0 || close > limit ? limit : close;
        value = html.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const vs = i;
        while (i < limit && !/[\s>]/.test(html[i]!)) i += 1;
        value = html.slice(vs, i);
      }
    }
    if (name && !attrs.has(name)) attrs.set(name, value);
  }
  return { attrs, end: i };
}

/** The title, description and share image a page declares in its head. Linear in the page. */
export function parsePageMeta(html: string, base: URL): PageMeta {
  const head = html.slice(0, 400_000);
  const lower = asciiLower(head);
  const tags = new Map<string, string>();
  // Every value of an image tag, not just the first: pages often list several.
  const imageValues = new Map<string, string[]>();
  let from = 0;
  for (let n = 0; n < 300; n += 1) {
    const start = lower.indexOf("<meta", from);
    if (start < 0) break;
    const { attrs, end } = readTag(head, start + 5);
    from = end + 1;
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content && !tags.has(key)) tags.set(key, decodeEntities(content).trim());
    if (content && IMAGE_KEYS.includes(key)) {
      const list = imageValues.get(key) ?? [];
      if (list.length < MAX_VALUES_PER_KEY) imageValues.set(key, [...list, decodeEntities(content).trim()]);
    }
  }
  // <link rel="image_src" href="..."> is the older way to name a share image.
  const linkImages: string[] = [];
  let linkFrom = 0;
  for (let n = 0; n < MAX_LINK_TAGS && linkImages.length < MAX_VALUES_PER_KEY; n += 1) {
    const start = lower.indexOf("<link", linkFrom);
    if (start < 0) break;
    const { attrs, end } = readTag(head, start + 5);
    linkFrom = end + 1;
    const href = attrs.get("href");
    if (href && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("image_src")) linkImages.push(decodeEntities(href).trim());
  }
  const icons: PageIcon[] = [];
  from = 0;
  for (let n = 0; n < 200 && icons.length < 20; n += 1) {
    const start = lower.indexOf("<link", from);
    if (start < 0) break;
    const { attrs, end } = readTag(head, start + 5);
    from = end + 1;
    const rel = (attrs.get("rel") ?? "").toLowerCase().trim();
    const href = attrs.get("href");
    if (!href || !(rel.includes("icon"))) continue;
    try {
      const u = new URL(decodeEntities(href).trim(), base);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      icons.push({ href: u.toString(), rel, sizes: attrs.get("sizes")?.toLowerCase().trim() || null, type: attrs.get("type")?.toLowerCase().trim() || null });
    } catch {
      // not a URL
    }
  }
  const rawTitle = findTitle(head, lower);
  const clip = (v: string | undefined | null, n: number) => (v ? v.replace(/\s+/g, " ").trim().slice(0, n) || null : null);

  const images: string[] = [];
  for (const v of [...IMAGE_KEYS.flatMap((k) => imageValues.get(k) ?? []), ...linkImages]) {
    if (images.length >= MAX_IMAGE_CANDIDATES) break;
    try {
      const u = new URL(v, base);
      if ((u.protocol === "http:" || u.protocol === "https:") && !images.includes(u.toString())) images.push(u.toString());
    } catch {
      // not a URL; skip it
    }
  }
  return {
    finalUrl: base.toString(),
    title: clip(tags.get("og:title") ?? (rawTitle === null ? null : decodeEntities(rawTitle)), 200),
    description: clip(tags.get("og:description") ?? tags.get("description"), 400),
    image: images[0] ?? null,
    images,
    icons,
  };
}

/** A page's declared title, description and share image (college lookup). */
export async function fetchPageMeta(rawUrl: string): Promise<PageMeta> {
  const page = await fetchBytes(rawUrl, {
    accept: "text/html,application/xhtml+xml;q=0.9",
    types: ["text/html", "application/xhtml+xml"],
    maxBytes: 600_000,
    truncate: true,
  });
  return parsePageMeta(page.bytes.toString("utf8"), page.finalUrl);
}

// ---- A whole page: text, links and meta from one fetch (college site info) ----------------

export type SiteLink = { href: string; text: string };

/** What one page of a college's site gave: its readable text, the links on it and what its head declares. */
export type SitePage = {
  finalUrl: string;
  title: string | null;
  text: string;
  meta: PageMeta;
  links: SiteLink[];
};

const MAX_SITE_PAGE_BYTES = 1_500_000;
/** The most links kept from a page, and the most `<a` tags looked at to find them. */
const MAX_LINKS = 400;
const MAX_ANCHORS_SCANNED = 5_000;
const MAX_LINK_TEXT = 120;
/** How far past an anchor's `>` its text may run before the cut: a link's words are short. */
const LINK_TEXT_WINDOW = 600;

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/**
 * The page's links: absolute http(s) URLs without their fragment, with the
 * anchor's words, at most MAX_LINKS (400), each URL once. Linear in the page:
 * every scan is `indexOf` from a moving position and at most MAX_ANCHORS_SCANNED
 * anchors are read, so a page of "<a" with no ">" (or no "</a") costs a bounded
 * amount, not a rescan per anchor (see linearText.ts).
 */
export function extractLinks(source: string, base: URL): SiteLink[] {
  // Anchors inside a script's string, a style or a comment are not links on the page.
  let html = replaceBlocks(source, "<script", "</script>", " ");
  html = replaceBlocks(html, "<style", "</style>", " ");
  html = replaceBlocks(html, "<!--", "-->", " ");
  const lower = asciiLower(html);
  const found = new Map<string, SiteLink>();
  let from = 0;
  // The next "</a" at or after the anchor being read; looked up again only once it is behind us.
  let close = -1;
  let noMoreCloses = false;

  for (let n = 0; n < MAX_ANCHORS_SCANNED && found.size < MAX_LINKS; n += 1) {
    const start = lower.indexOf("<a", from);
    if (start < 0) break;
    from = start + 2;
    // "<a" then white space: an anchor with attributes, not <abbr>, <article> or <aside>.
    if (!isSpace(lower.charCodeAt(start + 2))) continue;

    const { attrs, end } = readTag(html, start + 2);
    from = Math.max(from, end + 1);
    const raw = attrs.get("href");
    if (!raw) continue;
    const href = decodeEntities(raw).trim();
    if (!href || href.startsWith("#")) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";

    let text = "";
    if (html[end] === ">" && !noMoreCloses) {
      if (close < end + 1) {
        close = lower.indexOf("</a", end + 1);
        if (close < 0) noMoreCloses = true;
      }
      if (!noMoreCloses) {
        const words = replaceTags(html.slice(end + 1, Math.min(close, end + 1 + LINK_TEXT_WINDOW)), " ");
        text = decodeEntities(words).replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT);
      }
    }

    const key = url.toString();
    const seen = found.get(key);
    if (!seen) found.set(key, { href: key, text });
    else if (!seen.text && text) seen.text = text;
  }
  return [...found.values()];
}

/**
 * One page of a college's site through the same pinned, redirect-checked fetch
 * as the rest of this file: the text a model may read, the links to follow and
 * the head's title, description and share images, from a single request.
 */
export async function fetchSitePage(rawUrl: string): Promise<SitePage> {
  const page = await fetchBytes(rawUrl, {
    accept: "text/html,application/xhtml+xml;q=0.9",
    types: ["text/html", "application/xhtml+xml"],
    maxBytes: MAX_SITE_PAGE_BYTES,
    truncate: true,
  });
  const html = page.bytes.toString("utf8");
  const { title, text } = extractText(html);
  return {
    finalUrl: page.finalUrl.toString(),
    title,
    text: text.slice(0, MAX_TEXT_CHARS),
    meta: parsePageMeta(html, page.finalUrl),
    links: extractLinks(html, page.finalUrl),
  };
}

/**
 * One picture a college's page names, at most `maxBytes`: a JPEG, PNG or WebP
 * by Content-Type and, because a type is only a claim, by its first bytes.
 * The same validation and pinning as everything else here.
 */
export async function fetchImageAny(rawUrl: string, maxBytes: number): Promise<{ finalUrl: string; bytes: Buffer }> {
  const img = await fetchBytes(rawUrl, {
    accept: "image/jpeg,image/png,image/webp,*/*;q=0.1",
    types: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
    maxBytes,
    truncate: false,
  });
  if (!sniffImage(img.bytes)) throw badRequest("That isn't a JPEG, PNG or WebP image");
  return { finalUrl: img.finalUrl.toString(), bytes: img.bytes };
}

/** One JPEG, at most `maxBytes`, through the same validation and pinning. */
export async function fetchJpeg(rawUrl: string, maxBytes: number): Promise<{ finalUrl: string; bytes: Buffer }> {
  const img = await fetchBytes(rawUrl, { accept: "image/jpeg,*/*;q=0.1", types: ["image/jpeg"], maxBytes, truncate: false });
  const b = img.bytes;
  if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) throw badRequest("That image isn't a JPEG");
  return { finalUrl: img.finalUrl.toString(), bytes: b };
}

/** One small image (a site's icon): PNG, JPEG or WebP by its bytes, at most `maxBytes`, through the same validation and pinning. */
export async function fetchIconImage(
  rawUrl: string,
  maxBytes: number
): Promise<{ finalUrl: string; bytes: Buffer; type: "png" | "jpg" | "webp" }> {
  const img = await fetchBytes(rawUrl, {
    accept: "image/png,image/webp,image/jpeg;q=0.9,*/*;q=0.1",
    types: ["image/png", "image/jpeg", "image/webp"],
    maxBytes,
    truncate: false,
  });
  const b = img.bytes;
  const type =
    b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      ? "png"
      : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
        ? "jpg"
        : b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"
          ? "webp"
          : null;
  if (!type) throw badRequest("That image isn't a PNG, JPEG or WebP");
  return { finalUrl: img.finalUrl.toString(), bytes: b, type };
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
