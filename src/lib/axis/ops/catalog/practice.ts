/**
 * The practice itself: Management (routes/management.ts), the firm and its
 * people (routes/firms.ts) and the Data & privacy switches
 * (routes/settings.ts).
 *
 * Every Management write asks. Assigning a task lands on a consultant's desk,
 * and editing or ticking one off can change a colleague's list without
 * telling them: the assigner and the firm's owners/admins may edit tasks on
 * other people's lists (RLS), and the risk tier only sees a task id, so it
 * can't tell the counselor's own task from a colleague's. Deleting a task and
 * the staff email blast ask too. Everything about the firm (starting one,
 * branding, invitations, seats, removing someone) and every privacy switch
 * is practice-wide, so it asks.
 *
 * Replies and card lines name people by name and seat only: never an email
 * address (an address shows only in a card's details). An invitation is found
 * by the address the counselor typed, which the reply doesn't repeat.
 */
import { z } from "zod";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, day, dayLabel, defined, idOf, listReply, plainText, seg, str, untrusted, uuid } from "../util.js";

type Rec = Record<string, unknown>;
type Getter = Pick<OpHelpers, "get">;

const SEAT_ROLES = ["admin", "counselor", "assistant"] as const;

const count = (n: unknown, word: string) => `${Number(n ?? 0)} ${word}${Number(n ?? 0) === 1 ? "" : "s"}`;

// ---- Management ---------------------------------------------------------------------

/** GET /management: every consultant (names, seat, "you"), each with the tasks the caller may see. */
async function loadConsultants(h: Getter): Promise<Rec[]> {
  return asArray(asRecord(await h.get("/management")).consultants);
}

const consultantName = (people: Rec[], id: unknown) => str(people.find((c) => c.id === id)?.name);

/** A task or a subtask by id, with its assignee's name. */
async function findTask(h: Getter, id: string): Promise<{ task: Rec; assignee: string | null; parent: Rec | null } | null> {
  for (const c of await loadConsultants(h)) {
    for (const t of asArray(c.tasks)) {
      if (t.id === id) return { task: t, assignee: str(c.name), parent: null };
      const sub = asArray(t.subtasks).find((s) => s.id === id);
      if (sub) return { task: sub, assignee: str(c.name), parent: t };
    }
  }
  return null;
}

const taskLabel = (t: { task: Rec; assignee: string | null } | null) =>
  t ? `"${plainText(t.task.title, 80)}"${t.assignee ? ` (${plainText(t.assignee, 60)})` : ""}` : "a Management task";

function taskLine(t: Rec, assignee: string, indent = ""): string {
  const due = str(t.dueOn);
  const student = str(t.studentName);
  return `${indent}id ${str(t.id)}: [${t.done ? "done" : "open"}] ${due ? `due ${due} ` : ""}${untrusted(t.title)}${indent ? "" : ` · assigned to ${untrusted(assignee, "roster")}`}${student ? ` · student ${untrusted(student, "roster")}` : ""}`;
}

export const management: OpGroup = {
  heading: "Management",
  ops: [
    op({
      name: "management.consultants",
      kind: "read",
      title: "The practice's consultants with ids (for assigning work, owners, blasts).",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/management" }),
      reply: (body) =>
        listReply(
          asArray(asRecord(body).consultants),
          (c) =>
            `id ${str(c.id)}: ${untrusted(c.name, "roster")}${c.isYou ? " (you)" : ""} · ${str(c.seatRole) ?? "counselor"} · ${count(c.studentCount, "student")} · ${count(c.openTaskCount, "open task")}`,
          "No consultants found."
        ),
    }),
    op({
      name: "management.tasks",
      kind: "read",
      title: "Management tasks you can see, with ids and their subtasks (optionally one consultant's).",
      doc: "{ assignee_id?, include_done? bool }",
      input: z.object({ assignee_id: uuid.optional(), include_done: z.boolean().optional() }).strict(),
      request: () => ({ method: "GET", url: "/management" }),
      reply: (body, i) => {
        const rows: Rec[] = [];
        for (const c of asArray(asRecord(body).consultants)) {
          if (i.assignee_id && c.id !== i.assignee_id) continue;
          for (const t of asArray(c.tasks)) if (i.include_done || !t.done) rows.push({ ...t, assigneeName: c.name });
        }
        return listReply(
          rows,
          (t) => [taskLine(t, String(t.assigneeName ?? "")), ...asArray(t.subtasks).slice(0, 12).map((s) => taskLine(s, "", "  subtask "))].join("\n"),
          "No Management tasks."
        );
      },
    }),
    op({
      name: "management.consultant_students",
      kind: "read",
      title: "A consultant's caseload (student ids and names), for a task about one of their students.",
      doc: "{ consultant_id }",
      input: z.object({ consultant_id: uuid }).strict(),
      request: (i) => ({ method: "GET", url: `/management/consultants/${seg(i.consultant_id)}/students` }),
      reply: (body) =>
        listReply(asArray(body), (s) => `id ${str(s.id)}: ${untrusted(s.name, "roster")}${s.gradYear ? ` · class of ${str(s.gradYear)}` : ""}`, "No students on that caseload."),
    }),
    op({
      name: "management.assign_task",
      kind: "write",
      risk: "confirm",
      title: "Assign a Management task to a consultant (or yourself), or add a subtask under a task with parent_id.",
      doc: "{ assignee_id, title ≤300, detail? ≤4000, student_id? (assignee's caseload), parent_id? (subtask: same assignee, no stages/student), stages? [{name, due_on YYYY-MM-DD}] ≤12 (2+ = dated subtasks), notify? bool }",
      input: z
        .object({
          assignee_id: uuid,
          title: z.string().trim().min(1).max(300),
          detail: z.string().trim().max(4000).optional(),
          student_id: uuid.optional(),
          parent_id: uuid.optional(),
          stages: z
            .array(z.object({ name: z.string().trim().min(1).max(300), due_on: day }).strict())
            .max(12)
            .optional(),
          notify: z.boolean().optional(),
        })
        .strict()
        .refine((i) => !(i.parent_id && ((i.stages?.length ?? 0) > 0 || i.student_id)), { message: "A subtask is just a title: leave out stages and student_id" }),
      request: (i) => ({
        method: "POST",
        url: "/management/tasks",
        body: defined({
          assigneeId: i.assignee_id,
          title: i.title,
          detail: i.detail,
          studentId: i.student_id,
          parentId: i.parent_id,
          stages: i.stages?.map((s) => ({ name: s.name, dueOn: s.due_on })),
          notify: i.notify,
        }),
      }),
      describe: async (i, h) => {
        const people = await loadConsultants(h);
        const who = plainText(consultantName(people, i.assignee_id) ?? "a consultant", 60);
        const you = people.find((c) => c.id === i.assignee_id)?.isYou === true;
        if (i.parent_id) {
          const parent = await findTask(h, i.parent_id);
          return `Add subtask "${plainText(i.title, 80)}" under ${taskLabel(parent)}`;
        }
        let student = "";
        if (i.student_id) {
          const name = h.studentName(i.student_id);
          const fallback = asArray(await h.get(`/management/consultants/${seg(i.assignee_id)}/students`)).find((s) => s.id === i.student_id);
          student = ` about ${name !== "the student" ? name : plainText(fallback?.name ?? "a student", 60)}`;
        }
        const last = i.stages?.length ? i.stages[i.stages.length - 1] : null;
        return `${you ? "Add a Management task for yourself" : `Assign a task to ${who}`}: "${plainText(i.title, 80)}"${student}${last ? `, due ${dayLabel(last.due_on)}` : ""}`;
      },
      details: async (i, h) => {
        // The route emails only a colleague, never the counselor assigning to themselves.
        const you = i.notify ? (await loadConsultants(h)).find((c) => c.id === i.assignee_id)?.isYou === true : false;
        return [
          ...(i.detail ? [plainText(i.detail, 600)] : []),
          ...(i.stages && i.stages.length > 1 ? i.stages.map((s) => `${plainText(s.name, 120)}: due ${dayLabel(s.due_on)}`) : []),
          ...(i.notify && !you ? ["They get an email about it."] : []),
        ];
      },
      warning: "It goes onto that consultant's list in Management; with notify, they're emailed.",
      undo: (_i, body) => {
        const id = idOf(asRecord(body).task);
        return id ? { op: "management.delete_task", input: { task_id: id } } : null;
      },
      reply: (body) => {
        const b = asRecord(body);
        return `Assigned (task id ${idOf(b.task) ?? "unknown"})${b.notified === true ? "; they were emailed" : ""}.`;
      },
    }),
    op({
      name: "management.update_task",
      kind: "write",
      risk: "confirm",
      title: "Change a Management task or subtask, or tick it off with done: true.",
      doc: "{ task_id, title? ≤300, detail? ≤4000|null, due_on? YYYY-MM-DD|null, done? bool }",
      input: z
        .object({
          task_id: uuid,
          title: z.string().trim().min(1).max(300).optional(),
          detail: z.string().trim().max(4000).nullable().optional(),
          due_on: day.nullable().optional(),
          done: z.boolean().optional(),
        })
        .strict()
        .refine((i) => i.title !== undefined || i.detail !== undefined || i.due_on !== undefined || i.done !== undefined, { message: "Set at least one field to change" }),
      request: (i) => ({ method: "PATCH", url: `/management/tasks/${seg(i.task_id)}`, body: defined({ title: i.title, detail: i.detail, dueOn: i.due_on, done: i.done }) }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        const only = Object.keys(i).length === 2;
        return only && i.done === true ? `Tick off ${taskLabel(t)}` : only && i.done === false ? `Reopen ${taskLabel(t)}` : `Update ${taskLabel(t)}`;
      },
      details: (i) => changeLines(i, { title: "Title", detail: "Notes", due_on: "Due", done: "Done" }),
      warning: "If the task is on a colleague's list, it changes there too, and they aren't told.",
      snapshot: async (i, h) => (await findTask(h, i.task_id))?.task ?? null,
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { task_id: i.task_id };
        if ("title" in i) prev.title = b.title;
        if ("detail" in i) prev.detail = b.detail ?? null;
        if ("due_on" in i) prev.due_on = b.dueOn ?? null;
        if ("done" in i) prev.done = b.done === true;
        return { op: "management.update_task", input: prev };
      },
      reply: () => "Task updated.",
    }),
    op({
      name: "management.delete_task",
      kind: "write",
      risk: "confirm",
      title: "Delete a Management task (and its subtasks) or a subtask.",
      doc: "{ task_id }",
      input: z.object({ task_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/management/tasks/${seg(i.task_id)}` }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        const subs = t && !t.parent ? asArray(t.task.subtasks).length : 0;
        return `Delete ${t?.parent ? "subtask " : ""}${taskLabel(t)} from Management${subs ? ` with its ${subs} subtask${subs === 1 ? "" : "s"}` : ""}`;
      },
      warning: "It's deleted, not ticked off, and comes off the consultant's list.",
    }),
    op({
      name: "management.email_staff",
      kind: "write",
      risk: "confirm",
      title: "Email consultants in the firm (owner/admin only).",
      doc: "{ subject ≤300, body ≤20000 ({first}, {me} fill in), consultant_ids: [ids from management.consultants] 1-200 }",
      input: z
        .object({
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(20_000),
          consultant_ids: z.array(uuid).min(1).max(200),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/management/blast", body: { subject: i.subject, body: i.body, consultantIds: i.consultant_ids } }),
      describe: (i) => {
        const n = new Set(i.consultant_ids).size;
        return `Email ${n} consultant${n === 1 ? "" : "s"}: "${plainText(i.subject, 100)}"`;
      },
      details: async (i, h) => {
        const people = await loadConsultants(h);
        const names = [...new Set(i.consultant_ids)].map((id) => plainText(consultantName(people, id) ?? "someone not in the practice", 60));
        return [`Subject: ${plainText(i.subject, 300)}`, `To: ${names.slice(0, 20).join(", ")}${names.length > 20 ? `, and ${names.length - 20} more` : ""}`, plainText(i.body, 1200)];
      },
      warning: "The email goes to each consultant now.",
      reply: (body) => {
        const b = asRecord(body);
        return `Blast ${str(b.status) ?? "sent"}: ${Number(b.deliveredCount ?? 0)} delivered, ${Number(b.failedCount ?? 0)} failed, ${Number(b.skippedCount ?? 0)} without an address.`;
      },
    }),
  ],
};

// ---- Firm & team --------------------------------------------------------------------

type Member = { profileId?: string; seatRole?: string; fullName?: string | null; joinedAt?: string };

async function findMember(h: Getter, id: string): Promise<Member | null> {
  const hit = asArray(await h.get("/firms/mine/members")).find((m) => m.profileId === id);
  return hit ? (hit as Member) : null;
}

async function firmName(h: Getter): Promise<string> {
  const f = asRecord(await h.get("/firms/mine"));
  return f.name ? `"${plainText(f.name, 80)}"` : "the firm";
}

const BRANDING_KEYS: Record<string, string> = {
  name: "name",
  website: "website",
  logo_url: "logoUrl",
  banner_url: "bannerUrl",
  accent_color: "accentColor",
  accent_color_source: "accentColorSource",
};
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Use a #RRGGBB colour");

export const firm: OpGroup = {
  heading: "Firm & team",
  ops: [
    op({
      name: "firm.members",
      kind: "read",
      title: "The firm's members with profile ids and seat roles.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/firms/mine/members" }),
      reply: (body) =>
        listReply(
          asArray(body),
          (m) => `id ${str(m.profileId)}: ${m.fullName ? untrusted(m.fullName, "roster") : "(no name)"} · ${str(m.seatRole)}${m.joinedAt ? ` · joined ${String(m.joinedAt).slice(0, 10)}` : ""}`,
          "You're not part of a firm, or it has no members."
        ),
    }),
    op({
      name: "firm.invites",
      kind: "read",
      title: "The firm's invitations with ids. Pass the invitee's email to find theirs (addresses aren't shown).",
      doc: "{ email?, status?: pending|accepted|revoked }",
      input: z
        .object({
          email: z.string().trim().toLowerCase().email().max(320).optional(),
          status: z.enum(["pending", "accepted", "revoked"]).optional(),
        })
        .strict(),
      request: () => ({ method: "GET", url: "/firms/mine/invites" }),
      reply: (body, i) =>
        listReply(
          asArray(body).filter((r) => (!i.email || String(r.email ?? "").toLowerCase() === i.email) && (!i.status || r.status === i.status)),
          (r) =>
            `id ${str(r.id)}: ${str(r.seatRole)} seat · ${str(r.status)} · sent ${String(r.createdAt ?? "").slice(0, 10)}${r.status === "pending" && r.expiresAt ? ` · expires ${String(r.expiresAt).slice(0, 10)}` : ""}${i.email ? " · to the address given" : ""}`,
          i.email ? "No invitation to that address." : "No invitations."
        ),
    }),
    op({
      name: "firm.create",
      kind: "write",
      risk: "confirm",
      title: "Start a firm with the counselor as its owner (only when not already in one).",
      doc: "{ name ≤200 }",
      input: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
      request: (i) => ({ method: "POST", url: "/firms", body: { name: i.name } }),
      describe: (i) => `Start a firm called "${plainText(i.name, 80)}" with you as owner`,
      details: () => [
        "You become the firm's owner. An owner can't leave their own firm, and the app has no way to close one.",
        "Your solo Contact Pipeline, Payment Tracker and Management tasks stay behind: the firm starts with a fresh board.",
        "The firm's Data & privacy switches start at the defaults (all on), whatever your solo practice had set.",
        "Your students stay yours.",
      ],
      warning: "This can't be undone: you become the owner of a new firm, your solo pipeline and billing don't move into it, and Data & privacy starts at the defaults (all on).",
      reply: (body) => `Firm started (id ${str(asRecord(body).firmId) ?? "unknown"}).`,
    }),
    op({
      name: "firm.update_branding",
      kind: "write",
      risk: "confirm",
      title: "Change the firm's name, website, logo or banner link, or accent colour (owner/admin).",
      doc: "{ name? ≤200, website? url|null, logo_url? url|null, banner_url? url|null, accent_color? #RRGGBB|null, accent_color_source?: default|logo|banner|manual }",
      input: z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          website: z.string().trim().url().max(500).nullable().optional(),
          logo_url: z.string().trim().url().max(2000).nullable().optional(),
          banner_url: z.string().trim().url().max(2000).nullable().optional(),
          accent_color: hexColor.nullable().optional(),
          accent_color_source: z.enum(["default", "logo", "banner", "manual"]).optional(),
        })
        .strict()
        .refine((i) => Object.keys(BRANDING_KEYS).some((k) => (i as Record<string, unknown>)[k] !== undefined), { message: "Set at least one branding field" }),
      request: (i) => {
        const body: Record<string, unknown> = {};
        for (const [k, dto] of Object.entries(BRANDING_KEYS)) if ((i as Record<string, unknown>)[k] !== undefined) body[dto] = (i as Record<string, unknown>)[k];
        return { method: "PATCH", url: "/firms/mine", body };
      },
      describe: async (_i, h) => `Change the branding of ${(await firmName(h)).replace(/^"/, 'firm "')}`,
      details: (i) => changeLines(i, { name: "Name", website: "Website", logo_url: "Logo", banner_url: "Banner", accent_color: "Accent colour", accent_color_source: "Colour from" }),
      warning: "Everyone in the firm sees the new branding.",
      snapshot: (_i, h) => h.get("/firms/mine"),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = {};
        for (const [k, dto] of Object.entries(BRANDING_KEYS)) if (k in i) prev[k] = b[dto] ?? null;
        // A colour put back keeps the source it had, rather than being read as typed by hand.
        if ("accent_color" in i) prev.accent_color_source = b.accentColorSource ?? "default";
        if ("accent_color_source" in prev && !prev.accent_color_source) delete prev.accent_color_source;
        if ("name" in prev && !prev.name) return null;
        return Object.keys(prev).length ? { op: "firm.update_branding", input: prev } : null;
      },
      reply: () => "Branding updated.",
    }),
    op({
      name: "firm.invite",
      kind: "write",
      risk: "confirm",
      title: "Invite a consultant to join the firm by email (owner/admin).",
      doc: "{ email, seat_role?: admin|counselor|assistant (default counselor) }",
      input: z.object({ email: z.string().trim().toLowerCase().email().max(320), seat_role: z.enum(SEAT_ROLES).optional() }).strict(),
      request: (i) => ({ method: "POST", url: "/firms/mine/invites", body: defined({ email: i.email, seatRole: i.seat_role }) }),
      describe: async (i, h) => `Invite a consultant to join ${await firmName(h)} as ${i.seat_role ?? "counselor"}`,
      details: (i) => [`To: ${plainText(i.email, 320)}`],
      warning: "An invitation email goes out now; it's good for 14 days.",
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "firm.revoke_invite", input: { invite_id: id } } : null;
      },
      reply: (body) => {
        const b = asRecord(body);
        return `Invitation created (id ${str(b.id) ?? "unknown"})${b.emailSent === false ? ", but the email didn't go out" : ""}.`;
      },
    }),
    op({
      name: "firm.revoke_invite",
      kind: "write",
      risk: "confirm",
      title: "Revoke a pending firm invitation.",
      doc: "{ invite_id }",
      input: z.object({ invite_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/firms/mine/invites/${seg(i.invite_id)}/revoke` }),
      describe: async (i, h) => {
        const inv = asArray(await h.get("/firms/mine/invites")).find((r) => r.id === i.invite_id);
        return inv ? `Revoke the ${str(inv.seatRole)} invitation sent ${dayLabel(inv.createdAt)}` : "Revoke a firm invitation";
      },
      details: async (i, h) => {
        const inv = asArray(await h.get("/firms/mine/invites")).find((r) => r.id === i.invite_id);
        return inv?.email ? [`To: ${plainText(inv.email, 320)}`] : [];
      },
      warning: "The link in their email stops working.",
      reply: () => "Invitation revoked.",
    }),
    op({
      name: "firm.set_member_role",
      kind: "write",
      risk: "confirm",
      title: "Change a firm member's seat: admin, counselor or assistant (owner/admin).",
      doc: "{ profile_id (firm.members), seat_role: admin|counselor|assistant }",
      input: z.object({ profile_id: uuid, seat_role: z.enum(SEAT_ROLES) }).strict(),
      request: (i) => ({ method: "PATCH", url: `/firms/mine/members/${seg(i.profile_id)}`, body: { seatRole: i.seat_role } }),
      describe: async (i, h) => {
        const m = await findMember(h, i.profile_id);
        return `Change ${m?.fullName ? plainText(m.fullName, 60) : "a firm member"}'s seat${m?.seatRole ? ` from ${m.seatRole}` : ""} to ${i.seat_role}`;
      },
      warning: "A seat decides who can bill families, assign work to others and change practice settings.",
      snapshot: (i, h) => findMember(h, i.profile_id),
      undo: (i, _body, before) => {
        const role = str(asRecord(before).seatRole);
        return role && role !== i.seat_role && (SEAT_ROLES as readonly string[]).includes(role)
          ? { op: "firm.set_member_role", input: { profile_id: i.profile_id, seat_role: role } }
          : null;
      },
    }),
    op({
      name: "firm.remove_member",
      kind: "write",
      risk: "confirm",
      title: "Remove someone from the firm (owner/admin), or leave it yourself with your own id.",
      doc: "{ profile_id (firm.members) }",
      input: z.object({ profile_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/firms/mine/members/${seg(i.profile_id)}` }),
      describe: async (i, h) => {
        const [m, people, name] = await Promise.all([findMember(h, i.profile_id), loadConsultants(h), firmName(h)]);
        if (people.find((c) => c.id === i.profile_id)?.isYou === true) return `Leave ${name}`;
        return `Remove ${m?.fullName ? plainText(m.fullName, 60) : "a member"} from ${name}`;
      },
      warning: "They (or you, when leaving) lose the firm's shared pipeline, payments and Management; coming back takes a new invitation.",
    }),
  ],
};

// ---- Data & privacy -----------------------------------------------------------------

const PRIVACY_KEYS: Record<string, string> = {
  ai_summaries: "aiSummaries",
  auto_parse_documents: "autoParseDocuments",
  students_see_shared_reports: "studentsSeeSharedReports",
};

export const settings: OpGroup = {
  heading: "Data & privacy",
  ops: [
    op({
      name: "settings.update_privacy",
      kind: "write",
      risk: "confirm",
      title: "Turn the practice's Data & privacy switches on or off (owner/admin, or solo).",
      doc: "{ ai_summaries? bool, auto_parse_documents? bool, students_see_shared_reports? bool }",
      input: z
        .object({ ai_summaries: z.boolean().optional(), auto_parse_documents: z.boolean().optional(), students_see_shared_reports: z.boolean().optional() })
        .strict()
        .refine((i) => Object.keys(PRIVACY_KEYS).some((k) => (i as Record<string, unknown>)[k] !== undefined), { message: "Set at least one switch" }),
      request: (i) => {
        const body: Record<string, unknown> = {};
        for (const [k, dto] of Object.entries(PRIVACY_KEYS)) if ((i as Record<string, unknown>)[k] !== undefined) body[dto] = (i as Record<string, unknown>)[k];
        return { method: "PATCH", url: "/settings/privacy", body };
      },
      describe: (i) => {
        const words: Record<string, string> = { ai_summaries: "AI summaries", auto_parse_documents: "reading uploaded documents", students_see_shared_reports: "students seeing shared reports" };
        const parts = Object.keys(PRIVACY_KEYS)
          .filter((k) => (i as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${words[k]} ${(i as Record<string, unknown>)[k] ? "on" : "off"}`);
        return parts.length ? `Data & privacy: turn ${parts.join(", ")}` : "Change Data & privacy";
      },
      warning: "These switches apply to everyone in the practice.",
      snapshot: (_i, h) => h.get("/settings/privacy"),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        const prev: Record<string, unknown> = {};
        for (const [k, dto] of Object.entries(PRIVACY_KEYS)) if (k in i && typeof b[dto] === "boolean") prev[k] = b[dto];
        return Object.keys(prev).length ? { op: "settings.update_privacy", input: prev } : null;
      },
      reply: () => "Data & privacy updated.",
    }),
  ],
};
