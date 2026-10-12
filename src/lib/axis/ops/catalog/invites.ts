/**
 * Invitations (routes/invites.ts, routes/roster.ts). Every way a student
 * joins the practice is an emailed invitation, so creating, resending and
 * revoking one asks first, and so does sending a roster import. The Building
 * profile flow on Overview (new-student onboarding) is here too: ticking an
 * item received runs at once; sending one back emails the student and
 * confirming a student can't be taken back, so both ask. Replies never carry
 * an email address: a lookup filters on the address the counselor gave and
 * answers with ids and names.
 */
import { z } from "zod";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, defined, idOf, listReply, plainText, seg, str, untrusted, uuid } from "../util.js";

type Get = Pick<OpHelpers, "get">;

const email = z.string().trim().toLowerCase().email().max(320);

const requestItem = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    provided: z.boolean().optional(),
  })
  .strict();

type RequestItem = z.infer<typeof requestItem>;
const toRequests = (rs: RequestItem[]) => rs.map((r) => ({ id: r.id, label: r.label, provided: r.provided ?? false }));

const basics = {
  full_name: z.string().trim().min(1).max(200).nullable(),
  grade_level: z.string().trim().max(40).nullable(),
  grad_year: z.number().int().min(2000).max(2100).nullable(),
  timezone: z.string().trim().max(80).nullable(),
  intake_requests: z.array(requestItem).max(30),
};

const basicsBody = (i: { full_name?: string | null; grade_level?: string | null; grad_year?: number | null; timezone?: string | null; intake_requests?: RequestItem[] }) =>
  defined({
    fullName: i.full_name,
    gradeLevel: i.grade_level,
    gradYear: i.grad_year,
    timezone: i.timezone,
    intakeRequests: i.intake_requests ? toRequests(i.intake_requests) : undefined,
  });

const LABELS = { full_name: "Name", grade_level: "Grade", grad_year: "Class of", timezone: "Time zone" };

const REQUESTS_DOC = "[{ id: transcript|resume|scores|activities|awards|schedule|custom-<slug>, label ≤120, provided? }]";

type Invitation = {
  id?: string;
  status?: string;
  fullName?: string | null;
  acceptedByName?: string | null;
  acceptedBy?: string | null;
  email?: string;
  gradeLevel?: string | null;
  gradYear?: number | null;
  timezone?: string | null;
  intakeRequests?: { id?: string; label?: string; provided?: boolean }[];
  dismissedAt?: string | null;
};

/** GET /invites holds the latest 200; there is no single-invitation GET. */
async function findInvitation(h: Get, id: string): Promise<Invitation | null> {
  const rows = await h.get<unknown>("/invites");
  const hit = asArray(rows).find((r) => r.id === id);
  return hit ? (hit as Invitation) : null;
}

/** The Building profile card for an invitation (only while it is unconfirmed and on Overview). */
async function findCard(h: Get, id: string): Promise<Invitation | null> {
  const rows = await h.get<unknown>("/invites/building");
  const hit = asArray(rows).find((r) => r.id === id);
  return hit ? (hit as Invitation) : null;
}

/** A name for the card and the summary, never the address. */
const whoOf = (inv: Invitation | null) => {
  const name = inv ? (str(inv.fullName) ?? str(inv.acceptedByName)) : null;
  return name ? plainText(name, 80) : "a student";
};

const requestLabel = (inv: Invitation | null, requestId: string) => {
  const q = (inv?.intakeRequests ?? []).find((r) => r.id === requestId);
  return q?.label ? `"${plainText(q.label, 60)}"` : "an item";
};

/** A request id the model must copy back; shown bare only when it is a plain slug. */
const requestIdText = (id: unknown) => {
  const s = String(id ?? "");
  return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : untrusted(s, "request-id");
};

type ImportRow = { id?: string; filename?: string; status?: string; rows?: { status?: string }[] };

async function findImport(h: Get, id: string): Promise<ImportRow | null> {
  const detail = await h.get<unknown>(`/roster/imports/${seg(id)}`);
  return detail ? (asRecord(detail) as ImportRow) : null;
}

export const invites: OpGroup = {
  heading: "Invitations",
  ops: [
    op({
      name: "invites.list",
      kind: "read",
      title: "Your invitations with ids and status; pass the address the counselor gave to find one (addresses are never shown).",
      doc: "{ status?: pending|accepted|revoked, email? }",
      input: z.object({ status: z.enum(["pending", "accepted", "revoked"]).optional(), email: email.optional() }).strict(),
      request: () => ({ method: "GET", url: "/invites" }),
      reply: (body, i) =>
        listReply(
          asArray(body).filter((r) => (!i.status || r.status === i.status) && (!i.email || String(r.email ?? "").toLowerCase() === i.email)),
          (r) => {
            const name = str(r.fullName) ?? str(r.acceptedByName);
            return `id ${str(r.id)}: ${str(r.status)}${r.expired ? " (expired)" : ""}${r.dismissedAt ? ", off Overview" : ""}${r.confirmedAt ? ", confirmed" : ""} · ${name ? untrusted(name, "invitation") : "no name on it"}${r.acceptedBy ? ` · student ${str(r.acceptedBy)}` : ""} · ${r.audience === "family" ? "family link" : `via ${str(r.source) ?? "single"}`} · sent ${str(r.createdAt)?.slice(0, 10) ?? ""}`;
          },
          i.email ? "No invitation to that address." : "No invitations."
        ),
    }),
    op({
      name: "invites.create",
      kind: "write",
      risk: "confirm",
      title: "Invite a new student by email, optionally asking for documents (send_requests puts the ask in the email).",
      doc: `{ email, full_name?, grade_level?, grad_year? YYYY, timezone?, note? ≤1000, intake_requests? ${REQUESTS_DOC}, send_requests? bool }`,
      input: z
        .object({
          email,
          note: z.string().trim().max(1000).nullable().optional(),
          send_requests: z.boolean().optional(),
          full_name: basics.full_name.optional(),
          grade_level: basics.grade_level.optional(),
          grad_year: basics.grad_year.optional(),
          timezone: basics.timezone.optional(),
          intake_requests: basics.intake_requests.optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/invites", body: { email: i.email, ...defined({ note: i.note, sendRequests: i.send_requests }), ...basicsBody(i) } }),
      describe: (i) => `Invite ${i.full_name ? plainText(i.full_name, 80) : "a new student"} to join your practice`,
      details: (i) => {
        const open = (i.intake_requests ?? []).filter((r) => !r.provided).map((r) => r.label.toLowerCase());
        const note = i.note ?? (i.send_requests && open.length ? `Please send: ${open.join(", ")}.` : null);
        return [
          `To: ${i.email}`,
          ...changeLines(i, LABELS),
          ...(i.intake_requests?.length ? [`Asks for: ${plainText(i.intake_requests.map((r) => r.label).join(", "), 400)}`] : []),
          ...(note ? [`Note: ${plainText(note, 1000)}`] : []),
        ];
      },
      warning: "An invitation email goes to this address, and any earlier pending invitation to it stops working.",
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "invites.revoke", input: { invitation_id: id } } : null;
      },
    }),
    op({
      name: "invites.bulk",
      kind: "write",
      risk: "confirm",
      title: "Invite a list of students at once (Mass invite). Addresses already invited or on the roster are skipped.",
      doc: "{ recipients: [{ email, name? ≤200 }] 1-100, note? ≤1000 }",
      input: z
        .object({
          recipients: z
            .array(z.object({ email, name: z.string().trim().max(200).nullable().optional() }).strict())
            .min(1)
            .max(100),
          note: z.string().trim().max(1000).nullable().optional(),
        })
        .strict(),
      request: (i) => ({
        method: "POST",
        url: "/invites/bulk",
        body: { recipients: i.recipients.map((r) => defined({ email: r.email, name: r.name })), ...defined({ note: i.note }) },
      }),
      describe: (i) => `Invite ${i.recipients.length} ${i.recipients.length === 1 ? "student" : "students"} to join your practice`,
      details: (i) => [
        `To: ${plainText(i.recipients.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", "), 1500)}`,
        ...(i.note ? [`Note: ${plainText(i.note, 1000)}`] : []),
      ],
      warning: "Each new address gets an invitation email now.",
      reply: (body) => {
        const b = asRecord(body);
        const n = (k: string) => (typeof b[k] === "number" ? b[k] : 0);
        return `Sent ${n("sent")}, recorded but not emailed ${n("queued")}, skipped ${n("skipped")} (already invited or on the roster), failed ${n("failed")}.`;
      },
    }),
    op({
      name: "invites.update",
      kind: "write",
      risk: (i) => (i.intake_requests !== undefined ? "confirm" : "auto"),
      title: "Change what an invitation (New student card) says: name, grade, class year, time zone, or the full list of requests.",
      doc: "{ invitation_id, full_name?|null, grade_level?|null, grad_year? YYYY|null, timezone?|null, intake_requests? [{ id, label ≤120, provided? }] (the whole list) }",
      input: z
        .object({
          invitation_id: uuid,
          full_name: basics.full_name.optional(),
          grade_level: basics.grade_level.optional(),
          grad_year: basics.grad_year.optional(),
          timezone: basics.timezone.optional(),
          intake_requests: basics.intake_requests.optional(),
        })
        .strict(),
      request: (i) => ({ method: "PATCH", url: `/invites/${seg(i.invitation_id)}`, body: basicsBody(i) }),
      describe: async (i, h) => `Update the invitation for ${whoOf(await findInvitation(h, i.invitation_id))}`,
      details: (i) => [
        ...changeLines(i, LABELS),
        ...(i.intake_requests ? [`Requests: ${plainText(i.intake_requests.map((r) => `${r.label}${r.provided ? " (received)" : ""}`).join(", "), 600) || "none"}`] : []),
      ],
      warning: "If the student has joined, each new request becomes a task on their To-Do, and one marked provided completes theirs.",
      snapshot: (i, h) => findInvitation(h, i.invitation_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        // Tasks a request made on a joined student's To-Do stay when the request goes.
        if (i.intake_requests !== undefined && b.status === "accepted") return null;
        const from: Record<string, string> = { full_name: "fullName", grade_level: "gradeLevel", grad_year: "gradYear", timezone: "timezone", intake_requests: "intakeRequests" };
        const prev: Record<string, unknown> = { invitation_id: i.invitation_id };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        if ("intake_requests" in prev && !Array.isArray(prev.intake_requests)) prev.intake_requests = [];
        return Object.keys(prev).length > 1 ? { op: "invites.update", input: prev } : null;
      },
      reply: () => "Invitation updated.",
    }),
    op({
      name: "invites.resend",
      kind: "write",
      risk: "confirm",
      title: "Send an invitation again with a fresh link (for one not yet accepted).",
      doc: "{ invitation_id }",
      input: z.object({ invitation_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/invites/${seg(i.invitation_id)}/resend`, body: {} }),
      describe: async (i, h) => `Resend the invitation to ${whoOf(await findInvitation(h, i.invitation_id))}`,
      details: async (i, h) => {
        const inv = await findInvitation(h, i.invitation_id);
        return inv?.email ? [`To: ${inv.email}`] : [];
      },
      warning: "A new invitation email goes out now, and the old link stops working.",
    }),
    op({
      name: "invites.restore",
      kind: "write",
      risk: "auto",
      title: "Put a dismissed New student card back on Overview.",
      doc: "{ invitation_id }",
      input: z.object({ invitation_id: uuid }).strict(),
      request: (i) => ({ method: "PATCH", url: `/invites/${seg(i.invitation_id)}`, body: { dismissed: false } }),
      describe: async (i, h) => `Put ${whoOf(await findInvitation(h, i.invitation_id))} back on Overview`,
      undo: (i) => ({ op: "invites.dismiss", input: { invitation_id: i.invitation_id } }),
      reply: () => "Back on Overview.",
    }),
    op({
      name: "invites.dismiss",
      kind: "write",
      risk: "confirm",
      title: "Take a New student (Building profile) card off Overview. The invitation itself stays as it is.",
      doc: "{ invitation_id }",
      input: z.object({ invitation_id: uuid }).strict(),
      request: (i) => ({ method: "PATCH", url: `/invites/${seg(i.invitation_id)}`, body: { dismissed: true } }),
      describe: async (i, h) => `Take ${whoOf(await findInvitation(h, i.invitation_id))} off Overview`,
      warning: "The card leaves Overview; the invitation link keeps working.",
      undo: (i) => ({ op: "invites.restore", input: { invitation_id: i.invitation_id } }),
    }),
    op({
      name: "invites.revoke",
      kind: "write",
      risk: "confirm",
      title: "Revoke a pending invitation so its link stops working.",
      doc: "{ invitation_id }",
      input: z.object({ invitation_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: "/invites/revoke", body: { id: i.invitation_id } }),
      describe: async (i, h) => `Revoke the invitation to ${whoOf(await findInvitation(h, i.invitation_id))}`,
      details: async (i, h) => {
        const inv = await findInvitation(h, i.invitation_id);
        return inv?.email ? [`Address: ${inv.email}`] : [];
      },
      warning: "The invitation link stops working. Inviting them again sends a new email.",
    }),
  ],
};

export const newStudents: OpGroup = {
  heading: "New students (Building profile)",
  ops: [
    op({
      name: "invites.building",
      kind: "read",
      title: "Building profile cards on Overview: who joined, and each requested item's request_id and status.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/invites/building" }),
      reply: (body) =>
        listReply(
          asArray(body),
          (r) => {
            const name = str(r.fullName) ?? str(r.acceptedByName);
            const labels = new Map(asArray(r.intakeRequests).map((q) => [String(q.id), q.label] as const));
            const items = asArray(r.intakeItems).map(
              (q) => `\n  request_id ${requestIdText(q.requestId)}: ${untrusted(labels.get(String(q.requestId)) ?? "", "request")} ${str(q.status)}`
            );
            return `id ${str(r.id)}: ${name ? untrusted(name, "invitation") : "no name on it"} · ${r.status === "accepted" ? `joined (student ${str(r.studentId) ?? "unknown"})` : "hasn't joined yet"} · ${r.canConfirm ? "ready to confirm" : "not ready to confirm"}${items.join("")}`;
          },
          "No Building profile cards."
        ),
    }),
    op({
      name: "invites.receive_item",
      kind: "write",
      risk: "auto",
      title: "Tick a requested item received from a new student (received: false unticks it).",
      doc: "{ invitation_id, request_id ≤100, received: bool }",
      input: z.object({ invitation_id: uuid, request_id: z.string().trim().min(1).max(100), received: z.boolean() }).strict(),
      request: (i) => ({
        method: "PATCH",
        url: `/invites/${seg(i.invitation_id)}`,
        body: { receive: { requestId: i.request_id, received: i.received } },
      }),
      describe: async (i, h) => {
        const card = await findCard(h, i.invitation_id);
        return i.received
          ? `Mark ${requestLabel(card, i.request_id)} received from ${whoOf(card)}`
          : `Untick ${requestLabel(card, i.request_id)} for ${whoOf(card)}`;
      },
      snapshot: async (i, h) => {
        const card = await findCard(h, i.invitation_id);
        const q = (card?.intakeRequests ?? []).find((r) => r.id === i.request_id);
        return q ? { provided: q.provided === true } : null;
      },
      undo: (i, _body, before) =>
        asRecord(before).provided === !i.received
          ? { op: "invites.receive_item", input: { invitation_id: i.invitation_id, request_id: i.request_id, received: !i.received } }
          : null,
      reply: () => "Saved.",
    }),
    op({
      name: "invites.send_back_item",
      kind: "write",
      risk: "confirm",
      title: "Send a requested item back to a new student with what to change.",
      doc: "{ invitation_id, request_id ≤100, note ≤500 }",
      input: z
        .object({ invitation_id: uuid, request_id: z.string().trim().min(1).max(100), note: z.string().trim().min(1).max(500) })
        .strict(),
      request: (i) => ({
        method: "PATCH",
        url: `/invites/${seg(i.invitation_id)}`,
        body: { sendBack: { requestId: i.request_id, note: i.note } },
      }),
      describe: async (i, h) => {
        const card = await findCard(h, i.invitation_id);
        return `Send ${requestLabel(card, i.request_id)} back to ${whoOf(card)}`;
      },
      details: (i) => [`Note to the student: ${plainText(i.note, 500)}`],
      warning: "The student gets a notification and an email with your note, and the files they attached come off the request.",
    }),
    op({
      name: "invites.confirm_student",
      kind: "write",
      risk: "confirm",
      title: "Confirm a new student once everything requested is received: the Building profile card becomes a student card.",
      doc: "{ invitation_id }",
      input: z.object({ invitation_id: uuid }).strict(),
      request: (i) => ({ method: "PATCH", url: `/invites/${seg(i.invitation_id)}`, body: { confirmed: true } }),
      describe: async (i, h) => `Confirm ${whoOf(await findCard(h, i.invitation_id))} as a student`,
      warning: "This can't be undone: the card becomes a normal student card and their setup steps start.",
    }),
  ],
};

export const rosterImports: OpGroup = {
  heading: "Roster imports",
  ops: [
    op({
      name: "invites.list_imports",
      kind: "read",
      title: "Your roster imports (staged files of students to invite) with ids and counts.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/roster/imports" }),
      reply: (body) =>
        listReply(
          asArray(body),
          (r) =>
            `id ${str(r.id)}: ${untrusted(r.filename, "import")} · ${str(r.status)} · ${Number(r.rowsTotal ?? 0)} rows (${Number(r.rowsImported ?? 0)} invited, ${Number(r.rowsSkipped ?? 0)} skipped, ${Number(r.rowsFailed ?? 0)} failed) · ${str(r.createdAt)?.slice(0, 10) ?? ""}`,
          "No roster imports."
        ),
    }),
    op({
      name: "invites.send_import",
      kind: "write",
      risk: "confirm",
      title: "Send invitations to every row of a roster import still waiting to be sent.",
      doc: "{ import_id }",
      input: z.object({ import_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/roster/imports/${seg(i.import_id)}/send`, body: {} }),
      describe: async (i, h) => {
        const imp = await findImport(h, i.import_id);
        return `Send invitations from the roster import ${imp?.filename ? `"${plainText(imp.filename, 80)}"` : ""}`.trim();
      },
      details: async (i, h) => {
        const imp = await findImport(h, i.import_id);
        if (!imp) return [];
        const waiting = asArray(imp.rows).filter((r) => r.status === "pending").length;
        return [`${waiting} invitation ${waiting === 1 ? "email goes" : "emails go"} out.`];
      },
      warning: "Every waiting row gets an invitation email now.",
    }),
    op({
      name: "invites.delete_import",
      kind: "write",
      risk: "confirm",
      title: "Delete a roster import and its staged rows.",
      doc: "{ import_id }",
      input: z.object({ import_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/roster/imports/${seg(i.import_id)}` }),
      describe: async (i, h) => {
        const imp = await findImport(h, i.import_id);
        return `Delete the roster import ${imp?.filename ? `"${plainText(imp.filename, 80)}"` : ""}`.trim();
      },
      warning: "The import and its rows are deleted; invitations it already sent keep working.",
    }),
  ],
};
