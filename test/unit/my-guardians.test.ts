// A student's own parents (/me/guardians, lib/myGuardians.ts) and the notice a parent gets (lib/parentNotice.ts).
// Pure rules first, then the routes on a memory store that enforces the same ownership as the migration's RLS
// (20261122000001): validation, who may change what, the 4-parent cap, one notice per address per student, and the
// per-user rate limit. test/integration/my-guardians.test.mjs runs the same against the real database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "../../src/lib/errors.js";
import { cleanTags } from "../../src/lib/email.js";
import {
  MAX_PARENTS,
  addGuardianBody,
  editGuardianBody,
  toMyGuardian,
  type GuardianRow,
  type GuardianStore,
} from "../../src/lib/myGuardians.js";
import {
  PARENT_NOTICE_TEMPLATE,
  literalLike,
  noticeDecision,
  parentAddedEmail,
  sendParentNotice,
  type SendParentNoticeArgs,
} from "../../src/lib/parentNotice.js";
import myGuardianRoutes from "../../src/routes/myGuardians.js";

// ---- pure rules -----------------------------------------------------------------------------------------------

test("add: name, relationship and email are required; the email is lowercased; phone is optional", () => {
  const ok = addGuardianBody.parse({ name: " Ana Ruiz ", relationship: "Mother", email: "Ana.Ruiz@Example.COM " });
  assert.deepEqual(ok, { name: "Ana Ruiz", relationship: "Mother", email: "ana.ruiz@example.com" });
  assert.equal(addGuardianBody.parse({ name: "A", relationship: "Other", email: "a@b.co", phone: "" }).phone, null);
  assert.equal(addGuardianBody.parse({ name: "A", relationship: "Other", email: "a@b.co", phone: "+1 (555) 010-2000" }).phone, "+1 (555) 010-2000");
  for (const bad of [
    {},
    { name: "", relationship: "Mother", email: "a@b.co" },
    { name: "A", relationship: "Aunt", email: "a@b.co" },
    { name: "A", relationship: "Mother" },
    { name: "A", relationship: "Mother", email: "not-an-email" },
    { name: "A", relationship: "Mother", email: "a@b.co", phone: "12" },
    { name: "A", relationship: "Mother", email: "a@b.co", phone: "call me maybe 5550102000" },
    { name: "x".repeat(121), relationship: "Mother", email: "a@b.co" },
    { name: "A", relationship: "Mother", email: "a@b.co", alerts_enabled: true },
    { name: "A", relationship: "Mother", email: "a@b.co", student_id: randomUUID() },
  ]) {
    assert.equal(addGuardianBody.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("edit: any one field, nothing the counselor owns, never empty", () => {
  assert.deepEqual(editGuardianBody.parse({ name: "Ana" }), { name: "Ana" });
  assert.deepEqual(editGuardianBody.parse({ phone: null }), { phone: null });
  assert.equal(editGuardianBody.safeParse({}).success, false);
  assert.equal(editGuardianBody.safeParse({ alerts_enabled: true }).success, false);
  assert.equal(editGuardianBody.safeParse({ is_primary: true }).success, false);
  assert.equal(editGuardianBody.safeParse({ added_by: randomUUID() }).success, false);
});

const row = (over: Partial<GuardianRow> & { student_id: string }): GuardianRow => ({
  id: randomUUID(),
  full_name: "Ana Ruiz",
  email: "ana@example.com",
  phone: null,
  relationship: "Mother",
  alerts_enabled: false,
  added_by: over.student_id,
  created_at: new Date().toISOString(),
  ...over,
});

test("what the student may change follows who added the parent and whether the counselor switched them on", () => {
  const me = randomUUID();
  const counselor = randomUUID();
  const mineOff = toMyGuardian(row({ student_id: me }), me);
  assert.deepEqual([mineOff.addedByMe, mineOff.editable, mineOff.removable, mineOff.receivesMessages], [true, "all", true, false]);
  const mineOn = toMyGuardian(row({ student_id: me, alerts_enabled: true }), me);
  assert.deepEqual([mineOn.editable, mineOn.removable, mineOn.receivesMessages], ["name", false, true]);
  const theirs = toMyGuardian(row({ student_id: me, added_by: counselor, alerts_enabled: true }), me);
  assert.deepEqual([theirs.addedByMe, theirs.editable, theirs.removable], [false, "none", false]);
  const unknown = toMyGuardian(row({ student_id: me, added_by: null }), me);
  assert.deepEqual([unknown.editable, unknown.removable], ["none", false]);
});

test("the notice: never twice to one address, never after a bounce, again after a send that never left", () => {
  assert.equal(noticeDecision([], []), "send");
  const sent = { status: "sent", error: null };
  assert.equal(noticeDecision([sent], [sent]), "already_sent");
  assert.equal(noticeDecision([{ status: "delivered", error: null }], [{ status: "delivered", error: null }]), "already_sent");
  assert.equal(noticeDecision([{ status: "bounced", error: "bounced" }], [{ status: "bounced", error: "bounced" }]), "already_sent");
  const spam = { status: "bounced", error: "marked as spam by the recipient" };
  assert.equal(noticeDecision([spam], []), "suppressed", "a complaint about another message for this student");
  assert.equal(noticeDecision([{ status: "failed", error: "RESEND_API_KEY unset" }], [{ status: "failed", error: "x" }]), "send");
  assert.equal(noticeDecision([{ status: "sent", error: null }], []), "send", "another kind of email to them is no notice");
});

test("the notice's words: who added them, the counselor by name, reply to reach them, no link", () => {
  const withCounselor = parentAddedEmail({ studentName: "Maya Lee", parentName: "Ana Ruiz", counselorName: "Dr. Jordan Park" });
  assert.equal(withCounselor.subject, "Maya Lee added you as a parent on Meridies");
  const all = [withCounselor.heading, ...withCounselor.paragraphs, withCounselor.footnote].join("\n");
  assert.match(all, /Dear Ana,/);
  assert.match(all, /Dr\. Jordan Park is Maya's counselor and may email you updates about Maya's college applications/);
  assert.match(withCounselor.footnote, /Reply to this email to reach Dr\. Jordan Park/);
  assert.doesNotMatch(all, /https?:|log ?in|sign in|portal|password/i);

  const alone = parentAddedEmail({ studentName: "Maya Lee", parentName: "", counselorName: null });
  assert.match(alone.paragraphs.join("\n"), /Once Maya connects with a counselor/);
  assert.match(alone.paragraphs[0] as string, /^Hello,/);
  assert.doesNotMatch(alone.footnote, /Reply/);

  const long = parentAddedEmail({ studentName: "M".repeat(300) + "\nBcc: x", parentName: "A", counselorName: null });
  assert.ok(!long.subject.includes("\n") && long.subject.length < 140);
});

test("helpers: an address is matched literally; a bad Resend tag is dropped, never the email", () => {
  assert.equal(literalLike("a_b%c\\d@x.com"), "a\\_b\\%c\\\\d@x.com");
  assert.deepEqual(cleanTags([{ name: "category", value: "parent-added" }]), [{ name: "category", value: "parent-added" }]);
  assert.equal(cleanTags([{ name: "bad tag", value: "x" }]), undefined);
  assert.equal(cleanTags(undefined), undefined);
});

// ---- routes on a memory store ------------------------------------------------------------------------------------

/** The guardians table with the migration's rules for a student caller. */
function memoryStore(rows: GuardianRow[], me: string): GuardianStore {
  return {
    async list(studentId) {
      return rows.filter((r) => r.student_id === studentId && studentId === me);
    },
    async insert(r) {
      const g: GuardianRow = { ...r, id: randomUUID(), alerts_enabled: false, added_by: me, created_at: new Date().toISOString() };
      rows.push(g);
      return g;
    },
    async update(id, studentId, values) {
      const g = rows.find((r) => r.id === id && r.student_id === studentId && r.student_id === me && r.added_by === me);
      if (!g) return null;
      if (g.alerts_enabled && (("email" in values && values.email !== g.email) || ("phone" in values && values.phone !== g.phone))) {
        throw new HttpError(403, "contact locked", "guardian_contact_locked");
      }
      Object.assign(g, values);
      return g;
    },
    async remove(id, studentId) {
      const i = rows.findIndex((r) => r.id === id && r.student_id === studentId && r.student_id === me && r.added_by === me && !r.alerts_enabled);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  };
}

type Delivery = { student_id: string; to_email: string; template: string; status: string; error: string | null; channel: string };

/** Just enough of a service client for sendParentNotice: message_deliveries and profiles reads. */
function fakeSvc(deliveries: Delivery[], profiles: Record<string, { full_name: string; email: string }>): SupabaseClient {
  const from = (table: string) => {
    const filters: [string, string][] = [];
    let like: string | null = null;
    const q = {
      select: () => q,
      eq: (col: string, v: string) => (filters.push([col, v]), q),
      ilike: (_col: string, v: string) => ((like = v.replace(/\\(.)/g, "$1").toLowerCase()), q),
      limit: async () => ({
        data: deliveries.filter((d) => filters.every(([c, v]) => (d as Record<string, unknown>)[c] === v) && (like === null || d.to_email.toLowerCase() === like)),
        error: null,
      }),
      maybeSingle: async () => {
        const id = filters.find(([c]) => c === "id")?.[1] ?? "";
        return { data: table === "profiles" ? profiles[id] ?? null : null, error: null };
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

type Who = { id: string; role: "student" | "counselor"; full_name: string; counselor_id: string | null };

function harness(opts: { rows?: GuardianRow[]; sendOk?: boolean } = {}) {
  const rows = opts.rows ?? [];
  const deliveries: Delivery[] = [];
  const sent: { to: string; subject: string; from?: string; replyTo?: string; template: string }[] = [];
  const counselorId = randomUUID();
  const profiles = { [counselorId]: { full_name: "Jordan Park", email: "jordan@practice.test" } };
  const users = new Map<string, Who>();

  const app = Fastify();
  app.decorate("authenticate", async (request: FastifyRequest) => {
    const who = users.get(String(request.headers["x-user"]));
    if (!who) throw new HttpError(401, "Unauthorized");
    request.auth = { userId: who.id, token: "t" };
    request.profile = { id: who.id, role: who.role, full_name: who.full_name, counselor_id: who.counselor_id } as unknown as FastifyRequest["profile"];
  });
  app.setErrorHandler((err: FastifyError | ZodError | HttpError, _request, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request" });
    if (err instanceof HttpError) return reply.code(err.statusCode).send(err.code ? { error: err.message, code: err.code } : { error: err.message });
    return reply.code((err as FastifyError).statusCode ?? 500).send({ error: err.message });
  });
  app.register(myGuardianRoutes, {
    prefix: "/me/guardians",
    store: (request) => memoryStore(rows, request.auth.userId),
    notify: (a: SendParentNoticeArgs) =>
      sendParentNotice({
        ...a,
        deps: {
          svc: fakeSvc(deliveries, profiles),
          replyTo: async () => "r-abc@reply.test",
          withinDailyCap: async () => true,
          send: async (m) => {
            sent.push({ to: m.to, subject: m.subject, from: m.from, replyTo: m.replyTo, template: m.template });
            const ok = opts.sendOk !== false;
            deliveries.push({ student_id: m.student_id as string, to_email: m.to, template: m.template, status: ok ? "sent" : "failed", error: ok ? null : "down", channel: "email" });
            return { id: ok ? "re_1" : null, sent: ok, deliveryId: "d1", error: ok ? null : "down" };
          },
        },
      }),
  });

  const student = (over: Partial<Who> = {}): Who => {
    const w: Who = { id: randomUUID(), role: "student", full_name: "Maya Lee", counselor_id: counselorId, ...over };
    users.set(w.id, w);
    return w;
  };
  const call = async (who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url: `/me/guardians${url}`, headers: { "x-user": who.id }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  return { app, rows, deliveries, sent, student, call, counselorId };
}

const mom = { name: "Ana Ruiz", relationship: "Mother", email: "Ana@Example.com", phone: "555 010 2000" };

test("routes: a student adds, lists, edits and removes their own parent; the parent is emailed once", async () => {
  const h = harness();
  const s = h.student();

  const add = await h.call(s, "POST", "", mom);
  assert.equal(add.status, 201);
  const g = add.body.guardian as Record<string, unknown>;
  assert.deepEqual([g.name, g.email, g.relationship, g.addedByMe, g.editable, g.removable], ["Ana Ruiz", "ana@example.com", "Mother", true, "all", true]);
  assert.equal(add.body.notice, "sent");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.to, "ana@example.com");
  assert.equal(h.sent[0]?.template, PARENT_NOTICE_TEMPLATE);
  assert.equal(h.sent[0]?.replyTo, "r-abc@reply.test");
  assert.match(h.sent[0]?.subject ?? "", /Maya Lee added you/);

  const list = await h.call(s, "GET", "");
  assert.equal(list.status, 200);
  assert.equal((list.body.guardians as unknown[]).length, 1);
  assert.equal(list.body.max, MAX_PARENTS);

  // A corrected name sends nothing.
  const rename = await h.call(s, "PATCH", `/${g.id}`, { name: "Ana M. Ruiz" });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.notice, null);
  assert.equal(h.sent.length, 1);

  // A new address is a new parent inbox: one notice.
  const moved = await h.call(s, "PATCH", `/${g.id}`, { email: "ana.new@example.com" });
  assert.equal(moved.body.notice, "sent");
  assert.equal(h.sent.length, 2);

  // Removed and added again at an address already told: nothing new.
  assert.equal((await h.call(s, "DELETE", `/${g.id}`)).status, 200);
  assert.equal(h.rows.length, 0);
  const again = await h.call(s, "POST", "", { ...mom, email: "ana.new@example.com" });
  assert.equal(again.status, 201);
  assert.equal(again.body.notice, "already_sent");
  assert.equal(h.sent.length, 2);
});

test("routes: a send that failed may be tried again on the next add", async () => {
  const h = harness({ sendOk: false });
  const s = h.student();
  const first = await h.call(s, "POST", "", mom);
  assert.equal(first.body.notice, "not_sent");
  await h.call(s, "DELETE", `/${(first.body.guardian as { id: string }).id}`);
  const second = await h.call(s, "POST", "", mom);
  assert.equal(second.body.notice, "not_sent");
  assert.equal(h.sent.length, 2, "tried again, since the first never left");
});

test("routes: no counselor yet, so no reply address and words that say so", async () => {
  const h = harness();
  const s = h.student({ counselor_id: null });
  const add = await h.call(s, "POST", "", mom);
  assert.equal(add.body.notice, "sent");
  assert.equal(h.sent[0]?.replyTo, undefined);
});

test("routes: validation, duplicates and the cap of four", async () => {
  const h = harness();
  const s = h.student();
  assert.equal((await h.call(s, "POST", "", { ...mom, email: "nope" })).status, 400);
  assert.equal((await h.call(s, "POST", "", { ...mom, relationship: "Aunt" })).status, 400);
  assert.equal((await h.call(s, "POST", "", { ...mom, alerts_enabled: true })).status, 400);
  assert.equal((await h.call(s, "PATCH", "/not-a-uuid", { name: "x" })).status, 400);
  assert.equal((await h.call(s, "POST", "", mom)).status, 201);
  const dup = await h.call(s, "POST", "", { ...mom, email: "ANA@example.com" });
  assert.deepEqual([dup.status, dup.body.code], [409, "guardian_exists"]);
  for (const n of [2, 3, 4]) assert.equal((await h.call(s, "POST", "", { ...mom, email: `p${n}@example.com` })).status, 201);
  const full = await h.call(s, "POST", "", { ...mom, email: "p5@example.com" });
  assert.deepEqual([full.status, full.body.code], [409, "guardians_full"]);
});

test("routes: ownership. Counselor-added parents are read-only; switched-on ones keep their address; others' are invisible", async () => {
  const h = harness();
  const s = h.student();
  const other = h.student();
  const counselors = row({ student_id: s.id, added_by: h.counselorId, alerts_enabled: true, email: "dad@example.com" });
  const switchedOn = row({ student_id: s.id, alerts_enabled: true, email: "mine-on@example.com" });
  const othersParent = row({ student_id: other.id, email: "theirs@example.com" });
  h.rows.push(counselors, switchedOn, othersParent);

  const edit = await h.call(s, "PATCH", `/${counselors.id}`, { name: "Changed" });
  assert.deepEqual([edit.status, edit.body.code], [403, "guardian_locked"]);
  const del = await h.call(s, "DELETE", `/${counselors.id}`);
  assert.deepEqual([del.status, del.body.code], [403, "guardian_locked"]);

  assert.equal((await h.call(s, "PATCH", `/${switchedOn.id}`, { name: "Renamed" })).status, 200);
  const redirect = await h.call(s, "PATCH", `/${switchedOn.id}`, { email: "me@student.test" });
  assert.deepEqual([redirect.status, redirect.body.code], [403, "guardian_contact_locked"]);
  assert.equal(switchedOn.email, "mine-on@example.com");
  assert.equal((await h.call(s, "DELETE", `/${switchedOn.id}`)).status, 403);

  for (const [method, body] of [["PATCH", { name: "x" }], ["DELETE", undefined]] as const) {
    const r = await h.call(s, method, `/${othersParent.id}`, body);
    assert.deepEqual([r.status, r.body.code], [404, "guardian_not_found"], method);
  }
  assert.equal(othersParent.full_name, "Ana Ruiz");
  const mine = await h.call(s, "GET", "");
  assert.ok(!(mine.body.guardians as { id: string }[]).some((g) => g.id === othersParent.id));
  assert.equal(h.sent.length, 0);
});

test("routes: students only", async () => {
  const h = harness();
  const c = h.student({ role: "counselor" });
  assert.equal((await h.call(c, "GET", "")).status, 403);
  assert.equal((await h.call(c, "POST", "", mom)).status, 403);
});

test("routes: adding is rate limited per student (12 an hour)", async () => {
  const h = harness();
  const s = h.student();
  const statuses: number[] = [];
  for (let i = 0; i < 13; i++) statuses.push((await h.call(s, "POST", "", { ...mom, email: "bad" })).status);
  assert.deepEqual(statuses.slice(0, 12), Array(12).fill(400));
  assert.equal(statuses[12], 429);
  // Another student's budget is their own.
  assert.equal((await h.call(h.student(), "POST", "", mom)).status, 201);
});
