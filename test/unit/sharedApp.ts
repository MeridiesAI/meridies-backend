// One Fastify app per test process: building and readying it costs more than most tests that use it.
// For tests that only inject requests and change no app state. A test that needs its own env or plugins
// builds its own (axis-eval-clock).
import { after } from "node:test";
import { buildApp } from "../../src/app.js";

let app: Promise<ReturnType<typeof buildApp>> | null = null;

// Registered when the test file imports this module, so it runs once after the file's last test
// (an `after` registered inside a test would close the app when that test ends).
after(async () => {
  if (app) await (await app).close();
});

export function sharedApp(): Promise<ReturnType<typeof buildApp>> {
  app ??= (async () => {
    const built = buildApp();
    await built.ready();
    return built;
  })();
  return app;
}
