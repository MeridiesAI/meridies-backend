// The seed and the speed test write fake accounts with the service-role key and
// stamp counselors approved directly, which skips the approval gate. They must
// only ever reach a throwaway local stack, so every address they use has to be
// on this machine. There is deliberately no override: a run against a deployed
// project would put approved fake counselors and their students into it.

/** The production Supabase project. Refused by name as well, in case a tunnel makes it look local. */
export const PRODUCTION_PROJECT_REFS = ["kerstlpuvpmstiavxblv"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True only for an http(s) or postgres(ql) URL whose host is this machine. */
export function isLocalUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:", "postgres:", "postgresql:"].includes(url.protocol)) return false;
  return LOCAL_HOSTS.has(url.hostname.toLowerCase());
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
