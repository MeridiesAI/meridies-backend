import { buildApp } from "./app.js";
import { env } from "./env.js";
import { verifyImportWorkerAtBoot } from "./lib/imports/db.js";
import { researchFakeRefusal } from "./lib/research/bootGuard.js";

const app = buildApp();

// The research test double must never run for real counselors: only with NODE_ENV=development or test, read raw
// (env.NODE_ENV defaults to development when unset).
const refusal = researchFakeRefusal({ RESEARCH_FAKE: env.RESEARCH_FAKE, NODE_ENV: process.env.NODE_ENV });
if (refusal) {
  app.log.error(refusal);
  process.exit(1);
}
if (env.RESEARCH_FAKE) app.log.warn("RESEARCH_FAKE is on: research returns canned fixtures, not real results");

await verifyImportWorkerAtBoot(app.log);

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
