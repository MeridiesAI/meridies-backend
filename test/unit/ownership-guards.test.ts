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

test("allowedRecipients: a student email goes only to the address on file now", () => {
  const row = { student_id: S, audience: "student" as const, channel: "email" as const };
  const onFile = [{ kind: "student", id: S, name: "Maya Lee", email: "Maya@Example.com", phone: "+1 (555) 010-0000" }];
  const ok = allowedRecipients({ ...row, recipients: [rec({ email: "maya@example.com " })] }, { student, family: [] });
  assert.deepEqual(ok, onFile);

  const changed = allowedRecipients({ ...row, recipients: [rec({ email: "old-address@example.com" })] }, { student, family: [] });
  assert.deepEqual(changed, onFile, "a student who changed their address since it was scheduled still gets it, at the new one");

  const forged = allowedRecipients({ ...row, recipients: [rec({ email: "victim@elsewhere.com" })] }, { student, family: [] });
  assert.deepEqual(forged, onFile, "an address the row names is never used: only the one on file");

  const otherId = allowedRecipients({ ...row, recipients: [rec({ id: "other", email: "maya@example.com" })] }, { student, family: [] });
  assert.deepEqual(otherId, [], "a row that doesn't name this student sends nothing");
  const guardianKind = allowedRecipients({ ...row, recipients: [rec({ kind: "guardian", email: "maya@example.com" })] }, { student, family: [] });
  assert.deepEqual(guardianKind, []);

  const many = allowedRecipients(
    { ...row, recipients: [rec({ email: "maya@example.com" }), rec({ email: "victim@elsewhere.com" }), rec({ id: "x", email: "y@z.com" })] },
    { student, family: [] }
  );
  assert.deepEqual(many, onFile, "extra names on the row are dropped, the student gets one copy");

  assert.deepEqual(allowedRecipients({ ...row, recipients: [rec({ email: "maya@example.com" })] }, { student: null, family: [] }), []);
  assert.deepEqual(
    allowedRecipients({ ...row, recipients: [rec({ email: "maya@example.com" })] }, { student: { ...student, email: "  " }, family: [] }),
    [],
    "no address on file sends nothing"
  );
  assert.deepEqual(
    allowedRecipients({ ...row, recipients: [rec({})] }, { student: { ...student, id: "someone-else" }, family: [] }),
    [],
    "the contact must be this row's student"
  );
});

test("allowedRecipients: a student text goes only to the phone on file now", () => {
  const row = { student_id: S, audience: "student" as const, channel: "sms" as const };
  const sent = allowedRecipients({ ...row, recipients: [rec({ phone: "+19005550199" })] }, { student, family: [] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, "+1 (555) 010-0000", "the number on file, never the row's");
  assert.deepEqual(allowedRecipients({ ...row, recipients: [rec({ phone: "+15550100000" })] }, { student: { ...student, phone: "n/a" }, family: [] }), []);
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
