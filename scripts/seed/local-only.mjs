// The seed and the speed test write fake accounts with the service-role key and
// stamp counselors approved directly, which skips the approval gate. They must
// only ever reach a throwaway local stack, so every address they use has to be
// on this machine. There is deliberately no override: a run against a deployed
// project would put approved fake counselors and their students into it.

/** The production Supabase project. Refused by name as well, in case a tunnel makes it look local. */
export const PRODUCTION_PROJECT_REFS = ["kerstlpuvpmstiavxblv"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The only connection keywords a postgres URL here may carry. libpq reads
 * keywords from the query string and they beat the URL's own host:
 * `?host=` replaces it and `?hostaddr=` picks the address actually dialled
 * (the host then only names the server for TLS), and `?service=` pulls both
 * from a service file. So a URL that looks like 127.0.0.1 could connect
 * anywhere. Everything not listed is refused, whatever it is.
 */
const PG_QUERY_ALLOWED = new Set(["sslmode", "connect_timeout", "application_name"]);

/**
 * A postgres URL in the one shape libpq and WHATWG read alike: optional
 * user[:password] with no second "@", one host, an optional port, a path.
 * libpq splits userinfo at the first "@" where WHATWG takes the last, and
 * reads "a,b" as two hosts, so anything outside this shape is refused rather
 * than reasoned about.
 */
const PG_URL_SHAPE = /^postgres(?:ql)?:\/\/(?:[^@/?#\s,]*@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[A-Za-z0-9_.-]*)?(?:\?[^#\s]*)?$/i;

/**
 * libpq environment variables that can change which server psql reaches even
 * when the URL names this machine: PGHOSTADDR (used when the URL has no
 * hostaddr), and a service file (PGSERVICE, PGSERVICEFILE, PGSYSCONFDIR) that
 * can carry a hostaddr. PGHOST is dropped too, for a URL without a host.
 */
export const LIBPQ_HOST_ENV = ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGSYSCONFDIR"];

/** The environment psql runs with: this process's, minus every variable that could move the host. */
export function psqlEnv(env = process.env) {
  const out = { ...env };
  for (const k of LIBPQ_HOST_ENV) delete out[k];
  return out;
}

/** True only for an http(s) or postgres(ql) URL whose every effective host is this machine. */
export function isLocalUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:", "postgres:", "postgresql:"].includes(url.protocol)) return false;
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) return false;
  if (url.protocol === "postgres:" || url.protocol === "postgresql:") {
    if (!PG_URL_SHAPE.test(value)) return false;
    // URLSearchParams decodes the keys, as libpq does, so "?h%6Fst=" is "host".
    for (const key of url.searchParams.keys()) {
      if (!PG_QUERY_ALLOWED.has(key.toLowerCase())) return false;
    }
  }
  return true;
}

/**
 * Throws unless every named address is local. `env` maps a variable name to
 * its value; an unset value fails too, so a missing DB_URL can't fall through
 * to a default somewhere else.
 */
export function assertLocalStack(env) {
  const bad = [];
  for (const [name, value] of Object.entries(env)) {
    const text = String(value ?? "");
    if (PRODUCTION_PROJECT_REFS.some((ref) => text.includes(ref))) bad.push(`${name} names the production project`);
    else if (!isLocalUrl(text)) bad.push(`${name} is ${text ? "not a localhost address" : "not set"}`);
  }
  if (bad.length) {
    throw new Error(
      `Refusing to run: ${bad.join("; ")}. This script creates approved fake accounts with the service-role key ` +
        "and only runs against a local Supabase stack and API."
    );
  }
}
