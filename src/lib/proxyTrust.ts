/**
 * How many proxies stand between the internet and this process, which decides
 * whose address request.ip (the per-IP rate limit, the request log) is.
 *
 * Fastify takes the address n hops from the right of X-Forwarded-For: the
 * entry the outermost trusted proxy appended. Everything further left is
 * whatever the client sent, and is never trusted. Too few hops (0 behind a
 * proxy) gives every caller the proxy's address, one shared bucket; too many
 * (or `true`) lets a client pick its own address with a fresh header each
 * request. Since Fastify 5.12 a plain number is read as "trust nothing"
 * (hop counts can't validate the immediate peer), so `trustProxyOption` hands
 * it the same rule as a function; what it means hasn't changed.
 *
 * TRUST_PROXY_HOPS decides when set. Otherwise: on Railway (its RAILWAY_*
 * variables are present) one hop, its edge; in development and tests one hop
 * too, because the integration harness tells requests apart by the header and
 * nothing local is exposed; anywhere else in production none, the safe answer
 * for a process taking connections directly, with an error at boot asking for
 * the setting (behind an unknown proxy every caller would share one bucket).
 */

export type ProxyTrust = { hops: number; source: "setting" | "railway" | "development" | "default" };

export function proxyTrust(env: Record<string, string | undefined>, setting: number | undefined, nodeEnv: string): ProxyTrust {
  if (setting !== undefined) return { hops: setting, source: "setting" };
  const onRailway = ["RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID"].some(
    (k) => typeof env[k] === "string" && env[k]!.trim() !== ""
  );
  if (onRailway) return { hops: 1, source: "railway" };
  if (nodeEnv !== "production") return { hops: 1, source: "development" };
  return { hops: 0, source: "default" };
}

/**
 * A request that says the hop count is too low for this deployment: Cloudflare
 * set its headers, so (with Railway behind it) there are two proxies and one
 * trusted hop gives every caller Cloudflare's address, one shared bucket. Null
 * when nothing looks off. (A request with no X-Forwarded-For proves nothing:
 * Railway's own health check arrives without one.)
 */
export function proxyMismatch(headers: Record<string, string | string[] | undefined>, hops: number): string | null {
  if (hops === 1 && (headers["cf-connecting-ip"] || headers["cf-ray"])) {
    return "Requests carry Cloudflare headers but TRUST_PROXY_HOPS is 1: behind Cloudflare and Railway every caller shares Cloudflare's address. Set TRUST_PROXY_HOPS=2.";
  }
  return null;
}

/**
 * The `trustProxy` option for `hops`: the entries up to `hops` from the right
 * of X-Forwarded-For are trusted, exactly what `trustProxy: hops` meant before
 * Fastify 5.12 stopped reading a number (it now trusts nothing for one, which
 * would put every caller behind Railway's edge in one bucket). 0 trusts no
 * header at all.
 */
export function trustProxyOption(hops: number): false | ((address: string, hop: number) => boolean) {
  if (!Number.isInteger(hops) || hops <= 0) return false;
  return (_address: string, hop: number) => hop < hops;
}
