/**
 * Files (routes/files.ts): the counselor's drive of folders, documents and
 * saved links. Making, renaming and tidying folders and titles runs at once.
 * Whatever changes who may see a file or what AI may read from it asks
 * first: filing a document into a folder (a student's own folder shows it to
 * that student), its kind, the AI and FERPA switches, and attaching a link to
 * a student. Deleting asks. Uploads are not here (the file itself goes from
 * the browser to Storage), and a link is saved unread, because reading it
 * calls a model. Replies name files; they never carry what is in them.
 */
import { z } from "zod";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

const DOC_KINDS = [
  "transcript", "resume", "essay", "test-report", "award-letter",
  "financial", "common-app", "other",
  "recommendation-letter", "activity-list", "iep-504", "counselor-only",
] as const;
const AI_ACCESS = ["default", "allowed", "excluded"] as const;
const RELEVANCE = ["high", "medium", "low", "none"] as const;

const folderFields = {
  name: z.string().trim().min(1).max(200),
  parent_id: uuid.nullable(),
  description: z.string().trim().max(1000).nullable(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Use a #RRGGBB colour")
    .nullable(),
  sort_order: z.number().int().min(0).max(999),
};

const FOLDER_LABELS = { name: "Name", description: "Description", color: "Colour", sort_order: "Position" };
const AI_ACCESS_LABEL: Record<(typeof AI_ACCESS)[number], string> = {
  default: "by its kind (the default)",
  allowed: "always allowed",
  excluded: "never",
};

type Get = Pick<OpHelpers, "get">;
type Folder = { id?: string; name?: string; parentId?: string | null; studentId?: string | null; kind?: string; isSystem?: boolean; systemKey?: string | null; description?: string | null; color?: string | null; sortOrder?: number };
type Doc = { id?: string; studentId?: string | null; folderId?: string | null; filename?: string; title?: string | null; description?: string | null; kind?: string; availableToLlm?: boolean; aiAccess?: string; ferpaWaived?: boolean };
type Link = { id?: string; studentId?: string | null; folderId?: string | null; url?: string; domain?: string | null; title?: string | null; status?: string; availableToLlm?: boolean; relevance?: string | null };

/** No single-row GETs: each list is one call, RLS-scoped to what the counselor may see. */
async function findIn<T>(h: Get, url: string, id: string): Promise<T | null> {
  const hit = asArray(await h.get<unknown[]>(url)).find((r) => r.id === id);
  return hit ? (hit as T) : null;
}
const findFolder = (h: Get, id: string) => findIn<Folder>(h, "/files/folders", id);
const findDocument = (h: Get, id: string) => findIn<Doc>(h, "/files/documents", id);
const findLink = (h: Get, id: string) => findIn<Link>(h, "/files/links", id);

const folderLabel = (f: Folder | null) => (f ? `"${plainText(f.name, 80)}"${f.kind === "student" ? " (student folder)" : ""}` : "a folder");
const docLabel = (d: Doc | null) => (d ? `"${plainText(d.title || d.filename, 80)}"` : "a file");
const linkLabel = (l: Link | null) => (l ? `"${plainText(l.title || l.domain || l.url, 80)}"` : "a link");

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return plainText(url, 60);
  }
}

/** "Folder: …" for a card, saying so when it is a student's own folder (they see what is filed there). */
async function folderLine(h: OpHelpers, id: string | null | undefined, label = "Folder"): Promise<string> {
  if (!id) return `${label}: none (unfiled)`;
  const f = await findFolder(h, id);
  if (!f) return `${label}: a folder`;
  return f.kind === "student" && f.studentId
    ? `${label}: ${h.studentName(f.studentId)}'s own folder (the student sees files filed there, except restricted kinds)`
    : `${label}: "${plainText(f.name, 80)}"`;
}

function aiLines(i: { available_to_llm?: boolean; ai_access?: (typeof AI_ACCESS)[number]; ferpa_waived?: boolean }): string[] {
  const out: string[] = [];
  if (i.available_to_llm !== undefined) out.push(`AI may read it: ${i.available_to_llm ? "yes" : "no (kept out of AI)"}`);
  if (i.ai_access !== undefined) out.push(`AI access: ${AI_ACCESS_LABEL[i.ai_access]}`);
  if (i.ferpa_waived !== undefined) {
    out.push(`FERPA waived: ${i.ferpa_waived ? "yes (a recommendation letter is hidden from the student)" : "no (a recommendation letter becomes visible to the student)"}`);
  }
  return out;
}

const folderBody = (i: Record<string, unknown>) =>
  defined({ name: i.name, parentId: i.parent_id, description: i.description, color: i.color, sortOrder: i.sort_order });

export const files: OpGroup = {
  heading: "Files",
  ops: [
    op({
      name: "files.list_folders",
      kind: "read",
      title: "The counselor's folders with ids (or one student's), including student and practice folders.",
      doc: "{ student_id? }",
      input: z.object({ student_id: uuid.optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/files/folders${qs({ studentId: i.student_id })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (f) => {
            const tag = f.kind === "student" ? "student folder" : f.systemKey ? `practice folder ${str(f.systemKey)}` : "folder";
            return `id ${str(f.id)}: ${untrusted(f.name)} [${tag}]${f.parentId ? ` in ${str(f.parentId)}` : ""}${f.studentId ? ` · student ${str(f.studentId)}` : ""}`;
          },
          "No folders.",
          120
        ),
    }),
    op({
      name: "files.list_documents",
      kind: "read",
      title: "Documents with ids, by student, folder, or unfiled. Names and settings only, never contents.",
      doc: "{ student_id?, folder_id?, unfiled? bool }",
      input: z.object({ student_id: uuid.optional(), folder_id: uuid.optional(), unfiled: z.boolean().optional() }).strict(),
      request: (i) => ({
        method: "GET",
        url: `/files/documents${qs({ studentId: i.student_id, folderId: i.folder_id, unfiled: i.unfiled === undefined ? undefined : String(i.unfiled) })}`,
      }),
      reply: (body) =>
        listReply(
          asArray(body),
          (d) => {
            const flags = [
              d.availableToLlm === false ? "kept out of AI" : null,
              d.aiAccess === "allowed" ? "AI always allowed" : d.aiAccess === "excluded" ? "AI excluded" : null,
              d.ferpaWaived ? "FERPA waived" : null,
            ].filter(Boolean);
            return `id ${str(d.id)}: ${untrusted(d.title || d.filename)} [${str(d.kind)}${flags.length ? `, ${flags.join(", ")}` : ""}]${d.folderId ? ` in folder ${str(d.folderId)}` : " (unfiled)"}${d.studentId ? ` · student ${str(d.studentId)}` : ""}`;
          },
          "No documents."
        ),
    }),
    op({
      name: "files.list_links",
      kind: "read",
      title: "Saved links with ids, by student or folder.",
      doc: "{ student_id?, folder_id? }",
      input: z.object({ student_id: uuid.optional(), folder_id: uuid.optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/files/links${qs({ studentId: i.student_id, folderId: i.folder_id })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (l) =>
            `id ${str(l.id)}: ${untrusted(l.title || l.domain)}${l.domain ? ` (${untrusted(l.domain)})` : ""} [${str(l.status)}${l.availableToLlm === false ? ", kept out of AI" : ""}]${l.folderId ? ` in folder ${str(l.folderId)}` : ""}${l.studentId ? ` · student ${str(l.studentId)}` : ""}`,
          "No saved links."
        ),
    }),
    op({
      name: "files.create_folder",
      kind: "write",
      risk: "auto",
      title: "Make a folder in Files, at the top or inside another folder.",
      doc: "{ name ≤200, parent_id?, description? ≤1000, color? #RRGGBB, sort_order? 0-999 }",
      input: z
        .object({
          name: folderFields.name,
          parent_id: folderFields.parent_id.optional(),
          description: folderFields.description.optional(),
          color: folderFields.color.optional(),
          sort_order: folderFields.sort_order.optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/files/folders", body: folderBody(i) }),
      describe: async (i, h) => {
        const parent = i.parent_id ? await findFolder(h, i.parent_id) : null;
        return `Make folder "${plainText(i.name, 80)}" ${i.parent_id ? `inside ${folderLabel(parent)}` : "at the top of Files"}`;
      },
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "files.delete_folder", input: { folder_id: id } } : null;
      },
    }),
    op({
      name: "files.update_folder",
      kind: "write",
      risk: "auto",
      title: "Rename, describe, recolour, reorder or move a folder (parent_id null moves it to the top).",
      doc: "{ folder_id, name? ≤200, parent_id?|null, description?|null, color? #RRGGBB|null, sort_order? 0-999 }",
      input: z
        .object({
          folder_id: uuid,
          name: folderFields.name.optional(),
          parent_id: folderFields.parent_id.optional(),
          description: folderFields.description.optional(),
          color: folderFields.color.optional(),
          sort_order: folderFields.sort_order.optional(),
        })
        .strict(),
      request: (i) => ({ method: "PATCH", url: `/files/folders/${seg(i.folder_id)}`, body: folderBody(i) }),
      describe: async (i, h) => {
        const f = await findFolder(h, i.folder_id);
        const keys = Object.keys(i).filter((k) => k !== "folder_id");
        if (keys.length === 1 && keys[0] === "parent_id") return `Move folder ${folderLabel(f)}`;
        if (keys.length === 1 && keys[0] === "name") return `Rename folder ${folderLabel(f)} to "${plainText(i.name, 80)}"`;
        return `Update folder ${folderLabel(f)}`;
      },
      details: async (i, h) => {
        const lines = changeLines(i, FOLDER_LABELS);
        if ("parent_id" in i) lines.push(i.parent_id ? await folderLine(h, i.parent_id, "Into") : "Into: the top of Files");
        return lines;
      },
      snapshot: (i, h) => findFolder(h, i.folder_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const from: Record<string, string> = { name: "name", parent_id: "parentId", description: "description", color: "color", sort_order: "sortOrder" };
        const prev: Record<string, unknown> = { folder_id: i.folder_id };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        if ("name" in prev && !prev.name) return null;
        if ("sort_order" in prev && typeof prev.sort_order !== "number") prev.sort_order = 0;
        return { op: "files.update_folder", input: prev };
      },
    }),
    op({
      name: "files.delete_folder",
      kind: "write",
      risk: "confirm",
      title: "Delete an empty folder (student and practice folders can't be deleted).",
      doc: "{ folder_id }",
      input: z.object({ folder_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/files/folders/${seg(i.folder_id)}` }),
      describe: async (i, h) => `Delete folder ${folderLabel(await findFolder(h, i.folder_id))}`,
      warning: "The folder is deleted. Only an empty folder can be; Meridies refuses one that still holds anything.",
    }),
    op({
      name: "files.update_document",
      kind: "write",
      risk: (i) =>
        i.kind !== undefined || i.available_to_llm !== undefined || i.ai_access !== undefined || i.ferpa_waived !== undefined || typeof i.folder_id === "string"
          ? "confirm"
          : "auto",
      title: "Retitle, refile, re-kind a document or set its AI/FERPA switches (only title, description, unfiling run at once).",
      doc: "{ document_id, title?|null, description?|null, folder_id?|null, kind?: transcript|resume|essay|test-report|award-letter|financial|common-app|other|recommendation-letter|activity-list|iep-504|counselor-only, available_to_llm? bool, ai_access?: default|allowed|excluded, ferpa_waived? bool }",
      input: z
        .object({
          document_id: uuid,
          folder_id: uuid.nullable().optional(),
          title: z.string().trim().max(300).nullable().optional(),
          description: z.string().trim().max(2000).nullable().optional(),
          kind: z.enum(DOC_KINDS).optional(),
          available_to_llm: z.boolean().optional(),
          ai_access: z.enum(AI_ACCESS).optional(),
          ferpa_waived: z.boolean().optional(),
        })
        .strict(),
      request: (i) => ({
        method: "PATCH",
        url: `/files/documents/${seg(i.document_id)}`,
        body: defined({
          folderId: i.folder_id,
          title: i.title,
          description: i.description,
          kind: i.kind,
          availableToLlm: i.available_to_llm,
          aiAccess: i.ai_access,
          ferpaWaived: i.ferpa_waived,
        }),
      }),
      describe: async (i, h) => {
        const d = await findDocument(h, i.document_id);
        const what = `${docLabel(d)}${d?.studentId ? ` (${h.studentName(d.studentId)})` : ""}`;
        const keys = Object.keys(i).filter((k) => k !== "document_id");
        if (keys.length === 1 && keys[0] === "folder_id") {
          if (!i.folder_id) return `Unfile ${what}`;
          const f = await findFolder(h, i.folder_id);
          return `File ${what} into ${f?.kind === "student" && f.studentId ? `${h.studentName(f.studentId)}'s folder` : folderLabel(f)}`;
        }
        if (keys.length && keys.every((k) => k === "available_to_llm" || k === "ai_access" || k === "ferpa_waived")) {
          return `Change the AI and privacy settings of ${what}`;
        }
        return `Update ${what}`;
      },
      details: async (i, h) => {
        const lines = changeLines(i, { title: "Title", description: "Description", kind: "Kind" });
        if ("folder_id" in i) lines.push(await folderLine(h, i.folder_id));
        return [...lines, ...aiLines(i)];
      },
      warning: "This changes where the file lives, who can see it, or what AI may read from it.",
      snapshot: (i, h) => findDocument(h, i.document_id),
      undo: (i, body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        // Filing into a student's folder made the file that student's; moving it back would not undo that.
        if ("folder_id" in i && str(asRecord(body).studentId) !== str(b.studentId)) return null;
        const from: Record<string, string> = {
          folder_id: "folderId",
          title: "title",
          description: "description",
          kind: "kind",
          available_to_llm: "availableToLlm",
          ai_access: "aiAccess",
          ferpa_waived: "ferpaWaived",
        };
        const prev: Record<string, unknown> = { document_id: i.document_id };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        if ("kind" in prev && !prev.kind) return null;
        if ("ai_access" in prev && !prev.ai_access) prev.ai_access = "default";
        if ("available_to_llm" in prev) prev.available_to_llm = prev.available_to_llm === true;
        if ("ferpa_waived" in prev) prev.ferpa_waived = prev.ferpa_waived === true;
        return { op: "files.update_document", input: prev };
      },
    }),
    op({
      name: "files.delete_document",
      kind: "write",
      risk: "confirm",
      title: "Delete a document from Files.",
      doc: "{ document_id }",
      input: z.object({ document_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/files/documents/${seg(i.document_id)}` }),
      describe: async (i, h) => {
        const d = await findDocument(h, i.document_id);
        return `Delete ${docLabel(d)}${d?.studentId ? ` from ${h.studentName(d.studentId)}'s files` : " from Files"}`;
      },
      warning: "The document is removed from Files for you and the student, and from anything that links to it.",
    }),
    op({
      name: "files.add_link",
      kind: "write",
      risk: "auto",
      title: "Save a web link in Files, for a student or a folder. It is saved unread (not summarized).",
      doc: "{ url ≤2000, student_id?, folder_id?, title? ≤300, available_to_llm? bool }",
      input: z
        .object({
          url: z.string().trim().min(4).max(2000),
          student_id: uuid.nullable().optional(),
          folder_id: uuid.nullable().optional(),
          title: z.string().trim().max(300).nullable().optional(),
          available_to_llm: z.boolean().optional(),
        })
        .strict(),
      // read: false — reading a link fetches the page and calls a model, which AxIS doesn't start.
      request: (i) => ({
        method: "POST",
        url: "/files/links",
        body: { ...defined({ url: i.url, studentId: i.student_id, folderId: i.folder_id, title: i.title, availableToLlm: i.available_to_llm }), read: false },
      }),
      describe: async (i, h) => {
        const where = i.student_id ? `${h.studentName(i.student_id)}'s files` : i.folder_id ? folderLabel(await findFolder(h, i.folder_id)) : "Files";
        return `Save link ${i.title ? `"${plainText(i.title, 80)}" ` : ""}(${hostOf(i.url)}) to ${where}`;
      },
      details: async (i, h) => {
        const lines = [`Link: ${plainText(i.url, 300)}`];
        if (i.student_id && i.folder_id) lines.push(await folderLine(h, i.folder_id));
        if (i.available_to_llm === false) lines.push("AI may read it: no (kept out of AI)");
        return lines;
      },
      reply: (body) => `Saved unread (id ${idOf(body) ?? "unknown"}); reading and summarizing it is the counselor's click in Files.`,
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "files.delete_link", input: { link_id: id } } : null;
      },
    }),
    op({
      name: "files.update_link",
      kind: "write",
      risk: (i) => (i.available_to_llm !== undefined || typeof i.student_id === "string" ? "confirm" : "auto"),
      title: "Retitle, refile or rate a saved link; attaching it to a student or changing its AI switch waits for Confirm.",
      doc: "{ link_id, title? ≤300|null, folder_id?|null, student_id?|null, available_to_llm? bool, relevance?: high|medium|low|none|null }",
      input: z
        .object({
          link_id: uuid,
          title: z.string().trim().max(300).nullable().optional(),
          folder_id: uuid.nullable().optional(),
          student_id: uuid.nullable().optional(),
          available_to_llm: z.boolean().optional(),
          relevance: z.enum(RELEVANCE).nullable().optional(),
        })
        .strict(),
      request: (i) => ({
        method: "PATCH",
        url: `/files/links/${seg(i.link_id)}`,
        body: defined({ title: i.title, folderId: i.folder_id, studentId: i.student_id, availableToLlm: i.available_to_llm, relevance: i.relevance }),
      }),
      describe: async (i, h) => {
        const l = await findLink(h, i.link_id);
        return `Update link ${linkLabel(l)}${l?.studentId ? ` (${h.studentName(l.studentId)})` : ""}`;
      },
      details: async (i, h) => {
        const lines = changeLines(i, { title: "Title", relevance: "Relevance" });
        if ("folder_id" in i) lines.push(await folderLine(h, i.folder_id));
        if ("student_id" in i) lines.push(i.student_id ? `Student: ${h.studentName(i.student_id)} (they will see this link)` : "Student: none (taken off the student's files)");
        return [...lines, ...aiLines(i)];
      },
      warning: "A link attached to a student shows in their files; the AI switch decides whether AI may read it.",
      snapshot: (i, h) => findLink(h, i.link_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const from: Record<string, string> = { title: "title", folder_id: "folderId", student_id: "studentId", available_to_llm: "availableToLlm", relevance: "relevance" };
        const prev: Record<string, unknown> = { link_id: i.link_id };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        if ("available_to_llm" in prev) prev.available_to_llm = prev.available_to_llm === true;
        return { op: "files.update_link", input: prev };
      },
    }),
    op({
      name: "files.delete_link",
      kind: "write",
      risk: "confirm",
      title: "Delete a saved link.",
      doc: "{ link_id }",
      input: z.object({ link_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/files/links/${seg(i.link_id)}` }),
      describe: async (i, h) => {
        const l = await findLink(h, i.link_id);
        return `Delete link ${linkLabel(l)}${l?.studentId ? ` from ${h.studentName(l.studentId)}'s files` : " from Files"}`;
      },
      warning: "The link and its summary are deleted.",
    }),
  ],
};
