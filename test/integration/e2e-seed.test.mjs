// The e2e seed (scripts/seed/e2e-stack.mjs) builds what the app's signed-in
// suite and the speed test rely on. Each helper is run here on a small scale
// and its result read back through the API as the persona would see it.
import { call, check } from "./harness.mjs";
import {
  createJoinInvite, createPersona, createStudents, rest, seedBillingScenario, seedFirm, seedHubEvents, seedOverviewExtras, seedPractice,
  seedRoster, signIn, todayInSeedZone,
} from "../../scripts/seed/e2e-stack.mjs";
import { BILLING_FAMILIES, BILLING_TOTALS } from "../../scripts/seed/billing-scenario.mjs";

const owner = await createPersona({ tag: "seedtest-owner", fullName: "Seed Owner" });
const member = await createPersona({ tag: "seedtest-member", fullName: "Seed Member" });
const billing = await createPersona({ tag: "seedtest-billing", fullName: "Seed Billing" });
const joiner = await createPersona({ tag: "seedtest-joiner", role: "student", fullName: "Seed Joiner" });

// ---- personas ----------------------------------------------------------------
const me = await call(owner.token, "GET", "/auth/me");
check("a seeded counselor is approved and onboarded", me.status === 200 && me.body?.role === "counselor", String(me.status));
check("a persona signs in with the password the seed prints", typeof (await signIn(member.email, member.password)) === "string");
const joinerMe = await call(joiner.token, "GET", "/auth/me");
check("a seeded student is a student", joinerMe.status === 200 && joinerMe.body?.role === "student");

// ---- firm ----------------------------------------------------------------------
const firmId = await seedFirm(owner, "Seed test firm", [member]);
const [ownerWs] = await rest(owner.token, "POST", "/rest/v1/rpc/crm_my_workspace", {});
const [memberWs] = await rest(member.token, "POST", "/rest/v1/rpc/crm_my_workspace", {});
check("the owner runs the firm as an admin", ownerWs.firm_id === firmId && ownerWs.is_admin === true);
check("the member is in the same firm and is not an admin", memberWs.firm_id === firmId && memberWs.is_admin === false);

// ---- roster ----------------------------------------------------------------------
const ids = createStudents(owner, 3, "seedtest");
check("createStudents puts three students on the roster", ids.length === 3, String(ids.length));
await seedRoster(owner, ids);
const students = await call(owner.token, "GET", "/students");
check("GET /students lists them", students.status === 200 && students.body.length === 3, String(students.body?.length));
const summaries = await call(owner.token, "GET", "/overview/student-summaries");
check("Overview summaries cover each student", summaries.status === 200 && summaries.body.length === 3);
const tasks = await call(owner.token, "GET", "/tasks");
check("each student has four tasks", tasks.status === 200 && tasks.body.length === 12, String(tasks.body?.length));
check("each task has an overdue step and one due this week", tasks.body.every?.((t) => (t.stages ?? []).length === 2) ?? false);
const work = await call(owner.token, "GET", "/work-items");
check("My Work Queue holds one item per student", work.status === 200 && work.body.filter((w) => w.studentId).length >= 3);
const pins = await call(owner.token, "GET", "/pins");
check("the first students are pinned", pins.status === 200 && pins.body.length === 3);
const [y, m] = todayInSeedZone().split("-").map(Number);
const monthStart = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const feed = await call(owner.token, "GET", `/calendar/feed?from=${monthStart}&to=${monthEnd}&tz=America/New_York`);
const meetings = (feed.body?.items ?? []).filter((i) => i.kind === "meeting");
check("each student has a meeting this month", feed.status === 200 && meetings.length === 3, String(meetings.length));
check("a meeting carries a second attendee", meetings.some((m) => m.attendeeIds.length === 2));

seedHubEvents();
await seedOverviewExtras(owner, { invites: 2 });
const building = await call(owner.token, "GET", "/invites/building");
check("two invitations wait on the Building profile cards", building.status === 200 && building.body.length === 2, String(building.body?.length));
const saves = await call(owner.token, "GET", `/events/calendar?from=${monthStart}&to=2100-01-01`);
check("the Meridies-wide listings are saved to the counselor's calendar", saves.status === 200 && saves.body.length >= 1, String(saves.body?.length));

// ---- practice --------------------------------------------------------------------
await seedPractice(owner, { contacts: 9, packages: 3, tasks: 6, assignees: [member], studentIds: ids });
const board = await call(owner.token, "GET", "/pipeline");
check("the pipeline holds the seeded contacts across its stages", board.status === 200 && board.body.contacts.length === 9 && new Set(board.body.contacts.map((c) => c.stageId)).size > 1);
const memberBoard = await call(member.token, "GET", "/pipeline");
check("the member shares the firm's pipeline", memberBoard.status === 200 && memberBoard.body.contacts.length === 9);
const pay = await call(owner.token, "GET", "/pipeline/payments");
check("three families are billed", pay.status === 200 && pay.body.accounts.length === 3);
const mgmt = await call(owner.token, "GET", "/management");
const taskCount = (mgmt.body?.consultants ?? []).reduce((n, c) => n + c.tasks.length, 0);
check("Management shows both consultants and the seeded tasks", mgmt.status === 200 && mgmt.body.consultants.length === 2 && taskCount === 6, `${mgmt.body?.consultants?.length} ${taskCount}`);

// ---- billing scenario ------------------------------------------------------------
const contacts = await seedBillingScenario(billing);
const ledger = await call(billing.token, "GET", "/pipeline/payments");
check("the billing counselor's tracker holds exactly the two families", ledger.status === 200 && ledger.body.accounts.length === 2);
check("the totals strip matches the hand-worked figures", JSON.stringify(ledger.body.totals) === JSON.stringify(BILLING_TOTALS), JSON.stringify(ledger.body.totals));
for (const fam of BILLING_FAMILIES) {
  const a = ledger.body.accounts.find((x) => x.contactId === contacts[fam.key]);
  const e = fam.expected;
  check(`family ${fam.key}: ${e.status}, balance ${e.balanceCents}, overdue ${e.overdueCents}`,
    a && a.status === e.status && a.balanceCents === e.balanceCents && a.overdueCents === e.overdueCents && a.billedCents === e.billedCents
      && JSON.stringify(a.invoices.map((i) => i.state)) === JSON.stringify(e.invoiceStates),
    JSON.stringify(a && { status: a.status, balance: a.balanceCents, overdue: a.overdueCents, states: a.invoices.map((i) => i.state) }));
}
const famA = ledger.body.accounts.find((x) => x.contactId === contacts.A);
const voided = await call(billing.token, "POST", `/pipeline/invoices/${famA.invoices[1].id}/void`, {});
const after = BILLING_FAMILIES[0].expected.afterVoidingSecond;
check("voiding family A's second invoice leaves them paid up with a credit",
  voided.status === 200 && voided.body.status === after.status && voided.body.balanceCents === after.balanceCents, JSON.stringify({ s: voided.status, st: voided.body?.status, b: voided.body?.balanceCents }));

// ---- contact invitation ------------------------------------------------------------
const join = await createJoinInvite(owner, joiner);
const preview = await rest(joiner.token, "POST", "/rest/v1/rpc/invitation_preview", { p_token: join.token });
check("the joiner's invitation token previews", preview !== null);
await rest(joiner.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: join.token });
const linked = await call(owner.token, "GET", "/pipeline");
const contact = linked.body.contacts.find((c) => c.id === join.contactId);
check("accepting links the contact to the new student", contact?.conversion === "joined" && contact?.studentId === joiner.id, JSON.stringify(contact && { c: contact.conversion, s: contact.studentId }));
