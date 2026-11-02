// Parent communication, milestone 1: the email a parent receives is written
// for a parent (not "your counselor" as if they were the student), replies have
// somewhere to go, and a parent can be texted from the composer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertFootnote,
  composerEmailTemplate,
  guardianFootnote,
  parentTextBody,
  pickParentRecipients,
} from "../../src/lib/parentCopy.js";
import { fromHeader } from "../../src/lib/email.js";
import { allowedRecipients, type FamilyContact, type Recipient } from "../../src/lib/studentMessages.js";

const S = "11111111-1111-4111-8111-111111111111";

const guardian: Recipient = { kind: "guardian", id: "g1", name: "Ann Lee", email: "ann@example.com", phone: "(555) 201-0000" };
const student: Recipient = { kind: "student", id: S, name: "Maya Lee", email: "maya@example.com", phone: null };
const ctx = { counselorName: "Brandon Cha", studentName: "Maya Lee" };

test("a parent's email greets the parent, names the student, and promises a reply path", () => {
  const t = composerEmailTemplate({ subject: null, body: "Maya finished her draft." }, guardian, ctx);
  assert.equal(t.heading, "A note about Maya");
  assert.equal(t.paragraphs[0], "Dear Ann,");
  assert.ok(t.paragraphs.includes("Maya finished her draft."));
  assert.match(t.footnote, /Brandon Cha/);
  assert.match(t.footnote, /Reply to this email/i);
  assert.doesNotMatch(t.footnote, /your counselor directly/i, "that line is written for the student");
});

test("a student's email keeps the student wording", () => {
  const t = composerEmailTemplate({ subject: null, body: "See you Friday." }, student, ctx);
  assert.equal(t.heading, "A note from your counselor");
  assert.equal(t.paragraphs[0], "See you Friday.");
  assert.match(t.footnote, /Reply to your counselor directly/);
});

test("a subject the counselor wrote is kept, and a greeting they wrote is not doubled", () => {
  const t = composerEmailTemplate({ subject: "Fall plan", body: "Hi Ann,\n\nHere's the plan." }, guardian, ctx);
  assert.equal(t.heading, "Fall plan");
  assert.equal(t.paragraphs[0], "Hi Ann,");
  assert.equal(t.paragraphs.filter((p) => /^(dear|hi|hello)\b/i.test(p)).length, 1);
});

test("with no counselor name the parent footer still says who answers", () => {
  const t = composerEmailTemplate({ subject: null, body: "Hello" }, guardian, { counselorName: null, studentName: "Maya Lee" });
  assert.match(t.footnote, /your child's counselor|the counselor/i);
  assert.match(t.footnote, /Reply to this email/i);
});

test("a parent's text names the sender and the student, and stays under the SMS cap", () => {
  const body = parentTextBody("Maya finished her draft.", guardian, ctx);
  assert.match(body, /^Hi Ann, it's Brandon Cha about Maya:/);
  assert.ok(body.endsWith("Maya finished her draft."));
  const long = parentTextBody("x".repeat(5000), guardian, ctx);
  assert.ok(long.length <= 1600);
});

test("a text the counselor already opened with a greeting is not greeted twice", () => {
  const body = parentTextBody("Hi Ann, quick update on Maya.", guardian, ctx);
  assert.equal(body, "Hi Ann, quick update on Maya.");
});

const family: FamilyContact[] = [
  { id: "g1", name: "Ann Lee", email: "ann@example.com", phone: "(555) 201-0000", relationship: "mother", isPrimary: true, receivesMessages: true },
  { id: "g2", name: "Bo Lee", email: "bo@example.com", phone: null, relationship: "father", isPrimary: false, receivesMessages: true },
  { id: "g3", name: "Cy Lee", email: null, phone: "n/a", relationship: "uncle", isPrimary: false, receivesMessages: true },
  { id: "g4", name: "Di Lee", email: "di@example.com", phone: "555-201-0002", relationship: "aunt", isPrimary: false, receivesMessages: false },
];

test("pickParentRecipients: email needs an address, text needs a real phone, opted-out guardians get nothing", () => {
  assert.deepEqual(pickParentRecipients(family, "email").map((r) => r.id), ["g1", "g2"]);
  assert.deepEqual(pickParentRecipients(family, "sms").map((r) => r.id), ["g1"], "'n/a' is no phone; g4 opted out");
});

test("dispatch re-check: a parent text goes only to a guardian still on file at the same phone", () => {
  const row = {
    student_id: S,
    audience: "parent" as const,
    channel: "sms" as const,
    recipients: [
      { kind: "guardian", id: "g1", name: "Ann Lee", email: "ann@example.com", phone: "555 201 0000" },
      { kind: "guardian", id: "g2", name: "Bo Lee", email: "bo@example.com", phone: "5552010001" },
      { kind: "guardian", id: "g4", name: "Di Lee", email: "di@example.com", phone: "555-201-0002" },
    ] as Recipient[],
  };
  const out = allowedRecipients(row, { student: null, family });
  assert.deepEqual(out.map((r) => r.id), ["g1"], "g2 has no phone now, g4 opted out");
});

test("dispatch re-check: a guardian whose phone changed since scheduling is dropped, not re-addressed", () => {
  const row = {
    student_id: S,
    audience: "parent" as const,
    channel: "sms" as const,
    recipients: [{ kind: "guardian", id: "g1", name: "Ann Lee", email: null, phone: "555-999-9999" }] as Recipient[],
  };
  assert.deepEqual(allowedRecipients(row, { student: null, family }), []);
});

test("dispatch re-check: parent email still works as before", () => {
  const row = {
    student_id: S,
    audience: "parent" as const,
    channel: "email" as const,
    recipients: [{ kind: "guardian", id: "g1", name: "Ann Lee", email: "ANN@example.com", phone: null }] as Recipient[],
  };
  assert.deepEqual(allowedRecipients(row, { student: null, family }).map((r) => r.id), ["g1"]);
});

test("fromHeader: the counselor's name rides on our verified address, and cannot break the header", () => {
  const cfg = "Meridies <hello@meridiesai.com>";
  assert.equal(fromHeader(cfg, "Brandon Cha"), "Brandon Cha via Meridies <hello@meridiesai.com>");
  assert.equal(fromHeader(cfg, null), cfg);
  assert.equal(fromHeader(cfg, "   "), cfg);
  // Characters that could end the display name or add an address are stripped; the address never changes.
  const evil = fromHeader(cfg, 'Eve" <evil@x.com>, Bob');
  assert.ok(evil.endsWith("<hello@meridiesai.com>"));
  assert.doesNotMatch(evil.replace("<hello@meridiesai.com>", ""), /[<>@,"]/);
  assert.equal(fromHeader("hello@meridiesai.com", "Ann"), "Ann via Meridies <hello@meridiesai.com>", "a bare configured address works");
  assert.ok(fromHeader(cfg, "x".repeat(500)).length < 120, "the name is capped");
});

test("guardianFootnote is the one parent footer, with and without a name", () => {
  assert.match(guardianFootnote("Brandon Cha"), /^Sent by Brandon Cha through Meridies\. Reply to this email and Brandon Cha will receive it directly\.$/);
  assert.match(guardianFootnote(null), /Reply to this email/);
});

test("alertFootnote: parent hears who wrote and can reply; the student is pointed at their counselor", () => {
  assert.match(alertFootnote("guardian", "Maya Lee", "Brandon Cha"), /Brandon Cha.*Reply to this email/);
  assert.match(alertFootnote("guardian", "Maya Lee", null), /Maya's counselor/);
  assert.doesNotMatch(alertFootnote("guardian", "Maya Lee", null), /Contact your counselor directly/);
  assert.match(alertFootnote("student", "Maya Lee", "Brandon Cha"), /Reply to your counselor directly/);
});
