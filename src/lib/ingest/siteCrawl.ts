/**
 * Reading a college's own site politely, for the college features ingest (lib/ingest/collegeFeatures.ts).
 *
 *   - robots.txt first, per host (RFC 9309): the group for our product token ("Meridies-LinkReader", the
 *     User-Agent lib/links.ts sends) or else "*", longest rule wins, Allow wins a tie. A missing file (404/410)
 *     allows everything; one we can't read (refused, 5xx, timeout) allows nothing. Crawl-delay is honoured.
 *   - At most one request per second per host (`HostThrottle`), redirects included: every request, every hop,
 *     goes through `beforeRequest`, which waits its turn, refuses a hop off the school's domain and checks
 *     robots.txt before a byte is sent.
 *   - Pages are found in the sitemap first (robots.txt's Sitemap lines, else /sitemap.xml; one level of sitemap
 *     index), then in the home page's links, and picked by their URL and link words: academics, majors and
 *     programs, research, honors, co-op and internships, study abroad, centers and institutes.
 *   - A page's text is its main content (lib/links.ts `extractMainText`), cleaned, and hashed after cleaning, so
 *     a page whose words didn't change hashes the same however its HTML moved.
 *
 * Every fetch is lib/links.ts (validated, pinned DNS, hand-followed redirects, size and time caps); this file
 * only decides what to ask for, and is handed its fetchers so it is unit tested without the network. Every scan
 * of a site's text (robots.txt, sitemaps, URLs) is linear: `indexOf` and splits, no backtracking pattern.
 */

import { createHash } from "node:crypto";
import { onSchoolDomain, schoolDomain } from "../catalogProposals.js";
import { HttpError } from "../errors.js";
import { asciiLower } from "../linearText.js";
import type { BeforeRequest, CrawlFileKind, SiteLink, SitePage } from "../links.js";

// ---- robots.txt -------------------------------------------------------------------------------

/** The User-Agent product tokens a robots.txt group may name us by (lib/links.ts sends Meridies-LinkReader/1.0). */
export const CRAWLER_TOKENS = ["meridies-linkreader", "meridies"];

export type RobotsRule = { allow: boolean; pattern: string };
export type Robots = { rules: RobotsRule[]; crawlDelaySeconds: number | null; sitemaps: string[] };

export const ALLOW_ALL: Robots = { rules: [], crawlDelaySeconds: null, sitemaps: [] };
export const DISALLOW_ALL: Robots = { rules: [{ allow: false, pattern: "/" }], crawlDelaySeconds: null, sitemaps: [] };

const MAX_ROBOTS_LINES = 20_000;
const MAX_ROBOTS_RULES = 2_000;
const MAX_PATTERN_CHARS = 500;
const MAX_SITEMAP_LINES = 20;

/**
 * A robots.txt, reduced to what applies to us: the rules of every group naming one of CRAWLER_TOKENS, or, when
 * none does, of every "*" group (RFC 9309 2.2.1: matching groups are merged). Sitemap lines are global.
 */
export function parseRobots(text: string): Robots {
  type Group = { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length && i < MAX_ROBOTS_LINES; i++) {
    let line = lines[i]!;
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      // "Meridies-LinkReader/1.0" names the product; the version doesn't matter.
      current.agents.push(value.toLowerCase().split("/")[0]!.trim());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      // An empty Disallow allows everything: no rule. An empty Allow says nothing.
      if (!current || !value || value.length > MAX_PATTERN_CHARS || current.rules.length >= MAX_ROBOTS_RULES) continue;
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      lastWasAgent = false;
      const n = Number(value);
      if (current && Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    } else if (key === "sitemap") {
      if (value && sitemaps.length < MAX_SITEMAP_LINES) sitemaps.push(value);
    }
  }

  const ours = groups.filter((g) => g.agents.some((a) => CRAWLER_TOKENS.includes(a)));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySeconds: delays.length ? Math.max(...delays) : null,
    sitemaps,
  };
}

/**
 * Whether a robots.txt path pattern matches a path (path and query). `*` is any run of characters and a final
 * `$` anchors the end. Matched segment by segment with `indexOf`, leftmost first, which is exact for patterns
 * whose only wildcard is `*` and never backtracks.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return anchored ? path.length === first.length : true;
  let at = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = path.indexOf(parts[i]!, at);
    if (found < 0) return false;
    at = found + parts[i]!.length;
  }
  const last = parts[parts.length - 1]!;
  if (anchored) return path.endsWith(last) && path.length - last.length >= at;
  return last === "" || path.indexOf(last, at) >= 0;
}

/** Whether robots.txt lets us fetch a URL: the longest matching rule decides, Allow on a tie, nothing matching allows. */
export function robotsAllows(robots: Robots, url: URL): boolean {
  const path = `${url.pathname || "/"}${url.search}`;
  if (url.pathname === "/robots.txt") return true;
  let best: RobotsRule | null = null;
  for (const r of robots.rules) {
    if (!robotsPatternMatches(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// ---- Sitemaps --------------------------------------------------------------------------------

export type ParsedSitemap = { kind: "index" | "urlset" | "text"; urls: string[] };

const MAX_SITEMAP_URLS = 50_000;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The addresses a sitemap lists: a sitemap index's child sitemaps, a urlset's pages, or a plain-text sitemap's
 * lines. Linear: `<loc>` elements are found with `indexOf` from a moving position, never a pattern over the file.
 */
export function parseSitemap(xml: string, max = MAX_SITEMAP_URLS): ParsedSitemap {
  const lower = asciiLower(xml);
  if (lower.indexOf("<") < 0) {
    const urls = xml
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l))
      .slice(0, max);
    return { kind: "text", urls };
  }
  const kind = lower.indexOf("<sitemapindex") >= 0 ? "index" : "urlset";
  const urls: string[] = [];
  let from = 0;
  while (urls.length < max) {
    const open = lower.indexOf("<loc", from);
    if (open < 0) break;
    const gt = lower.indexOf(">", open + 4);
    if (gt < 0) break;
    // "<loc>" or "<loc xmlns...>", not "<location>".
    const c = lower.charCodeAt(open + 4);
    if (c !== 62 && c !== 32 && c !== 9 && c !== 10 && c !== 13) {
      from = open + 4;
      continue;
    }
    const close = lower.indexOf("</loc>", gt + 1);
    if (close < 0) break;
    let inner = xml.slice(gt + 1, close).trim();
    if (inner.startsWith("<![CDATA[") && inner.endsWith("]]>")) inner = inner.slice(9, -3).trim();
    else inner = decodeXml(inner);
    if (inner) urls.push(inner);
    from = close + 6;
  }
  return { kind, urls };
}

/** Child sitemaps worth reading: pages first; never news, events, posts, people, images or video. */
export function pickChildSitemaps(urls: string[], domain: string, max = 3): string[] {
  const NOISE = /news|event|post|blog|story|stories|image|video|people|person|profile|author|tag|categor|product|calendar/;
  const GOOD = /page|academic|program|research|main|default|site|content|node|general/;
  return urls
    .filter((u) => u.length <= 2000 && onSchoolDomain(u, domain))
    .map((u, i) => {
      const path = asciiLower(u);
      return { u, i, noise: NOISE.test(path), good: GOOD.test(path) };
    })
    .filter((x) => !x.noise)
    .sort((a, b) => Number(b.good) - Number(a.good) || a.i - b.i)
    .slice(0, max)
    .map((x) => x.u);
}

// ---- Which pages to read ---------------------------------------------------------------------

export type Topic = "academics" | "research" | "honors" | "experiential" | "abroad" | "centers";
/** The order pages are taken in: one of each topic first, then a second round, so ten pages cover the site. */
export const TOPIC_ORDER: Topic[] = ["academics", "research", "honors", "experiential", "abroad", "centers"];

/** Words (as whole path or link-text words, multi-word ones in order) that make a page about a topic, with weights. */
const TOPIC_WORDS: Record<Topic, Array<[string, number]>> = {
  academics: [
    ["academics", 5], ["academic", 3], ["majors", 5], ["major", 3], ["minors", 4], ["programs", 4], ["program", 2],
    ["degrees", 3], ["degree programs", 5], ["areas of study", 5], ["fields of study", 5], ["departments", 3],
    ["undergraduate programs", 5], ["curriculum", 3],
  ],
  research: [["research", 5], ["undergraduate research", 7], ["urop", 6]],
  honors: [["honors", 6], ["honours", 6], ["honors college", 7], ["honors program", 7]],
  experiential: [
    ["co op", 6], ["coop", 6], ["cooperative education", 7], ["internships", 6], ["internship", 5],
    ["experiential learning", 5], ["career center", 3],
  ],
  abroad: [["study abroad", 7], ["abroad", 5], ["education abroad", 7], ["global education", 5], ["global programs", 4]],
  centers: [["centers", 5], ["centres", 5], ["institutes", 5], ["institute", 3], ["center", 2], ["centre", 2], ["centers and institutes", 6]],
};

/** Pages that never say what a student can do here: news, events, people, giving, sign-in, policies, admissions. */
const NOISE_WORDS = new Set([
  "news", "newsroom", "event", "events", "calendar", "blog", "blogs", "story", "stories", "magazine", "press",
  "alumni", "giving", "give", "donate", "athletics", "sports", "login", "signin", "sso", "jobs", "employment",
  "shop", "store", "directory", "people", "person", "profile", "profiles", "staff", "bio", "tag", "tags",
  "category", "author", "search", "privacy", "accessibility", "policy", "policies", "archive", "archives", "video",
  "videos", "podcast", "webinar", "apply", "admission", "admissions", "visit", "tour", "tours", "parents", "family",
  "families", "library", "libraries", "covid", "emergency", "feed", "rss",
]);
/** Pages for people who aren't undergraduates: graduate, professional and continuing education. */
const NOT_UNDERGRAD_WORDS = new Set([
  "grad", "graduate", "gradschool", "postgraduate", "masters", "master", "phd", "doctoral", "doctorate", "med",
  "medical", "medicine", "md", "law", "jd", "mba", "dental", "dentistry", "pharmacy", "veterinary", "executive",
  "extension", "continuing", "online", "precollege", "postdoc", "postdoctoral",
]);
/** Sites of a school that are its news, giving, sport or graduate schools. */
const NOISE_HOST_LABELS = new Set([
  "news", "newsroom", "giving", "alumni", "athletics", "sports", "events", "calendar", "careers", "jobs", "library",
  "libraries", "shop", "store", "blog", "press", "magazine", "grad", "graduate", "gradschool", "med", "medicine",
  "law", "mba", "online", "extension", "professional", "apply", "admissions", "admission", "my", "login", "sso",
]);
const SKIP_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|webp|svg|mp4|mov|mp3|xml|json|ics|rss|txt|csv)$/;
const MAX_URL_CHARS = 500;
const MAX_QUERY_CHARS = 30;
const MAX_SLUG_WORDS = 6;
const MIN_PAGE_SCORE = 4;

/** Lower-case ASCII words of a path or link text, in order. */
function wordsOf(s: string): string[] {
  return asciiLower(s).split(/[^a-z0-9]+/).filter(Boolean);
}

/** The best topic for these words and its score; multi-word entries must appear in order. */
function topicScore(words: string[]): { topic: Topic; score: number } | null {
  if (!words.length) return null;
  const joined = ` ${words.join(" ")} `;
  let best: { topic: Topic; score: number } | null = null;
  for (const topic of TOPIC_ORDER) {
    let score = 0;
    for (const [phrase, weight] of TOPIC_WORDS[topic]) if (weight > score && joined.includes(` ${phrase} `)) score = weight;
    if (score > 0 && (!best || score > best.score)) best = { topic, score };
  }
  return best;
}

/** The key two addresses of one page share: host without "www.", path without its trailing slash, the query. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

export type PageCandidate = { url: string; text: string; from: "sitemap" | "home" };
export type PickedPage = { url: string; topic: Topic; score: number };

/**
 * The pages worth reading, best first and spread over the topics: the best page of each topic in TOPIC_ORDER,
 * then the second best of each, and so on, up to `max`. A candidate is scored by its path words (the topic's
 * weight) and its link words (one less); deep paths and query strings lose points; news, people, admissions,
 * graduate-school and file addresses are skipped, as are pages off the school's domain.
 */
export function pickPages(candidates: PageCandidate[], domain: string, max: number): PickedPage[] {
  const seen = new Set<string>();
  const byTopic = new Map<Topic, Array<PickedPage & { len: number; order: number }>>();
  candidates.forEach((c, order) => {
    if (c.url.length > MAX_URL_CHARS || !onSchoolDomain(c.url, domain)) return;
    let u: URL;
    try {
      u = new URL(c.url);
    } catch {
      return;
    }
    const key = pageKey(c.url);
    if (!key || seen.has(key)) return;
    const path = asciiLower(u.pathname);
    if (path === "/" || path === "" || SKIP_EXTENSIONS.test(path) || u.search.length > MAX_QUERY_CHARS) return;
    const segments = path.split("/").filter(Boolean);
    if (segments.some((s) => /^(?:19|20)\d\d$/.test(s))) return;
    const last = segments[segments.length - 1] ?? "";
    if (last.split(/[-_]/).length > MAX_SLUG_WORDS) return;
    // The labels in front of the school's own domain: "news" in news.example.edu.
    const hostLabels = u.hostname.toLowerCase().replace(/^www\./, "").split(".");
    const subLabels = hostLabels.slice(0, Math.max(0, hostLabels.length - domain.split(".").length));
    if (subLabels.some((l) => NOISE_HOST_LABELS.has(l) || NOT_UNDERGRAD_WORDS.has(l))) return;

    const pathWords = wordsOf(path);
    const textWords = wordsOf(c.text.slice(0, 200));
    const all = [...pathWords, ...textWords];
    if (all.some((w) => NOISE_WORDS.has(w) || NOT_UNDERGRAD_WORDS.has(w))) return;

    const fromPath = topicScore(pathWords);
    const fromText = topicScore(textWords);
    const viaText = fromText ? { topic: fromText.topic, score: fromText.score - 1 } : null;
    const hit = fromPath && (!viaText || fromPath.score >= viaText.score) ? fromPath : viaText;
    if (!hit) return;
    const score = hit.score - Math.max(0, segments.length - 2) - (u.search ? 2 : 0);
    if (score < MIN_PAGE_SCORE) return;

    seen.add(key);
    u.hash = "";
    const list = byTopic.get(hit.topic) ?? [];
    list.push({ url: u.toString(), topic: hit.topic, score, len: path.length, order });
    byTopic.set(hit.topic, list);
  });

  for (const list of byTopic.values()) list.sort((a, b) => b.score - a.score || a.len - b.len || a.order - b.order);
  const out: PickedPage[] = [];
  for (let round = 0; out.length < max; round++) {
    let added = false;
    for (const topic of TOPIC_ORDER) {
      const p = byTopic.get(topic)?.[round];
      if (!p || out.length >= max) continue;
      out.push({ url: p.url, topic: p.topic, score: p.score });
      added = true;
    }
    if (!added) break;
  }
  return out;
}

// ---- Text ------------------------------------------------------------------------------------

/** A page's text as stored and hashed: control characters out, each line trimmed with its spaces collapsed, no blank lines. */
export function cleanPageText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** sha256 hex of a page's cleaned text. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---- Throttle --------------------------------------------------------------------------------

const hostKey = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * One request per `minIntervalMs` per host (www. and the bare name count as one), or the host's Crawl-delay when
 * longer. A caller reserves its slot on entry, so concurrent callers queue in order rather than all waking at once.
 */
export class HostThrottle {
  private readonly next = new Map<string, number>();
  private readonly intervals = new Map<string, number>();
  private readonly min: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: { minIntervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.min = o.minIntervalMs ?? 1000;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  setInterval(host: string, ms: number): void {
    this.intervals.set(hostKey(host), Math.max(this.min, ms));
  }

  async wait(host: string): Promise<void> {
    const key = hostKey(host);
    const now = this.now();
    const at = Math.max(now, this.next.get(key) ?? 0);
    this.next.set(key, at + (this.intervals.get(key) ?? this.min));
    if (at > now) await this.sleep(at - now);
  }
}

// ---- The crawl -------------------------------------------------------------------------------

/** Why a request was not sent. */
export class CrawlRefusal extends Error {
  constructor(readonly reason: "robots" | "off-domain") {
    super(reason === "robots" ? "robots.txt disallows this page" : "the page is off the school's site");
    this.name = "CrawlRefusal";
  }
}

export type CrawlFetchers = {
  fetchFile: (url: string, kind: CrawlFileKind, o: { beforeRequest: BeforeRequest }) => Promise<{ finalUrl: string; text: string }>;
  /** A page's main-content text (lib/links.ts `fetchSitePage` with `mainContent`). */
  fetchPage: (url: string, o: { beforeRequest: BeforeRequest }) => Promise<SitePage>;
};

export type CrawledPage = { url: string; title: string | null; text: string; chars: number; hash: string; topic: Topic };

export type CrawlResult = {
  domain: string;
  /** How the home host's robots.txt read: read, missing (allows all), or unreadable (allows nothing). */
  robots: "read" | "missing" | "unreadable";
  sitemapUrls: number;
  /** Links on the home page, when it was read: a handful usually means its menus are drawn by JavaScript. */
  homeLinks: number | null;
  candidates: number;
  pages: CrawledPage[];
  /** Pages tried and not read, by reason: robots, off-domain, not-found, error. */
  skipped: Record<string, number>;
  /** Set when the crawl stopped before reading pages. */
  stop: "no-website" | "robots" | "crawl-delay" | null;
};

/** The longest Crawl-delay we wait out; a site asking for more is not read. */
export const MAX_CRAWL_DELAY_SECONDS = 30;
const MAX_ROOT_SITEMAPS = 2;
const MAX_CHILD_SITEMAPS = 3;
/** Pages tried past the ones wanted, to stand in for a page that 404s or that robots.txt keeps out. */
const SPARE_PAGES = 6;

const codeOf = (err: unknown) => (err instanceof HttpError ? err.code : undefined);

function siteBase(website: string): URL | null {
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

/**
 * Read up to `maxPages` topic pages of a college's own site. Never throws for a site's failures: what couldn't be
 * read is counted in `skipped` or named in `stop`.
 */
export async function crawlCollege(
  website: string | null,
  deps: CrawlFetchers & { throttle: HostThrottle },
  opts: { maxPages: number }
): Promise<CrawlResult> {
  const domain = schoolDomain(website);
  const base = website ? siteBase(website) : null;
  const result: CrawlResult = { domain: domain ?? "", robots: "missing", sitemapUrls: 0, homeLinks: null, candidates: 0, pages: [], skipped: {}, stop: null };
  if (!domain || !base) return { ...result, stop: "no-website" };

  type RobotsState = { robots: Robots; state: CrawlResult["robots"]; tooSlow?: boolean };
  const robotsByOrigin = new Map<string, Promise<RobotsState>>();
  const onSite = (url: URL) => {
    if (!onSchoolDomain(url.toString(), domain)) throw new CrawlRefusal("off-domain");
  };
  const robotsFor = (url: URL) => {
    let p = robotsByOrigin.get(url.origin);
    if (!p) {
      p = (async (): Promise<RobotsState> => {
        try {
          const f = await deps.fetchFile(`${url.origin}/robots.txt`, "robots", {
            beforeRequest: async (hop) => {
              onSite(hop);
              await deps.throttle.wait(hop.hostname);
            },
          });
          const robots = parseRobots(f.text);
          if (robots.crawlDelaySeconds !== null) {
            if (robots.crawlDelaySeconds > MAX_CRAWL_DELAY_SECONDS) return { robots: DISALLOW_ALL, state: "read", tooSlow: true };
            deps.throttle.setInterval(url.hostname, robots.crawlDelaySeconds * 1000);
          }
          return { robots, state: "read" };
        } catch (err) {
          // RFC 9309: a missing file allows everything; one that can't be read allows nothing.
          const code = codeOf(err);
          if (code === "link_not_found" || code === "link_not_page") return { robots: ALLOW_ALL, state: "missing" };
          return { robots: DISALLOW_ALL, state: "unreadable" };
        }
      })();
      robotsByOrigin.set(url.origin, p);
    }
    return p;
  };
  const guard: BeforeRequest = async (url) => {
    onSite(url);
    const { robots } = await robotsFor(url);
    if (!robotsAllows(robots, url)) throw new CrawlRefusal("robots");
    await deps.throttle.wait(url.hostname);
  };
  const skip = (reason: string) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };
  const reasonOf = (err: unknown) =>
    err instanceof CrawlRefusal ? err.reason : codeOf(err) === "link_not_found" ? "not-found" : "error";

  // The home host's robots.txt decides whether the site is read at all.
  const home = await robotsFor(base);
  result.robots = home.state;
  if (home.tooSlow) return { ...result, stop: "crawl-delay" };
  if (!robotsAllows(home.robots, base)) return { ...result, stop: "robots" };

  // 1. Sitemaps: robots.txt's own, else /sitemap.xml; one level of index.
  const roots = home.robots.sitemaps.filter((s) => onSchoolDomain(s, domain)).slice(0, MAX_ROOT_SITEMAPS);
  if (!roots.length) roots.push(`${base.origin}/sitemap.xml`);
  const pageUrls: string[] = [];
  for (const root of roots) {
    if (pageUrls.length >= MAX_SITEMAP_URLS) break;
    try {
      const f = await deps.fetchFile(root, "sitemap", { beforeRequest: guard });
      const parsed = parseSitemap(f.text);
      if (parsed.kind !== "index") {
        pageUrls.push(...parsed.urls);
        continue;
      }
      for (const child of pickChildSitemaps(parsed.urls, domain, MAX_CHILD_SITEMAPS)) {
        if (pageUrls.length >= MAX_SITEMAP_URLS) break;
        try {
          const c = await deps.fetchFile(child, "sitemap", { beforeRequest: guard });
          pageUrls.push(...parseSitemap(c.text).urls);
        } catch {
          // A missing child sitemap only means fewer addresses to choose from.
        }
      }
    } catch {
      // No sitemap: the home page's links are next.
    }
  }
  pageUrls.length = Math.min(pageUrls.length, MAX_SITEMAP_URLS);
  result.sitemapUrls = pageUrls.length;
  const want = opts.maxPages + SPARE_PAGES;
  let candidates: PageCandidate[] = pageUrls.map((url) => ({ url, text: "", from: "sitemap" as const }));
  let picks = pickPages(candidates, domain, want);

  // 2. The home page's links, when the sitemap didn't give enough.
  if (picks.length < want) {
    try {
      const page = await deps.fetchPage(base.toString(), { beforeRequest: guard });
      result.homeLinks = page.links.length;
      candidates = [...candidates, ...page.links.map((l: SiteLink) => ({ url: l.href, text: l.text, from: "home" as const }))];
      picks = pickPages(candidates, domain, want);
    } catch (err) {
      skip(`home-${reasonOf(err)}`);
    }
  }
  result.candidates = candidates.length;

  // 3. The pages, in order, until enough were read.
  const read = new Set<string>();
  for (const pick of picks) {
    if (result.pages.length >= opts.maxPages) break;
    try {
      const page = await deps.fetchPage(pick.url, { beforeRequest: guard });
      const key = pageKey(page.finalUrl);
      // Two links that redirect to one page are one page.
      if (!key || read.has(key)) {
        skip("duplicate");
        continue;
      }
      read.add(key);
      const text = cleanPageText(page.text);
      result.pages.push({ url: page.finalUrl, title: page.title, text, chars: text.length, hash: contentHash(text), topic: pick.topic });
    } catch (err) {
      skip(reasonOf(err));
    }
  }
  return result;
}
