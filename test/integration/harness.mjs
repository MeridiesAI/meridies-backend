// Integration harness: real users on a local Supabase, calls against a running
// API. Configured by env (see .github/workflows/ci.yml, or run locally after
// `supabase start` and starting the API):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DB_URL, API_URL, CRON_SECRET
import { execFileSync } from "node:child_process";

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required for the integration tests`);
  return v;
};
export const API = (process.env.API_URL ?? "http://127.0.0.1:4100").replace(/\/+$/, "");
export const CRON_SECRET = process.env.CRON_SECRET ?? "local-test-cron-secret-0123456789abcdef";
export const SB = need("SUPABASE_URL");
export const ANON = need("SUPABASE_ANON_KEY");
const SERVICE = need("SUPABASE_SERVICE_ROLE_KEY");
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PSQL = process.env.PSQL ?? "psql";
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

/** A confirmed account with a confirmed role, signed in. Counselors are approved unless `approved: false`. */
export async function user(tag, role = "counselor", { approved = true } = {}) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = `pw-${Math.random().toString(36).slice(2)}-Aa1!`;
  let r = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: svc, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: tag, role } }) });
  const u = await r.json();
  if (!r.ok) throw new Error("create user " + JSON.stringify(u));
  r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const t = await r.json();
  if (!r.ok) throw new Error("login " + JSON.stringify(t));
  await fetch(`${SB}/rest/v1/rpc/confirm_user_role`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_role: role }) });
  if (role === "counselor" && approved) {
    await sql(`update public.profiles set counselor_approved_at = now(), counselor_approved_via = 'team' where id = '${u.id}'`);
  }
  return { id: u.id, email, password, token: t.access_token };
}

export async function call(token, method, path, body) {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

export async function sql(query) {
  return execFileSync(PSQL, [DB_URL, "-tAc", query]).toString().trim();
}

let failures = 0;
export function check(label, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

/** PostgREST / Storage as a signed-in user (RLS applies). `path` starts with /rest/v1 or /storage/v1. */
export async function rest(token, method, path, body, headers = {}) {
  const isJson = body !== undefined && !(body instanceof Uint8Array) && typeof body !== "string";
  const r = await fetch(SB + path, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, ...(isJson ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

/** Like sql(), but async, so two statements can race (concurrency tests). */
export async function sqlAsync(query) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) =>
    execFile(PSQL, [DB_URL, "-tAc", query], (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())))
  );
}
