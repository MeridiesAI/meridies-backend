// AxIS operations end to end: a change AxIS filed is run by the counselor's
// Confirm through the real routes (and RLS), an executed change is put back by
// Undo, and nobody but the owner can do either. No model is called: the
// proposals are written the way perform_action writes them.
import { user, call, check, sql, rest } from "./harness.mjs";

const c = await user("axis-ops-counselor");
const s = await user("axis-ops-student", "student");
await sql(`update profiles set counselor_id='${c.id}' where id='${s.id}'`);
const other = await user("axis-ops-other");
const stranger = await user("axis-ops-stranger", "student");
await sql(`update profiles set counselor_id='${other.id}' where id='${stranger.id}'`);

const conv = await call(c.token, "POST", "/chat/conversations", { studentId: s.id, tool: "axis" });
check("conversation created", conv.status === 201, `status ${conv.status} ${JSON.stringify(conv.body).slice(0, 120)}`);
const convId = conv.body.id;

/** What perform_action writes for a change that waits on Confirm. */
async function propose(op, input, studentId = s.id, status = "pending", result) {
  const r = await rest(c.token, "POST", "/rest/v1/axis_actions", {
    conversation_id: convId,
    student_id: studentId,
    type: "operation",
    status,
    payload: { op, area: "Test", summary: `Test ${op}`, details: [], warning: null, reason: null, input },
    ...(result ? { result } : {}),
  }, { Prefer: "return=representation" });
  if (r.status !== 201) throw new Error(`propose ${op}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}

// ---- Confirm runs the change ------------------------------------------------------------
const dl = await call(c.token, "POST", "/deadlines", { studentId: s.id, title: "Common App EA", type: "application", dueDate: "2026-11-01" });
check("deadline created", dl.status === 201, `status ${dl.status}`);
const delId = await propose("deadlines.delete", { deadline_id: dl.body.id });

const listed = await call(c.token, "GET", `/axis/actions?conversationId=${convId}&status=all`);
const row = Array.isArray(listed.body) ? listed.body.find((a) => a.id === delId) : null;
check("the card lists with its status", row?.payload?.status === "pending" && row?.type === "operation", JSON.stringify(row).slice(0, 200));
check("the stored input stays on the server", row && !("input" in row.payload));

const studentTry = await call(s.token, "POST", `/axis/actions/${delId}/confirm`, {});
check("a student can't confirm", studentTry.status === 403, `status ${studentTry.status}`);
const otherTry = await call(other.token, "POST", `/axis/actions/${delId}/confirm`, {});
check("another counselor can't confirm", otherTry.status === 409 || otherTry.status === 404, `status ${otherTry.status}`);
let still = await call(c.token, "GET", `/deadlines?studentId=${s.id}`);
check("nothing happened before Confirm", still.body.some((d) => d.id === dl.body.id));

const confirmed = await call(c.token, "POST", `/axis/actions/${delId}/confirm`, {});
check("Confirm runs it", confirmed.status === 200 && confirmed.body.status === "confirmed" && confirmed.body.result.ok === true, JSON.stringify(confirmed.body));
still = await call(c.token, "GET", `/deadlines?studentId=${s.id}&includeDone=true`);
check("the deadline is gone", !still.body.some((d) => d.id === dl.body.id));
const twice = await call(c.token, "POST", `/axis/actions/${delId}/confirm`, {});
check("a second Confirm is refused", twice.status === 409, `status ${twice.status}`);

// ---- Confirm re-checks everything ---------------------------------------------------------
const tampered = await propose("deadlines.delete", { deadline_id: dl.body.id, extra: "x" });
const t = await call(c.token, "POST", `/axis/actions/${tampered}/confirm`, {});
check("an input that no longer validates fails cleanly", t.status === 200 && t.body.status === "failed", JSON.stringify(t.body));

const notMine = await propose("deadlines.create", { student_id: stranger.id, title: "Sneaky", type: "test" }, null);
const nm = await call(c.token, "POST", `/axis/actions/${notMine}/confirm`, {});
check("a student off the roster is refused at Confirm", nm.status === 200 && nm.body.status === "failed", JSON.stringify(nm.body));
const strangerDl = await call(other.token, "GET", `/deadlines?studentId=${stranger.id}`);
check("and nothing was written for them", Array.isArray(strangerDl.body) && !strangerDl.body.some((d) => d.title === "Sneaky"));

const gone = await propose("deadlines.delete", { deadline_id: dl.body.id });
const g = await call(c.token, "POST", `/axis/actions/${gone}/confirm`, {});
check("a target that's already gone says so in words for the counselor", g.status === 200 && g.body.status === "failed" && /no longer exists/.test(g.body.result.message) && !/lookup|the counselor/i.test(g.body.result.message), JSON.stringify(g.body));

const unknown = await propose("nothing.here", {});
const u = await call(c.token, "POST", `/axis/actions/${unknown}/confirm`, {});
check("an operation that doesn't exist fails", u.status === 200 && u.body.status === "failed");

// ---- Undo puts it back --------------------------------------------------------------------------
const item = await call(c.token, "POST", "/work-items", { title: "Call the family", source: "AxIS" });
check("queue item created", item.status === 201);
const executed = await propose("work_queue.add", { title: "Call the family" }, null, "executed", { ok: true, undo: { op: "work_queue.delete", input: { item_id: item.body.id } } });
const undo = await call(c.token, "POST", `/axis/actions/${executed}/undo`, {});
check("Undo runs the reversal", undo.status === 200 && undo.body.status === "undone", JSON.stringify(undo.body));
const queue = await call(c.token, "GET", "/work-items?includeDone=true");
check("the item is gone", !queue.body.some((w) => w.id === item.body.id));
const again = await call(c.token, "POST", `/axis/actions/${executed}/undo`, {});
check("a second Undo is refused", again.status === 409, `status ${again.status}`);
const pendingUndo = await propose("deadlines.delete", { deadline_id: dl.body.id });
const pu = await call(c.token, "POST", `/axis/actions/${pendingUndo}/undo`, {});
check("a change that never ran can't be undone", pu.status === 409, `status ${pu.status}`);

// A crafted reversal is still only a catalog operation run as the counselor.
const evil = await propose("work_queue.add", { title: "x" }, null, "executed", { ok: true, undo: { op: "deadlines.delete", input: { deadline_id: "not-a-uuid" } } });
const ev = await call(c.token, "POST", `/axis/actions/${evil}/undo`, {});
check("a reversal that doesn't validate is refused", ev.status === 409, `status ${ev.status}`);

// ---- Dismiss ---------------------------------------------------------------------------------------
const toDismiss = await propose("deadlines.delete", { deadline_id: dl.body.id });
const d = await call(c.token, "POST", `/axis/actions/${toDismiss}/dismiss`, {});
check("Dismiss", d.status === 200 && d.body.status === "dismissed");
const afterDismiss = await call(c.token, "POST", `/axis/actions/${toDismiss}/confirm`, {});
check("a dismissed card can't be confirmed", afterDismiss.status === 409);

const all = await call(c.token, "GET", `/axis/actions?conversationId=${convId}&status=all`);
const statuses = new Set((all.body ?? []).map((a) => a.status));
check("status=all replays every state", ["confirmed", "failed", "undone", "dismissed"].every((x) => statuses.has(x)), [...statuses].join(","));
const noConv = await call(c.token, "GET", "/axis/actions?status=all");
check("status=all needs a conversation", noConv.status === 400, `status ${noConv.status}`);

// ---- "Remove a student": archive on Confirm, find them again, restore them ----------------------
const archiveCard = await propose("students.archive", { student_id: s.id });
const archived = await call(c.token, "POST", `/axis/actions/${archiveCard}/confirm`, {});
check("archiving a student runs on Confirm", archived.status === 200 && archived.body.status === "confirmed", JSON.stringify(archived.body));
const roster = await call(c.token, "GET", "/students");
check("they leave the roster", Array.isArray(roster.body) && !roster.body.some((r) => r.id === s.id));
const archivedList = await call(c.token, "GET", "/students?archived=true");
check("and are listed as archived", Array.isArray(archivedList.body) && archivedList.body.some((r) => r.id === s.id), JSON.stringify(archivedList.body).slice(0, 160));
const otherArchived = await call(other.token, "GET", "/students?archived=true");
check("only to their own counselor", Array.isArray(otherArchived.body) && !otherArchived.body.some((r) => r.id === s.id));
const restoreCard = await propose("students.unarchive", { student_id: s.id });
const restored = await call(c.token, "POST", `/axis/actions/${restoreCard}/confirm`, {});
check("restoring runs on Confirm", restored.status === 200 && restored.body.status === "confirmed", JSON.stringify(restored.body));
const back = await call(c.token, "GET", "/students");
check("and they are back on the roster", Array.isArray(back.body) && back.body.some((r) => r.id === s.id));
