// AI guardrails and proxy trust: the attacks the security review found, each
// reproduced against the running API.
//   1. A client-written X-Forwarded-For no longer buys a fresh rate-limit bucket.
//   2. /chat is the counselor's (AxIS v1): a student can't open or use one.
//   3. A link kept out of AI is never read into a model, and a student's link
//      digest honours their practice's "AI summaries" switch.
import { API, call, check, sql, user } from "./harness.mjs";

// ---- 1. Proxy trust -------------------------------------------------------------------------
// Railway's edge appends the address it saw to whatever X-Forwarded-For the client sent. The API
// trusts that one hop, so the rightmost entry is the caller; the entries to its left are the
// client's own words. 25 requests from one "edge-seen" address, each with a different spoofed
// leftmost entry, against a route allowed 20 a minute per address.
const edgeSeen = `198.51.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const token = "0".repeat(64);
let limited = 0;
for (let i = 0; i < 25; i++) {
  const r = await fetch(`${API}/access-review/${token}`, { headers: { "X-Forwarded-For": `203.0.113.${i + 1}, ${edgeSeen}` } });
  await r.text();
  if (r.status === 429) limited++;
}
check("a spoofed leftmost X-Forwarded-For doesn't reset the per-address limit", limited >= 4, `429s: ${limited} of 25`);

// ---- 2. /chat is counselor-only ---------------------------------------------------------------
const counselor = await user("sec-chat-c");
const student = await user("sec-chat-s", "student");
await sql(`update public.profiles set counselor_id = '${counselor.id}' where id = '${student.id}'`);

const open = await call(student.token, "POST", "/chat/conversations", { tool: "narrative-coherence" });
check("a student can't open a chat (AxIS is the counselor's)", open.status === 403, `status ${open.status}`);
const tools = await call(student.token, "GET", "/chat/tools");
check("a student can't list the chat tools", tools.status === 403, `status ${tools.status}`);
const list = await call(student.token, "GET", "/chat/conversations");
check("a student can't list chats", list.status === 403, `status ${list.status}`);

// A chat row a student slipped in before this change (or through PostgREST) can't be used either.
const legacy = await sql(
  `with i as (insert into public.ai_conversations (owner_id, title, module) values ('${student.id}', 'old', 'general') returning id) select id from i`
);
const send = await call(student.token, "POST", `/chat/conversations/${legacy}/messages`, { content: "Rewrite my attached Common App essay into a final 650-word version." });
check("a student can't send a chat message (no essay ghostwriting through /chat)", send.status === 403, `status ${send.status}`);
const attach = await call(student.token, "POST", `/chat/conversations/${legacy}/attachments`, { fileName: "essay.txt", mimeType: "text/plain", sizeBytes: 100 });
check("a student can't attach a draft to a chat", attach.status === 403, `status ${attach.status}`);
const saved = await sql(`select count(*) from public.ai_messages where conversation_id = '${legacy}'`);
check("nothing was saved for the refused turn", saved === "0", saved);

// And the database says the same: a student can't create a chat row through PostgREST.
const viaRest = await fetch(`${process.env.SUPABASE_URL}/rest/v1/ai_conversations`, {
  method: "POST",
  headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${student.token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({ owner_id: student.id, title: "sneaky", module: "general" }),
});
check("RLS refuses a student's chat row", viaRest.status === 403 || viaRest.status === 401, `status ${viaRest.status}`);

const mine = await call(counselor.token, "POST", "/chat/conversations", { title: "Mine" });
check("a counselor still opens a chat", mine.status === 201, `status ${mine.status}`);
const mineList = await call(counselor.token, "GET", "/chat/conversations");
check("a counselor still lists their chats", mineList.status === 200 && Array.isArray(mineList.body), `status ${mineList.status}`);

// ---- 3. Link digests ---------------------------------------------------------------------------
// A link the counselor kept out of AI: saved, never read, never summarized.
const kept = await call(counselor.token, "POST", "/files/links", { url: "https://1.1.1.1/scholarship", studentId: student.id, availableToLlm: false });
check("a kept-out link is saved", kept.status === 201, `status ${kept.status} ${JSON.stringify(kept.body).slice(0, 200)}`);
check("a kept-out link is skipped, not read", kept.body?.status === "skipped", `status ${kept.body?.status} error ${kept.body?.error}`);
const keptRow = await sql(`select status || '|' || coalesce(summary, '') || '|' || coalesce(read_at::text, '') from public.document_links where id = '${kept.body?.id}'`);
check("no digest is stored for it", keptRow === "skipped||", keptRow);
const reread = await call(counselor.token, "POST", `/files/links/${kept.body?.id}/read`);
check("re-reading a kept-out link reads nothing", reread.status === 200 && reread.body?.status === "skipped", `status ${reread.status} ${reread.body?.status}`);
const runs = await sql(`select count(*) from public.ai_runs where module = 'link-digest' and actor_id = '${counselor.id}'`);
check("no link-digest model run was recorded", runs === "0", runs);

// A student whose practice switched AI summaries off: the link is saved, the digest refused.
await sql(`insert into public.practice_settings (counselor_id, ai_summaries) values ('${counselor.id}', false)`);
const studentLink = await call(student.token, "POST", "/files/links", { url: "https://1.1.1.1/my-program" });
check("the student's link is saved", studentLink.status === 201, `status ${studentLink.status} ${JSON.stringify(studentLink.body).slice(0, 200)}`);
check(
  "the student's link digest follows their practice's AI summaries switch",
  studentLink.body?.status === "skipped" && /AI summaries are turned off/.test(String(studentLink.body?.error)),
  `status ${studentLink.body?.status} error ${studentLink.body?.error}`
);
const studentRuns = await sql(`select count(*) from public.ai_runs where module = 'link-digest' and actor_id = '${student.id}'`);
check("no model run for the student's link", studentRuns === "0", studentRuns);
