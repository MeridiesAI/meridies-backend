// Regular-expression denial of service: each attack from the security review,
// as the persona who can make it, against a running API. Before the fix each
// one held the API's single event loop for seconds to hours, so every other
// request (here, GET /health) waited behind it. Now the attack request itself
// answers quickly and /health answers while it runs.
//
// Not reproduced here: the link reader (POST /files/links). Its SSRF guard
// refuses every address this machine could serve a page from, so the attack
// page can't be reached from a local stack; test/unit/links.test.ts feeds the
// same 2 MB page through fetchReadablePage with the resolver and opener seams.
//
// Needs the API started with IMPORTS_ROLLOUT=all (and IMPORT_DATABASE_URL, as
// the CI workflow sets it) for the import step.
import { deflateRawSync } from "node:zlib";
import { API, CLIENT, call, check, sql, user } from "./harness.mjs";
import { addImportFile, enc } from "./imports-helpers.mjs";

const SB = process.env.SUPABASE_URL;
/** REDOS_ONLY=txt,docx,mass,import runs some of the attacks (each one holds an unfixed API for minutes). */
const ONLY = process.env.REDOS_ONLY ? new Set(process.env.REDOS_ONLY.split(",")) : null;
const runs = (name) => !ONLY || ONLY.has(name);
const ANON = process.env.SUPABASE_ANON_KEY;

/** How long an attack request may take, and how long /health may wait behind it. */
const ATTACK_MS = 10_000;
const HEALTH_MS = 2_000;

/** `fn`'s request with a deadline; `{ status: "timeout" }` when it passes. */
async function timed(fn, ms) {
  const started = Date.now();
  const result = await Promise.race([fn(), new Promise((r) => setTimeout(() => r({ status: "timeout" }), ms))]);
  return { ...result, ms: Date.now() - started };
}

/**
 * The attack, with GET /health asked every 200 ms until it settles: the
 * longest any of those waited is how long the event loop was held.
 */
async function withHealthProbe(attack) {
  let settled = false;
  const pending = timed(attack, ATTACK_MS).finally(() => {
    settled = true;
  });
  let worst = { status: 200, ms: 0 };
  await new Promise((r) => setTimeout(r, 100));
  while (!settled) {
    const probe = await timed(async () => {
      const r = await fetch(`${API}/health`, { headers: CLIENT, signal: AbortSignal.timeout(HEALTH_MS + 1000) }).catch(() => null);
      return { status: r ? r.status : "timeout" };
    }, HEALTH_MS);
    if (probe.status !== 200 || probe.ms > worst.ms) worst = probe;
    if (probe.status !== 200) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { attack: await pending, health: worst };
}

async function storeAsStudent(student, name, bytes, mime) {
  const path = `${student.id}/${Date.now()}-${name}`;
  const r = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${student.token}`, "Content-Type": mime },
    body: bytes,
  });
  if (!r.ok) throw new Error(`storage upload ${r.status} ${await r.text()}`);
  const doc = await call(student.token, "POST", "/files/documents", { storagePath: path, filename: name, mimeType: mime, sizeBytes: bytes.length });
  if (doc.status !== 201) throw new Error(`register ${doc.status} ${JSON.stringify(doc.body)}`);
  return doc.body.id;
}

/** A minimal .docx: one deflated word/document.xml in a zip. */
function docx(xml) {
  const name = Buffer.from("word/document.xml");
  const raw = Buffer.from(xml, "utf8");
  const data = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

// ---- Personas ------------------------------------------------------------------

const counselor = await user("counselor-redos");
const student = await user("student-redos", "student");
await sql(`update public.profiles set counselor_id = '${counselor.id}' where id = '${student.id}'`);

// ---- 1. A student's .txt of spaces with no newline -----------------------------
// /[ \t]+\n/g took 11 s for 100k spaces and grew with the square of the length.
if (runs("txt")) {
  const id = await storeAsStudent(student, "essay.txt", Buffer.alloc(400_000, 0x20), "text/plain");
  const { attack, health } = await withHealthProbe(() =>
    call(student.token, "POST", "/application/essays/from-document", { studentId: student.id, documentId: id, essayKind: "other" })
  );
  check("a student's .txt of 400,000 spaces is read promptly", attack.status === 201 || attack.status === 200, `status ${attack.status} in ${attack.ms} ms`);
  check("…and the API answers /health while it is read", health.status === 200, `slowest /health ${health.ms} ms (${health.status})`);
}

// ---- 2. A student's .docx of one unclosed run -----------------------------------
// `<w:t(?:\s[^>]*)?>` rescanned the part from every "<w:t "; the archive is tiny.
if (runs("docx")) {
  const xml = `<w:document><w:body><w:p>${"<w:t ".repeat(400_000)}</w:p></w:body></w:document>`;
  const bytes = docx(xml);
  const id = await storeAsStudent(student, "essay.docx", bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { attack, health } = await withHealthProbe(() =>
    call(student.token, "POST", "/application/essays/from-document", { studentId: student.id, documentId: id, essayKind: "other" })
  );
  check(`a student's ${bytes.length}-byte .docx (2 MB of "<w:t ") is read promptly`, attack.status === 201 || attack.status === 200, `status ${attack.status} in ${attack.ms} ms`);
  check("…and the API answers /health while it is read", health.status === 200, `slowest /health ${health.ms} ms (${health.status})`);
}

// ---- 3. A counselor's 20,000-character Mass invite paste -------------------------
// The spelled-out fold took 1.5-2.2 s on 20,000 "a"; the edge pattern 2 s on an
// address token ending in a long run of ")".
for (const [label, text] of !runs("mass") ? [] : [
  ["20,000 \"a\"", "a".repeat(20_000)],
  ["\"a.\" x 10,000", "a.".repeat(10_000)],
  ["an address token closed by 19,996 \")\"", `a@${")".repeat(19_996)}a`],
  ["an \"@\" before 19,998 letters", `a@${"a".repeat(19_998)}`],
]) {
  const r = await timed(() => call(counselor.token, "POST", "/invites/mass/sort", { text }), ATTACK_MS);
  check(`Mass invite sorts ${label} in under half a second`, r.status === 200 && r.ms < 500, `status ${r.status} in ${r.ms} ms`);
}

// ---- 4. A counselor's import file with crafted cells -----------------------------
// Masking `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` on "a@a.a.…" took 1.2 s per 40,000-character
// cell, and parseNumber's `\d+\.?\d*` as long on a run of digits, for every row.
if (runs("import")) {
  const start = await call(counselor.token, "POST", "/imports", { permissionConfirmed: true });
  if (start.status === 403 || start.status === 503) {
    check("imports are switched on for this API (IMPORTS_ROLLOUT=all and the migrations)", false, `status ${start.status} ${JSON.stringify(start.body)}`);
  } else {
    const rows = ["Email,SAT,Courses"];
    for (let i = 0; i < 20; i++) rows.push(`a@${"a.".repeat(20_000)}${i} x,${"1".repeat(40_000)}!,"${",".repeat(20_000)}x"`);
    const bytes = enc(rows.join("\n") + "\n");
    const { attack, health } = await withHealthProbe(() => addImportFile(counselor, start.body.id, "roster.csv", bytes));
    check(`a ${bytes.length}-byte import file of crafted cells is profiled promptly`, attack.status === 200 || attack.status === 201, `status ${attack.status} in ${attack.ms} ms ${JSON.stringify(attack.body ?? "").slice(0, 160)}`);
    check("…and the API answers /health while it is profiled", health.status === 200, `slowest /health ${health.ms} ms (${health.status})`);
    await call(counselor.token, "DELETE", `/imports/${start.body.id}`);
  }
}
