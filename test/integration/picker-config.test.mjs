// Local stack has no Google settings: the Picker is "not configured".
import { call, check, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("picker");
const pending = await user("picker-pending", "counselor", { approved: false });
const s = await studentOf(c, "picker-student");

const r = await call(c.token, "GET", "/integrations/google/picker-config");
check("without settings the API says Drive isn't set up, naming the setting", r.status === 503 && r.body?.code === "picker_not_configured" && /GOOGLE_/.test(r.body?.error ?? ""), JSON.stringify(r.body));
const prov = await call(c.token, "GET", "/integrations/providers");
check("providers report the Picker as not ready", prov.status === 200 && prov.body.find((p) => p.provider === "google")?.pickerReady === false, JSON.stringify(prov.body));
const st = await call(s.token, "GET", "/integrations/google/picker-config");
check("a student can't read the Picker settings", st.status === 403, `status ${st.status}`);
const p = await call(pending.token, "GET", "/integrations/google/picker-config");
check("an unapproved counselor can't either", p.status === 403, `status ${p.status}`);
