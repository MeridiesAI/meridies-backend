import { buildApp } from "./app.js";
import { env } from "./env.js";
import { bookingBusyFixtureRefusal } from "./lib/booking.js";
import { verifyImportWorkerAtBoot } from "./lib/imports/db.js";
import { researchFakeRefusal } from "./lib/research/bootGuard.js";
import { meetingSummaryFakeRefusal } from "./lib/meetingSummary.js";
import { translateFakeRefusal } from "./lib/translate.js";
import { accessibilityFakeRefusal } from "./lib/collegeAccessibility.js";
import { evalClockRefusal } from "./lib/axis/clock.js";
import { driveFakeRefusal } from "./lib/driveExport.js";
import { listMatchEnabled } from "./lib/listMatchLoad.js";

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

// And for the accessibility research double: it would store college facts no page said.
const accessibilityRefusal = accessibilityFakeRefusal({ ACCESSIBILITY_FAKE: env.ACCESSIBILITY_FAKE, NODE_ENV: process.env.NODE_ENV });
if (accessibilityRefusal) {
  app.log.error(accessibilityRefusal);
  process.exit(1);
}
if (env.ACCESSIBILITY_FAKE) app.log.warn("ACCESSIBILITY_FAKE is on: accessibility research returns canned fixtures");

// The evals' clock: only on a local stack and never in production, read raw like the doubles above.
const clockRefusal = evalClockRefusal({ AXIS_EVAL_CLOCK: env.AXIS_EVAL_CLOCK, NODE_ENV: process.env.NODE_ENV, SUPABASE_URL: env.SUPABASE_URL });
if (clockRefusal) {
  app.log.error(clockRefusal);
  process.exit(1);
}
if (env.AXIS_EVAL_CLOCK) app.log.warn("AXIS_EVAL_CLOCK is on: AxIS's clock can be moved forward (evals only)");

// And for the meeting-summary double: it would hand a counselor a summary no model wrote.
const summaryRefusal = meetingSummaryFakeRefusal({ MEETING_SUMMARY_FAKE: env.MEETING_SUMMARY_FAKE, NODE_ENV: process.env.NODE_ENV });
if (summaryRefusal) {
  app.log.error(summaryRefusal);
  process.exit(1);
}
if (env.MEETING_SUMMARY_FAKE) app.log.warn("MEETING_SUMMARY_FAKE is on: meeting summaries are canned, not a model's");
// And for the Drive export double: it would answer a counselor with a Sheet link that doesn't exist.
const driveRefusal = driveFakeRefusal({ DRIVE_EXPORT_FAKE: env.DRIVE_EXPORT_FAKE, NODE_ENV: process.env.NODE_ENV });
if (driveRefusal) {
  app.log.error(driveRefusal);
  process.exit(1);
}
if (env.DRIVE_EXPORT_FAKE) app.log.warn("DRIVE_EXPORT_FAKE is on: Sheets exports are not sent to Google");
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

// List matching embeds a student's interest paragraph during a list-builder request: load the model now (about
// 130 MB, downloaded again on each Railway deploy) so the first list doesn't wait for it. Off with the flag, so an
// instance that doesn't match never loads it. Never fails boot; a failed load is retried by the first embed().
if (listMatchEnabled()) {
  const warnLoad = (err: unknown) =>
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "List match: the embedding model didn't load at boot; the first list will try again");
  void import("./lib/embeddings.js")
    .then(({ warmEmbeddings }) => warmEmbeddings(warnLoad))
    .then((ready) => {
      if (ready) app.log.info("List match: embedding model loaded");
    })
    .catch(warnLoad);
}

// Shutdown. app.close() stops accepting connections and waits for every request in flight, so one
// hung request or an open AxIS stream could hold it until the platform's SIGKILL: past the deadline
// the process logs and exits on its own. A second signal while closing changes nothing.
const SHUTDOWN_DEADLINE_MS = 25_000;
let closing = false;

function shutdown(reason: string, exitCode: number): void {
  if (closing) return;
  closing = true;
  app.log.info({ reason }, "shutting down");
  setTimeout(() => {
    app.log.error({ reason }, `shutdown did not finish within ${SHUTDOWN_DEADLINE_MS / 1000} seconds; exiting`);
    process.exit(exitCode);
  }, SHUTDOWN_DEADLINE_MS).unref();
  app.close().then(
    () => process.exit(exitCode),
    (err: unknown) => {
      app.log.error({ err }, "closing the server failed");
      process.exit(1);
    }
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal, 0));
}

// A promise nobody awaited that rejects (background work started with `void`) is logged and the
// process keeps serving: by default Node exits on one, dropping every tenant's requests in flight.
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandled promise rejection");
});

// A thrown error nothing caught leaves the process in an unknown state: log it, close as above, exit 1.
process.on("uncaughtException", (err) => {
  app.log.fatal({ err }, "uncaught exception; shutting down");
  shutdown("uncaughtException", 1);
});
