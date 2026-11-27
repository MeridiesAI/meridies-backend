// Tool-call evals: does AxIS pick the right tool, with the right key input, for a counselor's request? Most cases are
// perform_action, where one tool fronts the whole operation catalog (lib/axis/ops) and the model must name the
// operation. tool-calls.mjs runs them on the real model with a fixed, made-up context (no database, nothing is ever
// executed: lookups get the canned answers below); tool-call-score.mjs scores each run.
//
// A case:
//   id, say          the counselor's message
//   chat             "student" (a chat about Maya Chen, the default) or "roster" (no student selected)
//   mode             the turn's mode, as the router would set it (lib/axis/profiles.ts); default "action"
//   expect           { tool, input? } or a list of them (any one passes). `input` maps a path ("action", "input.title")
//                    to what it must be: a value (equal), a RegExp (tested on the value as a string), a function
//                    (true passes), or undefined (the key must be absent)
//   never            optional list of { tool, input? }: any such call fails the run (e.g. propose_action for a
//                    Work Queue item)
//   lookups          optional answers for `lookup` by its `what`, over LOOKUPS below

export const MAYA = "5b2d0c1e-0000-4000-8000-000000000001";
export const JORDAN = "5b2d0c1e-0000-4000-8000-000000000002";
export const PRIYA = "5b2d0c1e-0000-4000-8000-000000000003";

export const IDS = {
  deadlineSat: "d1000000-0000-4000-8000-000000000001",
  deadlineEssay: "d1000000-0000-4000-8000-000000000002",
  deadlineFafsa: "d1000000-0000-4000-8000-000000000003",
  taskResume: "7a000000-0000-4000-8000-000000000001",
  taskBrag: "7a000000-0000-4000-8000-000000000002",
  queueChens: "9e000000-0000-4000-8000-000000000001",
  listDuke: "5c000000-0000-4000-8000-000000000001",
  listMichigan: "5c000000-0000-4000-8000-000000000002",
  collegeTufts: "c0000000-0000-4000-8000-000000000001",
};

export const ROSTER = [
  { id: MAYA, name: "Maya Chen" },
  { id: JORDAN, name: "Jordan Alvarez" },
  { id: PRIYA, name: "Priya Raman" },
];

/** The student record a chat about Maya carries in its system prompt (a short, made-up one). */
export const RECORD = [
  "Maya Chen, class of 2027, Lincoln High School. Intended major: mechanical engineering.",
  "Academics: GPA 3.87 unweighted (4.0 scale), SAT 1480.",
  "College list: Duke (reach, RD, applying), University of Michigan (target, EA, applied), Northeastern (target, RD, interested).",
  "Open tasks: Resume (in progress, due in 9 days), Brag sheet (not started, due in 14 days).",
  "Deadlines: SAT registration (test, due in 6 days), Common App essay (essay, due in 20 days), FAFSA (financial, due in 30 days).",
].join("\n");

/** The roster summary a chat with no student selected carries. */
export const ROSTER_TEXT = [
  "Maya Chen (2027): 2 open tasks, 3 deadlines in the next three weeks.",
  "Jordan Alvarez (2026): 1 overdue task, Early Decision application due in 5 days.",
  "Priya Raman (2027): no open work, last activity 24 days ago.",
].join("\n");

/** Canned `lookup` answers, by `what`. Anything not here answers "Nothing found." */
export const LOOKUPS = {
  "deadlines.list": [
    `id ${IDS.deadlineSat}: SAT registration (test), due in 6 days`,
    `id ${IDS.deadlineEssay}: Common App essay (essay), due in 20 days`,
    `id ${IDS.deadlineFafsa}: FAFSA (financial), due in 30 days`,
  ].join("\n"),
  "tasks.list": [`id ${IDS.taskResume}: Resume [in-progress], due in 9 days`, `id ${IDS.taskBrag}: Brag sheet [not-started], due in 14 days`].join("\n"),
  "work_queue.list": `id ${IDS.queueChens}: Call the Chens about ED [open]`,
  "college_list.list": [
    `student_college_id ${IDS.listDuke}: Duke University (reach, RD, applying)`,
    `student_college_id ${IDS.listMichigan}: University of Michigan (target, EA, applied)`,
  ].join("\n"),
  "colleges.find": `college_id ${IDS.collegeTufts}: Tufts University (Medford, MA)`,
  "students.archived": "No archived students.",
  "pins.list": "No pinned students.",
};

const write = (action, input = {}) => ({ tool: "perform_action", input: { action, ...prefix(input) } });
const read = (what) => ({ tool: "lookup", input: { what } });
const prefix = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`input.${k}`, v]));
const between = (lo, hi) => (v) => typeof v === "number" && v >= lo && v <= hi;
const NO_WRITE = { tool: "perform_action" };
const NO_PROPOSAL = { tool: "propose_action" };

export const TOOL_CASES = [
  // ---- Reads: the right read tool, and nothing changed ----
  { id: "rank-this-week", chat: "roster", mode: "roster", say: "Who's behind this week?", expect: { tool: "rank_caseload", input: { days: between(5, 8) } }, never: [NO_WRITE] },
  { id: "rank-default", chat: "roster", mode: "roster", say: "Which students need my attention most right now?", expect: { tool: "rank_caseload" }, never: [NO_WRITE] },
  { id: "rank-month", chat: "roster", mode: "roster", say: "Rank my caseload by urgency for the next month.", expect: { tool: "rank_caseload", input: { days: between(28, 31) } }, never: [NO_WRITE] },
  { id: "rank-top-three", chat: "roster", mode: "roster", say: "Give me the top 3 students I should worry about.", expect: { tool: "rank_caseload", input: { limit: 3 } }, never: [NO_WRITE] },
  { id: "upcoming-roster", chat: "roster", mode: "roster", say: "What's due across my whole roster in the next 10 days?", expect: { tool: "list_upcoming", input: { days: 10 } }, never: [NO_WRITE] },
  { id: "upcoming-student", mode: "record", say: "What does Maya have coming up over the next three weeks, meetings included?", expect: { tool: "list_upcoming", input: { days: between(20, 22) } }, never: [NO_WRITE] },
  {
    id: "other-student-record", chat: "roster", mode: "record", say: "Pull up Jordan Alvarez's test scores.",
    expect: [{ tool: "find_student", input: { name: /jordan/i } }, { tool: "get_student_record", input: { student_id: JORDAN } }], never: [NO_WRITE],
  },
  { id: "college-stats", mode: "colleges", say: "What's Bowdoin's acceptance rate?", expect: { tool: "search_colleges", input: { query: /bowdoin/i } }, never: [NO_WRITE] },
  { id: "college-state", chat: "roster", mode: "colleges", say: "Find engineering schools in California.", expect: { tool: "search_colleges", input: { states: (v) => Array.isArray(v) && v.includes("CA") } }, never: [NO_WRITE] },
  { id: "transcript-grade", mode: "documents", say: "What grade did Maya get in AP Chemistry on her transcript?", expect: { tool: "search_documents", input: { query: /chem/i } }, never: [NO_WRITE] },
  {
    id: "record-section", mode: "record", say: "Show me where Maya's essays stand.",
    expect: [{ tool: "get_student_record", input: { sections: (v) => Array.isArray(v) && v.includes("essays") } }, read("essays.list")], never: [NO_WRITE],
  },

  // ---- Email drafts: propose_action, never a send ----
  {
    id: "email-parents", mode: "action", say: "Draft an email to Maya's parents reminding them the CSS Profile is due Friday.",
    expect: { tool: "propose_action", input: { type: "email_draft", to: (v) => v === undefined || v === "parents" } }, never: [write("messages.send"), write("blasts.send")],
  },
  {
    id: "email-student", mode: "action", say: "Write Maya an email nudging her to finish her activity list.",
    expect: { tool: "propose_action", input: { type: "email_draft", to: "student" } }, never: [write("messages.send")],
  },

  // ---- My Work Queue: perform_action work_queue.*, never a proposal ----
  { id: "queue-add", say: "Add 'call the Chens about ED' to my work queue for Thursday.", expect: write("work_queue.add", { title: /chen/i }), never: [NO_PROPOSAL] },
  { id: "queue-remind", say: "Remind me to check on Maya's recommendation letters next Monday.", expect: write("work_queue.add", { title: /rec/i }), never: [NO_PROPOSAL] },
  { id: "queue-done", say: "Mark my 'call the Chens' queue item done.", expect: write("work_queue.update", { item_id: IDS.queueChens, done: true }), never: [NO_PROPOSAL] },

  // ---- Deadlines ----
  { id: "deadline-create", say: "Add a deadline for Maya: Stanford REA application due November 1.", expect: write("deadlines.create", { title: /stanford/i, type: "application" }) },
  { id: "deadline-move", say: "Push Maya's SAT registration deadline to December 5.", expect: write("deadlines.update", { deadline_id: IDS.deadlineSat, due_date: /-12-05$/ }) },
  { id: "deadline-delete", say: "Delete the Common App essay deadline.", expect: write("deadlines.delete", { deadline_id: IDS.deadlineEssay }) },
  { id: "deadline-done", say: "Mark the FAFSA deadline done.", expect: write("deadlines.update", { deadline_id: IDS.deadlineFafsa, done: true }) },

  // ---- Tasks ----
  { id: "task-create", say: "Assign Maya a task to draft her UC PIQs by December 1.", expect: write("tasks.create", { title: /PIQ|UC|personal insight/i }) },
  { id: "task-complete", say: "Mark Maya's resume task complete.", expect: write("tasks.update", { task_id: IDS.taskResume, status: "complete" }) },
  { id: "task-delete", say: "Delete the brag sheet task.", expect: write("tasks.delete", { task_id: IDS.taskBrag }) },

  // ---- College list ----
  { id: "list-add", say: "Add Tufts to Maya's college list as a target, applying ED.", expect: write("college_list.add", { fit: "target" }) },
  { id: "list-remove", say: "Take Duke off Maya's list.", expect: write("college_list.remove", { student_college_id: IDS.listDuke }) },
  { id: "list-accepted", say: "Mark Michigan as accepted on Maya's list.", expect: write("college_list.set_status", { student_college_id: IDS.listMichigan, status: "accepted" }) },

  // ---- Record ----
  { id: "sat-update", say: "Update Maya's SAT to 1510.", expect: write("students.update_academics", { sat: 1510 }) },
  { id: "test-score", say: "Add Maya's AP Biology score: a 5, taken May 2026.", expect: write("test_scores.create", { exam: /biology/i, score: (v) => String(v) === "5" }) },
  { id: "course-add", say: "Add AP Physics C to Maya's courses, in progress.", expect: write("courses.create", { name: /physics/i, status: "in-progress" }) },
  { id: "status-at-risk", say: "Mark Maya as at risk.", expect: write("students.set_status", { status: "at-risk" }) },
  { id: "activity-add", say: "Add an activity for Maya: robotics club captain, 10 hours a week, grades 10 to 12.", expect: write("application.add_activity", { position: /captain/i }) },
  { id: "fafsa-submitted", say: "Mark Maya's FAFSA as submitted.", expect: write("aid.update_forms", { fafsa_status: "submitted" }) },

  // ---- Meetings, notes, flags ----
  { id: "meeting-create", say: "Schedule a 30-minute Zoom with Maya next Tuesday at 4pm Eastern.", expect: write("meetings.create", { mode: "zoom" }) },
  { id: "meeting-note", say: "Log a meeting note: today we talked through her Early Decision options.", expect: write("meeting_notes.create") },
  { id: "red-flag", say: "Raise a red flag for Maya: she hasn't started her supplements.", expect: write("accountability.raise_red_flag", { title: /supplement/i }) },
  { id: "pin", say: "Pin Maya to my overview.", expect: write("pins.pin") },
  { id: "archive-other", chat: "roster", say: "Archive Jordan Alvarez.", expect: write("students.archive", { student_id: JORDAN }) },

  // ---- Communication and roster-wide ----
  { id: "text-student", say: "Text Maya: don't forget your interview tomorrow at 3.", expect: write("messages.send", { channel: "sms", audience: "student" }), never: [NO_PROPOSAL] },
  { id: "blast-class", chat: "roster", say: "Send an email blast to the class of 2027 about the summer program fair on May 2.", expect: write("blasts.send", { audience_kind: "class-year" }) },
  { id: "invite", chat: "roster", say: "Invite sam.lee@example.com as a new student.", expect: write("invites.create", { email: "sam.lee@example.com" }) },
  { id: "calendar-event", chat: "roster", say: "Put a college fair on my calendar for March 3.", expect: write("calendar.create_event", { title: /fair/i }) },
];
