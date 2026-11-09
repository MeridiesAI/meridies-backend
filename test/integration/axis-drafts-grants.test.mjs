// ai_conversations.draft_rows is written only by the server (20261112000001; AxIS activity drafts, plan review
// item 5): the counselor's own client can't write it, everything it wrote before still works, and the server's
// client can.
import { ANON, call, check, rest, SB, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("drafts-grants-counselor");
const s = await studentOf(c, "drafts-grants-student");

const created = await call(c.token, "POST", "/chat/conversations", { studentId: s.id, tool: "axis" });
check("a conversation can still be created", created.status === 201, `status ${created.status}`);
const id = created.body.id;

const rows = [{ key: "r1", op: "add", fields: { organization: "Planted" }, sources: {}, read_as: {}, status: "collecting" }];
const direct = await rest(c.token, "PATCH", `/rest/v1/ai_conversations?id=eq.${id}`, { draft_rows: rows });
check("the owner's own client can't write draft_rows", direct.status === 401 || direct.status === 403, `status ${direct.status} ${JSON.stringify(direct.body).slice(0, 160)}`);
check("…with Postgres's permission error", direct.body?.code === "42501", JSON.stringify(direct.body).slice(0, 160));
check("nothing was written", (await sql(`select coalesce(draft_rows::text, 'null') from public.ai_conversations where id = '${id}'`)) === "null");

const insertWith = await rest(c.token, "POST", "/rest/v1/ai_conversations", { owner_id: c.id, title: "x", draft_rows: rows }, { Prefer: "return=minimal" });
check("the owner's client can't insert draft_rows either", insertWith.status === 401 || insertWith.status === 403, `status ${insertWith.status}`);

const title = await rest(c.token, "PATCH", `/rest/v1/ai_conversations?id=eq.${id}`, { title: "Renamed" }, { Prefer: "return=minimal" });
check("the owner can still rename it directly", title.status === 204, `status ${title.status} ${JSON.stringify(title.body).slice(0, 160)}`);
const state = await rest(c.token, "PATCH", `/rest/v1/ai_conversations?id=eq.${id}`, { state: { students: [], colleges: [], at: new Date().toISOString() }, summary: "s" }, { Prefer: "return=minimal" });
check("…and write state and summary", state.status === 204, `status ${state.status}`);
const renamed = await call(c.token, "PATCH", `/chat/conversations/${id}`, { title: "Through the API" });
check("the API's rename still works", renamed.status === 200, `status ${renamed.status} ${JSON.stringify(renamed.body).slice(0, 160)}`);

const service = await fetch(`${SB}/rest/v1/ai_conversations?id=eq.${id}`, {
  method: "PATCH",
  headers: { apikey: ANON, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({ draft_rows: rows }),
});
check("the server's client can write draft_rows", service.status === 204, `status ${service.status}`);
check("…and it reads back", (await sql(`select draft_rows -> 0 ->> 'key' from public.ai_conversations where id = '${id}'`)) === "r1");
const read = await rest(c.token, "GET", `/rest/v1/ai_conversations?id=eq.${id}&select=draft_rows`);
check("the owner can read it", read.status === 200 && read.body?.[0]?.draft_rows?.[0]?.key === "r1", JSON.stringify(read.body).slice(0, 160));

const tooMany = await fetch(`${SB}/rest/v1/ai_conversations?id=eq.${id}`, {
  method: "PATCH",
  headers: { apikey: ANON, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ draft_rows: Array.from({ length: 11 }, (_, i) => ({ ...rows[0], key: `r${i}` })) }),
});
check("more than 10 rows is refused by the CHECK", tooMany.status === 400, `status ${tooMany.status}`);
const notArray = await fetch(`${SB}/rest/v1/ai_conversations?id=eq.${id}`, {
  method: "PATCH",
  headers: { apikey: ANON, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ draft_rows: { key: "r1" } }),
});
check("an object instead of a list is refused cleanly", notArray.status === 400, `status ${notArray.status}`);

// ---- The save's compare-and-set round-trips through PostgREST (lib/axis/drafts/state.ts saveDraft) ----
const svc = { apikey: ANON, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
const seen = (await rest(c.token, "GET", `/rest/v1/ai_conversations?id=eq.${id}&select=updated_at`)).body?.[0]?.updated_at;
const casHit = await fetch(`${SB}/rest/v1/ai_conversations?id=eq.${id}&owner_id=eq.${c.id}&updated_at=eq.${encodeURIComponent(seen)}`, { method: "PATCH", headers: svc, body: JSON.stringify({ draft_rows: rows }) });
const hitRows = await casHit.json();
check("a write on the updated_at it read lands", casHit.status === 200 && hitRows.length === 1, `status ${casHit.status} ${JSON.stringify(hitRows).slice(0, 120)}`);
const casMiss = await fetch(`${SB}/rest/v1/ai_conversations?id=eq.${id}&owner_id=eq.${c.id}&updated_at=eq.${encodeURIComponent(seen)}`, { method: "PATCH", headers: svc, body: JSON.stringify({ draft_rows: null }) });
const missRows = await casMiss.json();
check("a write on a stale updated_at changes nothing", casMiss.status === 200 && missRows.length === 0, `status ${casMiss.status} ${JSON.stringify(missRows).slice(0, 120)}`);
check("…and the rows are still there", (await sql(`select draft_rows -> 0 ->> 'key' from public.ai_conversations where id = '${id}'`)) === "r1");
