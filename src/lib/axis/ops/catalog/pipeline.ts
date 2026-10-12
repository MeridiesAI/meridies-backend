/**
 * Contact Pipeline and its Payment Tracker (routes/pipeline.ts). The
 * practice's private board of families, from first inquiry to active
 * student; no student or family sees it, so adding a card or a stage,
 * editing one and moving a card run at once. Deleting a card or a stage
 * asks, and so does handing a card to a colleague (its owner can bill the
 * family). Inviting the student and emailing the family send mail, so they
 * ask. Everything in the Payment Tracker is money, so all of it asks.
 *
 * Replies name a card by its student's name, stage, owner and days in stage,
 * never by an email, phone or address.
 */
import { z } from "zod";
import { formatUsd, PAYMENT_METHODS, type PaymentMethod } from "../../../payments.js";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, day, dayLabel, defined, idOf, listReply, plainText, seg, str, untrusted, uuid } from "../util.js";

const LIFECYCLE_GROUPS = ["prospect", "lead", "client", "current"] as const;

// The route's own shapes (routes/pipeline.ts), field for field.
const shortText = (max: number) => z.string().trim().max(max);
const optionalEmail = z.union([z.literal(""), z.string().trim().toLowerCase().email().max(320)]);
const PLACEHOLDER_NAME = /^(new contact|new student|untitled( contact)?|unnamed|name|student name)$/i;
const contactName = shortText(200).refine((n) => n.length > 0 && !PLACEHOLDER_NAME.test(n), { message: "Give the contact a name first" });
const stageName = z.string().trim().min(1).max(120);

const contactFields = {
  student_name: contactName,
  grad_year: z.number().int().min(2000).max(2100).nullable(),
  student_email: optionalEmail,
  student_phone: shortText(40),
  parent_name: shortText(200),
  parent_email: optionalEmail,
  parent_phone: shortText(40),
  next_step: shortText(300),
};

/** Card field (snake_case input) -> the contact DTO key, which is also the PATCH body key. */
const CONTACT_KEYS: Record<keyof typeof contactFields, string> = {
  student_name: "studentName",
  grad_year: "gradYear",
  student_email: "studentEmail",
  student_phone: "studentPhone",
  parent_name: "parentName",
  parent_email: "parentEmail",
  parent_phone: "parentPhone",
  next_step: "nextStep",
};

const CONTACT_LABELS = {
  student_name: "Student",
  grad_year: "Class of",
  student_email: "Student email",
  student_phone: "Student phone",
  parent_name: "Parent",
  parent_email: "Parent email",
  parent_phone: "Parent phone",
  next_step: "Next step",
};

/** The info card a contact carries before they are a student: input key -> `info` key (limits in `infoInput`, the route's). */
const INFO: Record<string, { key: string; label: string }> = {
  high_school: { key: "highSchool", label: "High school" },
  gpa_weighted: { key: "gpaWeighted", label: "Weighted GPA" },
  gpa_unweighted: { key: "gpaUnweighted", label: "Unweighted GPA" },
  class_rank: { key: "classRank", label: "Class rank" },
  sat: { key: "sat", label: "SAT" },
  act: { key: "act", label: "ACT" },
  rigor: { key: "rigor", label: "Rigor" },
  intended_majors: { key: "intendedMajors", label: "Intended majors" },
  citizenship: { key: "citizenship", label: "Citizenship" },
  first_gen: { key: "firstGen", label: "First-gen" },
  living_with_parent: { key: "livingWithParent", label: "Living with parent" },
  marital_status: { key: "maritalStatus", label: "Parents' marital status" },
  gender: { key: "gender", label: "Gender" },
  birthday: { key: "birthday", label: "Birthday" },
  address: { key: "address", label: "Address" },
};
const INFO_LABELS = Object.fromEntries(Object.entries(INFO).map(([k, v]) => [k, v.label]));
const infoInput = z
  .object({
    contact_id: uuid,
    high_school: shortText(200).optional(),
    gpa_weighted: shortText(10).optional(),
    gpa_unweighted: shortText(10).optional(),
    class_rank: shortText(40).optional(),
    sat: shortText(10).optional(),
    act: shortText(10).optional(),
    rigor: shortText(200).optional(),
    intended_majors: shortText(300).optional(),
    citizenship: shortText(60).optional(),
    first_gen: shortText(20).optional(),
    living_with_parent: shortText(20).optional(),
    marital_status: shortText(40).optional(),
    gender: shortText(60).optional(),
    birthday: shortText(20).optional(),
    address: shortText(300).optional(),
  })
  .strict();

// ---- Reading the board --------------------------------------------------------------

type Rec = Record<string, unknown>;
type Board = { stages: Rec[]; contacts: Rec[]; consultants: Rec[] };
type Getter = Pick<OpHelpers, "get">;

const byPosition = (a: Rec, b: Rec) => Number(a.position ?? 0) - Number(b.position ?? 0);

function boardOf(body: unknown): Board {
  const b = asRecord(body);
  return { stages: asArray(b.stages).sort(byPosition), contacts: asArray(b.contacts), consultants: asArray(b.consultants) };
}

async function loadBoard(h: Getter): Promise<Board | null> {
  const body = await h.get("/pipeline");
  return body ? boardOf(body) : null;
}

const findContact = (b: Board | null, id: string) => b?.contacts.find((c) => c.id === id) ?? null;
const findStage = (b: Board | null, id: unknown) => b?.stages.find((s) => s.id === id) ?? null;
const personName = (b: Board | null, id: unknown) => str(b?.consultants.find((c) => c.id === id)?.name);

/** Card lines read "cleared" for an empty string, which is how these fields are cleared. */
const blankToNull = (i: Record<string, unknown>) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, v === "" ? null : v]));

const cardLabel = (c: Rec | null) => (c ? `${plainText(c.studentName, 80)}'s card` : "a pipeline card");
const familyLabel = (c: Rec | null) => (c ? `${plainText(c.studentName, 80)}'s family` : "a family");
const stageLabel = (s: Rec | null) => (s ? `"${plainText(s.name, 60)}"` : "a stage");

function contactLine(c: Rec, b: Board): string {
  const stage = findStage(b, c.stageId);
  const owner = personName(b, c.ownerId);
  const joined = c.conversion === "joined" ? ` · joined as a student (student id ${str(c.studentId)})` : c.conversion === "invited" ? " · invited" : "";
  return `id ${str(c.id)}: ${untrusted(c.studentName)} · stage ${stage ? untrusted(stage.name) : "unknown"} · owner ${owner ? untrusted(owner, "roster") : "none"} · ${Number(c.daysInStage ?? 0)} days in stage${joined}`;
}

// ---- Reading the Payment Tracker ----------------------------------------------------

const usd = (cents: unknown) => formatUsd(Number(cents ?? 0));

async function loadAccounts(h: Getter): Promise<Rec[]> {
  return asArray(asRecord(await h.get("/pipeline/payments")).accounts);
}

async function findAccount(h: Getter, contactId: string): Promise<Rec | null> {
  return (await loadAccounts(h)).find((a) => a.contactId === contactId) ?? null;
}

/** An invoice or a payment by id, with the account it sits on. */
async function findBilling(h: Getter, kind: "invoices" | "payments", id: string): Promise<{ row: Rec; contactId: string } | null> {
  for (const a of await loadAccounts(h)) {
    const row = asArray(a[kind]).find((r) => r.id === id);
    if (row) return { row, contactId: String(a.contactId) };
  }
  return null;
}

async function familyName(h: Getter, contactId: string | null | undefined): Promise<string> {
  if (!contactId) return "a family";
  return familyLabel(findContact(await loadBoard(h), contactId));
}

// ---- Contact Pipeline --------------------------------------------------------------

export const pipeline: OpGroup = {
  heading: "Contact Pipeline",
  ops: [
    op({
      name: "pipeline.stages",
      kind: "read",
      title: "The Contact Pipeline's stage columns with ids, in board order.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/pipeline" }),
      reply: (body) => {
        const b = boardOf(body);
        const counts = new Map<string, number>();
        for (const c of b.contacts) counts.set(String(c.stageId), (counts.get(String(c.stageId)) ?? 0) + 1);
        return listReply(
          b.stages,
          (s) => `id ${str(s.id)}: ${untrusted(s.name)} [${str(s.lifecycleGroup)}] · ${counts.get(String(s.id)) ?? 0} card${counts.get(String(s.id)) === 1 ? "" : "s"}`,
          "The pipeline has no stages yet."
        );
      },
    }),
    op({
      name: "pipeline.contacts",
      kind: "read",
      title: "Contact Pipeline cards (families) with ids: stage, owner, days in stage. Filter by stage or name.",
      doc: "{ stage_id?, name? (part of the student's name) }",
      input: z.object({ stage_id: uuid.optional(), name: z.string().trim().min(1).max(200).optional() }).strict(),
      request: () => ({ method: "GET", url: "/pipeline" }),
      reply: (body, i) => {
        const b = boardOf(body);
        const order = new Map(b.stages.map((s, n) => [String(s.id), n]));
        const needle = i.name?.toLowerCase();
        const rows = b.contacts
          .filter((c) => (!i.stage_id || c.stageId === i.stage_id) && (!needle || String(c.studentName ?? "").toLowerCase().includes(needle)))
          .sort((x, y) => (order.get(String(x.stageId)) ?? 0) - (order.get(String(y.stageId)) ?? 0) || byPosition(x, y));
        return listReply(rows, (c) => contactLine(c, b), i.name || i.stage_id ? "No contacts match." : "The pipeline has no contacts yet.");
      },
    }),
    op({
      name: "pipeline.create_stage",
      kind: "write",
      risk: "auto",
      title: "Add a stage column to the Contact Pipeline (at the end).",
      doc: "{ name? ≤120, lifecycle_group?: prospect|lead|client|current }",
      input: z.object({ name: stageName.optional(), lifecycle_group: z.enum(LIFECYCLE_GROUPS).optional() }).strict(),
      request: (i) => ({ method: "POST", url: "/pipeline/stages", body: defined({ name: i.name, lifecycleGroup: i.lifecycle_group }) }),
      describe: (i) => `Add stage "${plainText(i.name ?? "New stage", 60)}"${i.lifecycle_group ? ` (${i.lifecycle_group})` : ""} to the Contact Pipeline`,
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "pipeline.delete_stage", input: { stage_id: id } } : null;
      },
    }),
    op({
      name: "pipeline.create_contact",
      kind: "write",
      risk: "auto",
      title: "Add a family to the Contact Pipeline as a new card in a stage.",
      doc: "{ stage_id, student_name ≤200, grad_year? int|null, student_email?, student_phone? ≤40, parent_name? ≤200, parent_email?, parent_phone? ≤40, next_step? ≤300 }",
      input: z
        .object({
          stage_id: uuid,
          student_name: contactFields.student_name,
          grad_year: contactFields.grad_year.optional(),
          student_email: contactFields.student_email.optional(),
          student_phone: contactFields.student_phone.optional(),
          parent_name: contactFields.parent_name.optional(),
          parent_email: contactFields.parent_email.optional(),
          parent_phone: contactFields.parent_phone.optional(),
          next_step: contactFields.next_step.optional(),
        })
        .strict(),
      request: (i) => ({
        method: "POST",
        url: "/pipeline/contacts",
        body: defined({
          stageId: i.stage_id,
          studentName: i.student_name,
          gradYear: i.grad_year,
          studentEmail: i.student_email,
          studentPhone: i.student_phone,
          parentName: i.parent_name,
          parentEmail: i.parent_email,
          parentPhone: i.parent_phone,
          nextStep: i.next_step,
        }),
      }),
      describe: async (i, h) => {
        const stage = findStage(await loadBoard(h), i.stage_id);
        return `Add ${plainText(i.student_name, 80)} to the Contact Pipeline in ${stageLabel(stage)}`;
      },
      details: (i) => changeLines(i, { grad_year: "Class of", student_email: "Student email", student_phone: "Student phone", parent_name: "Parent", parent_email: "Parent email", parent_phone: "Parent phone", next_step: "Next step" }),
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "pipeline.delete_contact", input: { contact_id: id } } : null;
      },
    }),
    op({
      name: "pipeline.update_stage",
      kind: "write",
      risk: "auto",
      title: "Rename a pipeline stage or move it to another lifecycle group.",
      doc: "{ stage_id, name? ≤120, lifecycle_group?: prospect|lead|client|current }",
      input: z.object({ stage_id: uuid, name: stageName.optional(), lifecycle_group: z.enum(LIFECYCLE_GROUPS).optional() }).strict(),
      request: (i) => ({ method: "PATCH", url: `/pipeline/stages/${seg(i.stage_id)}`, body: defined({ name: i.name, lifecycleGroup: i.lifecycle_group }) }),
      describe: async (i, h) => {
        const s = findStage(await loadBoard(h), i.stage_id);
        return `${i.name && !i.lifecycle_group ? "Rename" : "Update"} pipeline stage ${stageLabel(s)}`;
      },
      details: (i) => changeLines(i, { name: "Name", lifecycle_group: "Lifecycle group" }),
      snapshot: async (i, h) => findStage(await loadBoard(h), i.stage_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { stage_id: i.stage_id };
        if ("name" in i) prev.name = b.name;
        if ("lifecycle_group" in i) prev.lifecycle_group = b.lifecycleGroup;
        return { op: "pipeline.update_stage", input: prev };
      },
    }),
    op({
      name: "pipeline.reorder_stages",
      kind: "write",
      risk: "auto",
      title: "Put the pipeline's stage columns in a new order (every stage id, in order).",
      doc: "{ stage_ids: [every stage id, in the new order] ≤40 }",
      input: z.object({ stage_ids: z.array(uuid).min(1).max(40) }).strict(),
      request: (i) => ({ method: "PUT", url: "/pipeline/stages/order", body: { ids: i.stage_ids } }),
      describe: async (i, h) => {
        const b = await loadBoard(h);
        const names = i.stage_ids.slice(0, 8).map((id) => plainText(findStage(b, id)?.name ?? "?", 40));
        return `Reorder the Contact Pipeline's stages: ${names.join(", ")}${i.stage_ids.length > 8 ? ", …" : ""}`;
      },
      snapshot: async (_i, h) => (await loadBoard(h))?.stages.map((s) => String(s.id)) ?? null,
      undo: (_i, _body, before) => (Array.isArray(before) && before.length ? { op: "pipeline.reorder_stages", input: { stage_ids: before } } : null),
    }),
    op({
      name: "pipeline.update_contact",
      kind: "write",
      risk: "auto",
      title: "Edit a pipeline card: names, class year, contact details, next step.",
      doc: "{ contact_id, student_name? ≤200, grad_year? int|null, student_email?, student_phone? ≤40, parent_name? ≤200, parent_email?, parent_phone? ≤40, next_step? ≤300 }",
      input: z
        .object({
          contact_id: uuid,
          student_name: contactFields.student_name.optional(),
          grad_year: contactFields.grad_year.optional(),
          student_email: contactFields.student_email.optional(),
          student_phone: contactFields.student_phone.optional(),
          parent_name: contactFields.parent_name.optional(),
          parent_email: contactFields.parent_email.optional(),
          parent_phone: contactFields.parent_phone.optional(),
          next_step: contactFields.next_step.optional(),
        })
        .strict(),
      request: (i) => {
        const body: Record<string, unknown> = {};
        for (const [k, dto] of Object.entries(CONTACT_KEYS)) if ((i as Record<string, unknown>)[k] !== undefined) body[dto] = (i as Record<string, unknown>)[k];
        return { method: "PATCH", url: `/pipeline/contacts/${seg(i.contact_id)}`, body };
      },
      describe: async (i, h) => `Update ${cardLabel(findContact(await loadBoard(h), i.contact_id))} in the Contact Pipeline`,
      details: (i) => changeLines(blankToNull(i), CONTACT_LABELS),
      snapshot: async (i, h) => findContact(await loadBoard(h), i.contact_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { contact_id: i.contact_id };
        for (const [k, dto] of Object.entries(CONTACT_KEYS)) if (k in i) prev[k] = k === "grad_year" ? (b[dto] ?? null) : String(b[dto] ?? "");
        if ("student_name" in prev && !prev.student_name) return null;
        return { op: "pipeline.update_contact", input: prev };
      },
    }),
    op({
      name: "pipeline.update_contact_info",
      kind: "write",
      risk: "auto",
      title: "Edit a pipeline card's info card (school, GPA, scores, majors…). An empty string clears a field.",
      doc: "{ contact_id, high_school?, gpa_weighted?, gpa_unweighted?, class_rank?, sat?, act?, rigor?, intended_majors?, citizenship?, first_gen?, living_with_parent?, marital_status?, gender?, birthday?, address? }",
      input: infoInput,
      request: (i) => {
        const info: Record<string, string> = {};
        for (const [k, v] of Object.entries(INFO)) {
          const val = (i as Record<string, unknown>)[k];
          if (typeof val === "string") info[v.key] = val;
        }
        return { method: "PATCH", url: `/pipeline/contacts/${seg(i.contact_id)}`, body: { info } };
      },
      describe: async (i, h) => `Update the info card on ${cardLabel(findContact(await loadBoard(h), i.contact_id))}`,
      details: (i) => changeLines(blankToNull(i), INFO_LABELS),
      snapshot: async (i, h) => findContact(await loadBoard(h), i.contact_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const info = asRecord(b.info);
        const prev: Record<string, unknown> = { contact_id: i.contact_id };
        for (const [k, v] of Object.entries(INFO)) if (k in i) prev[k] = typeof info[v.key] === "string" ? info[v.key] : "";
        return { op: "pipeline.update_contact_info", input: prev };
      },
    }),
    op({
      name: "pipeline.move_contact",
      kind: "write",
      risk: "auto",
      title: "Move a pipeline card to another stage (it goes to the bottom; days in stage restart).",
      doc: "{ contact_id, stage_id }",
      input: z.object({ contact_id: uuid, stage_id: uuid }).strict(),
      request: (i) => ({ method: "PATCH", url: `/pipeline/contacts/${seg(i.contact_id)}`, body: { stageId: i.stage_id } }),
      describe: async (i, h) => {
        const b = await loadBoard(h);
        const c = findContact(b, i.contact_id);
        const from = c ? findStage(b, c.stageId) : null;
        return `Move ${cardLabel(c)}${from ? ` from ${stageLabel(from)}` : ""} to ${stageLabel(findStage(b, i.stage_id))}`;
      },
      snapshot: async (i, h) => findContact(await loadBoard(h), i.contact_id),
      undo: (i, _body, before) => {
        const prev = str(asRecord(before).stageId);
        return prev && prev !== i.stage_id ? { op: "pipeline.move_contact", input: { contact_id: i.contact_id, stage_id: prev } } : null;
      },
    }),
    op({
      name: "pipeline.order_contacts",
      kind: "write",
      risk: "auto",
      title: "Set the top-to-bottom order of cards in one stage column (cards listed from other stages move into it).",
      doc: "{ stage_id, contact_ids: [card ids, top first] ≤2000 }",
      input: z.object({ stage_id: uuid, contact_ids: z.array(uuid).max(2000) }).strict(),
      request: (i) => ({ method: "PUT", url: "/pipeline/layout", body: { layout: { [i.stage_id]: i.contact_ids } } }),
      describe: async (i, h) => {
        const b = await loadBoard(h);
        const names = i.contact_ids.slice(0, 6).map((id) => plainText(findContact(b, id)?.studentName ?? "?", 40));
        return `Order the ${stageLabel(findStage(b, i.stage_id))} column: ${names.join(", ")}${i.contact_ids.length > 6 ? ", …" : ""}`;
      },
      snapshot: async (i, h) => {
        const b = await loadBoard(h);
        if (!b) return null;
        const inStage = b.contacts.filter((c) => c.stageId === i.stage_id).sort(byPosition);
        const ids = new Set(inStage.map((c) => String(c.id)));
        // A card that came from another column can't be put back by one reorder.
        return i.contact_ids.every((id) => ids.has(id)) ? inStage.map((c) => String(c.id)) : null;
      },
      undo: (i, _body, before) => (Array.isArray(before) && before.length ? { op: "pipeline.order_contacts", input: { stage_id: i.stage_id, contact_ids: before } } : null),
    }),
    op({
      name: "pipeline.set_owner",
      kind: "write",
      risk: "confirm",
      title: "Make a consultant the owner of a pipeline card (null clears it).",
      doc: "{ contact_id, owner_id: consultant id (management.consultants) | null }",
      input: z.object({ contact_id: uuid, owner_id: uuid.nullable() }).strict(),
      request: (i) => ({ method: "PATCH", url: `/pipeline/contacts/${seg(i.contact_id)}`, body: { ownerId: i.owner_id } }),
      describe: async (i, h) => {
        const b = await loadBoard(h);
        const c = findContact(b, i.contact_id);
        if (!i.owner_id) return `Clear the owner of ${cardLabel(c)}`;
        return `Make ${plainText(personName(b, i.owner_id) ?? "a consultant", 80)} the owner of ${cardLabel(c)}`;
      },
      warning: "The owner is the consultant responsible for this family, and can bill them.",
      snapshot: async (i, h) => findContact(await loadBoard(h), i.contact_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev = str(b.ownerId);
        return prev === (i.owner_id ?? null) ? null : { op: "pipeline.set_owner", input: { contact_id: i.contact_id, owner_id: prev } };
      },
    }),
    op({
      name: "pipeline.invite_contact",
      kind: "write",
      risk: "confirm",
      title: "Invite a pipeline card's student to Meridies (emails the student address on the card).",
      doc: "{ contact_id }",
      input: z.object({ contact_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/pipeline/contacts/${seg(i.contact_id)}/invite` }),
      describe: async (i, h) => {
        const c = findContact(await loadBoard(h), i.contact_id);
        return `Invite ${c ? plainText(c.studentName, 80) : "this card's student"} to join Meridies as your student`;
      },
      details: async (i, h) => {
        const c = findContact(await loadBoard(h), i.contact_id);
        return c?.studentEmail ? [`To: ${plainText(c.studentEmail, 320)}`] : ["No student email on the card yet."];
      },
      warning: "An invitation email goes to the student's address on the card.",
      reply: (body) => {
        const b = asRecord(body);
        return b.emailSent === false ? "The invitation was created, but the email didn't go out." : "Invitation sent.";
      },
    }),
    op({
      name: "pipeline.email_contact",
      kind: "write",
      risk: "confirm",
      title: "Email a pipeline family (the student, the parent, or both) at the addresses on the card.",
      doc: "{ contact_id, subject ≤300, body ≤20000 ({first}, {me} fill in), to: [student|parent] 1-2, template_id? }",
      input: z
        .object({
          contact_id: uuid,
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(20_000),
          to: z.array(z.enum(["student", "parent"])).min(1).max(2),
          template_id: uuid.optional(),
        })
        .strict(),
      request: (i) => ({
        method: "POST",
        url: `/pipeline/contacts/${seg(i.contact_id)}/email`,
        body: defined({ subject: i.subject, body: i.body, to: i.to, templateId: i.template_id }),
      }),
      describe: async (i, h) => {
        const c = findContact(await loadBoard(h), i.contact_id);
        const who = [...new Set(i.to)].map((t) => (t === "parent" ? "parent" : "student")).join(" and ");
        return `Email ${c ? `${plainText(c.studentName, 80)}'s` : "a pipeline family's"} ${who}: "${plainText(i.subject, 100)}"`;
      },
      details: async (i, h) => {
        const c = findContact(await loadBoard(h), i.contact_id);
        const to = [...new Set(i.to)].map((t) => {
          const addr = c ? str(t === "parent" ? c.parentEmail : c.studentEmail) : null;
          return `${t}${addr ? ` (${plainText(addr, 320)})` : " (no address on the card)"}`;
        });
        return [`Subject: ${plainText(i.subject, 300)}`, `To: ${to.join(", ")}`, plainText(i.body, 1200)];
      },
      warning: "The email goes to the family now, at the addresses on the card.",
      reply: (body) => {
        const n = Number(asRecord(body).sentCount ?? 0);
        return n > 0 ? `Sent to ${n} recipient${n === 1 ? "" : "s"}.` : "Nothing was delivered.";
      },
    }),
    op({
      name: "pipeline.delete_stage",
      kind: "write",
      risk: "confirm",
      title: "Delete a pipeline stage; its cards move to the stage before it.",
      doc: "{ stage_id }",
      input: z.object({ stage_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/pipeline/stages/${seg(i.stage_id)}` }),
      describe: async (i, h) => {
        const b = await loadBoard(h);
        const s = findStage(b, i.stage_id);
        if (!b || !s) return `Delete ${stageLabel(s)} from the Contact Pipeline`;
        const at = b.stages.indexOf(s);
        const target = at === 0 ? b.stages[b.stages.length - 1] : b.stages[at - 1];
        const n = b.contacts.filter((c) => c.stageId === i.stage_id).length;
        return `Delete stage ${stageLabel(s)} from the Contact Pipeline${n && target && target !== s ? ` (its ${n} card${n === 1 ? "" : "s"} move to ${stageLabel(target)})` : ""}`;
      },
      warning: "The stage is deleted for everyone in the practice; its cards move to the stage before it.",
    }),
    op({
      name: "pipeline.delete_contact",
      kind: "write",
      risk: "confirm",
      title: "Delete a pipeline card (a family with invoices or payments can't be deleted).",
      doc: "{ contact_id }",
      input: z.object({ contact_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/pipeline/contacts/${seg(i.contact_id)}` }),
      describe: async (i, h) => `Delete ${cardLabel(findContact(await loadBoard(h), i.contact_id))} from the Contact Pipeline`,
      warning: "The card and everything on it is deleted for everyone in the practice.",
    }),
  ],
};

// ---- Payment Tracker ---------------------------------------------------------------

const METHODS = PAYMENT_METHODS as [PaymentMethod, ...PaymentMethod[]];
const cents = (min: number) => z.number().int().min(min).max(100_000_000);

function accountLines(a: Rec): string {
  const lines = [`contact ${str(a.contactId)}: package ${untrusted(a.packageName)} · ${str(a.status)}`];
  for (const inv of asArray(a.invoices).slice(0, 20)) {
    lines.push(`  invoice ${str(inv.id)}: #${str(inv.number)} ${untrusted(inv.label)} ${usd(inv.amountCents)} due ${str(inv.dueOn)} [${str(inv.state)}]`);
  }
  for (const p of asArray(a.payments).slice(0, 20)) {
    lines.push(`  payment ${str(p.id)}: ${usd(p.amountCents)} received ${str(p.receivedOn)} (${str(p.method)})`);
  }
  return lines.join("\n");
}

export const payments: OpGroup = {
  heading: "Payment Tracker",
  ops: [
    op({
      name: "payments.accounts",
      kind: "read",
      title: "Payment Tracker accounts by contact id, with invoice and payment ids (names: pipeline.contacts).",
      doc: "{ contact_id? }",
      input: z.object({ contact_id: uuid.optional() }).strict(),
      request: () => ({ method: "GET", url: "/pipeline/payments" }),
      reply: (body, i) => {
        const b = asRecord(body);
        const rows: Rec[] = [
          ...asArray(b.accounts).map((a): Rec => ({ ...a, kind: "account" })),
          ...asArray(b.unbilled).map((u): Rec => ({ ...u, kind: "unbilled" })),
        ].filter((r) => !i.contact_id || r.contactId === i.contact_id);
        return listReply(
          rows,
          (r) => (r.kind === "account" ? accountLines(r) : `contact ${str(r.contactId)}: ${untrusted(r.studentName)} · no package yet`),
          i.contact_id ? "That family has no package, or you can't bill them." : "No families you can bill."
        );
      },
    }),
    op({
      name: "payments.set_package",
      kind: "write",
      risk: "confirm",
      title: "Set up or change a family's package (name, total in cents, number of installments).",
      doc: "{ contact_id, package_name ≤200, total_cents int ($1 = 100), installments 1-60 }",
      input: z
        .object({ contact_id: uuid, package_name: z.string().trim().min(1).max(200), total_cents: cents(0), installments: z.number().int().min(1).max(60) })
        .strict(),
      request: (i) => ({
        method: "PUT",
        url: `/pipeline/contacts/${seg(i.contact_id)}/package`,
        body: { packageName: i.package_name, totalCents: i.total_cents, installments: i.installments },
      }),
      describe: async (i, h) =>
        `Set the package for ${await familyName(h, i.contact_id)}: "${plainText(i.package_name, 80)}", ${usd(i.total_cents)} over ${i.installments} installment${i.installments === 1 ? "" : "s"}`,
      details: async (i, h) => {
        const a = await findAccount(h, i.contact_id);
        return a ? [`Was: "${plainText(a.packageName, 80)}", ${usd(a.totalCents)} over ${Number(a.installments ?? 1)}`] : ["New package"];
      },
      warning: "This sets what the family is contracted to pay.",
      snapshot: (i, h) => findAccount(h, i.contact_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.contactId) return null;
        return { op: "payments.set_package", input: { contact_id: i.contact_id, package_name: b.packageName, total_cents: b.totalCents, installments: b.installments } };
      },
      reply: () => "Package saved.",
    }),
    op({
      name: "payments.create_invoice",
      kind: "write",
      risk: "confirm",
      title: "Invoice a family (emailed to the parent unless send is false). Needs a package first.",
      doc: "{ contact_id, label ≤120, amount_cents int ($1 = 100), due_on YYYY-MM-DD (not past), send? bool (default true) }",
      input: z.object({ contact_id: uuid, label: z.string().trim().min(1).max(120), amount_cents: cents(1), due_on: day, send: z.boolean().optional() }).strict(),
      request: (i) => ({
        method: "POST",
        url: `/pipeline/contacts/${seg(i.contact_id)}/invoices`,
        body: defined({ label: i.label, amountCents: i.amount_cents, dueOn: i.due_on, send: i.send }),
      }),
      describe: async (i, h) =>
        `${i.send === false ? "Record an invoice (not emailed) for" : "Send an invoice to"} ${await familyName(h, i.contact_id)}: "${plainText(i.label, 80)}", ${usd(i.amount_cents)} due ${dayLabel(i.due_on)}`,
      details: (i) => [i.send === false ? "Recorded only; no email goes out." : "Emailed to the parent (or the student when no parent email is on the card)."],
      warning: "The invoice goes on the family's account and, unless send is false, is emailed to them.",
      undo: (_i, body) => {
        const b = asRecord(body);
        const inv = asArray(asRecord(b.account).invoices).find((r) => str(r.number) === str(b.invoiceNumber));
        const id = inv ? str(inv.id) : null;
        return id ? { op: "payments.void_invoice", input: { invoice_id: id } } : null;
      },
      reply: (body) => {
        const b = asRecord(body);
        return `Invoice #${str(b.invoiceNumber) ?? "?"} created${b.emailSent ? " and emailed" : ""}.`;
      },
    }),
    op({
      name: "payments.record_payment",
      kind: "write",
      risk: "confirm",
      title: "Record a payment a family made (not in the future).",
      doc: "{ contact_id, amount_cents int ($1 = 100), received_on YYYY-MM-DD, method: card|ach|check|zelle|other, note? ≤300 }",
      input: z.object({ contact_id: uuid, amount_cents: cents(1), received_on: day, method: z.enum(METHODS), note: z.string().trim().max(300).optional() }).strict(),
      request: (i) => ({
        method: "POST",
        url: `/pipeline/contacts/${seg(i.contact_id)}/payments`,
        body: defined({ amountCents: i.amount_cents, receivedOn: i.received_on, method: i.method, note: i.note }),
      }),
      describe: async (i, h) => `Record a ${usd(i.amount_cents)} ${i.method} payment from ${await familyName(h, i.contact_id)}, received ${dayLabel(i.received_on)}`,
      details: (i) => (i.note ? [`Note: ${plainText(i.note, 300)}`] : []),
      warning: "The payment is recorded on the family's account and settles their oldest invoice first.",
      snapshot: async (i, h) => asArray((await findAccount(h, i.contact_id))?.payments).map((p) => String(p.id)),
      undo: (_i, body, before) => {
        if (!Array.isArray(before)) return null;
        const had = new Set(before as string[]);
        const added = asArray(asRecord(body).payments).filter((p) => !had.has(String(p.id)));
        const id = added.length === 1 ? str(added[0].id) : null;
        return id ? { op: "payments.delete_payment", input: { payment_id: id } } : null;
      },
      reply: () => "Payment recorded.",
    }),
    op({
      name: "payments.void_invoice",
      kind: "write",
      risk: "confirm",
      title: "Void an invoice sent in error (it stays on the record and stops counting).",
      doc: "{ invoice_id }",
      input: z.object({ invoice_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/pipeline/invoices/${seg(i.invoice_id)}/void` }),
      describe: async (i, h) => {
        const hit = await findBilling(h, "invoices", i.invoice_id);
        if (!hit) return "Void an invoice";
        return `Void invoice #${str(hit.row.number)} "${plainText(hit.row.label, 60)}" (${usd(hit.row.amountCents)}) for ${await familyName(h, hit.contactId)}`;
      },
      warning: "A voided invoice can't be reopened. The family isn't told.",
      reply: () => "Invoice voided.",
    }),
    op({
      name: "payments.delete_payment",
      kind: "write",
      risk: "confirm",
      title: "Remove a payment recorded by mistake.",
      doc: "{ payment_id }",
      input: z.object({ payment_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/pipeline/payments/${seg(i.payment_id)}` }),
      describe: async (i, h) => {
        const hit = await findBilling(h, "payments", i.payment_id);
        if (!hit) return "Remove a recorded payment";
        return `Remove the ${usd(hit.row.amountCents)} ${str(hit.row.method)} payment received ${dayLabel(hit.row.receivedOn)} from ${await familyName(h, hit.contactId)}`;
      },
      warning: "The payment comes off the family's account and their balance goes back up.",
      snapshot: (i, h) => findBilling(h, "payments", i.payment_id),
      undo: (_i, _body, before) => {
        const b = asRecord(before);
        const row = asRecord(b.row);
        if (!b.contactId || !row.id) return null;
        return {
          op: "payments.record_payment",
          input: defined({
            contact_id: b.contactId,
            amount_cents: row.amountCents,
            received_on: str(row.receivedOn)?.slice(0, 10),
            method: row.method,
            note: str(row.note) ?? undefined,
          }),
        };
      },
      reply: () => "Payment removed.",
    }),
  ],
};
