// Files in an AxIS chat (20261020000001): uploaded through a signed URL, tied to
// the message they were sent with, replayed with the chat, owner-only, removed
// with the chat.
import { ANON, SB, call, check, rest, sql, user } from "./harness.mjs";

const c = await user("axis-files");
const other = await user("axis-files-other");

const conv = await call(c.token, "POST", "/chat/conversations", { title: "Files" });
check("a chat is created", conv.status === 201, JSON.stringify(conv.body));
const chatId = conv.body.id;

const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const ticket = await call(c.token, "POST", `/chat/conversations/${chatId}/attachments`, {
  fileName: "Transcript (fall).pdf",
  mimeType: "application/pdf",
  sizeBytes: pdf.length,
});
check("an upload is started", ticket.status === 201 && ticket.body.token && ticket.body.attachment?.id, JSON.stringify(ticket.body));
check("the file lives under the counselor's own folder", String(ticket.body.path).startsWith(`${c.id}/${chatId}/`), ticket.body.path);

const put = await fetch(`${SB}/storage/v1/object/upload/sign/axis-attachments/${ticket.body.path}?token=${ticket.body.token}`, {
  method: "PUT",
  headers: { apikey: ANON, "Content-Type": "application/pdf" },
  body: pdf,
});
check("the signed upload goes through", put.ok, `status ${put.status}`);

const badType = await call(c.token, "POST", `/chat/conversations/${chatId}/attachments`, { fileName: "a.exe", mimeType: "application/x-msdownload", sizeBytes: 10 });
check("an unsupported type is refused", badType.status === 400, `status ${badType.status}`);
const tooBig = await call(c.token, "POST", `/chat/conversations/${chatId}/attachments`, { fileName: "big.pdf", mimeType: "application/pdf", sizeBytes: 20 * 1024 * 1024 });
check("a file over 10 MB is refused", tooBig.status === 400, `status ${tooBig.status}`);

const theirs = await call(other.token, "POST", `/chat/conversations/${chatId}/attachments`, { fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10 });
check("no one else can attach to the chat", theirs.status === 404, `status ${theirs.status}`);

// Someone else's message can't claim the file into their own chat.
const theirChat = await call(other.token, "POST", "/chat/conversations", { title: "Mine" });
await call(other.token, "POST", `/chat/conversations/${theirChat.body.id}/messages`, { content: "read this", attachmentIds: [ticket.body.attachment.id] });
const stolen = await sql(`select count(*) from public.ai_attachments where id = '${ticket.body.attachment.id}' and message_id is not null`);
check("another chat's message can't claim the file", stolen === "0", stolen);

// The message names the file; it is tied to that message whether or not the model answers here.
await call(c.token, "POST", `/chat/conversations/${chatId}/messages`, { content: "explain this", attachmentIds: [ticket.body.attachment.id] });
const detail = await call(c.token, "GET", `/chat/conversations/${chatId}`);
const sent = (detail.body.messages ?? []).find((m) => m.role === "user" && m.content === "explain this");
check("the message carries its file in the replay", sent?.attachments?.length === 1 && sent.attachments[0].fileName === "Transcript (fall).pdf", JSON.stringify(sent));

const link = await call(c.token, "GET", `/chat/attachments/${ticket.body.attachment.id}/url`);
check("the counselor can open the file", link.status === 200 && /^https?:\/\//.test(link.body.url), JSON.stringify(link.body));
const got = link.status === 200 ? await fetch(link.body.url) : null;
check("the link serves the file", got?.ok === true && Buffer.from(await got.arrayBuffer()).equals(pdf));
const peek = await call(other.token, "GET", `/chat/attachments/${ticket.body.attachment.id}/url`);
check("no one else can open it", peek.status === 404, `status ${peek.status}`);
const rows = await rest(other.token, "GET", `/rest/v1/ai_attachments?select=id&id=eq.${ticket.body.attachment.id}`);
check("no one else can read its row", (rows.body ?? []).length === 0);

const del = await call(c.token, "DELETE", `/chat/conversations/${chatId}`);
check("the chat deletes", del.status === 204, `status ${del.status}`);
const left = await sql(`select count(*) from storage.objects where bucket_id = 'axis-attachments' and name like '${c.id}/${chatId}/%'`);
check("its stored files go with it", left === "0", left);
const rowsLeft = await sql(`select count(*) from public.ai_attachments where conversation_id = '${chatId}'`);
check("and their rows", rowsLeft === "0", rowsLeft);
