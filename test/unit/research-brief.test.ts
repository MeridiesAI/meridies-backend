import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_TYPES } from "../../src/lib/profileUpdates.js";
import { ACTIVITY_CATEGORIES, ACTIVITY_TYPE_CATEGORY, assertNoIdentity, briefHash, category, fold, identityTokens, IDENTITY_FILLER_WORDS, IDENTITY_STOPLIST, IdentityLeakError, toResearchBrief } from "../../src/lib/research/brief.js";

const facts = {
  intendedMajors: ["Biology", "Computer Science"], gradYear: "2027", state: "WY",
  gpa: { value: 3.74, scale: "4.0" }, sat: 1460, act: null,
  activityCategories: ["Math competitions", "USAMO Qualifier", "robotics"],
  identity: { name: "Avery Quinlan", email: "avery.q@example.com", school: "Cheyenne Central High", hometown: "Cheyenne" },
};

test("the brief has categories and bands only", () => {
  const b = toResearchBrief(facts, "activities", null, new Date("2026-10-10"));
  assert.deepEqual(b.interests.sort(), ["math competitions", "robotics"]);
  assert.equal(b.gpaBand, "3.6–3.8 on 4.0");
  assert.equal(b.testBand, "SAT 1400–1500");
  assert.equal(b.grade, 12);
  assert.equal(b.region, "WY");
  const text = JSON.stringify(b).toLowerCase();
  for (const t of ["avery", "quinlan", "example.com", "cheyenne", "usamo"]) assert.ok(!text.includes(t), `${t} leaked`);
});
test("the grade rolls over on August 1 UTC, as the repo's currentGrade does (class of 2027)", () => {
  assert.equal(toResearchBrief(facts, "activities", null, new Date("2026-07-31T23:59:59Z")).grade, 11);
  assert.equal(toResearchBrief(facts, "activities", null, new Date("2026-08-01T00:00:00Z")).grade, 12);
});
test("a non-4/5 GPA scale gives an unknown band", () => {
  assert.equal(toResearchBrief({ ...facts, gpa: { value: 92, scale: "100" } }, "college_list", null).gpaBand, "unknown");
});
test("the identity filter refuses names, emails, schools and hometowns", () => {
  const tokens = identityTokens(facts.identity);
  assert.throws(() => assertNoIdentity("summer programs for Quinlan in Wyoming", tokens), IdentityLeakError);
  assert.throws(() => assertNoIdentity("cheyenne central high robotics", tokens), IdentityLeakError);
  assert.throws(() => assertNoIdentity("avery.q@example.com", tokens), IdentityLeakError);
  assert.doesNotThrow(() => assertNoIdentity("math competitions for high school juniors in WY", tokens));
});
test("focus text passes the same filter", () => {
  assert.throws(() => toResearchBrief(facts, "activities", "something like Avery's club"), IdentityLeakError);
});
test("the hash changes when majors change", () => {
  const a = briefHash(toResearchBrief(facts, "activities", null));
  const b = briefHash(toResearchBrief({ ...facts, intendedMajors: ["History"] }, "activities", null));
  assert.notEqual(a, b);
});

test("a CJK name is a token even when it is two characters", () => {
  const tokens = identityTokens({ name: "李明", email: null, school: null, hometown: null });
  assert.ok(tokens.includes("李明"));
  assert.throws(() => assertNoIdentity("适合李明的夏令营", tokens), IdentityLeakError);
});
test("a spaced CJK name also yields the joined form", () => {
  const tokens = identityTokens({ name: "李 明", email: null, school: null, hometown: null });
  assert.ok(tokens.includes("李明"));
});
test("a two-letter ASCII name part is not a token, a three-letter one is", () => {
  const tokens = identityTokens({ name: "Li Wei", email: null, school: null, hometown: null });
  assert.ok(!tokens.includes("li"));
  assert.ok(tokens.includes("wei"));
  assert.doesNotThrow(() => assertNoIdentity("reliable planning, li as a word", tokens));
  assert.throws(() => assertNoIdentity("Wei Chen science fair", tokens), IdentityLeakError);
});
test("empty or whitespace-only identity fields produce no tokens and never match", () => {
  const identity = { name: null, email: null, school: "", hometown: "  " };
  assert.deepEqual(identityTokens(identity), []);
  assert.doesNotThrow(() => assertNoIdentity("anything", identityTokens(identity)));
});

const ident = (o: Partial<{ name: string | null; email: string | null; school: string | null; hometown: string | null }>) =>
  ({ name: null, email: null, school: null, hometown: null, ...o });
const refuses = (text: string, id: ReturnType<typeof ident>) =>
  assert.throws(() => assertNoIdentity(text, identityTokens(id)), IdentityLeakError, text);
const allows = (text: string, id: ReturnType<typeof ident>) =>
  assert.doesNotThrow(() => assertNoIdentity(text, identityTokens(id)), text);
const withMajors = (intendedMajors: string[]) => toResearchBrief({ ...facts, intendedMajors }, "college_list", null).majors;

// Finding 1
test("majors are kept only when short and plain", () => {
  assert.deepEqual(withMajors(["Computer Science", "Film & Media Studies", "Pre-Med"]), ["computer science", "film & media studies", "pre-med"]);
  assert.deepEqual(withMajors(["I go to Lincoln High and love bio", "biology 307-555-0100", "bio@x.org", "see http://x.org", "a".repeat(61), "  ", "&"]), []);
  assert.deepEqual(withMajors(["one two three four five", "one two three four five six"]), ["one two three four five"]);
  assert.equal(withMajors(["a", "b", "c", "d", "e", "f", "g"]).length, 5);
});

// Finding 2
test("the GPA band label comes from the scale kind, never the raw string", () => {
  const band = (scale: string | null, value = 3.74) => toResearchBrief({ ...facts, gpa: { value, scale } }, "college_list", null).gpaBand;
  assert.equal(band("4.0 weighted at Lincoln High"), "3.6–3.8 on 4.0");
  assert.equal(band("4.0"), "3.6–3.8 on 4.0");
  assert.equal(band("5.0 scale", 4.5), "4.4–4.6 on 5.0");
  assert.equal(band(null), "3.6–3.8 on 4.0");
  assert.equal(band("100"), "unknown");
});

// Finding 3
test("school and hometown words match, generic words do not", () => {
  const school = ident({ school: "Cheyenne Central High" });
  refuses("cheyenne central robotics", school);
  refuses("programs near cheyenne", ident({ hometown: "Cheyenne, WY" }));
  refuses("st marys", ident({ school: "St. Mary's H.S." }));
  refuses("st marys hs", ident({ school: "St. Mary's H.S." }));
  allows("math competitions for high school juniors in WY", ident({ school: "Cheyenne Central High", hometown: "Cheyenne, WY" }));
  const sci = identityTokens(ident({ school: "Science Academy" }));
  assert.deepEqual(sci, ["science academy"]);
  assert.doesNotThrow(() => assertNoIdentity("science research", sci));
  assert.ok(IDENTITY_STOPLIST.has("high") && !IDENTITY_STOPLIST.has("wyoming") && !IDENTITY_STOPLIST.has("park"));
});

// Finding 4
test("Unicode forms compare equal", () => {
  refuses("hi jose\u0301 here", ident({ name: "Jos\u00e9" }));
  refuses("hi jos\u00e9 here", ident({ name: "Jose\u0301" }));
  refuses("ＱＵＩＮＬＡＮ", ident({ name: "Quinlan" }));
  refuses("camp for Nunez", ident({ name: "Núñez" }));
  refuses("camp for Núñez", ident({ name: "Nunez" }));
  refuses("适合李明的夏令营", ident({ name: "李明" }));
  refuses("Q\u200buinlan", ident({ name: "Quinlan" }));
  assert.equal(fold("Ｃafé"), "cafe");
  assert.deepEqual(withMajors(["Ingeniería"]), ["ingenieria"]);
  const b = toResearchBrief({ ...facts, activityCategories: ["ROBOTICS", "Ｍusic"] }, "activities", null);
  assert.deepEqual(b.interests, ["robotics", "music"]);
});

// Finding 5
test("name parts split on separators and fused forms are tokens", () => {
  refuses("obrien lab", ident({ name: "O'Brien" }));
  refuses("brien lab", ident({ name: "O'Brien" }));
  refuses("o\u2019brien lab", ident({ name: "O\u2019Brien" }));
  refuses("maryjane camp", ident({ name: "Mary-Jane Smith" }));
  refuses("avery camp", ident({ name: "Avery_Quinlan" }));
  refuses("averyquinlan camp", ident({ name: "Avery_Quinlan" }));
  refuses("quinlan camp", ident({ name: "Avery_Quinlan" }));
});

// Finding 6
test("region must be exactly two ASCII letters", () => {
  const region = (state: string | null) => toResearchBrief({ ...facts, state }, "college_list", null).region;
  assert.equal(region("wy"), "WY");
  assert.equal(region("Wyoming"), null);
  assert.equal(region("W1"), null);
  assert.equal(region("Ｗｙ"), null);
  assert.equal(region(null), null);
});

// G2: the final scan reads only the majors and the focus, never the brief's own keys and fixed words.
test("a name equal to a fixed vocabulary word no longer refuses the run", () => {
  // Was: hometown "Music City" and the interest "music" refused every run. The interests are code-built and not scanned.
  const withMusic = { ...facts, identity: { ...facts.identity, hometown: "Music City" }, activityCategories: ["Music: Vocal"] };
  assert.deepEqual(toResearchBrief(withMusic, "activities", null).interests, ["music"]);
});
test("surnames and schools that equal the brief's own keys or words are not refused", () => {
  const brief = (identity: Partial<typeof facts.identity>, over: Partial<typeof facts> = {}, feature: "activities" | "college_list" = "activities") =>
    toResearchBrief({ ...facts, ...over, identity: { ...facts.identity, ...identity } }, feature, null);
  assert.doesNotThrow(() => brief({ name: "Sam Null" }));
  assert.doesNotThrow(() => brief({ name: "Sam List" }, {}, "college_list"));
  assert.doesNotThrow(() => brief({ name: "Sam Region" }));
  const b = brief({ school: "Health Sciences High" }, { activityCategories: ["Research"] });
  assert.deepEqual(b.interests, ["science research"]);
  assert.doesNotThrow(() => brief({ school: "Health Sciences High" }, { activityCategories: ["health and medicine"] }));
  assert.deepEqual(brief({ school: "Health Sciences High" }, { activityCategories: ["health and medicine"] }).interests, ["health and medicine"]);
});
test("a major that holds the student's identity is dropped and the others are kept", () => {
  const b = toResearchBrief({ ...facts, intendedMajors: ["Biology", "Quinlan studies", "Computer Science"] }, "college_list", null);
  assert.deepEqual(b.majors, ["biology", "computer science"]);
  assert.equal(toResearchBrief({ ...facts, intendedMajors: ["Cheyenne studies"] }, "college_list", null).majors.length, 0);
});
test("a focus that holds the name, school or hometown still throws", () => {
  assert.throws(() => toResearchBrief(facts, "activities", "like Quinlan did"), IdentityLeakError);
  assert.throws(() => toResearchBrief(facts, "activities", "near Cheyenne"), IdentityLeakError);
});

// G3: the product's own activity types reach the brief as interests.
test("every ACTIVITY_TYPES value maps to a vocabulary entry, and the table has no stale rows", () => {
  for (const t of ACTIVITY_TYPES) {
    const key = fold(t).trim().replace(/\s+/g, " ");
    const hit = ACTIVITY_TYPE_CATEGORY[key];
    assert.ok(hit && (ACTIVITY_CATEGORIES as readonly string[]).includes(hit), `${t} has no row in ACTIVITY_TYPE_CATEGORY`);
  }
  assert.equal(Object.keys(ACTIVITY_TYPE_CATEGORY).length, ACTIVITY_TYPES.length);
});
test("category(): types map, the vocabulary still matches, 'other' and unknown words give nothing", () => {
  assert.equal(category("Science/Math"), "science research");
  assert.equal(category("  Athletics:  Club "), "athletics");
  assert.equal(category("Robotics"), "robotics");
  assert.equal(category("math competitions"), "math competitions");
  assert.equal(category("Other Club/Activity"), null);
  assert.equal(category("other"), null);
  assert.equal(category("LGBT"), null);
  assert.equal(category("USAMO Qualifier"), null);
  assert.equal(category("constructor"), null);
  const b = toResearchBrief({ ...facts, activityCategories: ["Robotics", "Science/Math", "Other Club/Activity", "Music: Vocal", "Music: Instrumental"] }, "activities", null);
  assert.deepEqual(b.interests, ["robotics", "science research", "music"]);
});

// G5: the two layers no longer share the same blind spots.
test("plurals, glued digits, the school's short form and ø-type letters are caught", () => {
  refuses("the Okafors want something local", ident({ name: "Will Okafor" }));
  refuses("avery2027 robotics", ident({ name: "Avery Quinlan" }));
  refuses("avery2027", ident({ email: "avery.q@example.com" }));
  refuses("robotics at Lee High", ident({ school: "Lee High School" }));
  refuses("at cheyenne central high", ident({ school: "Cheyenne Central High School" }));
  refuses("ask Soren", ident({ name: "Søren Lund" }));
  refuses("ask Søren", ident({ name: "Soren Lund" }));
  refuses("Lukasz club", ident({ name: "Łukasz Nowak" }));
  refuses("Strasse", ident({ name: "Straße Mueller" }));
  refuses("Dorde", ident({ name: "Đorđe Petrovic" }));
  refuses("Aelfric", ident({ name: "Ælfric Gray" }));
  refuses("Thor", ident({ name: "Þor Gray" }));
  assert.equal(fold("ıı Øl Łđ"), "ii ol ld");
});
test("short tokens keep the whole-word rule", () => {
  allows("students willing to travel", ident({ name: "Will Turner" }));
  allows("marking period", ident({ name: "Mark Hale" }));
  allows("okay", ident({ name: "Oka Ito" }));
  refuses("will travel", ident({ name: "Will Turner" }));
  allows("annual leeway", ident({ name: "Ann Lee" }));
  assert.deepEqual(identityTokens(ident({ school: "Central High School" })).sort(), ["central high school"]);
  assert.ok(identityTokens(ident({ school: "Lee High School" })).includes("lee high"));
});
test("a school alias never consists only of generic and filler words", () => {
  const schools = ["Academy of Science", "School of the Arts", "The Arts Academy", "The Science Academy", "School of Science and Engineering Magnet"];
  for (const school of schools) {
    for (const tok of identityTokens(ident({ school }))) {
      if (tok === fold(school) || tok === fold(school).replace(/[^\p{L}\p{N}\s]/gu, "")) continue;
      assert.ok(
        tok.split(" ").some((w) => !IDENTITY_STOPLIST.has(w) && !IDENTITY_FILLER_WORDS.has(w)),
        `${school}: token "${tok}" is only generic/filler words`,
      );
    }
  }
  allows("summer programs in the arts", ident({ school: "The Arts Academy" }));
  // The whole name "Academy of Science" itself still matches "academy of sciences" by design (whole-string prefix rule).
  allows("national academy of sciences", ident({ school: "Academy of Science Magnet" }));
  allows("tulane school of science and engineering", ident({ school: "School of Science and Engineering Magnet" }));
  allows("programs for the arts and the science of learning", ident({ school: "School of the Arts" }));
});
test("aliases still work with fillers around a distinctive word", () => {
  assert.ok(identityTokens(ident({ school: "Lee High School" })).includes("lee high"));
  refuses("the Lee High robotics team", ident({ school: "Lee High School" }));
  const bronx = identityTokens(ident({ school: "Bronx High School of Science" }));
  assert.ok(bronx.includes("bronx high school"));
  // Caught by the "bronx" word token (5 characters, word prefix); "bronx science" is not an alias.
  refuses("Bronx Science robotics", ident({ school: "Bronx High School of Science" }));
  assert.ok(!bronx.some((t) => /\b(of|the)$/.test(t) && t !== "bronx high school of science"));
});
test("known limits: a two-letter Latin name part is not a token", () => {
  allows("Li and Bo want a camp", ident({ name: "Li Bo" }));
});

// Adversarial table
test("adversarial inputs", () => {
  const cases: Array<{ label: string; id: ReturnType<typeof ident>; text: string; leaks: boolean }> = [
    { label: "one-word name", id: ident({ name: "Madonna" }), text: "camps like madonna's", leaks: true },
    { label: "one-word name, other text", id: ident({ name: "Madonna" }), text: "summer camps", leaks: false },
    { label: "name inside a common word", id: ident({ name: "Ann Lee" }), text: "planning, annual leeway", leaks: false },
    { label: "name inside a common word 2", id: ident({ name: "Art" }), text: "start party", leaks: false },
    { label: "email local part with dots and digits", id: ident({ email: "j.r.smith99@mail.org" }), text: "jrsmith99 club", leaks: true },
    { label: "email local piece", id: ident({ email: "j.r.smith99@mail.org" }), text: "smith99 club", leaks: true },
    { label: "email full", id: ident({ email: "j.r.smith99@mail.org" }), text: "write j.r.smith99@mail.org", leaks: true },
    { label: "school with metacharacters", id: ident({ school: "C++ Academy (North)" }), text: "c++ academy (north) clubs", leaks: true },
    { label: "school with metacharacters, other", id: ident({ school: "C++ Academy (North)" }), text: "c programming north", leaks: false },
    { label: "whitespace-only fields", id: ident({ name: "  ", email: " ", school: "\t", hometown: "\n" }), text: "anything", leaks: false },
    { label: "empty fields", id: ident({ name: "", email: "", school: "", hometown: "" }), text: "anything", leaks: false },
    { label: "case and spacing", id: ident({ name: "AVERY   QUINLAN" }), text: "avery quinlan", leaks: true },
  ];
  for (const c of cases) {
    const run = () => assertNoIdentity(c.text, identityTokens(c.id));
    if (c.leaks) assert.throws(run, IdentityLeakError, c.label);
    else assert.doesNotThrow(run, c.label);
  }
});
test("a focus of 500 characters with the name at position 300 refuses, though only 200 would be stored", () => {
  const focus = "x ".repeat(150) + "Quinlan " + "y ".repeat(100);
  assert.ok(focus.indexOf("Quinlan") >= 300 - 2);
  assert.throws(() => toResearchBrief(facts, "activities", focus), IdentityLeakError);
  const ok = toResearchBrief(facts, "activities", "z ".repeat(250));
  assert.equal(ok.focus?.length, 200);
});

// Fix round 2
test("place words and state names are tokens, generic school words are not", () => {
  refuses("washington robotics", ident({ school: "Washington High" }));
  refuses("mountain", ident({ school: "Mountain View High" }));
  refuses("view", ident({ school: "Mountain View High" }));
  refuses("valley", ident({ school: "Valley Forge Academy" }));
  refuses("forge", ident({ school: "Valley Forge Academy" }));
  refuses("programs near park", ident({ hometown: "Park City" }));
  // Throws on the word token "york" (the whole string "new york, ny" would not match this text).
  refuses("programs in New York", ident({ hometown: "New York, NY" }));
  assert.ok(identityTokens(ident({ hometown: "New York, NY" })).includes("york"));
});
test("the state part of 'City, State' is not a word token", () => {
  const h = ident({ hometown: "Cheyenne, Wyoming" });
  allows("programs in Wyoming", h);
  refuses("programs near cheyenne", h);
  assert.ok(identityTokens(h).includes("cheyenne, wyoming"));
  allows("programs in WY", ident({ hometown: "Cheyenne, WY" }));
});
test("generic-only schools have no word tokens and are caught only as the whole string", () => {
  assert.deepEqual(identityTokens(ident({ school: "Central High" })), ["central high"]);
  refuses("central high clubs", ident({ school: "Central High" }));
  allows("science research in the north", ident({ school: "North Science Academy" }));
});
test("no one-character, empty or punctuation-only tokens", () => {
  assert.ok(!identityTokens(ident({ email: "a@x.com" })).includes("a"));
  assert.ok(identityTokens(ident({ email: "a@x.com" })).includes("a@x.com"));
  assert.deepEqual(identityTokens(ident({ school: "...", hometown: "?!" })), []);
});
