// POST /ai/meeting-summary: who may call it, and what it refuses before any model runs.
import { check, call, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const notes = "Met with Maya about her fall plan. She will retake the SAT in October and finish the activities list.";

const c = await user("sum-c");
const s = await studentOf(c, "sum-s");
const outsider = await user("sum-out");

const asStudent = await call(s.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes });
check("a student can't ask for a meeting summary", asStudent.status === 403, `status ${asStudent.status}`);

const asOutsider = await call(outsider.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes });
check("a counselor off the caseload is refused", asOutsider.status === 403 || asOutsider.status === 404, `status ${asOutsider.status}`);

const tooShort = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: "hi" });
check("notes that are too short are a 400", tooShort.status === 400, `status ${tooShort.status}`);

const extra = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes, sneaky: 1 });
check("unknown fields are refused", extra.status === 400, `status ${extra.status}`);

const huge = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: "x".repeat(20_001) });
check("notes over the cap are a 400", huge.status === 400, `status ${huge.status}`);

// With a key the call may succeed (200 draft); without one it is a 503. Never a 500, and never filed anywhere.
const ok = await call(c.token, "POST", "/ai/meeting-summary", { studentId: s.id, rawNotes: notes });
check(
  "a counselor's call is a draft or an unavailable answer, never a server error",
  (ok.status === 200 && ok.body.status === "draft" && typeof ok.body.summary === "string") || ok.status === 503 || ok.status === 502,
  `status ${ok.status} ${JSON.stringify(ok.body).slice(0, 120)}`
);
