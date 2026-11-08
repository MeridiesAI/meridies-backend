import { buildApp } from "./app.js";
import { env } from "./env.js";
import { verifyImportWorkerAtBoot } from "./lib/imports/db.js";
import { researchFakeRefusal } from "./lib/research/bootGuard.js";
import { meetingSummaryFakeRefusal } from "./lib/meetingSummary.js";
import { translateFakeRefusal } from "./lib/translate.js";

const app = buildApp();

// The research test double must never run for real counselors: only with NODE_ENV=development or test, read raw
// (env.NODE_ENV defaults to development when unset).
const refusal = researchFakeRefusal({ RESEARCH_FAKE: env.RESEARCH_FAKE, NODE_ENV: process.env.NODE_ENV });
if (refusal) {
  app.log.error(refusal);
  process.exit(1);
}
if (env.RESEARCH_FAKE) app.log.warn("RESEARCH_FAKE is on: research returns canned fixtures, not real results");

// Same rule for the translation double: it would send families text no model translated.
const translateRefusal = translateFakeRefusal({ TRANSLATE_FAKE: env.TRANSLATE_FAKE, NODE_ENV: process.env.NODE_ENV });
if (translateRefusal) {
  app.log.error(translateRefusal);
  process.exit(1);
}
if (env.TRANSLATE_FAKE) app.log.warn("TRANSLATE_FAKE is on: translations are canned, not a model's");

// And for the meeting-summary double: it would hand a counselor a summary no model wrote.
const summaryRefusal = meetingSummaryFakeRefusal({ MEETING_SUMMARY_FAKE: env.MEETING_SUMMARY_FAKE, NODE_ENV: process.env.NODE_ENV });
if (summaryRefusal) {
  app.log.error(summaryRefusal);
  process.exit(1);
}
if (env.MEETING_SUMMARY_FAKE) app.log.warn("MEETING_SUMMARY_FAKE is on: meeting summaries are canned, not a model's");

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
