import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collegeHost,
  discoveryDomains,
  needsLookup,
  parseAnswer,
  listingName,
  onCollegeSite,
  parseCandidates,
  validCandidates,
} from "../../src/lib/eventsDiscovery.js";
import { forStudents, toHubEvent } from "../../src/lib/eventsHub.js";
import { mapEventsCsv } from "../../src/lib/ingest/events.js";
import { rankColleges } from "../../src/lib/rosterColleges.js";

const NOW = new Date("2026-10-13T15:00:00Z");

const good = {
  title: "Campus Tour and Information Session",
  kind: "campus-tour",
  startDate: "2026-11-07",
  startTime: "10:00",
  endTime: "12:00",
  timeZone: "America/Los_Angeles",
  place: "Stanford, CA",
  signUpUrl: "https://visit.stanford.edu/tours/",
  description: "A student-led tour, then an admission officer's talk.",
};

test("the college's own host, bare; nothing usable is null", () => {
  assert.equal(collegeHost("https://www.stanford.edu"), "stanford.edu");
  assert.equal(collegeHost("www.mit.edu/"), "mit.edu");
  assert.equal(collegeHost(null), null);
  assert.equal(collegeHost("not a site"), null);
  assert.deepEqual(discoveryDomains("stanford.edu"), ["stanford.edu", "youvisit.com"]);
  assert.deepEqual(discoveryDomains("mit.edu"), ["mit.edu", "mitadmissions.org", "youvisit.com"], "MIT's admissions office has its own site");
  assert.equal(onCollegeSite("https://mitadmissions.org/visit/", "mit.edu"), true);
});

test("the answer's object gives the visit page and events; a bare array is events only", () => {
  const o = parseAnswer('```json\n{"visitPage": "https://visit.stanford.edu/", "events": [{"a":1}]}\n```');
  assert.equal(o.visitPage, "https://visit.stanford.edu/");
  assert.equal(o.events.length, 1);
  assert.deepEqual(parseAnswer('[{"a":1}]'), { visitPage: null, events: [{ a: 1 }] });
  assert.deepEqual(parseAnswer("nothing found"), { visitPage: null, events: [] });
});

test("a sign-up link counts only on the college's site, its subdomains, or an allowed platform", () => {
  assert.equal(onCollegeSite("https://visit.stanford.edu/tours", "stanford.edu"), true);
  assert.equal(onCollegeSite("https://stanford.edu/x", "stanford.edu"), true);
  assert.equal(onCollegeSite("https://www.youvisit.com/tour/stanford", "stanford.edu"), true);
  assert.equal(onCollegeSite("https://notstanford.edu/", "stanford.edu"), false);
  assert.equal(onCollegeSite("https://stanford.edu.evil.com/", "stanford.edu"), false);
  assert.equal(onCollegeSite("https://eventbrite.com/e/123", "stanford.edu"), false);
  assert.equal(onCollegeSite("javascript:alert(1)", "stanford.edu"), false);
});

test("the answer's JSON array is read, fenced or bare; anything else is nothing", () => {
  assert.equal(parseCandidates('Here you go:\n```json\n[{"a":1}]\n```').length, 1);
  assert.equal(parseCandidates('Found these. [{"a":1},{"b":2}]').length, 2);
  assert.deepEqual(parseCandidates("I couldn't find any events."), []);
  assert.deepEqual(parseCandidates("[not json"), []);
  assert.deepEqual(parseCandidates('{"a":1}'), []);
});

test("a candidate stays only if every field checks out", () => {
  const keep = (c: object) => validCandidates([c], "stanford.edu", NOW).length === 1;
  assert.equal(keep(good), true);
  assert.equal(keep({ ...good, kind: "conference" }), false, "conferences are found by people");
  assert.equal(keep({ ...good, kind: "party" }), false);
  assert.equal(keep({ ...good, startDate: "2026-10-01" }), false, "already past");
  assert.equal(keep({ ...good, startDate: "2027-09-01" }), false, "past the six-month horizon");
  assert.equal(keep({ ...good, startDate: "2026-02-30" }), false, "not a real date");
  assert.equal(keep({ ...good, timeZone: "Mars/Olympus" }), false);
  assert.equal(keep({ ...good, signUpUrl: "https://eventbrite.com/e/1" }), false, "off the college's site");
  assert.equal(keep({ ...good, startTime: null, endTime: "12:00" }), false);
  assert.equal(keep({ ...good, endTime: "09:00" }), false);
  assert.equal(keep({ ...good, startTime: null, endTime: null }), true, "all-day is fine");
});

test("the same session listed twice is one candidate, and a college gives at most 12", () => {
  assert.equal(validCandidates([good, { ...good }], "stanford.edu", NOW).length, 1);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...good, startDate: `2026-11-${String(i + 1).padStart(2, "0")}` }));
  assert.equal(validCandidates(many, "stanford.edu", NOW).length, 12);
});

test("a listing's name is the title, tidied", () => {
  assert.equal(listingName({ ...good, title: "  Campus   Tour  " } as never), "Campus Tour");
});

test("students see Meridies-wide listings for students or everyone, never a counselor's", () => {
  const base = { created_by: null, firm_id: null };
  assert.equal(forStudents({ ...base, audience: "everyone" }), true);
  assert.equal(forStudents({ ...base, audience: "student" }), true);
  assert.equal(forStudents({ ...base, audience: "counselor" }), false);
  assert.equal(forStudents({ created_by: "u1", firm_id: null, audience: "everyone" }), false);
  assert.equal(forStudents({ created_by: null, firm_id: "f1", audience: "everyone" }), false);
});

test("the card says Plan a visit for a tour or open house and Register otherwise", () => {
  const row = { id: "e", name: "x", kind: "campus-tour", host: "h", start_date: "2026-11-07", place: "p", url: "https://x.edu" };
  assert.equal(toHubEvent(row, "me", null, null).cta, "Plan a visit");
  assert.equal(toHubEvent({ ...row, kind: "open-house" }, "me", null, null).cta, "Plan a visit");
  assert.equal(toHubEvent({ ...row, kind: "info-session" }, "me", null, null).cta, "Register");
  assert.equal(toHubEvent(row, "me", null, null).audience, "counselor", "no audience on file reads as counselor-only");
});

test("a CSV row's audience defaults by kind and is marked csv", () => {
  const base = { name: "n", host: "h", start_date: "2099-01-15", url: "https://example.org" };
  const { ok, errors } = mapEventsCsv([
    { ...base, name: "tour", kind: "campus-tour" },
    { ...base, name: "conf", kind: "conference" },
    { ...base, name: "web", kind: "webinar", audience: "Everyone" },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    ok.map((o) => [o.row.name, o.row.audience, o.row.source]),
    [
      ["tour", "everyone", "csv"],
      ["conf", "counselor", "csv"],
      ["web", "everyone", "csv"],
    ]
  );
  assert.ok(mapEventsCsv([{ ...base, kind: "webinar", audience: "parents" }]).errors.length > 0);
});

test("roster colleges rank by how many students list them", () => {
  const by = new Map([
    ["a", new Set(["s1"])],
    ["b", new Set(["s1", "s2", "s3"])],
    ["c", new Set(["s2", "s3"])],
  ]);
  assert.deepEqual(rankColleges(by), ["b", "c", "a"]);
  assert.deepEqual(rankColleges(by, 2), ["b", "c"]);
});

test("a college is looked up again only when it never was, or a week has passed", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.equal(needsLookup(null, now), true);
  assert.equal(needsLookup("2026-10-12T12:00:00Z", now), false);
  assert.equal(needsLookup("2026-10-01T12:00:00Z", now), true);
});
