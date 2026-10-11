import { user, call, check, API } from "./harness.mjs";

const h = await (await fetch(API + "/health")).json();
// With a key configured the check must say it works; without one (CI), it must say false, not true.
check("health reports whether the key works", h.database === true && h.anthropic === Boolean(process.env.ANTHROPIC_API_KEY), JSON.stringify(h));
check("health reports that the schema this build needs is there", h.schema === true && h.status === "ok", JSON.stringify(h));

const c = await user("counselor-a");
const me = await call(c.token, "GET", "/auth/me");
check("counselor role", me.body?.role === "counselor", JSON.stringify(me.body).slice(0, 120));

// #3 punctuation in college search
for (const q of ["harvard;", "UC-Berkeley", "a,b)or(c", "%_", ";;;--", "St. John's", "Texas A&M", "São"]) {
  const r = await call(c.token, "GET", "/colleges/search?q=" + encodeURIComponent(q));
  check(`search ${JSON.stringify(q)} is not a 500`, r.status === 200, `status ${r.status} hits ${Array.isArray(r.body) ? r.body.length : "-"}`);
}
const harvard = await call(c.token, "GET", "/colleges/search?q=stanf");
check("search still finds schools", Array.isArray(harvard.body) && harvard.body.some((x) => /Stanford/.test(x.name)), harvard.body?.map?.((x) => x.name).join(", "));

// #8 contact name required
const board = await call(c.token, "GET", "/pipeline");
const stageId = board.body?.stages?.[0]?.id;
check("pipeline board loads with a stage", !!stageId, `status ${board.status}`);
const blank = await call(c.token, "POST", "/pipeline/contacts", { stageId });
check("blank contact rejected", blank.status === 400, `status ${blank.status}`);
const placeholder = await call(c.token, "POST", "/pipeline/contacts", { stageId, studentName: "New contact" });
check("placeholder name rejected", placeholder.status === 400, `status ${placeholder.status}`);
const ok = await call(c.token, "POST", "/pipeline/contacts", { stageId, studentName: "Jamie Rivera" });
check("named contact created", ok.status === 201, `status ${ok.status}`);
const badEmail = await call(c.token, "PATCH", `/pipeline/contacts/${ok.body.id}`, { studentEmail: "not-an-email" });
check("bad email rejected", badEmail.status === 400, `status ${badEmail.status}`);
const goodEmail = await call(c.token, "PATCH", `/pipeline/contacts/${ok.body.id}`, { studentEmail: "jamie@example.com", parentName: "Pat Rivera" });
check("email saved and returned", goodEmail.status === 200 && goodEmail.body.studentEmail === "jamie@example.com" && goodEmail.body.parentName === "Pat Rivera", JSON.stringify(goodEmail.body).slice(0, 160));
const reread = await call(c.token, "GET", "/pipeline");
check("edit persisted", reread.body.contacts.some((x) => x.id === ok.body.id && x.studentEmail === "jamie@example.com"));
const rename = await call(c.token, "PATCH", `/pipeline/contacts/${ok.body.id}`, { studentName: "  " });
check("cannot blank the name", rename.status === 400, `status ${rename.status}`);

// #5 global search
const inv = await call(c.token, "POST", "/invites", { email: "morgan.lee@example.com", fullName: "Morgan Lee" });
check("invite created", inv.status === 201 || inv.status === 200, `status ${inv.status} ${JSON.stringify(inv.body).slice(0, 120)}`);
const s = await call(c.token, "GET", "/search?q=morgan");
check("search finds the invited student", s.status === 200 && s.body.invitations?.some((i) => /morgan/i.test(i.email)), JSON.stringify(s.body).slice(0, 200));
const s2 = await call(c.token, "GET", "/search?q=" + encodeURIComponent("stan;ford"));
check("global search survives punctuation", s2.status === 200, `status ${s2.status}`);
const s3 = await call(c.token, "GET", "/search?q=stanford");
check("global search finds colleges", s3.body.colleges?.some((x) => /Stanford/.test(x.name)), JSON.stringify(s3.body.colleges));

// #2 privacy settings
const p0 = await call(c.token, "GET", "/settings/privacy");
check("privacy defaults", p0.status === 200 && p0.body.aiSummaries === true && p0.body.canEdit === true, JSON.stringify(p0.body));
const p1 = await call(c.token, "PATCH", "/settings/privacy", { aiSummaries: false });
check("privacy saved", p1.status === 200 && p1.body.aiSummaries === false, JSON.stringify(p1.body));
const p2 = await call(c.token, "GET", "/settings/privacy");
check("privacy persisted", p2.body.aiSummaries === false && p2.body.autoParseDocuments === true, JSON.stringify(p2.body));
const other = await user("counselor-b");
const p3 = await call(other.token, "GET", "/settings/privacy");
check("another practice keeps its own defaults", p3.body.aiSummaries === true, JSON.stringify(p3.body));
const stu = await user("student-x", "student");
const p4 = await call(stu.token, "GET", "/settings/privacy");
check("students can't read practice settings", p4.status === 403, `status ${p4.status}`);
await call(c.token, "PATCH", "/settings/privacy", { aiSummaries: true });
