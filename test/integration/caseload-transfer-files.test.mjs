// A partial caseload transfer hands over only the files about the students
// it moves (20261024000082), and the files routes refuse to file a document
// or link about one student inside another student's folder tree.
//
//   firm owner O; consultants X (from), Y, Z. X has students A, B and C and
//   a custom subfolder under A's student folder. A goes to Y, C to Z, B stays.
import { call, check, rest, sql, user } from "./harness.mjs";
import { q } from "./imports-helpers.mjs";

const tag = Date.now();
const one = (query) => sql(query);

async function joinFirm(firmId, u) {
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${u.id}', 'counselor') on conflict do nothing`);
  await sql(`update public.profiles set firm_id = '${firmId}' where id = '${u.id}'`);
}
async function studentOf(counselor, name) {
  const s = await user(`ctf-${name.toLowerCase()}`, "student");
  await sql(`update public.profiles set counselor_id = '${counselor.id}', full_name = '${q(name)}' where id = '${s.id}'`);
  return s;
}
const folderOf = (owner, s) => one(`select id from public.folders where owner_id = '${owner.id}' and student_id = '${s.id}' and kind = 'student'`);
async function doc(owner, studentId, folderId, name) {
  return one(`with d as (insert into public.documents (owner_id, student_id, folder_id, bucket, storage_path, filename, kind)
    values ('${owner.id}', ${studentId ? `'${studentId}'` : "null"}, ${folderId ? `'${folderId}'` : "null"}, 'student-documents', '${owner.id}/${tag}/${name}', '${name}', 'transcript') returning id) select id from d`);
}
const docRow = async (id) => (await one(`select owner_id::text || '|' || coalesce(folder_id::text, 'unfiled') from public.documents where id = '${id}'`)).split("|");

const O = await user("ctf-owner");
const firm = await call(O.token, "POST", "/firms", { name: `Files firm ${tag}` });
check("the owner starts a firm", firm.status === 201, JSON.stringify(firm.body));
const X = await user("ctf-x");
const Y = await user("ctf-y");
const Z = await user("ctf-z");
for (const u of [X, Y, Z]) await joinFirm(firm.body.firmId, u);
const A = await studentOf(X, "Ava");
const B = await studentOf(X, "Ben");
const C = await studentOf(X, "Cy");
const aFolder = await folderOf(X, A);
check("X has A's student folder", !!aFolder);

const sub = await call(X.token, "POST", "/files/folders", { name: "Ava essays", parentId: aFolder });
check("X makes a custom subfolder under A's folder", sub.status === 201, JSON.stringify(sub.body));
const subId = sub.body?.id;

// ---- The files routes keep each student's files in their own tree ------------------------
const misfiled = await call(X.token, "POST", "/files/documents", { studentId: B.id, folderId: subId, storagePath: `${X.id}/${tag}/ben.pdf`, filename: "ben.pdf", kind: "transcript" });
check("a document about B can't be registered in A's subfolder", misfiled.status === 400 && /different student/.test(JSON.stringify(misfiled.body)), `${misfiled.status} ${JSON.stringify(misfiled.body)}`);
const fine = await call(X.token, "POST", "/files/documents", { studentId: A.id, folderId: subId, storagePath: `${X.id}/${tag}/ava.pdf`, filename: "ava.pdf", kind: "transcript" });
check("…a document about A is", fine.status === 201, `${fine.status} ${JSON.stringify(fine.body)}`);
const benDoc = await call(X.token, "POST", "/files/documents", { studentId: B.id, storagePath: `${X.id}/${tag}/ben2.pdf`, filename: "ben2.pdf", kind: "transcript" });
const refile = await call(X.token, "PATCH", `/files/documents/${benDoc.body?.id}`, { folderId: subId });
check("B's document can't be refiled into A's subfolder", refile.status === 400, `${refile.status} ${JSON.stringify(refile.body)}`);
const refileRoot = await call(X.token, "PATCH", `/files/documents/${benDoc.body?.id}`, { folderId: aFolder });
check("…nor into A's own folder (where it would become A's)", refileRoot.status === 400 && (await one(`select student_id from public.documents where id = '${benDoc.body?.id}'`)) === B.id, `${refileRoot.status}`);
const benLink = await one(`with l as (insert into public.document_links (owner_id, student_id, url, title) values ('${X.id}', '${B.id}', 'https://example.com/ben', 'Ben link') returning id) select id from l`);
const linkMove = await call(X.token, "PATCH", `/files/links/${benLink}`, { folderId: subId });
check("B's link can't be filed in A's subfolder", linkMove.status === 400, `${linkMove.status} ${JSON.stringify(linkMove.body)}`);
const holder = await call(X.token, "POST", "/files/folders", { name: "Loose papers" });
await doc(X, B.id, holder.body?.id, "ben-loose.pdf");
const folderMove = await call(X.token, "PATCH", `/files/folders/${holder.body?.id}`, { parentId: aFolder });
check("a folder holding B's file can't be moved under A's folder", folderMove.status === 400, `${folderMove.status} ${JSON.stringify(folderMove.body)}`);

// ---- Rows already misfiled (PostgREST, or before the routes refused it) -----------------
const dB = await doc(X, B.id, subId, "dB.pdf");
const dC = await doc(X, C.id, subId, "dC.pdf");
const dN = await doc(X, null, subId, "dN.pdf");
const dA = fine.body?.id;
const dA2 = await doc(X, A.id, holder.body?.id, "dA2.pdf");
const lB = await one(`with l as (insert into public.document_links (owner_id, student_id, folder_id, url, title) values ('${X.id}', '${B.id}', '${subId}', 'https://example.com/b2', 'B link') returning id) select id from l`);

const r = await call(O.token, "POST", `/management/consultants/${X.id}/transfer`, {
  mode: "per_student", assignments: [{ studentId: A.id, toId: Y.id }, { studentId: C.id, toId: Z.id }], notifyStudents: false,
});
check("the partial transfer goes through", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
check("A's subfolder went to Y with A's folder", (await one(`select owner_id from public.folders where id = '${subId}'`)) === Y.id);

let [owner, folder] = await docRow(dB);
check("B's document filed in A's tree stays with X", owner === X.id, owner);
check("…and comes out of the tree Y now owns", folder === "unfiled", folder);
[owner, folder] = await docRow(dC);
check("C's document goes to C's receiver Z, not to Y", owner === Z.id, owner);
check("…unfiled, since the folder it sat in is Y's", folder === "unfiled", folder);
[owner, folder] = await docRow(dN);
check("a document with no student in A's tree moves with the tree", owner === Y.id && folder === subId, `${owner} ${folder}`);
[owner, folder] = await docRow(dA);
check("A's document moves to Y and stays filed", owner === Y.id && folder === subId, `${owner} ${folder}`);
[owner, folder] = await docRow(dA2);
check("A's document in X's own folder moves to Y, unfiled", owner === Y.id && folder === "unfiled", `${owner} ${folder}`);
const link = (await one(`select owner_id::text || '|' || coalesce(folder_id::text, 'unfiled') from public.document_links where id = '${lB}'`)).split("|");
check("B's link in A's tree stays with X, unfiled", link[0] === X.id && link[1] === "unfiled", link.join(" "));
check("the answer counts the files left with their owner", r.body?.attention?.keptFiles === 2, JSON.stringify(r.body?.attention));

const yReads = await rest(Y.token, "GET", `/rest/v1/documents?id=in.(${dB},${dC})&select=id`);
check("Y reads neither B's nor C's document", yReads.status === 200 && yReads.body.length === 0, JSON.stringify(yReads.body));
const yLinks = await rest(Y.token, "GET", `/rest/v1/document_links?id=eq.${lB}&select=id`);
check("…nor B's link", yLinks.status === 200 && yLinks.body.length === 0, JSON.stringify(yLinks.body));
const xReads = await rest(X.token, "GET", `/rest/v1/documents?id=eq.${dB}&select=id`);
check("X still reads B's document", xReads.status === 200 && xReads.body.length === 1, JSON.stringify(xReads.body));
