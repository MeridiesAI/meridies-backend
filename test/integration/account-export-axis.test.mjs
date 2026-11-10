// AxIS chats in the data exports: the chats, their messages, the action cards, and each attached file with the
// text the server read from it (ai_attachments.extracted_text). Bytes of a file are never exported.
//
//   GET  /account/export                  the caller's own chats, all of them (practice.axisChats... for a counselor,
//                                          records.axis_chats... for a student)
//   GET  /account/students/:id/export     the caller's own chats about that student (chat.student_id)
//   POST /account/export/students         the same, per student, as JSON and one CSV per part (the app's zip)
// Set API_LOG to the API's log file to also check no exported text reached it.
import { readFileSync } from "node:fs";
import { call, check, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const T = Date.now();
const FILE_TEXT = `Official transcript ${T}: AP Biology 5, GPA 3.91`;
const OTHER_TEXT = `Collaborator note ${T}`;
const STUDENT_TEXT = `Student legacy chat ${T}`;

const c = await user("axexp-counselor");
const s1 = await studentOf(c, "axexp-s1");
const s2 = await studentOf(c, "axexp-s2");
const col = await user("axexp-collab");
await firmWith(c, [col]); // a student is shared within a firm
await sql(`insert into student_collaborators (student_id, counselor_id, access) values ('${s1.id}', '${col.id}', 'read')`);

const q = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
async function chat(owner, studentId, title, createdAt) {
  return sql(
    `with x as (insert into ai_conversations (owner_id, student_id, module, title, created_at) values ('${owner.id}', ${q(studentId)}, 'axis', ${q(title)}, '${createdAt}') returning id) select id from x`
  );
}
async function message(owner, conv, role, content, createdAt) {
  return sql(
    `with x as (insert into ai_messages (conversation_id, owner_id, role, content, created_at) values ('${conv}', '${owner.id}', '${role}', ${q(content)}, '${createdAt}') returning id) select id from x`
  );
}

// Inserted out of time order, so the export's ordering is the code's, not the insert's.
const general = await chat(c, null, `General ${T}`, "2026-11-03T10:00:00Z");
const aboutS1 = await chat(c, s1.id, `About s1 ${T}`, "2026-11-01T10:00:00Z");
const aboutS2 = await chat(c, s2.id, `About s2 ${T}`, "2026-11-02T10:00:00Z");
const s1Ask = await message(c, aboutS1, "user", `What does the transcript say? ${T}`, "2026-11-01T10:00:01Z");
await message(c, aboutS1, "assistant", `It shows a 3.91 GPA. ${T}`, "2026-11-01T10:00:05Z");
await message(c, general, "user", `General question ${T}`, "2026-11-03T10:00:01Z");
await message(c, aboutS2, "user", `About s2 question ${T}`, "2026-11-02T10:00:01Z");
await sql(
  `insert into ai_attachments (conversation_id, message_id, owner_id, storage_path, file_name, mime_type, size_bytes, extracted_text, extract_kind, extract_cut)
   values ('${aboutS1}', '${s1Ask}', '${c.id}', '${c.id}/${aboutS1}/transcript-${T}.pdf', 'transcript.pdf', 'application/pdf', 2048, ${q(FILE_TEXT)}, 'text', false)`
);
await sql(
  `insert into axis_actions (owner_id, conversation_id, message_id, student_id, type, payload)
   values ('${c.id}', '${aboutS1}', '${s1Ask}', '${s1.id}', 'email_draft', '{"subject":"Transcript ${T}"}'::jsonb)`
);
// The collaborator's own chat about the same student, and a student's own chat from before chats were counselor-only.
const colChat = await chat(col, s1.id, `Collaborator ${T}`, "2026-11-04T10:00:00Z");
await message(col, colChat, "user", OTHER_TEXT, "2026-11-04T10:00:01Z");
const studentChat = await chat(s1, null, `Student own ${T}`, "2026-10-01T10:00:00Z");
await message(s1, studentChat, "user", STUDENT_TEXT, "2026-10-01T10:00:01Z");

const ids = (rows) => (Array.isArray(rows) ? rows.map((r) => r.id) : rows);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- The counselor's own export ------------------------------------------------------------------------------
const self = await call(c.token, "GET", "/account/export");
check("the counselor's own export answers", self.status === 200 && self.body.kind === "counselor", `status ${self.status}`);
const p = self.body.practice ?? {};
check("…older practice fields are all still there", ["workItems", "contacts", "contactActivities", "contactFollowups", "emailTemplates", "resources", "invitations"].every((k) => k in p) && Array.isArray(self.body.roster));
check("…every own chat, oldest first", same(ids(p.axisChats), [aboutS1, aboutS2, general]), JSON.stringify(ids(p.axisChats)));
check(
  "…each chat's messages, grouped by chat in the same order, oldest first",
  same((p.axisChatMessages ?? []).map((m) => [m.conversation_id, m.role]), [
    [aboutS1, "user"],
    [aboutS1, "assistant"],
    [aboutS2, "user"],
    [general, "user"],
  ]),
  JSON.stringify((p.axisChatMessages ?? []).map((m) => [m.conversation_id, m.role]))
);
const file = (p.axisChatFiles ?? [])[0];
check("…the attached file with the text read from it", p.axisChatFiles?.length === 1 && file.extracted_text === FILE_TEXT && file.file_name === "transcript.pdf" && file.extract_kind === "text" && file.message_id === s1Ask, JSON.stringify(p.axisChatFiles));
check("…the chat's action card", p.axisChatActions?.length === 1 && p.axisChatActions[0].payload?.subject === `Transcript ${T}`, JSON.stringify(p.axisChatActions));
check("…the rows carry no join leftovers", (p.axisChatMessages ?? []).every((m) => !("ai_conversations" in m)) && !("ai_conversations" in (file ?? {})));
const selfText = JSON.stringify(self.body);
check("…nobody else's chats", !selfText.includes(OTHER_TEXT) && !selfText.includes(STUDENT_TEXT));
check("…nothing marked truncated", self.body.truncated === undefined, JSON.stringify(self.body.truncated));

// ---- One student's export, as their counselor ----------------------------------------------------------------
const one = await call(c.token, "GET", `/account/students/${s1.id}/export`);
const r = one.body.records ?? {};
check("the per-student export answers, every part readable", one.status === 200 && same(one.body.notIncluded, []), `status ${one.status} ${JSON.stringify(one.body.notIncluded)}`);
check("…the counselor's chats about this student only", same(ids(r.axis_chats), [aboutS1]), JSON.stringify(ids(r.axis_chats)));
check("…their messages", same((r.axis_chat_messages ?? []).map((m) => m.conversation_id), [aboutS1, aboutS1]));
check("…the file text", r.axis_chat_files?.length === 1 && r.axis_chat_files[0].extracted_text === FILE_TEXT);
check("…the action card", r.axis_chat_actions?.length === 1);
const oneText = JSON.stringify(one.body);
check("…no other chat, and not the collaborator's", !oneText.includes(`General question ${T}`) && !oneText.includes(`About s2 question ${T}`) && !oneText.includes(OTHER_TEXT) && !oneText.includes(STUDENT_TEXT));
const two = await call(c.token, "GET", `/account/students/${s2.id}/export`);
check("…another student gets their own chat", same(ids(two.body.records?.axis_chats), [aboutS2]) && two.body.records?.axis_chat_files === undefined, JSON.stringify(ids(two.body.records?.axis_chats)));

// ---- The batch behind the app's zip ---------------------------------------------------------------------------
const batch = await call(c.token, "POST", "/account/export/students", { studentIds: [s1.id, s2.id] });
const b1 = (batch.body.students ?? []).find((s) => s.id === s1.id);
check("the batch carries the chats in the student's JSON", batch.status === 200 && b1?.status === "ok" && same(ids(b1.json?.records?.axis_chats), [aboutS1]), `status ${batch.status}`);
check("…and a CSV for each part with rows", ["axis_chats", "axis_chat_messages", "axis_chat_files", "axis_chat_actions"].every((k) => typeof b1?.csv?.[k] === "string" && b1.csv[k].startsWith("id,")), Object.keys(b1?.csv ?? {}).join(","));
check("…the file text is in its CSV", (b1?.csv?.axis_chat_files ?? "").includes(FILE_TEXT));
const recordRows = Object.values(b1?.json?.records ?? {}).reduce((n, rows) => n + rows.length, 0);
check("…and the chat rows count toward the batch's size (1 chat + 2 messages + 1 file + 1 action)", b1?.rows === 1 + recordRows && recordRows - (b1?.json?.records?.folders?.length ?? 0) === 5, `rows ${b1?.rows}`);

// ---- A counselor the student is shared with -------------------------------------------------------------------
// Through the batch: the per-student GET can't find a shared student (profiles RLS is the primary counselor's).
const colBatch = await call(col.token, "POST", "/account/export/students", { studentIds: [s1.id] });
const colJson = colBatch.body?.students?.[0]?.json;
check(
  "a collaborator's export of the student has only their own chat",
  colBatch.status === 200 && same(ids(colJson?.records?.axis_chats), [colChat]) && !JSON.stringify(colBatch.body).includes(FILE_TEXT),
  `status ${colBatch.status} ${JSON.stringify(ids(colJson?.records?.axis_chats))}`
);

// ---- The student's own export ---------------------------------------------------------------------------------
const mine = await call(s1.token, "GET", "/account/export");
check("a student's own export has the chats they own (one with no student set)", mine.status === 200 && same(ids(mine.body.records?.axis_chats), [studentChat]), JSON.stringify(ids(mine.body.records?.axis_chats)));
check("…and its messages", (mine.body.records?.axis_chat_messages ?? []).some((m) => m.content === STUDENT_TEXT));
const mineText = JSON.stringify(mine.body);
check("…never their counselor's chats about them, or the file text", !mineText.includes(FILE_TEXT) && !mineText.includes(`What does the transcript say? ${T}`) && !mineText.includes(OTHER_TEXT));

// ---- More chats than one query names (100 ids a query) ------------------------------------------------------------
const many = await user("axexp-many");
await sql(`with c as (
  insert into ai_conversations (owner_id, module, title, created_at)
  select '${many.id}', 'axis', 'Chat ' || g, now() - make_interval(mins => 200 - g) from generate_series(1, 130) g returning id, owner_id
), m as (
  insert into ai_messages (conversation_id, owner_id, role, content) select id, owner_id, 'user', 'hello' from c returning conversation_id
)
insert into ai_attachments (conversation_id, owner_id, storage_path, file_name, mime_type, size_bytes, extracted_text, extract_kind)
select id, owner_id, owner_id || '/' || id || '/f.txt', 'f.txt', 'text/plain', 5, 'hello', 'text' from c`);
const manyEx = await call(many.token, "GET", "/account/export");
const mp = manyEx.body.practice ?? {};
check(
  "130 chats: every chat, message and file comes back across the id chunks, nothing truncated",
  manyEx.status === 200 && mp.axisChats?.length === 130 && mp.axisChatMessages?.length === 130 && mp.axisChatFiles?.length === 130 && manyEx.body.truncated === undefined,
  `status ${manyEx.status} chats ${mp.axisChats?.length} messages ${mp.axisChatMessages?.length} files ${mp.axisChatFiles?.length}`
);
check("…oldest first", mp.axisChats?.[0]?.title === "Chat 1" && mp.axisChats?.[129]?.title === "Chat 130", `${mp.axisChats?.[0]?.title} … ${mp.axisChats?.[129]?.title}`);

if (process.env.API_LOG) {
  const log = readFileSync(process.env.API_LOG, "utf8");
  check("the API log has none of the exported chat or file text", !log.includes(FILE_TEXT) && !log.includes(STUDENT_TEXT) && !log.includes(OTHER_TEXT));
}
