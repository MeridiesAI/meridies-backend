// The code half of the RLS-and-ownership fixes: who may archive a student,
// which accepted invitations the API trusts, and which frozen recipients a
// scheduled composer message may still go to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canArchive } from "../../src/lib/guards.js";
import { isRosterStudent } from "../../src/lib/newStudentIntake.js";
import { allowedRecipients, type FamilyContact, type Recipient, type StudentContact } from "../../src/lib/studentMessages.js";

const S = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";

test("canArchive: only a counselor, and never about themselves", () => {
  assert.equal(canArchive("counselor", C, S), true);
  assert.equal(canArchive("student", S, S), false);
  assert.equal(canArchive("student", S, C), false);
  assert.equal(canArchive("counselor", C, C), false);
  assert.equal(canArchive(null, C, S), false);
});

test("isRosterStudent: the accepted profile must be a student on the caller's roster", () => {
  assert.equal(isRosterStudent({ id: S, role: "student", counselor_id: C }, C), true);
  assert.equal(isRosterStudent(null, C), false, "a profile RLS hid (another practice) is not trusted");
  assert.equal(isRosterStudent({ id: S, role: "counselor", counselor_id: C }, C), false);
  assert.equal(isRosterStudent({ id: S, role: "student", counselor_id: "someone-else" }, C), false);
  assert.equal(isRosterStudent({ id: S, role: "student", counselor_id: null }, C), false);
});

const student: StudentContact = { id: S, name: "Maya Lee", email: "Maya@Example.com", phone: "+1 (555) 010-0000" };
const family: FamilyContact[] = [
  { id: "g1", name: "Ann Lee", email: "ann@example.com", phone: null, relationship: "mother", isPrimary: true, receivesMessages: true },
  { id: "g2", name: "Bo Lee", email: "bo@example.com", phone: null, relationship: "father", isPrimary: false, receivesMessages: false },
];
const rec = (r: Partial<Recipient>): Recipient => ({ kind: "student", id: S, name: "x", email: null, phone: null, ...r });

test("allowedRecipients: a student email goes only to the address on file", () => {
  const row = { student_id: S, audience: "student" as const, channel: "email" as const };
  const ok = allowedRecipients({ ...row, recipients: [rec({ email: "maya@example.com " })] }, { student, family: [] });
  assert.deepEqual(ok, [{ kind: "student", id: S, name: "Maya Lee", email: "Maya@Example.com", phone: "+1 (555) 010-0000" }]);

  const forged = allowedRecipients(
    { ...row, recipients: [rec({ email: "victim@elsewhere.com" }), rec({ id: "other", email: "maya@example.com" })] },
    { student, family: [] }
  );
  assert.deepEqual(forged, [], "an arbitrary address, or the right address under another id, sends nothing");

  const many = allowedRecipients(
    { ...row, recipients: [rec({ email: "maya@example.com" }), rec({ email: "victim@elsewhere.com" })] },
    { student, family: [] }
  );
  assert.equal(many.length, 1, "extra names on the row are dropped, the student gets one copy");
  assert.equal(many[0].email, "Maya@Example.com");

  assert.deepEqual(allowedRecipients({ ...row, recipients: [rec({ email: "maya@example.com" })] }, { student: null, family: [] }), []);
  assert.deepEqual(
    allowedRecipients({ ...row, recipients: [rec({ email: "maya@example.com" })] }, { student: { ...student, email: null }, family: [] }),
    []
  );
});

test("allowedRecipients: a student text goes only to the phone on file", () => {
  const row = { student_id: S, audience: "student" as const, channel: "sms" as const };
  assert.equal(allowedRecipients({ ...row, recipients: [rec({ phone: "+15550100000" })] }, { student, family: [] }).length, 1);
  assert.deepEqual(allowedRecipients({ ...row, recipients: [rec({ phone: "+19005550199" })] }, { student, family: [] }), []);
});

test("allowedRecipients: parents only while on file, receiving, at the same address", () => {
  const row = { student_id: S, audience: "parent" as const, channel: "email" as const };
  const out = allowedRecipients(
    {
      ...row,
      recipients: [
        rec({ kind: "guardian", id: "g1", email: "ANN@example.com" }),
        rec({ kind: "guardian", id: "g1", email: "ann@example.com" }),
        rec({ kind: "guardian", id: "g2", email: "bo@example.com" }),
        rec({ kind: "guardian", id: "g3", email: "stranger@example.com" }),
        rec({ kind: "student", id: S, email: "maya@example.com" }),
        rec({ kind: "guardian", id: "g1-forged", email: "ann@example.com" }),
      ],
    },
    { student: null, family }
  );
  assert.deepEqual(out.map((r) => [r.id, r.email]), [["g1", "ann@example.com"]]);
  assert.deepEqual(
    allowedRecipients({ ...row, recipients: [rec({ kind: "guardian", id: "g1", email: "attacker@example.com" })] }, { student: null, family }),
    []
  );
  assert.deepEqual(
    allowedRecipients({ ...row, channel: "sms" as never, recipients: [rec({ kind: "guardian", id: "g1", email: "ann@example.com" })] }, { student: null, family }),
    []
  );
});
