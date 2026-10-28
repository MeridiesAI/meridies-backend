// Contact Pipeline history and follow-ups (migration 20261028000003), as real
// accounts on a local Supabase against a running API (see harness.mjs).
//
//   S   a solo counselor (their own workspace)
//   A   owner of a firm, B a consultant in it, X a solo counselor elsewhere
//   Stu a student
//
// Checks: the timeline is written by triggers and can't be forged, edited or
// deleted; it follows the contact's workspace; billing entries show only to
// whoever may bill; follow-ups; lost and reopen; duplicates; conversion.
import { call, check, rest, sql, user } from "./harness.mjs";

const tag = Date.now();
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const email = (name) => `${name}-${tag}@families.test`;

async function joinFirm(firmId, u, seat = "counselor") {
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${u.id}', '${seat}') on conflict do nothing`);
  await sql(`update public.profiles set firm_id = '${firmId}' where id = '${u.id}'`);
}

const board = async (u) => (await call(u.token, "GET", "/pipeline")).body;
const stageNamed = (b, name) => b.stages.find((s) => s.name === name);
const timeline = async (u, contactId) => (await call(u.token, "GET", `/pipeline/contacts/${contactId}/activities?limit=200`)).body.activities ?? [];
const kinds = (list) => list.map((a) => a.kind);
const newContact = async (u, stageId, over = {}) => {
  const r = await call(u.token, "POST", "/pipeline/contacts", { stageId, studentName: "Ada Lovelace", ...over });
  if (r.status !== 201) throw new Error(`create contact ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const restRows = async (u, query) => {
  const r = await rest(u.token, "GET", `/rest/v1/pipeline_activities?${query}`);
  return { status: r.status, rows: Array.isArray(r.body) ? r.body : [] };
};

const S = await user("ph-solo");
const A = await user("ph-owner");
const B = await user("ph-member");
const X = await user("ph-outsider");
const Stu = await user("ph-student", "student");

const created = await call(A.token, "POST", "/firms", { name: `History firm ${tag}` });
check("the owner starts a firm", created.status === 201, JSON.stringify(created.body));
const firmId = created.body.firmId;
await joinFirm(firmId, B);

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------
const sBoard = await board(S);
check("history is switched on once the migration is in", sBoard.historyEnabled === true);
const inquiry = stageNamed(sBoard, "Inquiry received");
const followUpStage = stageNamed(sBoard, "Follow-up");

const c1 = await newContact(S, inquiry.id, { studentEmail: email("ada") });
check("a new contact reads as open, with no source or follow-ups", c1.status === "open" && c1.source === "" && c1.openFollowups === 0 && c1.nextFollowup === null && c1.lastContactedAt === null, JSON.stringify(c1));

// ---------------------------------------------------------------------------
// Timeline: written by triggers
// ---------------------------------------------------------------------------
let tl = await timeline(S, c1.id);
check("creating a contact writes a 'created' entry", kinds(tl).join() === "created", kinds(tl).join());
check("the entry records who did it", tl[0]?.actorId === S.id, JSON.stringify(tl[0]));

const moved = await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { stageId: followUpStage.id });
check("moving a contact succeeds", moved.status === 200, JSON.stringify(moved.body));
tl = await timeline(S, c1.id);
const move = tl.find((a) => a.kind === "stage_change");
check("a stage move is logged with both stage names", move?.meta?.from === "Inquiry received" && move?.meta?.to === "Follow-up", JSON.stringify(move));

const same = await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { stageId: followUpStage.id, nextStep: "Call Friday" });
tl = await timeline(S, c1.id);
check("an edit that doesn't change the stage logs no move", same.status === 200 && tl.filter((a) => a.kind === "stage_change").length === 1);

const layout = await call(S.token, "PUT", "/pipeline/layout", { layout: { [followUpStage.id]: [c1.id] } });
tl = await timeline(S, c1.id);
check("redrawing the layout without a move logs nothing", layout.status === 200 && tl.filter((a) => a.kind === "stage_change").length === 1, JSON.stringify(layout.body));

// ---------------------------------------------------------------------------
// Timeline: written by hand, and nothing else
// ---------------------------------------------------------------------------
const note = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/activities`, { kind: "note", body: "Mom prefers evenings." });
check("a note is added", note.status === 201 && note.body.kind === "note" && note.body.actorId === S.id, JSON.stringify(note.body));
let after = (await call(S.token, "GET", "/pipeline")).body.contacts.find((c) => c.id === c1.id);
check("a note is not contact: last_contacted_at stays empty", after.lastContactedAt === null);

const callLog = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/activities`, { kind: "call", body: "Left a voicemail." });
after = (await call(S.token, "GET", "/pipeline")).body.contacts.find((c) => c.id === c1.id);
check("a call sets last_contacted_at", callLog.status === 201 && after.lastContactedAt !== null);

for (const kind of ["stage_change", "created", "status", "converted", "invoice", "payment", "task", "invite"]) {
  const r = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/activities`, { kind, body: "forged" });
  check(`the API refuses a hand-written '${kind}' entry`, r.status === 400, String(r.status));
}
const blank = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/activities`, { kind: "note", body: "   " });
check("a blank note is refused", blank.status === 400, String(blank.status));

// Straight at PostgREST, as the counselor's own session.
const forgeKind = await rest(S.token, "POST", "/rest/v1/pipeline_activities", { contact_id: c1.id, kind: "stage_change", body: "x" });
check("PostgREST refuses a system kind", forgeKind.status >= 400, String(forgeKind.status));
const forgeActor = await rest(S.token, "POST", "/rest/v1/pipeline_activities", { contact_id: c1.id, kind: "note", body: "x", actor_id: X.id });
check("PostgREST refuses a chosen actor (column not granted)", forgeActor.status >= 400, String(forgeActor.status));
const forgeScope = await rest(S.token, "POST", "/rest/v1/pipeline_activities", { contact_id: c1.id, kind: "note", body: "x", firm_id: firmId });
check("PostgREST refuses a chosen workspace", forgeScope.status >= 400, String(forgeScope.status));
const blankDirect = await rest(S.token, "POST", "/rest/v1/pipeline_activities", { contact_id: c1.id, kind: "note", body: "" });
check("PostgREST refuses an empty note", blankDirect.status >= 400, String(blankDirect.status));
const noteId = note.body.id;
const edit = await rest(S.token, "PATCH", `/rest/v1/pipeline_activities?id=eq.${noteId}`, { body: "tidied" });
const body0 = await sql(`select body from public.pipeline_activities where id = '${noteId}'`);
check("a counselor can't edit the past", edit.status >= 400 && body0 === "Mom prefers evenings.", `${edit.status} ${body0}`);
const del = await rest(S.token, "DELETE", `/rest/v1/pipeline_activities?id=eq.${noteId}`);
const stillThere = await sql(`select count(*) from public.pipeline_activities where id = '${noteId}'`);
check("a counselor can't delete the past", del.status >= 400 && stillThere === "1", `${del.status} ${stillThere}`);
const ghost = await rest(S.token, "POST", "/rest/v1/pipeline_activities", { contact_id: "00000000-0000-0000-0000-000000000000", kind: "note", body: "x" });
check("an entry for a contact that doesn't exist is refused", ghost.status >= 400, String(ghost.status));

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------
const peek = await call(X.token, "GET", `/pipeline/contacts/${c1.id}/activities`);
check("another practice can't read the timeline", peek.status === 404, String(peek.status));
const poke = await call(X.token, "POST", `/pipeline/contacts/${c1.id}/activities`, { kind: "note", body: "hello" });
check("another practice can't add to it", poke.status === 404, String(poke.status));
const xRest = await restRows(X, `contact_id=eq.${c1.id}`);
check("PostgREST shows another practice nothing", xRest.rows.length === 0, JSON.stringify(xRest));
const xForge = await rest(X.token, "POST", "/rest/v1/pipeline_activities", { contact_id: c1.id, kind: "note", body: "hello" });
check("PostgREST refuses another practice's note", xForge.status >= 400, String(xForge.status));
const stuRest = await restRows(Stu, `contact_id=eq.${c1.id}`);
check("a student reads none of it", stuRest.rows.length === 0, JSON.stringify(stuRest));
const stuForge = await rest(Stu.token, "POST", "/rest/v1/pipeline_activities", { contact_id: c1.id, kind: "note", body: "hi" });
check("a student can't write to it", stuForge.status >= 400, String(stuForge.status));
const stuApi = await call(Stu.token, "GET", `/pipeline/contacts/${c1.id}/activities`);
check("the API keeps students out", stuApi.status === 403, String(stuApi.status));

// A firm shares one timeline.
const aBoard = await board(A);
const firmInquiry = stageNamed(aBoard, "Inquiry received");
const f1 = await newContact(A, firmInquiry.id, { studentName: "Grace Hopper", studentEmail: email("grace") });
const bSees = await timeline(B, f1.id);
check("a colleague in the firm reads the timeline", kinds(bSees).includes("created"), kinds(bSees).join());
const bNote = await call(B.token, "POST", `/pipeline/contacts/${f1.id}/activities`, { kind: "meeting", body: "Zoom with the family." });
check("a colleague can log on a firm contact", bNote.status === 201 && bNote.body.actorId === B.id && bNote.body.actorName !== null, JSON.stringify(bNote.body));
const aSees = await timeline(A, f1.id);
check("the entry names the colleague for the owner", aSees.some((a) => a.kind === "meeting" && a.actorName), JSON.stringify(aSees.map((a) => [a.kind, a.actorName])));
const firmOfEntry = await sql(`select firm_id from public.pipeline_activities where id = '${bNote.body.id}'`);
check("the entry is pinned to the contact's workspace by the database", firmOfEntry === firmId, firmOfEntry);

// ---------------------------------------------------------------------------
// Billing entries show only to whoever may bill
// ---------------------------------------------------------------------------
const pkg = await call(A.token, "PUT", `/pipeline/contacts/${f1.id}/package`, { packageName: "Full service", totalCents: 300000, installments: 3 });
check("the owner sets a package", pkg.status === 200, JSON.stringify(pkg.body));
const inv = await call(A.token, "POST", `/pipeline/contacts/${f1.id}/invoices`, { label: "Deposit", amountCents: 100000, dueOn: day(10), send: false });
check("the owner issues an invoice", inv.status === 201, JSON.stringify(inv.body));
const pay = await call(A.token, "POST", `/pipeline/contacts/${f1.id}/payments`, { amountCents: 50000, receivedOn: day(-1), method: "check" });
check("the owner records a payment", pay.status === 201, JSON.stringify(pay.body));

const aTl = await timeline(A, f1.id);
const invoiceEntry = aTl.find((a) => a.kind === "invoice");
const paymentEntry = aTl.find((a) => a.kind === "payment");
check("billing shows in the owner's timeline", invoiceEntry?.meta?.event === "issued" && invoiceEntry?.meta?.amountCents === 100000 && paymentEntry?.meta?.method === "check", kinds(aTl).join());
const bTl = await timeline(B, f1.id);
check("a colleague who can't bill doesn't see billing entries", !kinds(bTl).some((k) => k === "invoice" || k === "payment") && kinds(bTl).includes("meeting"), kinds(bTl).join());
const bRest = await restRows(B, `contact_id=eq.${f1.id}&kind=in.(invoice,payment)`);
check("PostgREST agrees", bRest.rows.length === 0, JSON.stringify(bRest));

const owner = await call(A.token, "PATCH", `/pipeline/contacts/${f1.id}`, { ownerId: B.id });
check("the owner hands the family to the colleague", owner.status === 200, JSON.stringify(owner.body));
const bTl2 = await timeline(B, f1.id);
check("the contact's owner can bill, so sees the billing entries", kinds(bTl2).includes("invoice") && kinds(bTl2).includes("payment"), kinds(bTl2).join());

const voided = await call(A.token, "POST", `/pipeline/invoices/${inv.body.account.invoices[0].id}/void`);
const aTl2 = await timeline(A, f1.id);
check("voiding an invoice is logged", voided.status === 200 && aTl2.some((a) => a.kind === "invoice" && a.meta?.event === "voided"), `${voided.status} ${JSON.stringify(voided.body)}`);

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------
const fu = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/followups`, { title: "Send the contract", dueOn: day(-2) });
check("a follow-up is added", fu.status === 201 && fu.body.title === "Send the contract" && fu.body.done === false, JSON.stringify(fu.body));
check("it is assigned to the counselor when the contact has no owner", fu.body.assigneeId === S.id);
check("a date in the past reads as overdue", fu.body.overdue === true);
const fu2 = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/followups`, { title: "Check in next month", dueOn: day(30) });
const fu3 = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/followups`, { title: "Whenever" });
check("later and undated follow-ups are added", fu2.status === 201 && fu3.status === 201 && fu3.body.dueOn === null);

const onBoard = (await board(S)).contacts.find((c) => c.id === c1.id);
check("the card carries the count and the one due first", onBoard.openFollowups === 3 && onBoard.nextFollowup?.title === "Send the contract" && onBoard.nextFollowup?.overdue === true, JSON.stringify(onBoard.nextFollowup));

const mine = await call(S.token, "GET", "/pipeline/followups/mine");
check("'mine' lists them, soonest first, with the family's name", mine.status === 200 && mine.body.followups[0]?.title === "Send the contract" && mine.body.followups[0]?.contactName === "Ada Lovelace", JSON.stringify(mine.body).slice(0, 300));

const done = await call(S.token, "PATCH", `/pipeline/followups/${fu.body.id}`, { done: true });
check("completing a follow-up marks it done with a time", done.status === 200 && done.body.done === true && done.body.doneAt !== null && done.body.overdue === false, JSON.stringify(done.body));
tl = await timeline(S, c1.id);
check("adding and completing are both logged", tl.filter((a) => a.kind === "task").map((a) => a.meta.event).sort().join() === "added,added,added,done", tl.filter((a) => a.kind === "task").map((a) => a.meta.event).join());
const reopen = await call(S.token, "PATCH", `/pipeline/followups/${fu.body.id}`, { done: false });
check("a follow-up can be reopened, which clears the time", reopen.body.done === false && reopen.body.doneAt === null);
await call(S.token, "PATCH", `/pipeline/followups/${fu.body.id}`, { done: true });
const afterDone = (await board(S)).contacts.find((c) => c.id === c1.id);
check("the card's next follow-up moves on", afterDone.openFollowups === 2 && afterDone.nextFollowup?.title === "Check in next month", JSON.stringify(afterDone.nextFollowup));

const list = await call(S.token, "GET", `/pipeline/contacts/${c1.id}/followups`);
check("the contact's list puts open ones first", list.body.followups.length === 3 && list.body.followups[2]?.done === true, JSON.stringify(list.body.followups.map((f) => [f.title, f.done])));

const retitle = await call(S.token, "PATCH", `/pipeline/followups/${fu2.body.id}`, { title: "Check in", dueOn: null });
check("a follow-up can be retitled and undated", retitle.body.title === "Check in" && retitle.body.dueOn === null);
const emptyTitle = await call(S.token, "POST", `/pipeline/contacts/${c1.id}/followups`, { title: "  " });
check("a follow-up needs words", emptyTitle.status === 400, String(emptyTitle.status));

const xPatch = await call(X.token, "PATCH", `/pipeline/followups/${fu.body.id}`, { done: false });
check("another practice can't touch it", xPatch.status === 404, String(xPatch.status));
const xList = await call(X.token, "GET", `/pipeline/contacts/${c1.id}/followups`);
check("or list it", xList.status === 404, String(xList.status));
const xDirect = await rest(X.token, "GET", `/rest/v1/pipeline_followups?contact_id=eq.${c1.id}`);
check("PostgREST shows another practice none", Array.isArray(xDirect.body) && xDirect.body.length === 0, JSON.stringify(xDirect.body));
const xPlant = await call(X.token, "POST", `/pipeline/contacts/${c1.id}/followups`, { title: "Plant" });
check("another practice can't plant one", xPlant.status === 404, String(xPlant.status));
const stuFu = await rest(Stu.token, "POST", "/rest/v1/pipeline_followups", { contact_id: c1.id, title: "Hi" });
check("a student can't write one", stuFu.status >= 400, String(stuFu.status));

// Assignees are consultants in the workspace.
const outsiderAssignee = await call(A.token, "POST", `/pipeline/contacts/${f1.id}/followups`, { title: "Nope", assigneeId: X.id });
check("a follow-up can't be assigned outside the practice", outsiderAssignee.status === 400, `${outsiderAssignee.status} ${JSON.stringify(outsiderAssignee.body)}`);
const colleague = await call(A.token, "POST", `/pipeline/contacts/${f1.id}/followups`, { title: "Send the welcome packet", dueOn: day(3), assigneeId: B.id });
check("or to a colleague in the firm", colleague.status === 201 && colleague.body.assigneeId === B.id, JSON.stringify(colleague.body));
const defaulted = await call(A.token, "POST", `/pipeline/contacts/${f1.id}/followups`, { title: "Follow up with parent" });
check("with no assignee it goes to the contact's owner", defaulted.status === 201 && defaulted.body.assigneeId === B.id, JSON.stringify(defaulted.body));
const bMine = await call(B.token, "GET", "/pipeline/followups/mine");
check("the colleague sees theirs under 'mine'", bMine.body.followups.some((f) => f.title === "Send the welcome packet" && f.contactName === "Grace Hopper"));
const reassign = await call(A.token, "PATCH", `/pipeline/followups/${colleague.body.id}`, { assigneeId: X.id });
check("reassigning outside the practice is refused too", reassign.status === 400, String(reassign.status));

const removed = await call(S.token, "DELETE", `/pipeline/followups/${fu3.body.id}`);
const gone = await call(S.token, "GET", `/pipeline/contacts/${c1.id}/followups`);
check("a follow-up can be deleted", removed.status === 204 && !gone.body.followups.some((f) => f.id === fu3.body.id));

// ---------------------------------------------------------------------------
// Lost and reopened
// ---------------------------------------------------------------------------
const lost = await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { status: "lost", lostReason: "Went with another consultant" });
check("a contact is marked lost with a reason", lost.status === 200 && lost.body.status === "lost" && lost.body.lostReason === "Went with another consultant", JSON.stringify(lost.body));
check("a lost contact leaves the board", !(await board(S)).contacts.some((c) => c.id === c1.id));
const lostList = await call(S.token, "GET", "/pipeline/lost");
check("and is listed under Lost", lostList.status === 200 && lostList.body.contacts.some((c) => c.id === c1.id));
const xLost = await call(X.token, "GET", "/pipeline/lost");
check("another practice's Lost list doesn't include it", xLost.status === 200 && !xLost.body.contacts.some((c) => c.id === c1.id));
tl = await timeline(S, c1.id);
const lostEntry = tl.find((a) => a.kind === "status");
check("the timeline records the change and the reason", lostEntry?.meta?.to === "lost" && lostEntry?.body === "Went with another consultant", JSON.stringify(lostEntry));
const reopened = await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { status: "open" });
check("reopening clears the reason", reopened.body.status === "open" && reopened.body.lostReason === "", JSON.stringify(reopened.body));
check("and puts the card back on the board", (await board(S)).contacts.some((c) => c.id === c1.id));
const stray = await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { lostReason: "stray" });
check("a reason on an open contact is dropped by the database", stray.status === 200 && stray.body.lostReason === "", JSON.stringify(stray.body));
const badStatus = await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { status: "archived" });
check("an unknown status is refused", badStatus.status === 400, String(badStatus.status));
const src = await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { source: "Referral: Dr. Lee" });
check("a source can be set", src.body.source === "Referral: Dr. Lee", JSON.stringify(src.body));
const forgeLastContact = await rest(S.token, "PATCH", `/rest/v1/pipeline_contacts?id=eq.${c1.id}`, { last_contacted_at: "2020-01-01T00:00:00Z" });
check("last_contacted_at isn't client-writable", forgeLastContact.status >= 400, String(forgeLastContact.status));

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------
const dup = await call(S.token, "POST", "/pipeline/contacts", { stageId: inquiry.id, studentName: "Ada L.", studentEmail: email("ada") });
check("the same student email is refused as a duplicate", dup.status === 409 && dup.body.code === "duplicate_contact", JSON.stringify(dup.body));
const dupParent = await call(S.token, "POST", "/pipeline/contacts", { stageId: inquiry.id, studentName: "Someone", parentEmail: email("ada") });
check("so is a parent address that matches a student's", dupParent.status === 409, JSON.stringify(dupParent.body));
const dupCase = await call(S.token, "POST", "/pipeline/contacts", { stageId: inquiry.id, studentName: "Ada", studentEmail: email("ada").toUpperCase() });
check("case doesn't hide a duplicate", dupCase.status === 409, JSON.stringify(dupCase.body));
const anyway = await call(S.token, "POST", "/pipeline/contacts", { stageId: inquiry.id, studentName: "Ada L.", studentEmail: email("ada"), allowDuplicate: true });
check("'add anyway' goes through", anyway.status === 201, JSON.stringify(anyway.body));
const xSame = await call(X.token, "POST", "/pipeline/contacts", { stageId: stageNamed(await board(X), "Inquiry received").id, studentName: "Ada", studentEmail: email("ada") });
check("another practice may have the same family", xSame.status === 201, JSON.stringify(xSame.body));
await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { status: "lost", lostReason: "x" });
const dupLost = await call(S.token, "POST", "/pipeline/contacts", { stageId: inquiry.id, studentName: "Ada", studentEmail: email("ada") });
check("a lost contact still counts, so it can be reopened instead", dupLost.status === 409, JSON.stringify(dupLost.body));
await call(S.token, "PATCH", `/pipeline/contacts/${c1.id}`, { status: "open" });

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
// Editing an address into one another card already has asks once.
const other = await newContact(S, inquiry.id, { studentName: "Other Family", studentEmail: email("other") });
const clash = await call(S.token, "PATCH", `/pipeline/contacts/${other.id}`, { studentEmail: email("ada") });
check("typing another card's email into this one is flagged", clash.status === 409 && clash.body.code === "duplicate_contact", JSON.stringify(clash.body));
const clashParent = await call(S.token, "PATCH", `/pipeline/contacts/${other.id}`, { parentEmail: email("ada") });
check("so is a parent address that matches a student's", clashParent.status === 409, JSON.stringify(clashParent.body));
const resave = await call(S.token, "PATCH", `/pipeline/contacts/${other.id}`, { studentEmail: email("other"), nextStep: "Call" });
check("saving the address a card already has never asks", resave.status === 200, JSON.stringify(resave.body));
const clashOk = await call(S.token, "PATCH", `/pipeline/contacts/${other.id}`, { studentEmail: email("ada"), allowDuplicate: true });
check("'keep anyway' saves it", clashOk.status === 200 && clashOk.body.studentEmail === email("ada"), JSON.stringify(clashOk.body));
await call(S.token, "PATCH", `/pipeline/contacts/${other.id}`, { studentEmail: email("other") });

const convStage = stageNamed(aBoard, "Booked");
const conv = await newContact(A, convStage.id, { studentName: "Student Stu", studentEmail: Stu.email });
const invited = await call(A.token, "POST", `/pipeline/contacts/${conv.id}/invite`);
check("the contact is invited", invited.status === 200 && invited.body.contact.invitationId, JSON.stringify(invited.body).slice(0, 300));
const convTl0 = await timeline(A, conv.id);
check("the invitation is logged", convTl0.some((a) => a.kind === "invite" && a.meta?.email === Stu.email), kinds(convTl0).join());

const token = await sql(`select token from public.invitations where id = '${invited.body.contact.invitationId}'`);
const acc = await rest(Stu.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: token });
check("the student accepts", acc.status === 200, JSON.stringify(acc.body));

const won = (await board(A)).contacts.find((c) => c.id === conv.id);
const activeStage = stageNamed(aBoard, "Active student");
check("the contact is now won and linked to the student", won?.status === "won" && won?.studentId === Stu.id && won?.conversion === "joined", JSON.stringify(won));
check("and moved to the Current group", won?.stageId === activeStage.id && won?.lifecycleGroup === "current", `${won?.stageId} ${won?.lifecycleGroup}`);
const convTl = await timeline(A, conv.id);
const toActive = convTl.find((a) => a.kind === "stage_change" && a.meta?.to === "Active student");
check("the move and the conversion are logged", toActive && convTl.some((a) => a.kind === "converted") && convTl.some((a) => a.kind === "status" && a.meta?.to === "won"), kinds(convTl).join());
const convDays = won?.daysInStage;
check("days in stage restarted", convDays === 0, String(convDays));
const stuAfter = await restRows(Stu, `contact_id=eq.${conv.id}`);
check("the student still can't read the timeline of their own contact", stuAfter.rows.length === 0, JSON.stringify(stuAfter));

// A practice with no Current stage keeps the card where it is.
const S2 = await user("ph-nocurrent");
const Stu2 = await user("ph-student2", "student");
const b2 = await board(S2);
const gone2 = await call(S2.token, "DELETE", `/pipeline/stages/${stageNamed(b2, "Active student").id}`);
check("a practice can delete its Current stage", gone2.status === 200, JSON.stringify(gone2.body));
const c2 = await newContact(S2, stageNamed(b2, "Booked").id, { studentName: "No Current", studentEmail: Stu2.email });
const inv2 = await call(S2.token, "POST", `/pipeline/contacts/${c2.id}/invite`);
const tok2 = await sql(`select token from public.invitations where id = '${inv2.body.contact.invitationId}'`);
const acc2 = await rest(Stu2.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: tok2 });
const won2 = (await board(S2)).contacts.find((c) => c.id === c2.id);
check("with nowhere to go, the contact is won but stays put", acc2.status === 200 && won2?.status === "won" && won2?.stageId === c2.stageId, JSON.stringify(won2));

// Contacts that already sit in Current stay where they are.
const c3 = await newContact(S, stageNamed(await board(S), "Active student").id, { studentName: "Already Active", studentEmail: email("active") });
check("a contact created in Current logs only its creation", kinds(await timeline(S, c3.id)).join() === "created");

// ---------------------------------------------------------------------------
// Deleting a contact takes its history and follow-ups with it
// ---------------------------------------------------------------------------
const c4 = await newContact(S, inquiry.id, { studentName: "Temporary", studentEmail: email("temp") });
await call(S.token, "POST", `/pipeline/contacts/${c4.id}/followups`, { title: "Soon" });
await call(S.token, "POST", `/pipeline/contacts/${c4.id}/activities`, { kind: "note", body: "x" });
const delC = await call(S.token, "DELETE", `/pipeline/contacts/${c4.id}`);
const orphans = await sql(`select (select count(*) from public.pipeline_activities where contact_id = '${c4.id}') + (select count(*) from public.pipeline_followups where contact_id = '${c4.id}')`);
check("deleting a contact removes its timeline and follow-ups", delC.status === 204 && orphans === "0", `${delC.status} ${orphans}`);

// ---------------------------------------------------------------------------
// The email route logs to the timeline
// ---------------------------------------------------------------------------
const mailed = await call(S.token, "POST", `/pipeline/contacts/${c3.id}/email`, { subject: "Hello {first}", body: "Welcome aboard.", to: ["student"] });
// c3's student email is a families.test address; delivery goes to the local mail catcher when configured.
tl = await timeline(S, c3.id);
check("a sent email is logged", mailed.status === 200 && (mailed.body.sentCount === 0 || tl.some((a) => a.kind === "email")), `${mailed.status} ${JSON.stringify(mailed.body)} ${kinds(tl).join()}`);

console.log(process.exitCode ? "\nSome checks FAILED" : "\nAll checks passed");
