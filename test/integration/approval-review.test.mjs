// Counselor approval gate: asking for review, and approving by the emailed link.
import { createHash, randomBytes } from "node:crypto";
import { API, CLIENT, check, sql, user, call } from "./harness.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const approvedAt = (u) => sql(`select coalesce(counselor_approved_at::text, 'none') from public.profiles where id = '${u.id}'`);
const page = async (method, token) => {
  const r = await fetch(`${API}/access-review/${token}`, {
    method,
    headers: { ...CLIENT, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(method === "POST" ? { body: "" } : {}),
  });
  return { status: r.status, html: await r.text(), headers: r.headers };
};
/** The link the team would receive: tests can't read mail, so they plant a request with a known token. */
async function plant(u, { expired = false } = {}) {
  const token = randomBytes(32).toString("base64url");
  await sql(`update public.counselor_access_requests set used_at = now() where profile_id = '${u.id}' and used_at is null`);
  await sql(`insert into public.counselor_access_requests (profile_id, token_hash${expired ? ", expires_at" : ""}) values ('${u.id}', '${sha(token)}'${expired ? ", now() - interval '1 minute'" : ""})`);
  return token;
}

const p = await user("review-pending", "counselor", { approved: false });
await sql(`update public.profiles set full_name = '<script>alert(1)</script> O''Brien', profile = '{"firmName":"<b>Bold</b> Advising","firmSize":"2-5"}'::jsonb where id = '${p.id}'`);

// ---- Asking ---------------------------------------------------------------------
const ask = await call(p.token, "POST", "/auth/request-access");
check("a pending counselor can ask for review", ask.status === 200 && ask.body.status === "pending", JSON.stringify(ask.body));
if (ask.body.emailed === false) {
  check("an unsent request is removed, so the next visit retries", Number(await sql(`select count(*) from public.counselor_access_requests where profile_id = '${p.id}'`)) === 0);
} else {
  check("a second ask inside 24 hours sends nothing new", (await call(p.token, "POST", "/auth/request-access")).body.emailed === false);
}
const approvedUser = await user("review-approved");
const askA = await call(approvedUser.token, "POST", "/auth/request-access");
check("an approved counselor is told so and nothing is sent", askA.status === 200 && askA.body.status === "approved" && askA.body.emailed === false);
const student = await user("review-student", "student");
check("a student cannot ask", (await call(student.token, "POST", "/auth/request-access")).status === 403);

// ---- Opening the link changes nothing ---------------------------------------------
const token = await plant(p);
const get1 = await page("GET", token);
check("the link opens a confirm page", get1.status === 200 && /Approve this counselor/.test(get1.html), `status ${get1.status}`);
check("it shows who is being approved", get1.html.includes(p.email) && get1.html.includes("Bold"));
check("the name and practice are escaped", !get1.html.includes("<script>alert") && !get1.html.includes("<b>Bold") && get1.html.includes("&lt;script&gt;"));
check("the page is not cached and not indexed", get1.headers.get("cache-control") === "no-store" && /noindex/.test(get1.headers.get("x-robots-tag") ?? ""));
await page("GET", token);
check("opening the link (twice) approves nobody", (await approvedAt(p)) === "none");

// ---- The button approves, once -------------------------------------------------------
const post1 = await page("POST", token);
check("pressing Approve approves", post1.status === 200 && /Approved/.test(post1.html) && (await approvedAt(p)) !== "none", `status ${post1.status}`);
check("the approved counselor can now work", (await call(p.token, "GET", "/work-items")).status === 200);
check("the link is dead afterwards (POST)", (await page("POST", token)).status === 404);
const get2 = await page("GET", token);
check("the link is dead afterwards (GET)", get2.status === 404 && /no longer valid/i.test(get2.html));
check("approval is audited", Number(await sql(`select count(*) from public.audit_log where action = 'counselor.access.approved' and entity_id = '${p.id}'`)) === 1);

// ---- Bad links ---------------------------------------------------------------------------
const p2 = await user("review-expired", "counselor", { approved: false });
const old = await plant(p2, { expired: true });
check("an expired link shows the invalid page", (await page("GET", old)).status === 404);
check("an expired link approves nobody", (await page("POST", old)).status === 404 && (await approvedAt(p2)) === "none");
const older = await plant(p2);
const newer = await plant(p2);
check("a newer request retires the older link", (await page("POST", older)).status === 404 && (await approvedAt(p2)) === "none");
check("...and the newer one works", (await page("POST", newer)).status === 200 && (await approvedAt(p2)) !== "none");
check("a malformed token is just invalid", (await page("GET", "short")).status === 404);
check("an unknown well-formed token is just invalid", (await page("POST", randomBytes(32).toString("base64url"))).status === 404);

// ---- The link is never stored in readable form ----------------------------------------
const p4 = await user("review-stored", "counselor", { approved: false });
await call(p4.token, "POST", "/auth/request-access");
check("a review email was recorded", Number(await sql(`select count(*) from public.message_deliveries where template = 'access-review' and subject like '%${p4.email}%'`)) === 1);
check("no recorded email body holds a review link", Number(await sql(`select count(*) from public.message_deliveries where template = 'access-review' and subject like '%${p4.email}%' and body like '%/access-review/%'`)) === 0);
