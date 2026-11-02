// A family answers a text: which keyword is it, who is that number, and what
// the first text to a number must say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPhoneOwners, smsKeyword, twiml } from "../../src/lib/inboundSms.js";
import { contactTextBody, withOptOutNotice } from "../../src/lib/parentCopy.js";

test("smsKeyword: the carriers' opt-out and opt-in words, and only those, whole-message", () => {
  for (const w of ["STOP", "stop", " Stop ", "STOPALL", "unsubscribe", "Cancel", "END", "quit"]) {
    assert.equal(smsKeyword(w), "stop", w);
  }
  for (const w of ["START", "yes", "Unstop"]) assert.equal(smsKeyword(w), "start", w);
  for (const w of ["HELP", "info"]) assert.equal(smsKeyword(w), "help", w);
  // A sentence that merely contains a keyword is a message, not a command.
  for (const w of ["please stop by tomorrow", "Yes, 4pm works", "can you cancel the meeting", "", "   "]) {
    assert.equal(smsKeyword(w), null, JSON.stringify(w));
  }
  // Trailing punctuation people add.
  assert.equal(smsKeyword("STOP."), "stop");
  assert.equal(smsKeyword("stop!"), "stop");
});

test("matchPhoneOwners: finds every record whose phone is this number, however it was typed", () => {
  const owners = [
    { kind: "guardian" as const, id: "g1", studentId: "s1", phone: "(415) 555-0142" },
    { kind: "student" as const, id: "s1", studentId: "s1", phone: "415.555.0199" },
    { kind: "contact-parent" as const, id: "c1", contactId: "c1", phone: "+1 415 555 0142" },
    { kind: "guardian" as const, id: "g2", studentId: "s2", phone: "n/a" },
    { kind: "guardian" as const, id: "g3", studentId: "s3", phone: null },
    { kind: "contact-student" as const, id: "c2", contactId: "c2", phone: "4155550142 ext 3" },
  ];
  const hits = matchPhoneOwners("+14155550142", owners).map((o) => o.id);
  assert.deepEqual(hits.sort(), ["c1", "g1"]);
  assert.deepEqual(matchPhoneOwners("+14155550199", owners).map((o) => o.id), ["s1"]);
  assert.deepEqual(matchPhoneOwners("+19995550000", owners), []);
});

test("withOptOutNotice: only the first text to a number carries the STOP line, and never past the cap", () => {
  const first = withOptOutNotice("Hi Ann, it's Brandon about Maya: draft is in.", true);
  assert.match(first, /Reply STOP to opt out\.$/);
  assert.equal(withOptOutNotice("Hi Ann.", false), "Hi Ann.");
  const long = withOptOutNotice("x".repeat(1590), true);
  assert.ok(long.length <= 1600);
  assert.match(long, /Reply STOP to opt out\.$/, "the notice is kept; the message is trimmed to make room");
  assert.equal(withOptOutNotice("Reply STOP to opt out. Already says it.", true), "Reply STOP to opt out. Already says it.");
});

test("twiml answers Twilio with an empty response, escaping any message", () => {
  assert.equal(twiml(), "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  assert.match(twiml("a < b & c"), /<Message>a &lt; b &amp; c<\/Message>/);
});

test("contactTextBody: a parent is told who and which student; a student just who", () => {
  const ctx = { counselorName: "Brandon Cha", studentName: "Maya Lee" };
  assert.equal(contactTextBody("Draft is in.", { who: "parent", name: "Ann Lee" }, ctx), "Hi Ann, it's Brandon Cha about Maya: Draft is in.");
  assert.equal(contactTextBody("See you Friday.", { who: "student", name: "Maya Lee" }, ctx), "Hi Maya, it's Brandon Cha: See you Friday.");
  assert.equal(contactTextBody("Hi Ann, quick one.", { who: "parent", name: "Ann Lee" }, ctx), "Hi Ann, quick one.");
  assert.equal(contactTextBody("See you.", { who: "student", name: "" }, { counselorName: null, studentName: "" }), "Hi, it's your counselor: See you.");
});
