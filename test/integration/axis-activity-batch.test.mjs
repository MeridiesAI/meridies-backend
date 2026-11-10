// The Activities sheet's batch routes (AxIS activity drafts): one card saves several rows, each answered on its
// own, and its Undo deletes only rows nobody edited since. Through the real routes and RLS.
import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("act-batch-counselor");
const s = await studentOf(c, "act-batch-student");
const other = await user("act-batch-other");
const stranger = await studentOf(other, "act-batch-stranger");

const sheet = async (studentId = s.id) => (await call(c.token, "GET", `/application/sheets?studentId=${studentId}`)).body?.activities ?? [];

// ---- A batch saves each row and answers per row, in order -------------------------------------
const two = await call(c.token, "POST", "/application/activities/batch", {
  studentId: s.id,
  rows: [
    { organization: "Code Club", position: "Cofounder", grade_levels: ["11"], timing: ["break"], hours_per_week: 6, weeks_per_year: 2 },
    { organization: "Debate Club", description: "Led the novice team to state finals." },
  ],
});
check("batch answers 200", two.status === 200, `status ${two.status} ${JSON.stringify(two.body).slice(0, 200)}`);
const results = two.body?.results ?? [];
check("one result per row, in order, each with its id", results.length === 2 && results.every((r) => r.ok && typeof r.id === "string"), JSON.stringify(results));
const rows = await sheet();
check("both rows are on the sheet", rows.length === 2 && rows.some((r) => r.organization === "Code Club") && rows.some((r) => r.organization === "Debate Club"));
check("a description is saved as sent", rows.find((r) => r.organization === "Debate Club")?.description === "Led the novice team to state finals.");

// ---- A row past the 30-row cap fails alone ---------------------------------------------------
const values = Array.from({ length: 27 }, (_, i) => `('${s.id}', 'Filler ${i}', 'Filler ${i}', ${i + 10})`).join(",");
await sql(`insert into public.activities (student_id, name, organization, sort_order) values ${values}`);
const capped = await call(c.token, "POST", "/application/activities/batch", {
  studentId: s.id,
  rows: [{ organization: "Row 30" }, { organization: "Row 31" }],
});
const capResults = capped.body?.results ?? [];
check("the 30th row saves, the 31st fails alone", capped.status === 200 && capResults[0]?.ok === true && capResults[1]?.ok === false && /at most 30 rows/.test(capResults[1]?.message ?? ""), JSON.stringify(capped.body).slice(0, 300));

// ---- A student the counselor can't edit is refused whole --------------------------------------
const before = Number(await sql(`select count(*) from public.activities where student_id = '${stranger.id}'`));
const refused = await call(c.token, "POST", "/application/activities/batch", { studentId: stranger.id, rows: [{ organization: "Sneaky" }] });
const after = Number(await sql(`select count(*) from public.activities where student_id = '${stranger.id}'`));
check("another counselor's student is refused", refused.status === 403 || refused.status === 404, `status ${refused.status}`);
check("nothing was written for them", before === after);

// ---- The batch delete removes only that student's rows ----------------------------------------
const theirs = await call(other.token, "POST", "/application/activities/batch", { studentId: stranger.id, rows: [{ organization: "Theirs" }] });
const theirId = theirs.body?.results?.[0]?.id;
const [codeId, debateId] = results.map((r) => r.id);
const del = await call(c.token, "DELETE", `/application/activities?studentId=${s.id}&ids=${codeId},${theirId}`);
check("batch delete answers 200 with what it deleted", del.status === 200 && del.body?.deleted === 1, `status ${del.status} ${JSON.stringify(del.body)}`);
check("their row is still there", Number(await sql(`select count(*) from public.activities where id = '${theirId}'`)) === 1);
check("my row is gone", Number(await sql(`select count(*) from public.activities where id = '${codeId}'`)) === 0);

// ---- With onlyUnedited, a row edited after it was saved is kept and listed ---------------------
// Make room under the cap first (the filler rows).
await sql(`delete from public.activities where student_id = '${s.id}' and organization like 'Filler%'`);
const fresh = await call(c.token, "POST", "/application/activities/batch", {
  studentId: s.id,
  rows: [{ organization: "Chess Club" }, { organization: "Art Club" }],
});
const [chessId, artId] = (fresh.body?.results ?? []).map((r) => r.id);
check("two more rows saved for the Undo check", typeof chessId === "string" && typeof artId === "string", JSON.stringify(fresh.body).slice(0, 200));
const edit = await call(c.token, "PATCH", `/application/activities/${artId}`, { position: "President" });
check("the counselor edited one of them", edit.status === 200, `status ${edit.status}`);
const undo = await call(c.token, "DELETE", `/application/activities?studentId=${s.id}&ids=${chessId},${artId}&onlyUnedited=true`);
check("only the unedited row is deleted", undo.status === 200 && undo.body?.deleted === 1, JSON.stringify(undo.body));
check("the edited row is listed by name", undo.body?.skipped?.length === 1 && undo.body.skipped[0].id === artId && undo.body.skipped[0].organization === "Art Club", JSON.stringify(undo.body));
check("the edited row is still on the sheet", Number(await sql(`select count(*) from public.activities where id = '${artId}'`)) === 1);
check("Debate Club was never touched", Number(await sql(`select count(*) from public.activities where id = '${debateId}'`)) === 1);

// ---- Bad bodies are refused before anything is written -----------------------------------------
const tooMany = await call(c.token, "POST", "/application/activities/batch", { studentId: s.id, rows: Array.from({ length: 11 }, (_, i) => ({ organization: `X${i}` })) });
check("more than 10 rows is a 400", tooMany.status === 400, `status ${tooMany.status}`);
const badIds = await call(c.token, "DELETE", `/application/activities?studentId=${s.id}&ids=not-a-uuid`);
check("ids must be uuids", badIds.status === 400, `status ${badIds.status}`);
