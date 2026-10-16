// The 200,000-character bound on profiles.profile (lib/profileSize.ts and
// 20261024000081): the API measures the merged value, not the patch, on both
// PATCH /auth/me and the counselor's PATCH /students/:id, and the database
// refuses an oversized write that comes straight through PostgREST. A profile
// already over the bound can shrink, and its other columns stay writable.
import { call, check, rest, sql, user } from "./harness.mjs";

const big = (n) => "x".repeat(n);
const size = async (id) => Number(await sql(`select coalesce(length(profile::text), 0) from public.profiles where id = '${id}'`));

const s = await user("psize-s", "student");
const c = await user("psize-c");
await sql(`update public.profiles set counselor_id = '${c.id}' where id = '${s.id}'`);

// ---- PATCH /auth/me ---------------------------------------------------------------
const first = await call(s.token, "PATCH", "/auth/me", { profile: { k1: big(150_000) } });
check("a 150 KB profile save is accepted", first.status === 200, `status ${first.status}`);
const second = await call(s.token, "PATCH", "/auth/me", { profile: { k2: big(150_000) } });
check("a second 150 KB save under another key is refused: the merged value is over the bound", second.status === 400 && /too large/i.test(JSON.stringify(second.body)), `status ${second.status}`);
check("…and the stored profile didn't grow", (await size(s.id)) < 200_000, String(await size(s.id)));
const patchOnly = await call(s.token, "PATCH", "/auth/me", { profile: { k3: big(210_000) } });
check("a single patch over the bound is refused as before", patchOnly.status === 400, `status ${patchOnly.status}`);

// ---- Straight through PostgREST ------------------------------------------------------
const direct = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { profile: { huge: big(500_000) } }, { Prefer: "return=minimal" });
check("a 500 KB profile written through PostgREST is refused by the database", direct.status >= 400, `status ${direct.status}`);
check("…and nothing was stored", (await size(s.id)) < 200_000, String(await size(s.id)));
const directOk = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { profile: { k1: big(1_000) } }, { Prefer: "return=minimal" });
check("a small profile through PostgREST still works", directOk.status < 300, `status ${directOk.status}`);

// ---- The counselor's PATCH /students/:id ---------------------------------------------
const c1 = await call(c.token, "PATCH", `/students/${s.id}`, { profile: { notes1: big(150_000) } });
check("the counselor's 150 KB profile save is accepted", c1.status === 200, `status ${c1.status}`);
const c2 = await call(c.token, "PATCH", `/students/${s.id}`, { profile: { notes2: big(150_000) } });
check("…and a second one under another key is refused", c2.status === 400, `status ${c2.status}`);
const c3 = await call(c.token, "PATCH", `/students/${s.id}`, { profile: { notes3: big(250_000) } });
check("a single counselor patch over the bound is refused", c3.status === 400, `status ${c3.status}`);

// ---- A profile already over the bound ---------------------------------------------------
// Written past the trigger, as a profile saved before the bound existed would be.
await sql(`set session_replication_role = replica; update public.profiles set profile = jsonb_build_object('a', repeat('x', 300000), 'b', repeat('x', 300000)) where id = '${s.id}'`);
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
