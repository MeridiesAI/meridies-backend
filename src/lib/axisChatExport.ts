/**
 * AxIS chats in the data exports (routes/account.ts). A chat is four parts: the chat itself (ai_conversations), its
 * messages (ai_messages), the cards AxIS proposed in it (axis_actions) and the files attached to it (ai_attachments),
 * each file with the text the server read from it (`extracted_text`, written once by lib/axis/attachments.ts). A
 * file's bytes are never exported, the same as a student's documents.
 *
 * Every chat table is owner-only (RLS), so an export only ever holds the caller's own chats:
 *   - the caller's own export (GET /account/export): every chat they own. A student's are from before chats were
 *     counselor-only (20261024000051) and usually have no student set;
 *   - a student's export by a counselor (per student and in batches): the caller's own chats whose `student_id` is
 *     that student, the same rule as the app's chat list for a student (GET /chat/conversations?studentId=). That is
 *     the student the chat was last about, and a chat can mention other students the counselor can see.
 * A student's own export never holds their counselor's chats about them.
 *
 * Rows are as stored (`*`) and read in pages like every export table. The chats are read by owner (and student),
 * named in the query rather than left to RLS; the three child parts by their chats' ids (`conversation_id`, indexed
 * on each), so the read touches the caller's rows and no one else's. Each part comes
 * back oldest chat first, with each chat's rows together in time order, so the app's readable PDF and Word files
 * (which list every row of a part in turn) read chat by chat. File rows are read 50 to a page, since each can carry
 * 200,000 characters of text, and the text is budgeted: once FILE_TEXT_BUDGET is reached the files part stops after
 * that page and is reported truncated.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { TABLE_ROW_CAP, readPaged } from "./pagedRead.js";

type Row = Record<string, unknown>;

/** The parts, in export order, with their key in a student's `records` and in a counselor's `practice`. */
export const CHAT_PARTS = [
  { table: "ai_conversations", record: "axis_chats", practice: "axisChats" },
  { table: "ai_messages", record: "axis_chat_messages", practice: "axisChatMessages" },
  { table: "axis_actions", record: "axis_chat_actions", practice: "axisChatActions" },
  { table: "ai_attachments", record: "axis_chat_files", practice: "axisChatFiles" },
] as const;

export type ChatTable = (typeof CHAT_PARTS)[number]["table"];
/** Whose chats: always the caller's own (`owner`), and with `student` only those about that student. */
export type ChatScope = { owner: string; student?: string };
export type PartRead = { rows: Row[]; truncated: boolean; error: unknown };

/** File rows a page. */
export const FILE_PAGE_SIZE = 50;
/** File text one export carries, in UTF-8 bytes of `extracted_text` (it can go over by at most one page). */
export const FILE_TEXT_BUDGET = 20 * 1024 * 1024;

/** Counts file text page by page; `spent` once it reaches `limit`. */
export function fileTextBudget(limit = FILE_TEXT_BUDGET) {
  let bytes = 0;
  return {
    onPage(rows: Row[]) {
      for (const r of rows) if (typeof r.extracted_text === "string") bytes += Buffer.byteLength(r.extracted_text);
    },
    spent: () => bytes >= limit,
  };
}

const time = (r: Row) => {
  const t = Date.parse(String(r.created_at ?? ""));
  return Number.isNaN(t) ? 0 : t;
};
const byTimeThenId = (a: Row, b: Row) => time(a) - time(b) || String(a.id).localeCompare(String(b.id));

/**
 * Chats oldest first; every other part grouped by chat in that order, then by time, ties by id. A row whose chat
 * isn't in the list (its chat was past the row cap) goes last rather than being dropped. Returns new arrays.
 */
export function orderChatParts(parts: Record<ChatTable, Row[]>): Record<ChatTable, Row[]> {
  const chats = [...parts.ai_conversations].sort(byTimeThenId);
  const rank = new Map(chats.map((c, i) => [String(c.id), i]));
  const rankOf = (r: Row) => rank.get(String(r.conversation_id)) ?? Number.MAX_SAFE_INTEGER;
  const group = (rows: Row[]) => [...rows].sort((a, b) => rankOf(a) - rankOf(b) || byTimeThenId(a, b));
  return {
    ai_conversations: chats,
    ai_messages: group(parts.ai_messages),
    axis_actions: group(parts.axis_actions),
    ai_attachments: group(parts.ai_attachments),
  };
}

/** Chat ids per query on a child part (each a uuid in the URL's `in` list). */
export const CHAT_ID_CHUNK = 100;

type ChunkFetch = (ids: string[], from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;

/**
 * A child part's rows for `chatIds`, read by `conversation_id` (indexed on all three) CHAT_ID_CHUNK ids at a time,
 * each chunk paged by readPaged, under ONE row cap and one `stop` across the chunks. Once either is reached, each
 * later chunk is only probed for a row (readPaged with cap 0), so `truncated` says whether anything was left out.
 */
export async function readByChats(
  chatIds: string[],
  fetchChunk: ChunkFetch,
  opts: { pageSize?: number; cap?: number; onPage?: (rows: Row[]) => void; stop?: () => boolean } = {}
): Promise<PartRead> {
  const cap = opts.cap ?? TABLE_ROW_CAP;
  const rows: Row[] = [];
  for (let i = 0; i < chatIds.length; i += CHAT_ID_CHUNK) {
    const ids = chatIds.slice(i, i + CHAT_ID_CHUNK);
    const full = rows.length >= cap || (opts.stop?.() ?? false);
    const r = await readPaged((from, to) => fetchChunk(ids, from, to), {
      pageSize: opts.pageSize,
      onPage: opts.onPage,
      stop: opts.stop,
      cap: full ? 0 : cap - rows.length,
    });
    rows.push(...r.rows);
    if (r.error) return { rows, truncated: false, error: r.error };
    if (r.truncated) return { rows, truncated: true, error: null };
  }
  return { rows, truncated: false, error: null };
}

function readChats(db: SupabaseClient, scope: ChatScope, onPage?: (rows: Row[]) => void): Promise<PartRead> {
  return readPaged(
    (from, to) => {
      let q = db.from("ai_conversations").select("*").eq("owner_id", scope.owner);
      if (scope.student) q = q.eq("student_id", scope.student);
      return q.order("id").range(from, to);
    },
    { onPage }
  );
}

function readChildren(
  db: SupabaseClient,
  table: Exclude<ChatTable, "ai_conversations">,
  chatIds: string[],
  opts: { pageSize?: number; onPage?: (rows: Row[]) => void; stop?: () => boolean }
): Promise<PartRead> {
  return readByChats(chatIds, (ids, from, to) => db.from(table).select("*").in("conversation_id", ids).order("id").range(from, to), opts);
}

/**
 * The caller's chats in `scope`, then their messages, cards and files by chat id, every part read in pages
 * (`onPage` sees each page: the batch's size guard) and put in reading order. A part the caller can't read comes
 * back with its `error`, for the export to list as not included.
 */
export async function readAxisChats(
  db: SupabaseClient,
  scope: ChatScope,
  onPage?: (rows: Row[]) => void
): Promise<Record<ChatTable, PartRead>> {
  const chats = await readChats(db, scope, onPage);
  const ids = chats.error ? [] : chats.rows.map((c) => String(c.id));
  const budget = fileTextBudget();
  const [messages, actions, files] = await Promise.all([
    readChildren(db, "ai_messages", ids, { onPage }),
    readChildren(db, "axis_actions", ids, { onPage }),
    readChildren(db, "ai_attachments", ids, {
      pageSize: FILE_PAGE_SIZE,
      onPage: (rows) => {
        onPage?.(rows);
        budget.onPage(rows);
      },
      stop: budget.spent,
    }),
  ]);
  const ordered = orderChatParts({
    ai_conversations: chats.rows,
    ai_messages: messages.rows,
    axis_actions: actions.rows,
    ai_attachments: files.rows,
  });
  return {
    ai_conversations: { ...chats, rows: ordered.ai_conversations },
    ai_messages: { ...messages, rows: ordered.ai_messages },
    axis_actions: { ...actions, rows: ordered.axis_actions },
    ai_attachments: { ...files, rows: ordered.ai_attachments },
  };
}
