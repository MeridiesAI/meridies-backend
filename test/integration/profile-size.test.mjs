// Bounds on profiles (lib/profileSize.ts and 20261024000081): the API
// measures the merged profile, not the patch, on PATCH /auth/me and the
// counselor's PATCH /students/:id, in the database's own measure (UTF-8 bytes
// of the jsonb text, 300,000); the database refuses an oversized profile, or
// an overlong value in any other client-writable column, that comes straight
// through PostgREST. An oversized value can shrink, and the row's other
// columns stay writable. The roster reads named columns only.
import { call, check, rest, sql, user } from "./harness.mjs";

const big = (n) => "x".repeat(n);
const size = async (id) => Number(await sql(`select coalesce(octet_length(profile::text), 0) from public.profiles where id = '${id}'`));
const col = async (id, c) => Number(await sql(`select coalesce(length(${c}), 0) from public.profiles where id = '${id}'`));

const s = await user("psize-s", "student");
const c = await user("psize-c");
await sql(`update public.profiles set counselor_id = '${c.id}' where id = '${s.id}'`);

// ---- PATCH /auth/me ---------------------------------------------------------------
const first = await call(s.token, "PATCH", "/auth/me", { profile: { k1: big(200_000) } });
check("a 200 KB profile save is accepted", first.status === 200, `status ${first.status}`);
const second = await call(s.token, "PATCH", "/auth/me", { profile: { k2: big(200_000) } });
check("a second 200 KB save under another key is refused: the merged value is over the bound", second.status === 400 && /too large/i.test(JSON.stringify(second.body)), `status ${second.status}`);
check("…and the stored profile didn't grow", (await size(s.id)) < 300_000, String(await size(s.id)));
const patchOnly = await call(s.token, "PATCH", "/auth/me", { profile: { k3: big(310_000) } });
check("a single patch over the bound is refused as before", patchOnly.status === 400, `status ${patchOnly.status}`);
const emoji = await call(s.token, "PATCH", "/auth/me", { profile: { k1: null, e: "😀".repeat(80_000) } });
check("a profile under the bound in characters but over it in bytes is refused", emoji.status === 400, `status ${emoji.status}`);

// ---- Straight through PostgREST ------------------------------------------------------
const direct = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { profile: { huge: big(500_000) } }, { Prefer: "return=minimal" });
check("a 500 KB profile written through PostgREST is refused by the database", direct.status >= 400, `status ${direct.status}`);
const directEmoji = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { profile: { e: "😀".repeat(90_000) } }, { Prefer: "return=minimal" });
check("…and so is one over the bound in bytes (four-byte characters)", directEmoji.status >= 400, `status ${directEmoji.status}`);
check("…and nothing was stored", (await size(s.id)) < 300_000, String(await size(s.id)));
const directOk = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { profile: { k1: big(1_000) } }, { Prefer: "return=minimal" });
check("a small profile through PostgREST still works", directOk.status < 300, `status ${directOk.status}`);

// Every other column the authenticated grant lets a student write.
const columns = {
  full_name: 200, hometown: 200, high_school: 200, title: 200, headline: 300,
  avatar_url: 2048, phone: 40, timezone: 80, grad_year: 10,
};
for (const [name, max] of Object.entries(columns)) {
  const over = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { [name]: big(2_000_000) }, { Prefer: "return=minimal" });
  check(`a 2 MB ${name} through PostgREST is refused`, over.status >= 400, `status ${over.status}`);
  // grad_year is also a four-digit year (20261024000052), so its longest accepted value is a year.
  const fits = name === "grad_year" ? "2027" : big(max);
  const atMax = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { [name]: fits }, { Prefer: "return=minimal" });
  check(`…while ${fits.length} characters of ${name} are accepted`, atMax.status < 300 && (await col(s.id, name)) === fits.length, `status ${atMax.status}`);
}
const oddYear = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { grad_year: big(10) }, { Prefer: "return=minimal" });
check("…and 10 characters of grad_year that aren't a year are refused", oddYear.status >= 400, `status ${oddYear.status}`);
await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { full_name: "Psize Student", phone: null, timezone: null, avatar_url: null }, { Prefer: "return=minimal" });

// Signup copies full_name and avatar_url from the user's own metadata: clipped, never refused.
{
  const email = `psize-meta-${Date.now()}@example.test`;
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password-123456", data: { full_name: big(1_000_000), avatar_url: `https://x.test/${big(5_000)}` } }),
  });
  check("a signup with a megabyte name still creates the account", r.status < 300, `status ${r.status}`);
  const row = (await sql(`select length(full_name) || '|' || coalesce(avatar_url, 'null') from public.profiles where email = '${email}'`)).trim();
  check("…with the name clipped to 200 characters and the overlong link dropped", row === "200|null", row);
}

// ---- The counselor's PATCH /students/:id ---------------------------------------------
await sql(`update public.profiles set profile = '{}'::jsonb where id = '${s.id}'`);
const c1 = await call(c.token, "PATCH", `/students/${s.id}`, { profile: { notes1: big(200_000) } });
check("the counselor's 200 KB profile save is accepted", c1.status === 200, `status ${c1.status}`);
const c2 = await call(c.token, "PATCH", `/students/${s.id}`, { profile: { notes2: big(200_000) } });
check("…and a second one under another key is refused", c2.status === 400, `status ${c2.status}`);
const c3 = await call(c.token, "PATCH", `/students/${s.id}`, { profile: { notes3: big(310_000) } });
check("a single counselor patch over the bound is refused", c3.status === 400, `status ${c3.status}`);

// ---- The API and the database agree on what fits ----------------------------------------
// A student fills the profile to just under the database's bound through PostgREST;
// the questionnaire save (PATCH /auth/me) and the counselor's edit still work as long
// as the result stays within the same bound.
await sql(`update public.profiles set profile = '{}'::jsonb where id = '${s.id}'`);
const near = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { profile: { pad: big(299_000) } }, { Prefer: "return=minimal" });
check("a 299 KB profile through PostgREST is within the database's bound", near.status < 300, `status ${near.status}`);
const intake = await call(s.token, "PATCH", "/auth/me", { profile: { intakeAnswers: { grade: "11th" } } });
check("…and the questionnaire save that adds a small key still goes through the API", intake.status === 200, `status ${intake.status}`);
const counselorEdit = await call(c.token, "PATCH", `/students/${s.id}`, { profile: { gradeLevel: "11th" } });
check("…as does the counselor's edit of that profile", counselorEdit.status === 200, `status ${counselorEdit.status}`);
const tooFar = await call(s.token, "PATCH", "/auth/me", { profile: { more: big(2_000) } });
check("…while a save past the shared bound is refused", tooFar.status === 400, `status ${tooFar.status}`);

// ---- A profile already over the bound ---------------------------------------------------
// Written past the trigger, as a profile saved before the bound existed would be.
await sql(`set session_replication_role = replica; update public.profiles set profile = jsonb_build_object('a', repeat('x', 300000), 'b', repeat('x', 300000)), headline = repeat('h', 5000) where id = '${s.id}'`);
const name = await call(s.token, "PATCH", "/auth/me", { fullName: "Still Editable" });
check("a profile over the bound doesn't block a name change", name.status === 200, `status ${name.status}`);
const grow = await call(s.token, "PATCH", "/auth/me", { profile: { c: "one more" } });
check("…it can't grow", grow.status === 400, `status ${grow.status}`);
const shrink = await call(s.token, "PATCH", "/auth/me", { profile: { b: null } });
check("…and it can shrink", shrink.status === 200 && (await size(s.id)) < 310_000, `status ${shrink.status}`);
const growDirect = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { profile: { a: big(300_000), b: big(300_000) } }, { Prefer: "return=minimal" });
check("…nor grow back through PostgREST", growDirect.status >= 400, `status ${growDirect.status}`);
const otherCol = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { full_name: "Other column" }, { Prefer: "return=minimal" });
check("…while its other columns stay writable through PostgREST", otherCol.status < 300, `status ${otherCol.status}`);
const headlineGrow = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { headline: big(6_000) }, { Prefer: "return=minimal" });
check("an overlong headline from before can't grow", headlineGrow.status >= 400, `status ${headlineGrow.status}`);
const headlineShrink = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { headline: big(4_000) }, { Prefer: "return=minimal" });
check("…but can shrink", headlineShrink.status < 300, `status ${headlineShrink.status}`);

// ---- The roster reads named columns -------------------------------------------------------
await sql(`update public.profiles set profile = '{"gradeLevel":"11th"}'::jsonb, headline = 'Hi', phone = '555-0100' where id = '${s.id}'`);
const roster = await call(c.token, "GET", "/students");
const row = Array.isArray(roster.body) ? roster.body.find((r) => r.id === s.id) : null;
check("the roster still lists the student with the card's fields", roster.status === 200 && row?.fullName === "Other column" && row?.profile?.headline === "Hi" && row?.profile?.gradeLevel === "11th", JSON.stringify(row)?.slice(0, 200));
