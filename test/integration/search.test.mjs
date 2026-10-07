import { user, call, check, sql, API } from "./harness.mjs";
const c = await user("counselor-search");
const r1 = await fetch(API + "/colleges/search?q=berkly", { headers: { Authorization: `Bearer ${c.token}` } });
const b1 = await r1.json();
check("old-style call still returns an array", Array.isArray(b1) && b1[0]?.name === "University of California, Berkeley", b1.map?.((x) => x.name).join(", "));
check("total header", r1.headers.get("x-total-count") === String(b1.length), r1.headers.get("x-total-count"));
check("card keeps its old fields", ["id", "name", "slug", "profiled", "netPrice"].every((k) => k in b1[0]));
check("card gains official stats", b1[0].official?.admitRate > 0, JSON.stringify(b1[0].official).slice(0, 120));
const empty = await call(c.token, "GET", "/colleges/search?q=");
check("no words and no filters is still []", Array.isArray(empty.body) && empty.body.length === 0);

const r2 = await fetch(API + "/colleges/search?states=NY,PA,MA&limit=5&sort=admit-rate", { headers: { Authorization: `Bearer ${c.token}` } });
const b2 = await r2.json();
const next = r2.headers.get("x-next-cursor");
check("filter browse pages", b2.length === 5 && !!next && b2.every((x) => ["NY", "PA", "MA"].includes(x.state)), `${r2.headers.get("x-total-count")} total, next ${next}`);
const ar = b2.map((x) => x.official?.admitRate ?? x.acceptanceRate ?? 1);
check("sorted by admit rate", ar.every((v, i) => i === 0 || v >= ar[i - 1]), ar.join(","));
const r3 = await call(c.token, "GET", `/colleges/search?states=NY,PA,MA&limit=5&sort=admit-rate&cursor=${next}`);
check("next page differs", r3.body.length > 0 && r3.body[0].id !== b2[0].id && !b2.some((x) => x.id === r3.body[0].id));

const bad = await call(c.token, "GET", "/colleges/search?states=California");
check("bad filter is 400, not 500", bad.status === 400, `status ${bad.status}`);
const unknown = await call(c.token, "GET", "/colleges/search?q=x&evil=1");
check("unknown param is 400", unknown.status === 400);

// fit for a student on the roster
const s = await user("student-fit", "student");
await sql(`update profiles set counselor_id='${c.id}' where id='${s.id}'`);
await sql(`insert into student_academics (student_id, sat_superscore, gpa_unweighted) values ('${s.id}', 1500, 3.9) on conflict (student_id) do update set sat_superscore=1500, gpa_unweighted=3.9`);
const f = await call(c.token, "GET", `/colleges/search?states=NY,PA,MA,CA&studentId=${s.id}&limit=50`);
check("fit labels with a student", f.status === 200 && f.body.some((x) => x.fit) && f.body.every((x) => x.fit === null || x.fitSource === "meridies-estimate"), `status ${f.status} ${f.body?.slice?.(0, 4).map((x) => x.name + ":" + x.fit).join(", ")}`);
const reach = await call(c.token, "GET", `/colleges/search?states=NY,PA,MA,CA&studentId=${s.id}&fit=reach&limit=50`);
check("fit filter", reach.body.length > 0 && reach.body.every((x) => x.fit === "reach"), `${reach.body.length} reach`);
const other = await user("counselor-other");
const stolen = await call(other.token, "GET", `/colleges/search?states=CA&studentId=${s.id}`);
check("another counselor can't use my student", stolen.status === 404 || stolen.status === 403, `status ${stolen.status}`);
const stu = await call(s.token, "GET", `/colleges/search?states=CA&studentId=${s.id}`);
check("a student can't ask for fit", stu.status === 400);

const facets = await call(c.token, "GET", "/colleges/filters");
check("facets", facets.status === 200 && facets.body.total >= 40 && facets.body.states.NY > 0, JSON.stringify(facets.body).slice(0, 120));

// /recommended with hand-typed names
await sql(`insert into student_colleges (student_id, name) values ('${s.id}', 'UPenn'), ('${s.id}', 'Cal Tech'), ('${s.id}', 'Some Unknown School')`);
const rec = await call(c.token, "GET", "/colleges/recommended");
const listed = rec.body.filter((x) => x.students.length);
check("recommended matches typed names", listed.some((x) => x.slug === "penn") && listed.some((x) => x.slug === "caltech"), listed.map((x) => x.slug).join(","));
