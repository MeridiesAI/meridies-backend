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
 * Residual risk worth naming: DNS could change between the check and the
 * connection (a rebinding attack). Closing that needs a pinned-address
 * dispatcher; until then this runs with no cloud metadata credentials reachable
 * from the API's network position, and every fetch is logged with its host.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

/** Ranges that must never be reachable from a user-supplied URL. */
function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    const ip = address.toLowerCase();
    if (ip === "::" || ip === "::1") return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(ip)) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    // IPv4-mapped: ::ffff:10.0.0.1 must be judged as the v4 address it is.
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!, 4);
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  // A literal address skips DNS but not the range check.
  const literal = isIP(hostname);
  if (literal) {
    if (isBlockedAddress(hostname, literal)) {
      throw badRequest("That address isn't reachable from Meridies");
    }
    return;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw badRequest("That domain doesn't resolve");
  }
  if (addresses.length === 0) throw badRequest("That domain doesn't resolve");
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw badRequest("That address isn't reachable from Meridies");
    }
  }
}

/** Parse + validate one hop. Throws a 400 the client can act on. */
async function validateUrl(raw: string): Promise<URL> {
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
  await assertPublicHost(url.hostname);
  return url;
}

/** Public entry point for validation alone, used before a row is written. */
export async function normalizeLink(
  raw: string
): Promise<{ url: string; domain: string }> {
  const url = await validateUrl(raw);
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

/**
 * Fetch and extract. Follows redirects by hand so each hop is re-validated,
 * and never returns more than MAX_TEXT_CHARS of text to a prompt.
 */
export async function fetchReadablePage(rawUrl: string): Promise<FetchedPage> {
  let current = await validateUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Identify the crawler honestly; some sites rightly block blanks.
          "User-Agent": "Meridies-LinkReader/1.0 (+https://meridiesai.com)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      throw badRequest(aborted ? "That page took too long to respond" : "Couldn't reach that page");
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw badRequest("That link redirects nowhere");
      if (hop === MAX_REDIRECTS) throw badRequest("That link redirects too many times");
      // Re-validate the target: this is the hop an SSRF attempt rides on.
      current = await validateUrl(new URL(location, current).toString());
      continue;
    }

    if (!res.ok) {
      throw badRequest(`That page returned ${res.status}`);
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!READABLE_TYPES.some((t) => contentType.includes(t))) {
      throw badRequest(
        "That link isn't a readable web page. Upload a PDF as a document instead."
      );
    }

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw badRequest("That page is too large to read");

    // Stream with a hard cap: content-length is a claim, not a promise.
    const body = res.body;
    if (!body) throw badRequest("That page returned nothing to read");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }

    const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    const isHtml = contentType.includes("html") || contentType.includes("xml");
    const { title, text } = isHtml
      ? extractText(raw)
      : { title: null, text: raw.replace(/\s+/g, " ").trim() };

    return {
      finalUrl: current.toString(),
      domain: current.hostname.replace(/^www\./, ""),
      title,
      text: text.slice(0, MAX_TEXT_CHARS),
      contentType,
      chars: text.length,
      truncated: text.length > MAX_TEXT_CHARS,
    };
  }

  throw badRequest("That link redirects too many times");
}
