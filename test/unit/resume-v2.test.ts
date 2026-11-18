import assert from "node:assert/strict";
import { test } from "node:test";
import { SECTION_KEYS, cleanBullet, cleanPolish, polishBody, resumeDocV2, resumeSaveBody, type PolishEntry } from "../../src/lib/resumeDoc.js";

const entry = (over: Record<string, unknown> = {}) => ({ id: "e1", org: "Robotics", descriptor: "", location: "", role: "Captain", dates: "June 2024 – Present", hours: "6 hrs/wk", bullets: ["Led 12 members"], ...over });
const doc = (over: Record<string, unknown> = {}) => ({
  version: 2,
  header: { name: "Ava Lee", email: "ava@x.edu", phone: "555-0100", place: "Austin, TX", link: "" },
  education: [{ id: "ed1", school: "Lincoln High", location: "Austin, TX", date: "May 2027", address: "", contact: "", lines: [{ id: "l1", label: "GPA", text: "3.9" }] }],
  sections: {},
  snapshot: [],
  highlightUrl: "",
  skills: [{ id: "s1", label: "Skills", items: "Python" }],
  order: null,
  ...over,
});

test("a full athletics document is accepted", () => {
  const full = doc({
    sections: { snapshot: [], stats_honors: [entry()], leadership: [entry({ id: "e2" })], coaches: [entry({ id: "e3" })], highlight: [] },
    snapshot: [{ id: "n1", label: "Height", value: "6'1\"" }],
    highlightUrl: "https://example.com/film",
    order: ["leadership", "stats_honors"],
  });
  assert.ok(resumeDocV2.safeParse(full).success);
});

test("every one of the 24 section keys is accepted, and an unknown one is refused", () => {
  assert.equal(SECTION_KEYS.length, 24);
  const all = Object.fromEntries(SECTION_KEYS.map((k) => [k, [entry()]]));
  assert.ok(resumeDocV2.safeParse(doc({ sections: all })).success);
  assert.ok(!resumeDocV2.safeParse(doc({ sections: { bogus: [entry()] } })).success);
  assert.ok(!resumeDocV2.safeParse(doc({ order: ["bogus"] })).success);
});

test("limits: bullet length, bullets per entry, entries per section, education, skills, a non-web highlight link", () => {
  assert.ok(!resumeDocV2.safeParse(doc({ sections: { experience: [entry({ bullets: ["x".repeat(301)] })] } })).success);
  assert.ok(!resumeDocV2.safeParse(doc({ sections: { experience: [entry({ bullets: Array.from({ length: 9 }, () => "x") })] } })).success);
  assert.ok(!resumeDocV2.safeParse(doc({ sections: { experience: Array.from({ length: 31 }, (_, i) => entry({ id: `e${i}` })) } })).success);
  assert.ok(!resumeDocV2.safeParse(doc({ education: Array.from({ length: 7 }, (_, i) => ({ id: `ed${i}`, school: "S", location: "", date: "", address: "", contact: "", lines: [] })) })).success);
  assert.ok(!resumeDocV2.safeParse(doc({ skills: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, label: "", items: "" })) })).success);
  assert.ok(!resumeDocV2.safeParse(doc({ highlightUrl: "javascript:alert(1)" })).success);
  assert.ok(!resumeDocV2.safeParse({ ...doc(), extra: 1 }).success);
  assert.ok(!resumeDocV2.safeParse({ ...doc(), version: 1 }).success);
});

test("the save body takes one of the eight format keys and a document under the size cap", () => {
  assert.ok(resumeSaveBody.safeParse({ templateKey: "athletics", content: doc() }).success);
  assert.ok(!resumeSaveBody.safeParse({ templateKey: "classic", content: doc() }).success);
  // Many entries, each full of long bullets: valid per field, over 60000 bytes in all.
  const big = Object.fromEntries(
    SECTION_KEYS.slice(0, 10).map((k) => [k, Array.from({ length: 30 }, (_, i) => entry({ id: `${k}${i}`, bullets: Array.from({ length: 8 }, () => "y".repeat(300)) }))])
  );
  const tooBig = resumeSaveBody.safeParse({ templateKey: "general", content: doc({ sections: big }) });
  assert.ok(!tooBig.success);
  assert.match(JSON.stringify(tooBig.error?.issues), /too long to save/);
});

test("Polish drops a bullet that adds a number, keeps [#] and numbers the entry stated", () => {
  const e = polishBody.parse({ section: "Leadership", entry: { org: "Tutoring", descriptor: "", role: "Tutor", dates: "2024 – Present", hours: "3 hrs/wk", bullets: ["Helped 10 students with math"] } }).entry;
  const out = cleanPolish({ bullets: ["Tutored 10 students in math", "Raised grades for 25 students", "Improved scores by [#]%"] }, e);
  assert.deepEqual(out, ["Tutored 10 students in math"]);
  const two = polishBody.parse({ section: "x", entry: { ...e, bullets: ["Helped 10 students with math", "Ran weekly sessions"] } }).entry;
  assert.deepEqual(cleanPolish({ bullets: ["Tutored 10 students in math", "Improved scores by [#]%"] }, two), ["Tutored 10 students in math", "Improved scores by [#]%"]);
});

test("Polish: no first person, nothing over 140 characters, at most 3, and never more than the entry had", () => {
  const allowed = new Set<string>();
  assert.equal(cleanBullet("I led the team", allowed), null);
  assert.equal(cleanBullet("Led my team to regionals", allowed), null);
  assert.equal(cleanBullet("x".repeat(141), allowed), null);
  assert.equal(cleanBullet("Led the team to regionals", allowed), "Led the team to regionals");
  const e: PolishEntry = { org: "A", descriptor: "", role: "", dates: "", hours: "", bullets: ["one", "two"] };
  const out = cleanPolish({ bullets: ["Built the first thing", "Built the second thing", "Built the third thing", "Built the fourth thing"] }, e);
  assert.equal(out.length, 2);
});

test("Polish returns the student's own bullets when no rewrite survives", () => {
  const e: PolishEntry = { org: "Cafe", descriptor: "", role: "Barista", dates: "2024", hours: "", bullets: ["Served guests", "Closed the shop"] };
  assert.deepEqual(cleanPolish({ bullets: ["I served 500 guests", "x"] }, e), ["Served guests", "Closed the shop"]);
});

test("the polish body is strict and bounded", () => {
  assert.ok(!polishBody.safeParse({ section: "x", entry: { org: "", descriptor: "", role: "", dates: "", hours: "", bullets: [], extra: 1 } }).success);
  assert.ok(!polishBody.safeParse({ section: "x", entry: { org: "", descriptor: "", role: "", dates: "", hours: "", bullets: Array.from({ length: 9 }, () => "x") } }).success);
});
