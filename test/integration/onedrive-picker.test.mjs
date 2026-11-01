// OneDrive picker (spec docs/superpowers/specs/2026-11-01-onedrive-picker-design.md).
// The local stack and CI have no Microsoft settings, so the picker is "not configured";
// the token exchange itself is unit-tested (test/unit/onedrive-picker.test.ts).
import { API, call, check, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("odpicker");
const pending = await user("odpicker-pending", "counselor", { approved: false });
const s = await studentOf(c, "odpicker-student");

const r = await call(c.token, "GET", "/integrations/microsoft/picker-session");
check(
  "without settings the API says Microsoft isn't set up, naming the setting",
  r.status === 503 && r.body?.code === "picker_not_configured" && /MICROSOFT_/.test(r.body?.error ?? ""),
  JSON.stringify(r.body)
);

const raw = await fetch(`${API}/integrations/microsoft/picker-session`, { headers: { Authorization: `Bearer ${c.token}` } });
check("the picker session is never cached", (raw.headers.get("cache-control") ?? "").includes("no-store"), raw.headers.get("cache-control") ?? "none");

const st = await call(s.token, "GET", "/integrations/microsoft/picker-session");
check("a student can't open a OneDrive picker session", st.status === 403, `status ${st.status}`);
const p = await call(pending.token, "GET", "/integrations/microsoft/picker-session");
check("an unapproved counselor can't either", p.status === 403, `status ${p.status}`);

const list = await call(c.token, "GET", "/integrations/microsoft/files");
check("OneDrive has no file list: files are chosen in Microsoft's picker", list.status === 410 && list.body?.code === "use_picker", JSON.stringify(list.body));
const g = await call(c.token, "GET", "/integrations/google/files");
check("Google's recently-added list is still served (here: not set up)", g.status !== 410 && g.status !== 404, `status ${g.status}`);
