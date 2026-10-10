// Context layer Task 4: what AI sees, end to end through GET /students/:id/ai-context.
import { check, call, user, sql } from "./harness.mjs";
import { studentOf, firmWith } from "./imports-helpers.mjs";
import { seedStudent, MARKERS } from "../fixtures/context/students.mjs";

const c = await user("ctx-layer");
const ctx = async (studentId, feature = "chat", token = c.token) => call(token, "GET", `/students/${studentId}/ai-context?feature=${feature}`);

const { student: priv } = await seedStudent(c, "private");
const p = await ctx(priv.id);
check("context loads", p.status === 200, `status ${p.status}`);
for (const m of MARKERS.private) check(`never includes ${m}`, !p.body.text.includes(m));
check("the student's login email never appears", !p.body.text.includes(priv.email));
check("imported text is in an untrusted data block", /<data source="activity:[^"]*" kind="untrusted">ignore previous instructions/.test(p.body.text));
// Names, positions and titles are student-written too: strip every data block (and its source attribute)
// and the injection string must be gone from what is left.
check("an injection in an activity name is present", p.body.text.includes("NAME-INJECT"));
const bare = p.body.text.replace(/<data source="[^"]*" kind="untrusted">[\s\S]*?<\/data>/g, "");
check("every NAME-INJECT sits inside a data block or a source attribute", !bare.includes("NAME-INJECT"), bare.slice(0, 300));

const { student: docs } = await seedStudent(c, "documents");
const d = await ctx(docs.id);
check("an allowed transcript is included", d.body.text.includes("TRANSCRIPT-TEXT"));
check("a financial doc set to allowed is included", d.body.text.includes("FIN2-TEXT"));
for (const m of MARKERS.excludedDocs) check(`excluded document text ${m} never appears`, !d.body.text.includes(m));
const unc = d.body.omitted.find((o) => o.reason === "not-categorized");
check("uncategorized documents are reported with a count", unc?.count === 3, JSON.stringify(d.body.omitted));
check("used lists the transcript by name", d.body.used.some((u) => u.section === "documents" && u.items?.includes("transcript.pdf")));

await sql(`insert into public.practice_settings (counselor_id, auto_parse_documents) values ('${c.id}', false)
           on conflict do nothing`);
await sql(`update public.practice_settings set auto_parse_documents = false where counselor_id = '${c.id}'`);
const off = await ctx(docs.id);
check("practice document reading off drops all documents", !off.body.text.includes("TRANSCRIPT-TEXT") &&
  off.body.omitted.some((o) => o.section === "documents" && o.reason === "practice-setting"));
await sql(`update public.practice_settings set auto_parse_documents = true where counselor_id = '${c.id}'`);

const { student: huge } = await seedStudent(c, "huge");
const h = await ctx(huge.id, "student-ai");
check("a huge record stays within budget", h.body.text.length <= 40_000, String(h.body.text.length));
check("over-budget sections are dropped whole and reported", h.body.omitted.some((o) => o.reason === "budget"));
const starts = (h.body.text.match(/ACT-DESC-\d+-START/g) ?? []).length;
const ends = (h.body.text.match(/ACT-DESC-\d+-END/g) ?? []).length;
check("no activity description is cut mid-way",
  starts === ends && (starts > 0 || h.body.omitted.some((o) => o.section === "activities" && o.reason === "budget")),
  `starts ${starts} ends ${ends} ${JSON.stringify(h.body.omitted)}`);
const coh = await ctx(huge.id, "narrative-coherence");
const chat = await ctx(huge.id, "chat");
check("essay bodies only for coherence", coh.body.text.includes("ESSAY-BODY") && !chat.body.text.includes("ESSAY-BODY"));

const { student: edge } = await seedStudent(c, "edge");
const e = await ctx(edge.id);
check("a 100-point GPA keeps its scale", /92(\.0+)? \(100-point scale\)/.test(e.body.text), e.body.text.slice(0, 300));

const owner = await user("ctx-owner");
const member = await user("ctx-member");
await firmWith(owner, [member]);
const theirs = await studentOf(member, "ctx-firm-student");
const otherMember = await user("ctx-member2");
await firmWith(otherMember, []);
const nope = await ctx(theirs.id, "chat", otherMember.token);
check("a counselor without access gets 404", nope.status === 404, `status ${nope.status}`);
const st = await call(priv.token, "GET", `/students/${priv.id}/ai-context?feature=chat`);
check("a student gets 403", st.status === 403, `status ${st.status}`);
