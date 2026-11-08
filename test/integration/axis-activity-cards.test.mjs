// An activity card with several rows, end to end (AxIS activity drafts): Confirm keeps the rows the counselor
// ticked and answers each row's new id; Undo deletes only rows nobody edited since. No model is called: the card
// is written the way perform_action files it.
import { call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("act-cards-counselor");
const s = await studentOf(c, "act-cards-student");
const conv = await call(c.token, "POST", "/chat/conversations", { studentId: s.id, tool: "axis" });
check("conversation created", conv.status === 201, `status ${conv.status}`);
const convId = conv.body.id;

async function card(rows) {
  const r = await rest(c.token, "POST", "/rest/v1/axis_actions", {
    conversation_id: convId,
    student_id: s.id,
    type: "operation",
    status: "pending",
    payload: { op: "application.add_activities", area: "Application sheets", summary: "Add activities", details: [], warning: null, reason: null, input: { student_id: s.id, rows } },
  }, { Prefer: "return=representation" });
  if (r.status !== 201) throw new Error(`card: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}
const orgs = async () => (await call(c.token, "GET", `/application/sheets?studentId=${s.id}`)).body?.activities?.map((a) => a.organization).sort() ?? [];

// ---- Confirm keeps only the ticked rows, and answers their ids -------------------------------------
const first = await card([{ key: "r1", organization: "Code Club", hours_per_week: 6 }, { key: "r2", organization: "Debate Club", grade_levels: ["11"] }]);
const kept = await call(c.token, "POST", `/axis/actions/${first}/confirm`, { rows: ["r2"] });
check("confirm with rows answers 200", kept.status === 200 && kept.body?.status === "confirmed", JSON.stringify(kept.body).slice(0, 200));
const outcome = kept.body?.result?.rows ?? [];
check("the answer carries the kept row's id", outcome.length === 1 && outcome[0].key === "r2" && outcome[0].ok === true && typeof outcome[0].id === "string", JSON.stringify(outcome));
check("only the kept row is on the sheet", JSON.stringify(await orgs()) === JSON.stringify(["Debate Club"]), JSON.stringify(await orgs()));
const listed = (await call(c.token, "GET", `/axis/actions?conversationId=${convId}&status=all`)).body ?? [];
check("the card lists as confirmed", listed.find((a) => a.id === first)?.status === "confirmed");

const bad = await call(c.token, "POST", `/axis/actions/${await card([{ key: "r1", organization: "X" }])}/confirm`, { rows: ["r99"] });
check("a malformed row key is a 400", bad.status === 400, `status ${bad.status}`);

// ---- Undo keeps a row edited since it was saved, and names it -----------------------------------------
const second = await card([{ key: "r1", organization: "Chess Club" }, { key: "r2", organization: "Art Club" }]);
const both = await call(c.token, "POST", `/axis/actions/${second}/confirm`, {});
const [chess, art] = both.body?.result?.rows ?? [];
check("both rows saved", chess?.ok && art?.ok, JSON.stringify(both.body).slice(0, 200));
const edit = await call(c.token, "PATCH", `/application/activities/${art.id}`, { position: "President" });
check("the counselor edits one row", edit.status === 200, `status ${edit.status}`);
const undo = await call(c.token, "POST", `/axis/actions/${second}/undo`, {});
check("undo answers 200 and lists the kept row", undo.status === 200 && undo.body?.skipped?.length === 1 && undo.body.skipped[0].organization === "Art Club", JSON.stringify(undo.body));
check("the unedited row is gone, the edited one stays", JSON.stringify(await orgs()) === JSON.stringify(["Art Club", "Debate Club"]), JSON.stringify(await orgs()));
const after = ((await call(c.token, "GET", `/axis/actions?conversationId=${convId}&status=all`)).body ?? []).find((a) => a.id === second);
check("the card says what it kept", after?.status === "undone" && after?.payload?.message === "Undone, except Art Club: edited after it was saved.", JSON.stringify(after?.payload));

// ---- Every row edited: nothing is undone and the card keeps its Undo -------------------------------------
const third = await card([{ key: "r1", organization: "Solo Club" }]);
const solo = await call(c.token, "POST", `/axis/actions/${third}/confirm`, {});
await call(c.token, "PATCH", `/application/activities/${solo.body?.result?.rows?.[0]?.id}`, { position: "Founder" });
const none = await call(c.token, "POST", `/axis/actions/${third}/undo`, {});
check("all rows edited is a 409", none.status === 409 && /Every row was edited/.test(none.body?.error ?? ""), JSON.stringify(none.body));
check("the card is still confirmed", (await sql(`select status from public.axis_actions where id = '${third}'`)) === "confirmed");
