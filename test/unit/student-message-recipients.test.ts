import { test } from "node:test";
import assert from "node:assert/strict";
import { studentContactFrom, studentRecipientsStillAllowed } from "../../src/lib/studentMessages.js";

test("the composer writes to the student's sign-in email, whatever contact email is on file", () => {
  // A planted student_personal_details.contact_email never reaches this
  // function: only the profiles row does.
  const c = studentContactFrom({ id: "s1", full_name: "Ava", email: "ava@login.test", phone: "+15550100", contact_email: "planted@evil.test" });
  assert.equal(c.email, "ava@login.test");
  assert.equal(c.phone, "+15550100");
});

test("a scheduled email to the student leaves only for the sign-in address still on file", () => {
  const frozen = [{ kind: "student" as const, id: "s1", name: "Ava", email: "planted@evil.test", phone: null }];
  assert.deepEqual(studentRecipientsStillAllowed(frozen, "email", "ava@login.test"), []);
  const ok = [{ kind: "student" as const, id: "s1", name: "Ava", email: "Ava@Login.test ", phone: null }];
  assert.equal(studentRecipientsStillAllowed(ok, "email", "ava@login.test").length, 1);
  assert.deepEqual(studentRecipientsStillAllowed(ok, "email", null), [], "no address on file sends nothing");
  // A text is decided by the phone, not by this email rule.
  assert.equal(studentRecipientsStillAllowed(frozen, "sms", "ava@login.test").length, 1);
});
