// Parent accounts (20261123000002): the pure rules. Tokens and their hash, the emails' words, the chip's states,
// the Parent view's shape (a section the database left out stays out; never an essay's title), and the request gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedAsParent } from "../../src/lib/access.js";
import {
  hashInviteToken,
  hintOf,
  isInviteToken,
  newInviteToken,
  parentInviteEmail,
  parentJoinUrl,
  parentSchemaMissing,
  toParentAccount,
  toParentChild,
  toParentView,
  todayIn,
} from "../../src/lib/parentAccounts.js";
import { parentAddedEmail, sendParentNotice } from "../../src/lib/parentNotice.js";
import type { SupabaseClient } from "@supabase/supabase-js";

test("tokens: 32 random bytes, URL-safe, only the sha256 is stored, and the shape is checked", () => {
  const a = newInviteToken();
  const b = newInviteToken();
  assert.notEqual(a, b);
  assert.ok(isInviteToken(a) && isInviteToken(b), a);
  assert.match(hashInviteToken(a), /^[0-9a-f]{64}$/);
  assert.equal(hashInviteToken(a), hashInviteToken(a));
  assert.notEqual(hashInviteToken(a), hashInviteToken(b));
  for (const bad of ["", "short", a + "x", `${a.slice(0, 42)}/`, `${a.slice(0, 42)}%`, 42, null, undefined]) {
    assert.equal(isInviteToken(bad), false, String(bad));
  }
  assert.match(parentJoinUrl(a), new RegExp(`/join-parent/${a}$`));
});

test("the counselor's invitation: a Create button, what the view shows, read-only, 30 days, reply to reach them", () => {
  const e = parentInviteEmail({ studentName: "Maya Lee", parentName: "Ana Ruiz", counselorName: "Jordan Park", kind: "join", url: "https://app.test/join-parent/x" });
  const all = [e.subject, e.heading, ...e.paragraphs, e.footnote].join("\n");
  assert.equal(e.subject, "Jordan Park invited you to follow Maya's college applications on Meridies");
  assert.deepEqual(e.cta, { label: "Create your parent account", url: "https://app.test/join-parent/x" });
  assert.match(all, /Dear Ana,/);
  assert.match(all, /tasks, college list and deadlines, essay progress and upcoming meetings/);
  assert.match(all, /read-only/);
  assert.match(all, /30 days and only once/);
  assert.match(e.footnote, /Reply to this email to reach Jordan Park/);
  assert.doesNotMatch(all, /nothing to sign up for/i);

  const signin = parentInviteEmail({ studentName: "Maya Lee", parentName: "", counselorName: "Jordan Park", kind: "signin", url: "https://app.test/login?as=parent" });
  assert.equal(signin.cta.label, "Open your parent view");
  assert.match(signin.paragraphs[0] as string, /^Hello,/);
  assert.doesNotMatch(signin.paragraphs.join("\n"), /30 days/);

  const nasty = parentInviteEmail({ studentName: "M".repeat(300) + "\nBcc: x", parentName: "A", counselorName: "C\r\nX", kind: "join", url: "u" });
  assert.ok(!nasty.subject.includes("\n") && !nasty.subject.includes("\r"));
});

test("the student's notice now invites the parent; without a link it keeps its old, still-true words", () => {
  const join = parentAddedEmail({ studentName: "Maya Lee", parentName: "Ana Ruiz", counselorName: "Jordan Park", invite: { kind: "join", url: "https://app.test/join-parent/t" } });
  const words = join.paragraphs.join("\n");
  assert.doesNotMatch(words, /nothing to sign up for/i);
  assert.match(words, /Create your parent account with the button below/);
  assert.deepEqual(join.cta, { label: "Create your parent account", url: "https://app.test/join-parent/t" });

  const signin = parentAddedEmail({ studentName: "Maya Lee", parentName: "Ana Ruiz", counselorName: null, invite: { kind: "signin", url: "https://app.test/login" } });
  assert.equal(signin.cta?.label, "Open your parent view");

  const old = parentAddedEmail({ studentName: "Maya Lee", parentName: "Ana Ruiz", counselorName: "Jordan Park" });
  assert.match(old.paragraphs.join("\n"), /There's nothing to sign up for/);
  assert.equal(old.cta, undefined);
});

test("the notice mints its link on the student's client and records the email without the link", async () => {
  const sent: { html: string; text: string; recordText?: string }[] = [];
  const linked: string[] = [];
  const svc = {
    from: () => {
      const q = { select: () => q, eq: () => q, ilike: () => q, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: { full_name: "Jordan Park", email: "j@p.test" }, error: null }) };
      return q;
    },
  } as unknown as SupabaseClient;
  const db = { rpc: async (name: string, args: Record<string, unknown>) => (linked.push(`${name}:${String(args.p_delivery ?? "")}`), { data: null, error: null }) } as unknown as SupabaseClient;
  const out = await sendParentNotice({
    studentId: "s1", studentName: "Maya Lee", counselorId: "c1", guardianId: "g1", parentName: "Ana Ruiz", email: "ana@example.test", db,
    deps: {
      svc,
      replyTo: async () => undefined,
      withinDailyCap: async () => true,
      mint: async () => ({ kind: "join", token: "T".repeat(43), inviteId: "i1", studentId: "s1", email: "ana@example.test", expiresAt: "2026-12-11T00:00:00Z" }),
      send: async (m) => (sent.push({ html: m.html, text: m.text, recordText: m.recordText }), { id: "re", sent: true, deliveryId: "d1", error: null }),
    },
  });
  assert.equal(out, "sent");
  assert.ok(sent[0]?.html.includes(`/join-parent/${"T".repeat(43)}`), "the button carries the link");
  assert.ok(sent[0]?.text.includes(`/join-parent/${"T".repeat(43)}`));
  assert.ok(sent[0]?.recordText && !sent[0].recordText.includes("join-parent"), "the delivery record has no link");
  assert.deepEqual(linked, ["parent_invite_set_delivery:d1"]);
});

test("the chip's states", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const base = { has_account: false, grants_view: true, invited_at: null, expires_at: null, used_at: null };
  assert.equal(toParentAccount(base, now).state, "none");
  const invited = toParentAccount({ ...base, invited_at: "2026-11-10T00:00:00Z", expires_at: "2026-12-10T00:00:00Z", delivery_status: "delivered", delivery_channel: "email", delivery_at: "2026-11-10T00:00:01Z", delivered_at: "2026-11-10T00:00:05Z" }, now);
  assert.equal(invited.state, "invited");
  assert.equal(invited.delivery?.status, "delivered");
  assert.equal(toParentAccount({ ...base, invited_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-31T00:00:00Z" }, now).state, "expired");
  const bounced = toParentAccount({ ...base, invited_at: "2026-11-10T00:00:00Z", expires_at: "2026-12-10T00:00:00Z", delivery_status: "bounced", delivery_error: "RESEND_API_KEY unset" }, now);
  assert.equal(bounced.delivery?.reason, "Email isn't set up on the server yet", "a server setting is never shown");
  assert.equal(toParentAccount({ ...base, has_account: true, invited_at: "2026-11-10T00:00:00Z" }, now).state, "joined");
  assert.equal(toParentAccount({ ...base, grants_view: false }, now).state, "off");
  assert.equal(toParentAccount({ ...base, delivery_status: "weird" }, now).delivery, null);
});

test("the Parent view: only what the database sent; overdue in the student's zone; essays by kind, never title", () => {
  const raw = {
    student: { id: "s1", fullName: "Maya  Lee", gradYear: "2027", timezone: "America/Los_Angeles" },
    counselor: { id: "c1", name: "Jordan Park" },
    counselorReady: true,
    canMessage: false,
    sections: {
      tasks: [
        { id: "t1", title: "Draft personal statement", status: "in-progress", dueDate: "2026-11-10" },
        { id: "t2", title: "Ask for recs", status: "not-started", dueDate: "2026-11-11" },
        { id: "t3", title: "Register for SAT", status: "complete", dueDate: "2026-11-01", completedAt: "2026-11-05T00:00:00Z" },
      ],
      essays: [{ id: "e1", kind: "supplement", school: "Brown", status: "drafting", words: 210, wordLimit: 250, title: "SECRET TITLE", body: "SECRET BODY" }],
      meetings: [{ id: "m1", startsAt: "2026-11-20T18:00:00Z", mode: "google-meet", parentsInvited: false, title: null, joinUrl: "javascript:alert(1)" }],
    },
  };
  // 2026-11-11 04:00 UTC is still Nov 10 in Los Angeles: the Nov 10 task is due today there, not overdue.
  const v = toParentView(raw, new Date("2026-11-11T04:00:00Z"));
  assert.equal(v.student.firstName, "Maya");
  assert.equal(v.student.name, "Maya Lee");
  assert.deepEqual(v.sections.tasks?.open.map((t) => [t.id, t.overdue]), [["t1", false], ["t2", false]]);
  const later = toParentView(raw, new Date("2026-11-11T20:00:00Z"));
  assert.deepEqual(later.sections.tasks?.open.map((t) => [t.id, t.overdue]), [["t1", true], ["t2", false]]);
  assert.equal(later.sections.tasks?.overdue, 1);
  assert.deepEqual(later.sections.tasks?.recentlyDone.map((t) => t.id), ["t3"]);
  assert.equal(v.sections.colleges, undefined, "switched off: no section at all");
  assert.deepEqual(v.sections.essays?.[0], { id: "e1", label: "Supplement", school: "Brown", status: "drafting", words: 210, wordLimit: 250, dueDate: null });
  assert.ok(!JSON.stringify(v).includes("SECRET"), "an essay's title or text never passes, even if sent");
  assert.equal(v.sections.meetings?.[0]?.joinUrl, null, "only an https link");
  assert.equal(v.canMessage, false);

  const empty = toParentView({ student: { id: "s2", fullName: "" }, counselorReady: false, sections: {} });
  assert.deepEqual(empty.sections, {});
  assert.equal(empty.counselor, null);
  assert.equal(empty.student.name, "Your student");
});

test("children, zones and the database's answers", () => {
  assert.deepEqual(toParentChild({ student_id: "s1", full_name: "Maya Lee", grad_year: "2027", counselor_name: "Jordan Park", counselor_ready: true, can_message: true }), {
    id: "s1", name: "Maya Lee", firstName: "Maya", classYear: "2027", counselorName: "Jordan Park", counselorReady: true, canMessage: true,
  });
  assert.equal(todayIn("Not/AZone", new Date("2026-11-11T03:00:00Z")), "2026-11-10", "an unknown zone reads as New York");
  assert.equal(todayIn("Asia/Tokyo", new Date("2026-11-11T20:00:00Z")), "2026-11-12");
  assert.equal(parentSchemaMissing({ code: "PGRST202" }), true);
  assert.equal(parentSchemaMissing({ code: "42501" }), false);
  assert.equal(hintOf({ hint: "has_account" }), "has_account");
  assert.equal(hintOf({ hint: "Perhaps you meant to reference the column" }), null);
});

test("the request gate: a parent account opens only routes that say allowParent", () => {
  assert.equal(blockedAsParent({ role: "parent" }, undefined), true);
  assert.equal(blockedAsParent({ role: "parent" }, false), true);
  assert.equal(blockedAsParent({ role: "parent" }, true), false);
  assert.equal(blockedAsParent({ role: "student" }, undefined), false);
  assert.equal(blockedAsParent({ role: "counselor" }, undefined), false);
});
