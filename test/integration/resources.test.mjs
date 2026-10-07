import { user, call, check, sql, API, CRON_SECRET } from "./harness.mjs";
const c = await user("counselor-lib");
const all = await call(c.token, "GET", "/resources");
check("library lists for a counselor", all.status === 200 && all.body.length === 23, `${all.body.length}`);
const ca = await call(c.token, "GET", "/resources?state=ny");
check("state filter drops CA-only rows", ca.body.length > 0 && ca.body.every((r) => r.stateScope === null || r.stateScope === "NY"), `${ca.body.length}`);
const aid = await call(c.token, "GET", "/resources?category=aid&q=" + encodeURIComponent("cal grant;"));
check("category + punctuation-safe text search", aid.status === 200 && aid.body.some((r) => /Cal Grant/.test(r.title)), aid.body.map((r) => r.title).join(" | "));

const s = await user("student-lib", "student");
await sql(`update profiles set counselor_id='${c.id}' where id='${s.id}'`);
const sv = await call(s.token, "GET", "/resources");
check("students see only rows meant for them", sv.body.length > 0 && sv.body.every((r) => r.audience !== "counselor"), `${sv.body.length}`);

const mine = await call(c.token, "POST", "/resources", { category: "research", title: "Our essay checklist", url: "https://example.com/checklist" });
check("practice resource created", mine.status === 201 && mine.body.owner === "practice", JSON.stringify(mine.body).slice(0, 100));
const ssrf = await call(c.token, "POST", "/resources", { category: "research", title: "x", url: "http://169.254.169.254/latest" });
check("internal address refused", ssrf.status === 400, `status ${ssrf.status}`);
const other = await user("counselor-lib-2");
const ov = await call(other.token, "GET", "/resources");
check("another practice doesn't see it", !ov.body.some((r) => r.id === mine.body.id) && ov.body.length === 23);
const libRow = all.body.find((r) => r.title === "Common App");
const editLib = await call(c.token, "PATCH", `/resources/${libRow.id}`, { title: "hacked" });
check("library rows can't be edited", editLib.status === 404, `status ${editLib.status}`);
const delLib = await call(c.token, "DELETE", `/resources/${libRow.id}`);
check("library rows can't be deleted", delLib.status === 404);
const edit = await call(c.token, "PATCH", `/resources/${mine.body.id}`, { title: "Essay checklist v2" });
check("own row edits", edit.status === 200 && edit.body.title === "Essay checklist v2");

const calGrant = all.body.find((r) => /Cal Grant/.test(r.title));
const pin = await call(c.token, "POST", `/resources/${calGrant.id}/pins`, { studentId: s.id, note: "File by March 2" });
check("pin to student", pin.status === 201, `status ${pin.status} ${JSON.stringify(pin.body)}`);
const pins = await call(c.token, "GET", `/resources/pins?studentId=${s.id}`);
check("pins list", pins.body.length === 1 && pins.body[0].resource.id === calGrant.id && pins.body[0].note === "File by March 2");
const spins = await call(s.token, "GET", `/resources/pins?studentId=${s.id}`);
check("student sees their pins", spins.status === 200 && spins.body.length === 1, `status ${spins.status}`);
const opins = await call(other.token, "GET", `/resources/pins?studentId=${s.id}`);
check("other counselor can't read them", opins.status === 404 || (opins.status === 200 && opins.body.length === 0), `status ${opins.status}`);
const opin = await call(other.token, "POST", `/resources/${calGrant.id}/pins`, { studentId: s.id });
check("other counselor can't pin", opin.status === 404 || opin.status === 403, `status ${opin.status}`);
const mit = await sql("select id from colleges where slug='mit'");
const cpin = await call(c.token, "POST", `/resources/${libRow.id}/pins`, { collegeId: mit });
check("pin to college", cpin.status === 201);
const ocp = await call(other.token, "GET", `/resources/pins?collegeId=${mit}`);
check("college pins are per practice", ocp.body.length === 0);
const dl = await call(c.token, "POST", `/resources/${calGrant.id}/deadline`, { studentId: s.id });
check("Cal Grant onto the student's deadlines", dl.status === 201 && dl.body.dueDate === "2027-03-02", JSON.stringify(dl.body));
const nodl = await call(c.token, "POST", `/resources/${all.body.find((r) => r.title === "ACT").id}/deadline`, { studentId: s.id });
check("undated resource refused", nodl.status === 400);
const unpin = await call(c.token, "DELETE", `/resources/pins/${pin.body.pinId}`);
check("unpin", unpin.status === 204);

const css = await call(c.token, "GET", "/colleges/search?cssProfile=true&states=MA");
check("search by CSS Profile", css.body.length > 0 && css.body.every((x) => x.state === "MA"), css.body.map((x) => x.name).join(", "));
const ex = await call(c.token, "GET", `/colleges/${mit}/extras`);
check("profile shows curated policies with source", ex.body.policies?.cssProfileRequired === true && ex.body.policies.sources.css_profile_required.url.includes("collegeboard"), JSON.stringify(ex.body.policies));

const noSecret = await fetch(API + "/internal/resources/link-check", { method: "POST" });
check("link check needs the cron secret", noSecret.status === 401);
