import assert from "node:assert/strict";
import test from "node:test";
import { draftInfoPatchSchema, draftInfoView, splitDraftPatch } from "../../src/lib/invitationInfo.js";
import { infoCountsByInvitation } from "../../src/lib/invites.js";

const INV = "9acde249-47c8-4553-b194-37cbab069252";
const HS = "6b898b7d-0abf-447d-bc9d-2b47bd9c5731";
const inv = (over: Record<string, unknown> = {}) => ({
  id: INV, email: "ana@example.com", full_name: "Ana Lopez", grad_year: 2027, info: null as Record<string, unknown> | null, ...over,
});

test("splitDraftPatch: a value goes to set, null and an empty string go to remove", () => {
  const { set, remove } = splitDraftPatch({ phone: "555", address: null, rigor: "", email: "" });
  assert.deepEqual(set, { phone: "555" });
  assert.deepEqual(remove.sort(), ["address", "email", "rigor"]);
});

test("splitDraftPatch: false and 0 are values, not blanks", () => {
  const { set, remove } = splitDraftPatch({ firstGen: false, collegesPlanned: 0, intendedMajors: ["Biology"] });
  assert.deepEqual(set, { firstGen: false, collegesPlanned: 0, intendedMajors: ["Biology"] });
  assert.deepEqual(remove, []);
});

test("splitDraftPatch: gradYear becomes a number or null and never enters set or remove", () => {
  const year = splitDraftPatch({ gradYear: "2027" });
  assert.equal(year.gradYear, 2027);
  assert.deepEqual([year.set, year.remove], [{}, []]);
  const cleared = splitDraftPatch({ gradYear: "" });
  assert.equal(cleared.gradYear, null);
  assert.deepEqual([cleared.set, cleared.remove], [{}, []]);
  assert.equal(splitDraftPatch({ gradYear: null }).gradYear, null);
  assert.equal("gradYear" in splitDraftPatch({ phone: "555" }), false, "absent when the patch had none");
});

test("splitDraftPatch: highSchoolId travels only with highSchool", () => {
  assert.deepEqual(splitDraftPatch({ highSchool: "Lincoln High" }, HS).set, { highSchool: "Lincoln High", highSchoolId: HS });
  const unmatched = splitDraftPatch({ highSchool: "Lincoln High" });
  assert.deepEqual(unmatched.set, { highSchool: "Lincoln High" });
  assert.deepEqual(unmatched.remove, ["highSchoolId"], "a school typed with no catalog match drops the old link");
  assert.deepEqual(splitDraftPatch({ highSchool: "Lincoln High" }, null).remove, ["highSchoolId"]);
  assert.deepEqual(splitDraftPatch({ highSchool: null }, HS).remove.sort(), ["highSchool", "highSchoolId"]);
  const without = splitDraftPatch({ phone: "555" }, HS);
  assert.deepEqual(without.set, { phone: "555" });
  assert.deepEqual(without.remove, [], "no highSchool in the patch leaves the stored link alone");
});

test("splitDraftPatch: the private note is stored like any other key", () => {
  assert.deepEqual(splitDraftPatch({ privateNote: "Nervous about essays" }).set, { privateNote: "Nervous about essays" });
  assert.deepEqual(splitDraftPatch({ privateNote: null }).remove, ["privateNote"]);
  assert.deepEqual(splitDraftPatch({ privateNote: "" }).remove, ["privateNote"]);
});

test("draftInfoPatchSchema: the info card's rules, plus a private note, and nothing else", () => {
  assert.equal(draftInfoPatchSchema.safeParse({}).success, true);
  assert.equal(draftInfoPatchSchema.safeParse({ phone: "555", privateNote: "ok" }).success, true);
  assert.equal(draftInfoPatchSchema.safeParse({ privateNote: null }).success, true);
  assert.equal(draftInfoPatchSchema.safeParse({ privateNote: "x".repeat(4000) }).success, true);
  assert.equal(draftInfoPatchSchema.safeParse({ privateNote: "x".repeat(4001) }).success, false);
  assert.equal(draftInfoPatchSchema.safeParse({ sat: 399 }).success, false);
  assert.equal(draftInfoPatchSchema.safeParse({ sat: 400 }).success, true);
  assert.equal(draftInfoPatchSchema.safeParse({ gradYear: "27" }).success, false);
  assert.equal(draftInfoPatchSchema.safeParse({ guardianId: INV }).success, false, "unknown key");
  assert.equal(draftInfoPatchSchema.safeParse({ highSchoolId: HS }).success, false, "the server sets the school link");
});

test("draftInfoView: an invitation with no info is an empty but complete info card", () => {
  assert.deepEqual(draftInfoView(inv({ grad_year: null })), {
    studentId: INV, fullName: "Ana Lopez", loginEmail: "ana@example.com", email: "ana@example.com", contactEmailSet: false,
    phone: null, address: null, guardianId: null, parentName: null, parentEmail: null, parentPhone: null,
    gender: null, birthday: null, citizenship: null, firstGen: null, livingWithParent: null, maritalStatus: null,
    collegesPlanned: null, highSchool: null, highSchoolId: null, gradYear: null,
    gpaWeighted: null, gpaUnweighted: null, gpaScale: null, classRank: null,
    classRankDerived: null, classRankUnavailableReason: "Available once they join",
    sat: null, act: null, rigor: null, intendedMajors: [], applications: 0, fromQuestionnaire: [],
  });
  assert.equal(draftInfoView(inv({ full_name: null })).fullName, "");
  assert.equal(draftInfoView(inv()).gradYear, "2027");
});

test("draftInfoView: reads what was stored, and a contact email set on the draft wins over the invitation's", () => {
  const view = draftInfoView(inv({
    info: {
      email: "ana.home@example.com", phone: "555", address: "1 Main St", parentName: "Rosa", parentEmail: "rosa@example.com",
      parentPhone: "556", gender: "female", birthday: "2009-04-02", citizenship: "us-citizen", firstGen: false,
      livingWithParent: true, maritalStatus: "single", collegesPlanned: 8, highSchool: "Lincoln High", highSchoolId: HS,
      gpaWeighted: 4.3, gpaUnweighted: 3.9, gpaScale: "4.0", classRank: "12 of 300", sat: 1450, act: 32,
      rigor: "7 APs", intendedMajors: ["Biology", "Chemistry"], privateNote: "not on the card",
    },
  }));
  assert.equal(view.email, "ana.home@example.com");
  assert.equal(view.loginEmail, "ana@example.com");
  assert.equal(view.contactEmailSet, true);
  assert.equal(view.highSchoolId, HS);
  assert.equal(view.firstGen, false, "false is an answer");
  assert.equal(view.sat, 1450);
  assert.equal(view.gpaWeighted, 4.3);
  assert.deepEqual(view.intendedMajors, ["Biology", "Chemistry"]);
  assert.equal("privateNote" in view, false);
});

test("draftInfoView: a blank contact email falls back to the invitation's", () => {
  const view = draftInfoView(inv({ info: { email: "   " } }));
  assert.equal(view.email, "ana@example.com");
  assert.equal(view.contactEmailSet, false);
});

test("draftInfoView: a wrong-typed stored value reads as empty and never throws", () => {
  const view = draftInfoView(inv({
    info: {
      email: 5, phone: 555, sat: "1450", gpaWeighted: { a: 1 }, firstGen: "yes", gender: "robot", birthday: "soon",
      collegesPlanned: null, intendedMajors: "Biology", highSchoolId: 7, highSchool: ["x"],
    },
  }));
  assert.equal(view.email, "ana@example.com");
  assert.equal(view.contactEmailSet, false);
  for (const key of ["phone", "sat", "gpaWeighted", "firstGen", "gender", "birthday", "collegesPlanned", "highSchoolId", "highSchool"] as const) {
    assert.equal(view[key], null, key);
  }
  assert.deepEqual(view.intendedMajors, []);
});

// The column check is `pg_column_size(info) <= 40000` (a sanity limit; a violation's DETAIL would quote the row into
// the log, so it must stay out of reach). The worst case is every field at its bound in a letter that takes 3 bytes
// (the schema counts UTF-16 units, the database bytes): measured 19187 bytes of JSON, 19292 as jsonb on the local
// stack (7172 with ASCII only). The test keeps it at 60% of the bound, so a schema bound that raises it fails here.
test("the largest info a counselor can store stays within 60% of the column's 40000-byte check (19187 bytes of JSON)", () => {
  const big = (max: number) => "中".repeat(max);
  const patch = draftInfoPatchSchema.parse({
    email: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`,
    phone: big(40), address: big(400), parentName: big(200), parentPhone: big(40),
    parentEmail: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}.com`,
    gender: "non-binary", birthday: "2009-12-31", citizenship: "permanent-resident", firstGen: false, livingWithParent: false,
    maritalStatus: "married", collegesPlanned: 99, highSchool: big(200), gradYear: "2027", gpaWeighted: 1000, gpaScale: "100",
    gpaUnweighted: 1000, classRank: big(80), sat: 1600, act: 36, rigor: big(300),
    intendedMajors: Array.from({ length: 10 }, () => big(80)), privateNote: big(4000),
  });
  // Every key the schema knows is present, so a field added to it fails here until it joins this fixture at its bound.
  assert.deepEqual(Object.keys(patch).sort(), Object.keys(draftInfoPatchSchema.shape).sort());
  const { set } = splitDraftPatch(patch, HS);
  const bytes = Buffer.byteLength(JSON.stringify(set));
  assert.ok(bytes <= 24000, `the largest info is ${bytes} bytes of JSON; keep it at 24000 or less (the column allows 40000 as jsonb)`);
});

/** A request whose invitations read answers `result`; `warned` collects what was logged. */
const countsRequest = (result: { data?: unknown; error?: { code: string } | null }, warned: unknown[] = []) =>
  ({
    auth: { userId: "c" },
    log: { warn: (o: unknown) => warned.push(o) },
    db: { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: null, ...result }) }) }) }) },
  }) as never;

test("infoCountsByInvitation: the key count of each draft, 0 for {}", async () => {
  const out = await infoCountsByInvitation(countsRequest({ data: [{ id: "a", info: { phone: "1", sat: 1400 } }, { id: "b", info: {} }] }), ["a", "b"]);
  assert.deepEqual([...(out ?? [])], [["a", 2], ["b", 0]]);
});

test("infoCountsByInvitation: a missing column is null without a warning; any other failure is null with one", async () => {
  const warned: unknown[] = [];
  assert.equal(await infoCountsByInvitation(countsRequest({ error: { code: "42703" } }, warned), ["a"]), null);
  assert.equal(await infoCountsByInvitation(countsRequest({ error: { code: "PGRST204" } }, warned), ["a"]), null);
  assert.deepEqual(warned, []);
  assert.equal(await infoCountsByInvitation(countsRequest({ error: { code: "57014" } }, warned), ["a"]), null);
  assert.deepEqual(warned, [{ code: "57014" }]);
});

test("infoCountsByInvitation: no ids is an empty map, not null", async () => {
  assert.equal((await infoCountsByInvitation(countsRequest({ error: { code: "42703" } }), []))?.size, 0);
});
