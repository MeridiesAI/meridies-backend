// Import pipeline step 2: the security review's findings, each reproduced
// through the real API (fails before the fix, passes after).
// - A small XLSX whose cells all share one string: refused in the parse
//   child, and the API stays up.
// - An import's files share one character budget, at registration and again
//   at staging.
// - A file with no header row: its first student's row is stored, and would
//   reach the model, only as shapes.
// - The invitation review holds per counselor: splitting a list, or saving a
//   one-row import first, doesn't get past it.
// - A parent's address shared by siblings across two imports: the second
//   sibling isn't invited there, and sending refuses it, so the first
//   sibling's invitation stays live and their data stays theirs.
import { strToU8, zipSync } from "fflate";
import { API, call, check, rest, sql, user } from "./harness.mjs";
import { addImportFile, enc, stagedImport, waitStatus } from "./imports-helpers.mjs";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const tag = Date.now();
const mail = (n) => `${n}-${tag}@test.local`;

function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** rows x cols cells, every one the shared string at index 0. */
function sharedStringBomb(rows, cols, text) {
  const header = `<row r="1">${Array.from({ length: cols }, (_, j) => `<c r="${colName(j)}1" t="inlineStr"><is><t>H${j}</t></is></c>`).join("")}</row>`;
  const body = [header];
  for (let i = 2; i <= rows + 1; i++) {
    let r = `<row r="${i}">`;
    for (let j = 0; j < cols; j++) r += `<c r="${colName(j)}${i}" t="s"><v>0</v></c>`;
    body.push(r + "</row>");
  }
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdSS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${text}</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join("")}</sheetData></worksheet>`),
  });
}

const health = async () => (await fetch(`${API}/health`)).status;
const commit = async (u, id, n) => {
  const r = await call(u.token, "POST", `/imports/${id}/commit`, { invitations: n });
  if (r.status !== 202) throw new Error("commit " + JSON.stringify(r.body));
  return waitStatus(u.token, id, "committing");
};
const sendAll = async (u, id) => {
  const outs = [];
  for (let i = 0; i < 6; i++) {
    const r = await call(u.token, "POST", `/imports/${id}/invitations`);
    outs.push(r);
    if (r.status !== 200 || r.body.held || r.body.remaining === 0) break;
  }
  return outs;
};
const roster = (prefix, n) => ["Email,Name,SAT", ...Array.from({ length: n }, (_, i) => `${mail(`${prefix}${i}`)},${prefix.toUpperCase()} Student${String.fromCharCode(65 + (i % 26))}${i},1200`)].join("\n");

// ---- the shared-string fan-out ------------------------------------------------------------
const c = await user("imp2-sec");
const imp = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
const bomb = sharedStringBomb(5000, 300, "A".repeat(1000));
check("the crafted workbook is small", bomb.length < 5 * 1024 * 1024, String(bomb.length));
const bombed = await addImportFile(c, imp, "roster.xlsx", bomb, XLSX);
check("a workbook whose cells all share one string is refused as too large when unpacked",
  bombed.status === 200 && bombed.body.status === "failed" && /too large when unpacked/.test(bombed.body.error ?? ""), `${bombed.status} ${JSON.stringify(bombed.body).slice(0, 200)}`);
check("the API is still up", (await health()) === 200);
const after = await addImportFile(c, imp, "small.csv", enc("Email,Name\njane@x.org,Jane Doe\n"));
check("and the next file registers as usual", after.status === 200 && after.body.status === "profiled", JSON.stringify(after.body).slice(0, 200));

// ---- one character budget per import --------------------------------------------------------
const longRows = (prefix, n, width) => ["Email,Name,SAT,Notes", ...Array.from({ length: n }, (_, i) => `${prefix}${i}@x.org,Name ${i},1200,${"x".repeat(width)}`)].join("\n");
const big = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
const f1 = await addImportFile(c, big, "one.csv", enc(longRows("a", 2000, 1500)));
const f2 = await addImportFile(c, big, "two.csv", enc(longRows("b", 2000, 1500)));
const f3 = await addImportFile(c, big, "three.csv", enc(longRows("c", 1000, 2000)));
check("files within the budget register", f1.body?.status === "profiled" && f2.body?.status === "profiled", `${JSON.stringify(f1.body).slice(0, 150)} ${JSON.stringify(f2.body).slice(0, 150)}`);
check("a file that takes the import over its character budget is refused by name",
  f3.body?.status === "failed" && /three\.csv would make this import too large/.test(f3.body.error ?? ""), JSON.stringify(f3.body).slice(0, 200));

// Staging holds every file at once, so it checks the same total again: a
// count that registration didn't see (pre-fix rows, or two registrations at
// once) is caught there.
const staged = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
for (const [name, text] of [["one.csv", longRows("d", 2000, 1500)], ["two.csv", longRows("e", 2000, 1500)], ["three.csv", longRows("f", 1000, 2000)]]) {
  const r = await addImportFile(c, staged, name, enc(text));
  check(`${name} registers while the earlier counts are hidden`, r.body?.status === "profiled", JSON.stringify(r.body).slice(0, 200));
  await sql(`update public.import_files set profile = profile - 'chars' where import_id = '${staged}'`);
}
const plan = await call(c.token, "POST", `/imports/${staged}/plan`);
check("the plan is made", plan.status === 200, JSON.stringify(plan.body).slice(0, 200));
const stage = await call(c.token, "POST", `/imports/${staged}/stage`);
check("staging refuses files that together pass the budget", stage.status === 400 && /would make this import too large/.test(stage.body.error ?? ""), `${stage.status} ${JSON.stringify(stage.body).slice(0, 200)}`);
check("and the import goes back to mapping", (await sql(`select status from public.roster_imports where id = '${staged}'`)) === "mapping");

// ---- a file with no header row ------------------------------------------------------------------
const headless = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
const first = ["jane doe", "2008-05-14", "(555) 123-4567", "12 Oak Lane", "jane.doe"];
const noHeader = await addImportFile(c, headless, "dump.csv", enc([
  first.join(","),
  "john roe,2007-11-02,(555) 987-6543,4 Elm Street,john.roe",
  "ann lee,2008-01-30,(555) 222-3333,9 Pine Road,ann.lee",
].join("\n")));
check("the file registers", noHeader.body?.status === "profiled", JSON.stringify(noHeader.body).slice(0, 200));
const masked = await sql(`select string_agg(c ->> 'maskedHeader', '|' order by (c ->> 'index')::int) from public.import_files f, jsonb_array_elements(f.profile -> 'sheets' -> 0 -> 'columns') c where f.import_id = '${headless}'`);
check("no cell of the first student's row is kept for the model", first.every((v) => !masked.toLowerCase().includes(v.toLowerCase())), masked);
check("each is kept as its shape", masked === "<text, 2 words, lowercase>|<date>|<phone>|<text, 3 words, capitalized, with digits>|<text, 1 word, lowercase>", masked);

// ---- the invitation review counts per counselor ----------------------------------------------------
// Split: 20 invitations, then 31 more. Each import alone is under 50.
const split = await user("imp2-sec-split");
const s1 = await stagedImport(split, roster("spa", 20));
await commit(split, s1.id, 20);
const s1sent = await sendAll(split, s1.id);
check("the first 20 go out", s1sent.every((r) => r.status === 200 && !r.body.held) && s1sent.reduce((n, r) => n + r.body.sent + r.body.failed, 0) === 20, JSON.stringify(s1sent.map((r) => r.body)));
const s2 = await stagedImport(split, roster("spb", 31));
await commit(split, s2.id, 31);
const s2send = await call(split.token, "POST", `/imports/${s2.id}/invitations`);
check("31 more, 51 in all: they wait for Meridies", s2send.status === 200 && s2send.body.held === true && /quick check/.test(s2send.body.reason ?? ""), JSON.stringify(s2send.body));
check("nothing of the second import went out", (await sql(`select count(*) from public.import_items where import_id = '${s2.id}' and invitation_id is not null`)) === "0");
check("the hold is recorded on the import", (await sql(`select coalesce(invites_held_reason, '') from public.roster_imports where id = '${s2.id}'`)) === "first-import-review");
check("the history says so", (await call(split.token, "GET", "/imports")).body.imports.find((i) => i.id === s2.id)?.invitations.held === true);
await sql(`update public.roster_imports set invites_approved_at = now() where id = '${s2.id}'`);
const released = await call(split.token, "POST", `/imports/${s2.id}/invitations`);
check("approved, they go out", released.status === 200 && !released.body.held && released.body.sent + released.body.failed === 25, JSON.stringify(released.body));
const s3 = await stagedImport(split, roster("spc", 2));
await commit(split, s3.id, 2);
check("once Meridies has approved one, later imports aren't held", (await sql(`select coalesce(invites_held_reason, '') from public.roster_imports where id = '${s3.id}'`)) === "");

// Seed: a one-row import first, then 51.
const seed = await user("imp2-sec-seed");
const t1 = await stagedImport(seed, roster("sda", 1));
await commit(seed, t1.id, 1);
await sendAll(seed, t1.id);
const t2 = await stagedImport(seed, roster("sdb", 51));
await commit(seed, t2.id, 51);
const t2send = await call(seed.token, "POST", `/imports/${t2.id}/invitations`);
check("saving a one-row import first doesn't skip the review", t2send.status === 200 && t2send.body.held === true, JSON.stringify(t2send.body));
check("nothing of it went out", (await sql(`select count(*) from public.import_items where import_id = '${t2.id}' and invitation_id is not null`)) === "0");

// ---- siblings on a parent's address, across two imports ------------------------------------------------
const fam = await user("imp2-sec-fam");
const parent = mail("parent");
const a = await stagedImport(fam, ["Email,Name,SAT", `${parent},Mia Park,1500`].join("\n"));
await commit(fam, a.id, 1);
await sendAll(fam, a.id);
const miaItem = await sql(`select id from public.import_items where import_id = '${a.id}'`);
const miaInv = await sql(`select invitation_id from public.import_items where id = '${miaItem}'`);
check("Mia is invited at the parent's address", miaInv !== "" && (await sql(`select status from public.invitations where id = '${miaInv}'`)) === "pending");

const b = await stagedImport(fam, ["Email,Name,SAT", `${parent},Leo Park,1100`].join("\n"));
check("a later import doesn't invite Leo at the address holding Mia's data", b.stage.status === 200 && b.stage.body.stats.toInvite === 0 && b.stage.body.stats.skipped === 1, JSON.stringify(b.stage.body.stats));
const leo = (await call(fam.token, "GET", `/imports/${b.id}/review?section=skipped`)).body.items[0];
check("and says why", /already inviting this address for a different student/.test(leo?.skipReason ?? ""), JSON.stringify(leo));
const force = await call(fam.token, "PATCH", `/imports/${b.id}/review`, { items: { [leo.itemId]: { action: "invite" } } });
check("review can't invite him there either", force.status === 409, `${force.status} ${JSON.stringify(force.body)}`);

// An item already set to be invited there (staged before this check, or by
// a firm admin who can't read the uploader's invitations) is refused when
// sending, before Mia's invitation is touched.
await sql(`update public.import_items set match_status = 'new_invite', skip_reason = null, invite_state = 'unsent' where id = '${leo.itemId}'`);
await commit(fam, b.id, 1);
const leoSend = await call(fam.token, "POST", `/imports/${b.id}/invitations`);
check("sending refuses Leo at that address", leoSend.status === 200 && leoSend.body.sent === 0 && leoSend.body.failed === 1 && /different student/.test(leoSend.body.reason ?? ""), JSON.stringify(leoSend.body));
check("Mia's invitation is still the live one", (await sql(`select status from public.invitations where id = '${miaInv}'`)) === "pending");
check("Leo's item is tied to no invitation", (await sql(`select coalesce(invitation_id::text, '') from public.import_items where id = '${leo.itemId}'`)) === "");
const tok = await sql(`select token from public.invitations where id = '${miaInv}'`);
const joined = await user("imp2-sec-mia", "student");
await sql(`update public.profiles set full_name = 'Mia Park' where id = '${joined.id}'`);
await rest(joined.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: tok });
const heldForMia = (await call(fam.token, "GET", "/imports/held")).body.filter((e) => e.studentId === joined.id);
check("only Mia's data waits for the account that joined", heldForMia.length === 1 && heldForMia[0].itemId === miaItem, JSON.stringify(heldForMia).slice(0, 300));
check("Leo's data is held for nobody", (await sql(`select coalesce(student_id::text, '') from public.import_items where id = '${leo.itemId}'`)) === "");

// The same student again (a re-import of Mia's row) still follows her address.
const again = await stagedImport(fam, ["Email,Name,SAT", `${mail("parent2")},Ana Diaz,1400`].join("\n"));
await commit(fam, again.id, 1);
await sendAll(fam, again.id);
const re = await stagedImport(fam, ["Email,Name,SAT", `${mail("parent2")},Ana Diaz,1450`].join("\n"));
check("re-importing the same student at her address still invites her", re.stage.body.stats.toInvite === 1, JSON.stringify(re.stage.body.stats));
