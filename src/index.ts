import { buildApp } from "./app.js";
import { env } from "./env.js";
import { bookingBusyFixtureRefusal } from "./lib/booking.js";
import { verifyImportWorkerAtBoot } from "./lib/imports/db.js";
import { researchFakeRefusal } from "./lib/research/bootGuard.js";
import { translateFakeRefusal } from "./lib/translate.js";
import { evalClockRefusal } from "./lib/axis/clock.js";

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

// The evals' clock: only on a local stack and never in production, read raw like the doubles above.
const clockRefusal = evalClockRefusal({ AXIS_EVAL_CLOCK: env.AXIS_EVAL_CLOCK, NODE_ENV: process.env.NODE_ENV, SUPABASE_URL: env.SUPABASE_URL });
if (clockRefusal) {
  app.log.error(clockRefusal);
  process.exit(1);
}
if (env.AXIS_EVAL_CLOCK) app.log.warn("AXIS_EVAL_CLOCK is on: AxIS's clock can be moved forward (evals only)");

// And for the booking busy-time stand-in: it would offer students slots over a counselor's real calendar.
const busyRefusal = bookingBusyFixtureRefusal({ BOOKING_BUSY_FIXTURE: env.BOOKING_BUSY_FIXTURE, NODE_ENV: process.env.NODE_ENV });
if (busyRefusal) {
  app.log.error(busyRefusal);
  process.exit(1);
}
if (env.BOOKING_BUSY_FIXTURE) app.log.warn("BOOKING_BUSY_FIXTURE is on: calendar busy time is read from a file, not Google or Microsoft");

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
