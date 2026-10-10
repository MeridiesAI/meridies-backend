export type Candidate = { title: string; summary: string; sources: { url: string; title: string | null }[] };

const parse = (u: string): URL | null => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

const host = (u: string): string | null => {
  const url = parse(u);
  return url ? url.hostname.toLowerCase().replace(/^www\./, "") : null;
};

export function isBlocked(url: string, blocked: string[]): boolean {
  const h = host(url);
  if (!h) return true;
  return blocked.some((raw) => {
    const d = raw.toLowerCase().replace(/^www\./, "");
    return h === d || h.endsWith(`.${d}`);
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
  return `//${url.host}${url.pathname}${url.search}`.replace(/\/$/, "");
}

export async function keepCandidates(
  candidates: Candidate[],
  run: { seenUrls: string[] },
  blocked: string[],
  check: (url: string) => Promise<{ status: "ok" | "broken" | "blocked" }>
): Promise<(Candidate & { checkedAt: string })[]> {
  const seen = new Set<string>();
  for (const u of run.seenUrls) {
    const n = norm(u);
    if (n) seen.add(n);
  }
  const checkedAt = new Date().toISOString();
  // One link check per page per call; candidates often cite the same URL.
  const verdicts = new Map<string, boolean>();
  const isOk = async (url: string, key: string): Promise<boolean> => {
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    let good = false;
    try {
      good = (await check(url)).status === "ok";
    } catch {
      good = false;
    }
    verdicts.set(key, good);
    return good;
  };
  const out: (Candidate & { checkedAt: string })[] = [];
  for (const c of candidates) {
    const sources: Candidate["sources"] = [];
    for (const s of c.sources) {
      const key = norm(s.url);
      if (key === null || !seen.has(key) || isBlocked(s.url, blocked)) continue;
      if (!(await isOk(s.url, key))) continue;
      sources.push(s);
    }
    if (sources.length) out.push({ ...c, sources, checkedAt });
  }
  return out;
}
