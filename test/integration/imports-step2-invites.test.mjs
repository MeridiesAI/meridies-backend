// Import pipeline step 2: invitations after commit (spec §5.1, §5.7, §6.5).
// Siblings on a parent's email are never both invited to it; a double send
// sends once; an item is tied to its invitation before the email; a first
// import over 50 invitations waits for Meridies; a new account's daily quota
// is halved; dismissing held data with a name mismatch needs no typed name.
import { call, check, rest, sql, user } from "./harness.mjs";
import { stagedImport, waitStatus } from "./imports-helpers.mjs";

const tag = Date.now();
const mail = (n) => `${n}-${tag}@test.local`;
const commit = async (u, id, n) => {
  const r = await call(u.token, "POST", `/imports/${id}/commit`, { invitations: n });
  if (r.status !== 202) throw new Error("commit " + JSON.stringify(r.body));
  return waitStatus(u.token, id, "committing");
};

// ---- siblings on a parent's email ----------------------------------------------------
const c = await user("imp2-inv");
const sib = await stagedImport(c, ["Email,Name,SAT", `${mail("parent")},Mia Park,1500`, `${mail("parent")},Leo Park,1100`].join("\n"));
check("siblings on a parent's email are both skipped, never invited", sib.stage.body.stats.skipped === 2 && sib.stage.body.stats.toInvite === 0, JSON.stringify(sib.stage.body.stats));
const [mia, leo] = (await call(c.token, "GET", `/imports/${sib.id}/review?section=skipped`)).body.items.sort((x, y) => x.importedName.localeCompare(y.importedName)).reverse();
const one = await call(c.token, "PATCH", `/imports/${sib.id}/review`, { items: { [mia.itemId]: { action: "invite" } } });
check("the counselor may invite one of them at that address", one.status === 200 && one.body.stats.toInvite === 1, JSON.stringify(one.body));
const two = await call(c.token, "PATCH", `/imports/${sib.id}/review`, { items: { [leo.itemId]: { action: "invite" } } });
check("but never both", two.status === 409 && /already being invited/.test(two.body.error), JSON.stringify(two.body));
await commit(c, sib.id, 1);
await call(c.token, "POST", `/imports/${sib.id}/invitations`);
const tok = await sql(`select i.token from public.import_items it join public.invitations i on i.id = it.invitation_id where it.id = '${mia.itemId}'`);
const acceptor = await user("imp2-inv-mia", "student");
await sql(`update public.profiles set full_name = 'Mia Park' where id = '${acceptor.id}'`);
await rest(acceptor.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: tok });
const held = (await call(c.token, "GET", "/imports/held")).body.filter((e) => e.studentId === acceptor.id);
check("only the invited sibling's data waits for the account that joined", held.length === 1 && held[0].itemId === mia.itemId, JSON.stringify(held).slice(0, 200));
check("the other sibling's data is held for nobody", (await sql(`select match_status || '|' || coalesce(student_id::text, '') from public.import_items where id = '${leo.itemId}'`)) === "skipped|");

// ---- a double send sends once ---------------------------------------------------------------
const three = await stagedImport(c, ["Email,Name,SAT", ...["a", "b", "c"].map((x) => `${mail("kid" + x)},Kid ${x.toUpperCase()}x,1200`)].join("\n"));
await commit(c, three.id, 3);
const [p1, p2] = await Promise.all([call(c.token, "POST", `/imports/${three.id}/invitations`), call(c.token, "POST", `/imports/${three.id}/invitations`)]);
const attempts = (p1.body.sent ?? 0) + (p1.body.failed ?? 0) + (p2.body.sent ?? 0) + (p2.body.failed ?? 0);
check("two tabs sending at once attempt each invitation once", attempts === 3, `${JSON.stringify(p1.body)} ${JSON.stringify(p2.body)}`);
const perAddress = await sql(`select string_agg(n::text, ',') from (select count(*) n from public.invitations where counselor_id = '${c.id}' and email in ('${mail("kida")}','${mail("kidb")}','${mail("kidc")}') group by email) q`);
check("one invitation per address", perAddress === "1,1,1", perAddress);
const tied = await sql(`select count(*) from public.import_items it join public.invitations i on i.id = it.invitation_id where it.import_id = '${three.id}' and lower(i.email) = lower(it.match_key ->> 'email')`);
check("every item is tied to its own invitation", tied === "3");
const deliveries = await sql(`select count(*) from public.message_deliveries d join public.import_items it on it.invitation_id = d.invitation_id where it.import_id = '${three.id}'`);
check("each email attempt is recorded against the invitation it carries", deliveries === "3", deliveries);
const item = await sql(`select id from public.import_items where import_id = '${three.id}' limit 1`);
const inv = await sql(`select invitation_id from public.import_items where id = '${item}'`);
const relink = await rest(c.token, "POST", "/rest/v1/rpc/import_link_invitation", { p_item: item, p_invitation: inv });
check("an item that isn't being sent can't be re-linked", relink.status !== 200 && relink.body?.code === "55000", JSON.stringify(relink.body));

// ---- a first import over 50 invitations waits; a new account's quota is 50 a day --------------
const big = await user("imp2-inv-big");
const rows = Array.from({ length: 51 }, (_, i) => `${mail("bulk" + i)},Bulk Student${String.fromCharCode(65 + (i % 26))}${i},1200`);
const b = await stagedImport(big, ["Email,Name,SAT", ...rows].join("\n"));
check("51 to invite", b.stage.body.stats.toInvite === 51, JSON.stringify(b.stage.body.stats));
await commit(big, b.id, 51);
check("the save goes through", (await sql(`select status from public.roster_imports where id = '${b.id}'`)) === "committed");
const waiting = await call(big.token, "POST", `/imports/${b.id}/invitations`);
check("its invitations wait for a check from Meridies", waiting.status === 200 && waiting.body.held === true && /quick check/.test(waiting.body.reason), JSON.stringify(waiting.body));
check("the history says so", (await call(big.token, "GET", "/imports")).body.imports.find((i) => i.id === b.id)?.invitations.held === true);
const client = await rest(big.token, "PATCH", `/rest/v1/roster_imports?id=eq.${b.id}`, { invites_approved_at: new Date().toISOString() });
check("the counselor can't approve their own", client.status === 403);
await sql(`update public.roster_imports set invites_approved_at = now() where id = '${b.id}'`);
const r1 = await call(big.token, "POST", `/imports/${b.id}/invitations`);
const r2 = await call(big.token, "POST", `/imports/${b.id}/invitations`);
check("approved, they go out in batches", r1.status === 200 && r2.status === 200 && r1.body.sent + r1.body.failed === 25 && r2.body.sent + r2.body.failed === 25, `${JSON.stringify(r1.body)} ${JSON.stringify(r2.body)}`);
check("addresses never tried go before retries of failed ones", (await sql(`select count(*) from public.import_items where import_id = '${b.id}' and invitation_id is not null`)) === "50");
const r3 = await call(big.token, "POST", `/imports/${b.id}/invitations`);
check("a counselor account under 14 days old sends at most 50 a day", r3.status === 429, `status ${r3.status} ${JSON.stringify(r3.body)}`);

// ---- dismissing held data with a name mismatch --------------------------------------------------
const d = await stagedImport(c, ["Email,Name,SAT", `${mail("dismiss")},Jordan Lake,1310`].join("\n"));
await commit(c, d.id, 1);
await call(c.token, "POST", `/imports/${d.id}/invitations`);
const dtok = await sql(`select i.token from public.import_items it join public.invitations i on i.id = it.invitation_id where it.import_id = '${d.id}'`);
const stranger = await user("imp2-inv-stranger", "student");
await sql(`update public.profiles set full_name = 'Somebody Else' where id = '${stranger.id}'`);
await rest(stranger.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: dtok });
const entry = (await call(c.token, "GET", "/imports/held")).body.find((e) => e.studentId === stranger.id);
check("the mismatch is flagged", entry?.nameMismatch === true);
const decisions = Object.fromEntries(entry.changes.map((ch) => [ch.id, "reject"]));
const dismissed = await call(c.token, "POST", `/imports/held/${entry.itemId}/apply`, { decisions });
check("Dismiss (every change rejected) needs no typed name", dismissed.status === 202, JSON.stringify(dismissed.body));
const partial = Object.fromEntries(entry.changes.map((ch, i) => [ch.id, i === 0 ? "accept" : "reject"]));
const accept = await call(c.token, "POST", `/imports/held/${entry.itemId}/apply`, { decisions: partial });
check("applying anything still needs it (or the item has gone)", accept.status === 409 || accept.status === 404, `status ${accept.status}`);
for (let i = 0; i < 40 && (await sql(`select match_status from public.import_items where id = '${entry.itemId}'`)) === "applying"; i++) await new Promise((r) => setTimeout(r, 250));
check("dismissed data writes nothing", (await sql(`select coalesce((select sat_superscore::text from public.student_academics where student_id = '${stranger.id}'), 'none')`)) === "none");
