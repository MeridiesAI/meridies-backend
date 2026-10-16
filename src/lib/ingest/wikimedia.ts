/**
 * The college photo loader's network: Wikidata's query service, the Commons
 * API and Commons' upload host. Three fixed provider hosts, nothing a user
 * chose, so this is not the lib/links.ts SSRF surface; still, every URL is
 * checked against its pinned host before it is fetched, redirects are refused
 * rather than followed, and a download is capped in time, bytes and type.
 *
 * Wikimedia's API etiquette: a User-Agent naming the client and a contact
 * address, serial API calls (at least half a second apart), maxlag=5 on
 * Commons, and Retry-After honoured on 429/503 and on a maxlag answer.
 */

export const WDQS = "https://query.wikidata.org/sparql";
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const UPLOAD_HOST = "upload.wikimedia.org";
/** Wikimedia's User-Agent policy asks for a contact: the team inbox, never a person's. */
export const USER_AGENT = "MeridiesCatalog/1.0 (https://meridiesai.com; team@meridiesai.com) college-photos";
/** A stored copy is at most this big; the bucket refuses more as well. */
export const MAX_BYTES = 3 * 1024 * 1024;

/**
 * Every college with an IPEDS unitid (P1771) and, when it has one, its main
 * image (P18). `wdt:` gives best-rank values only. `schema:dateModified` is
 * when the item was last edited, for the review gate: a main image changed
 * within the week is held (lib/ingest/collegePhotos.ts, reviewDecision).
 */
export const SPARQL_QUERY =
  "SELECT ?item ?unitid ?image ?modified WHERE { ?item wdt:P1771 ?unitid . OPTIONAL { ?item wdt:P18 ?image } OPTIONAL { ?item schema:dateModified ?modified } }";

/** The extmetadata fields the license rules read; asking for only these keeps the answer small. */
const EXTMETADATA = "LicenseShortName|LicenseUrl|Artist|Attribution|NonFree|Restrictions";

const API_HOSTS = new Set(["query.wikidata.org", "commons.wikimedia.org"]);

type Fetch = typeof fetch;
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only https://upload.wikimedia.org/..., never a look-alike host, a port, or credentials. */
export function isAllowedDownloadUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === UPLOAD_HOST && url.port === "" && !url.username && !url.password;
}

function assertApiUrl(u: URL): void {
  if (u.protocol !== "https:" || !API_HOSTS.has(u.hostname) || u.port !== "" || u.username || u.password) {
    throw new Error("refused: not a Wikimedia API host");
  }
}

/** Seconds from a Retry-After header, capped at a minute; null when absent or unreadable. */
function retryAfterMs(res: Response): number | null {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 60) * 1000 : null;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

export type WikimediaClient = {
  sparql(): Promise<unknown>;
  /**
   * One batched imageinfo query (at most 50 titles), redirects followed.
   * Always the current version's URL (thumbnail at `width`), sha1 and upload
   * time, so a download can be checked against the version that was judged.
   * `full` adds size, mime, license metadata, the description page's latest
   * revision time and its `touched` time (prop=info: it moves when a template
   * the page uses, such as a photographer's credit template, is edited).
   */
  imageinfo(titles: string[], width: number, full: boolean): Promise<unknown>;
  download(url: string): Promise<Uint8Array>;
};

export function wikimediaClient(opts: { fetch?: Fetch; sleep?: Sleep; minGapMs?: number; attempts?: number } = {}): WikimediaClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const minGap = opts.minGapMs ?? 500;
  const attempts = opts.attempts ?? 4;
  let lastApiCall = 0;

  async function pace(): Promise<void> {
    const wait = lastApiCall + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    lastApiCall = Date.now();
  }

  /** A JSON GET/POST to a pinned API host. Errors carry the status or the API's error code, never a body. */
  async function apiJson(label: string, url: URL, init: RequestInit, timeoutMs: number): Promise<unknown> {
    assertApiUrl(url);
    for (let attempt = 0; ; attempt++) {
      await pace();
      const res = await doFetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
      });
      if (!res.ok) {
        if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
          await sleep(retryAfterMs(res) ?? 2000 * 2 ** attempt);
          continue;
        }
        throw new Error(`${label} returned ${res.status}`);
      }
      const body = (await res.json()) as { error?: { code?: unknown } };
      const code = typeof body?.error?.code === "string" ? body.error.code : null;
      if (code === "maxlag" && attempt < attempts - 1) {
        await sleep(retryAfterMs(res) ?? 5000);
        continue;
      }
      if (code !== null || (body && typeof body === "object" && "error" in body)) {
        throw new Error(`${label} error ${(code ?? "unknown").replace(/[^a-z0-9-]/gi, "").slice(0, 40)}`);
      }
      return body;
    }
  }

  return {
    async sparql() {
      const url = new URL(WDQS);
      url.searchParams.set("query", SPARQL_QUERY);
      url.searchParams.set("format", "json");
      return apiJson("Wikidata", url, { method: "GET", headers: { Accept: "application/sparql-results+json" } }, 90_000);
    },

    async imageinfo(titles, width, full) {
      if (titles.length === 0 || titles.length > 50) throw new Error("imageinfo takes 1 to 50 titles");
      if (titles.some((t) => t.includes("|"))) throw new Error("refused: a title with a pipe");
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        formatversion: "2",
        prop: full ? "imageinfo|revisions|info" : "imageinfo",
        iiprop: full ? "timestamp|url|size|mime|sha1|extmetadata" : "timestamp|url|sha1",
        iiurlwidth: String(width),
        redirects: "1",
        maxlag: "5",
        titles: titles.join("|"),
      });
      if (full) {
        // With many titles, revisions gives each page's latest revision; only its time is asked for.
        params.set("rvprop", "timestamp");
        params.set("iiextmetadatafilter", EXTMETADATA);
        params.set("iiextmetadatalanguage", "en");
      }
      // POST: fifty titles can outgrow a URL.
      return apiJson(
        "Commons API",
        new URL(COMMONS_API),
        { method: "POST", body: params.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        30_000
      );
    },

    async download(u) {
      if (!isAllowedDownloadUrl(u)) throw new Error("refused: not an upload.wikimedia.org URL");
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(u, {
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg" },
        });
        if (!res.ok) {
          if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
            await sleep(retryAfterMs(res) ?? 2000 * 2 ** attempt);
            continue;
          }
          throw new Error(`download returned ${res.status}`);
        }
        if (res.url && !isAllowedDownloadUrl(res.url)) throw new Error("refused: download left upload.wikimedia.org");
        return readJpeg(res);
      }
    },
  };
}

/** The body as bytes, refused unless it is a JPEG of at most MAX_BYTES. */
export async function readJpeg(res: Response, max = MAX_BYTES): Promise<Uint8Array> {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("image/jpeg")) throw new Error("download is not a JPEG");
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("download is too large");
  if (!res.body) throw new Error("download is empty");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("download is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  if (!isJpeg(bytes)) throw new Error("download is not a JPEG");
  return bytes;
}

/** A JPEG starts FF D8 FF. */
export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
