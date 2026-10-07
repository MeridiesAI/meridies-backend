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
const SB = need("SUPABASE_URL");
const ANON = need("SUPABASE_ANON_KEY");
const SERVICE = need("SUPABASE_SERVICE_ROLE_KEY");
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PSQL = process.env.PSQL ?? "psql";
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

/** A confirmed account with a confirmed role, signed in. */
export async function user(tag, role = "counselor") {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = `pw-${Math.random().toString(36).slice(2)}-Aa1!`;
  let r = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: svc, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: tag, role } }) });
  const u = await r.json();
  if (!r.ok) throw new Error("create user " + JSON.stringify(u));
  r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const t = await r.json();
  if (!r.ok) throw new Error("login " + JSON.stringify(t));
  await fetch(`${SB}/rest/v1/rpc/confirm_user_role`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_role: role }) });
  return { id: u.id, email, token: t.access_token };
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
