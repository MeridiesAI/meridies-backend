// Default meeting type (20261125000001): an approved counselor starts with one "Meeting" type, 30 minutes,
// seeded at approval; it is never made again after they delete it; an unapproved counselor has none.
import { user, call, check, sql } from "./harness.mjs";

const typesOf = (id) => sql(`select coalesce(json_agg(json_build_object('name', name, 'minutes', duration_minutes, 'mode', mode, 'active', active, 'sort', sort_order)), '[]') from public.booking_meeting_types where counselor_id = '${id}'`).then(JSON.parse);
const approve = (id) => sql(`update public.profiles set counselor_approved_at = now(), counselor_approved_via = 'team' where id = '${id}'`);

const A = await user("dt-a", "counselor", { approved: false });
check("an unapproved counselor has no meeting type", (await typesOf(A.id)).length === 0);

await approve(A.id);
const seeded = await typesOf(A.id);
check("approval seeds one 30-minute Meeting type, Google Meet, active, first", seeded.length === 1 && seeded[0].name === "Meeting" && seeded[0].minutes === 30 && seeded[0].mode === "google-meet" && seeded[0].active === true && seeded[0].sort === 0, JSON.stringify(seeded));

const list = await call(A.token, "GET", "/booking/types");
check("the counselor sees it in their own list", list.status === 200 && list.body.types.length === 1 && list.body.types[0].name === "Meeting", JSON.stringify(list.body));

// Booking stays off: the default type alone changes nothing for a student.
const settings = await call(A.token, "GET", "/booking/settings");
check("booking is still off until the counselor switches it on", settings.status === 200 && settings.body.enabled === false, JSON.stringify(settings.body));

// Deleting it sticks: a later profile update (and a second approval write) doesn't bring it back.
const del = await call(A.token, "DELETE", `/booking/types/${list.body.types[0].id}`);
check("a counselor deletes it", del.status === 200 && (await typesOf(A.id)).length === 0, JSON.stringify(del.body));
await sql(`update public.profiles set full_name = 'Dt A renamed' where id = '${A.id}'`);
await approve(A.id);
check("it is not made again after a delete", (await typesOf(A.id)).length === 0);

// A counselor who already has a type of their own (renamed or not) is left alone by the seed function.
const B = await user("dt-b", "counselor", { approved: false });
await sql(`insert into public.booking_meeting_types (counselor_id, name, duration_minutes, mode) values ('${B.id}', 'Essay review', 45, 'phone')`);
await approve(B.id);
const bTypes = await typesOf(B.id);
check("a counselor who already has a type gets no extra one", bTypes.length === 1 && bTypes[0].name === "Essay review", JSON.stringify(bTypes));

// The backfill: calling the seed again for a counselor with none makes exactly one; again, still one.
const C = await user("dt-c", "counselor");
await sql(`delete from public.booking_meeting_types where counselor_id = '${C.id}'`);
await sql(`select private.seed_default_booking_type('${C.id}')`);
await sql(`select private.seed_default_booking_type('${C.id}')`);
check("the seed function is idempotent", (await typesOf(C.id)).length === 1);

// A student, or a counselor who isn't approved, never gets one from the function.
const S = await user("dt-s", "student");
await sql(`select private.seed_default_booking_type('${S.id}')`);
const P = await user("dt-p", "counselor", { approved: false });
await sql(`select private.seed_default_booking_type('${P.id}')`);
check("a student or an unapproved counselor gets none from the function", (await typesOf(S.id)).length === 0 && (await typesOf(P.id)).length === 0);
