export type Candidate = { title: string; summary: string; sources: { url: string; title: string | null }[] };

const parse = (u: string): URL | null => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

const bareHost = (h: string): string => h.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

const host = (u: string): string | null => {
  const url = parse(u);
  return url ? bareHost(url.hostname) : null;
};

/** A blocklist entry in the same form as a parsed hostname (punycode, lowercase, no www. or trailing dot); null if it doesn't parse. */
const entryHost = (entry: string): string | null => {
  try {
    const h = bareHost(new URL(`http://${entry.trim()}`).hostname);
    return h || null;
  } catch {
    return null;
  }
};

export function isBlocked(url: string, blocked: string[]): boolean {
  const h = host(url);
  if (!h) return true;
  return blocked.some((raw) => {
    const d = entryHost(raw);
    return d !== null && (h === d || h.endsWith(`.${d}`));
  });
}

/**
 * The comparison key for "the same page": no fragment, no trailing slash,
 * scheme and host lowercased, http and https treated alike. The query string
 * stays: a different query is a different page. Null for anything that is not
 * an http(s) URL, which can never be kept.
 */
function norm(u: string): string | null {
  const url = parse(u);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  return `//${url.host}${url.pathname.replace(/\/$/, "")}${url.search}`;
}

/** How many link checks run at once. */
export const LINK_CHECKS = 6;

export async function keepCandidates<C extends Candidate>(
  candidates: C[],
  run: { seenUrls: string[] },
  blocked: string[],
  check: (url: string) => Promise<{ status: "ok" | "broken" | "blocked" }>
): Promise<(C & { checkedAt: string })[]> {
  const seen = new Set<string>();
  for (const u of run.seenUrls) {
    const n = norm(u);
    if (n) seen.add(n);
  }
  const checkedAt = new Date().toISOString();
  // Every distinct page that could count is checked once, LINK_CHECKS at a time: one check can take up to its 10 s
  // timeout, and checking them one after another made a run with a few slow sites wait most of a minute.
  const pending = new Map<string, string>();
  for (const c of candidates) {
    for (const s of c.sources) {
      const key = norm(s.url);
      if (key === null || !seen.has(key) || isBlocked(s.url, blocked) || pending.has(key)) continue;
      pending.set(key, s.url);
    }
  }
  const verdicts = new Map<string, boolean>();
  const queue = [...pending];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, url] = next;
      let good = false;
      try {
        good = (await check(url)).status === "ok";
      } catch {
        good = false;
      }
      verdicts.set(key, good);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_CHECKS, queue.length) }, worker));
  const out: (C & { checkedAt: string })[] = [];
  for (const c of candidates) {
    const sources: Candidate["sources"] = [];
    for (const s of c.sources) {
      const key = norm(s.url);
      if (key !== null && verdicts.get(key) === true) sources.push(s);
    }
    if (sources.length) out.push({ ...c, sources, checkedAt });
  }
  return out;
}
