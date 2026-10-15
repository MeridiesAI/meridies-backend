// Smoke test of the BUILT import parser (dist/), which the unit tests can't
// reach: they run the TypeScript source through tsx. Run after `npm run build`:
//   node scripts/smoke/parse-worker.mjs
// CI runs it, so a worker path that only works under tsx fails the build.
import { parseInWorker } from "../../dist/lib/imports/parse.js";

const csv = new TextEncoder().encode("Name,Email,GPA\nJane Doe,jane@example.org,3.8\n");
const out = await parseInWorker(csv, "smoke.csv", { maxRows: 5000 });
if (!out.ok || out.sheets[0].rows[0][2] !== "3.8") {
  console.error("parse worker smoke test failed", JSON.stringify(out));
  process.exit(1);
}
const timeout = await parseInWorker(csv, "smoke.csv", { maxRows: 5000, timeoutMs: 1 });
if (timeout.ok || timeout.reason !== "timeout") {
  console.error("parse worker timeout smoke test failed", JSON.stringify(timeout));
  process.exit(1);
}
console.log("parse worker (built) OK");
