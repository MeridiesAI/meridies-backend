// Documents a counselor adds for a student who hasn't joined yet (20261124000008): staged against the
// invitation, kept through a resend, and filed in the student's folder the moment they accept.
import { randomUUID } from "node:crypto";
import { ANON, SB, call, check, sql, user } from "./harness.mjs";

// psql prints the command tag ("INSERT 0 1") after a RETURNING row; keep the first line.
const one = async (q) => (await sql(q)).split("\n")[0];
const count = async (q) => Number(await sql(q));

const c = await user("invdoc-counselor");
const other = await user("invdoc-other");
const s = await user("invdoc-student", "student");
const studentEmail = await one(`select email from public.profiles where id = '${s.id}'`);

const token1 = `invdoc-${Date.now()}-aaaaaaaa`;
const invId = await one(
  `insert into public.invitations (counselor_id, email, token, source, full_name) values ('${c.id}', '${studentEmail}', '${token1}', 'intake', 'Invited Student') returning id`
);

/** The browser's half: upload to Storage under the counselor's own token. */
async function upload(who, path, body = "%PDF-1.4 test", type = "application/pdf") {
  return fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${who.token}`, "Content-Type": type },
    body: Buffer.from(body),
  });
}
const pathFor = (inv, name) => `${c.id}/${inv}/${Date.now()}-${randomUUID().slice(0, 6)}-${name}`;

// ---- stage ----------------------------------------------------------------------------------------
const p1 = pathFor(invId, "transcript.pdf");
check("the counselor can upload to their own staging path", (await upload(c, p1)).ok);
const add = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: p1, filename: "transcript.pdf", kind: "transcript", mimeType: "application/pdf", sizeBytes: 13 });
check("POST /invites/:id/documents registers it", add.status === 201 && add.body.kind === "transcript", `${add.status} ${JSON.stringify(add.body).slice(0, 160)}`);
const p2 = pathFor(invId, "bank.pdf");
await upload(c, p2);
const add2 = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: p2, filename: "bank.pdf", kind: "financial" });
check("a second file registers", add2.status === 201, `${add2.status}`);

const list = await call(c.token, "GET", `/invites/${invId}/documents`);
check("GET lists both", list.status === 200 && list.body.length === 2, `${list.status} ${JSON.stringify(list.body).slice(0, 120)}`);

const building = await call(c.token, "GET", "/invites/building");
const card = Array.isArray(building.body) ? building.body.find((b) => b.id === invId) : null;
check("the Building card carries documentCount", building.status === 200 && card?.documentCount === 2, `count ${card?.documentCount}`);

// ---- what is refused ------------------------------------------------------------------------------
const alien = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: `${other.id}/${invId}/1-x.pdf`, filename: "x.pdf" });
check("a path under someone else's id is refused", alien.status === 400, `${alien.status}`);
const wrongInv = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: `${c.id}/${randomUUID()}/1-x.pdf`, filename: "x.pdf" });
check("a path under another invitation is refused", wrongInv.status === 400, `${wrongInv.status}`);
const unfiled = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: `unfiled/1-x.pdf`, filename: "x.pdf" });
check("an 'unfiled' path is refused", unfiled.status === 400, `${unfiled.status}`);
const svg = pathFor(invId, "logo.svg");
await upload(c, svg, "<svg/>", "image/svg+xml");
const svgAdd = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: svg, filename: "logo.svg", mimeType: "image/svg+xml" });
check("SVG is refused", svgAdd.status === 400, `${svgAdd.status}`);
const badKind = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: pathFor(invId, "k.pdf"), filename: "k.pdf", kind: "diary" });
check("an unknown kind is refused", badKind.status === 400, `${badKind.status}`);

const theirs = await call(other.token, "GET", `/invites/${invId}/documents`);
check("another counselor lists none of them", theirs.status === 200 && theirs.body.length === 0, `${theirs.status} ${JSON.stringify(theirs.body).slice(0, 80)}`);
const theirsAdd = await call(other.token, "POST", `/invites/${invId}/documents`, { storagePath: `${other.id}/${invId}/1-x.pdf`, filename: "x.pdf" });
check("another counselor can't stage on this invitation", theirsAdd.status === 404, `${theirsAdd.status}`);
const theirsDel = await call(other.token, "DELETE", `/invites/${invId}/documents/${add.body.id}`);
check("another counselor can't remove one", theirsDel.status === 404, `${theirsDel.status}`);
const asStudent = await call(s.token, "GET", `/invites/${invId}/documents`);
check("a student can't use the route", asStudent.status === 403, `${asStudent.status}`);

// ---- remove ---------------------------------------------------------------------------------------
const del = await call(c.token, "DELETE", `/invites/${invId}/documents/${add2.body.id}`);
check("DELETE removes the row", del.status === 204 && (await count(`select count(*) from public.invitation_documents where invitation_id = '${invId}'`)) === 1, `${del.status}`);

// ---- resend: the staged file follows the new invitation --------------------------------------------
const resend = await call(c.token, "POST", `/invites/${invId}/resend`);
const newId = resend.body?.id;
check("resending makes a new invitation", resend.status === 201 || resend.status === 200, `${resend.status} ${JSON.stringify(resend.body).slice(0, 120)}`);
check("...and the staged file follows it", Boolean(newId) && newId !== invId && (await count(`select count(*) from public.invitation_documents where invitation_id = '${newId}'`)) === 1,
  `new ${newId}`);
check("...none left on the revoked one", (await count(`select count(*) from public.invitation_documents where invitation_id = '${invId}'`)) === 0);
const revokedAdd = await call(c.token, "POST", `/invites/${invId}/documents`, { storagePath: pathFor(invId, "late.pdf"), filename: "late.pdf" });
check("a revoked invitation takes no more files", revokedAdd.status === 409, `${revokedAdd.status}`);

// ---- accept: filed in the student's folder ----------------------------------------------------------
const token2 = await one(`select token from public.invitations where id = '${newId}'`);
const accept = await call(s.token, "POST", "/invites/accept", { token: token2 });
check("the student accepts", accept.status === 200, `${accept.status} ${JSON.stringify(accept.body).slice(0, 160)}`);
check("no staged row is left", (await count(`select count(*) from public.invitation_documents where invitation_id in ('${invId}', '${newId}')`)) === 0);
const filed = await one(
  `select d.filename || '|' || d.kind || '|' || (f.kind = 'student')::text || '|' || (d.student_id = '${s.id}')::text from public.documents d join public.folders f on f.id = d.folder_id where d.storage_path = '${p1}'`
);
check("the file is in the student's folder as a document", filed === "transcript.pdf|transcript|true|true", filed);
const viaApi = await call(c.token, "GET", `/files/documents?studentId=${s.id}`);
check("the counselor lists it through Files", viaApi.status === 200 && viaApi.body.some((d) => d.filename === "transcript.pdf"), `${viaApi.status}`);
const lateAdd = await call(c.token, "POST", `/invites/${newId}/documents`, { storagePath: pathFor(newId, "after.pdf"), filename: "after.pdf" });
check("after they join, staging answers 409 so the app uses their folder", lateAdd.status === 409 && lateAdd.body?.code === "invitation_accepted", `${lateAdd.status} ${JSON.stringify(lateAdd.body).slice(0, 120)}`);
