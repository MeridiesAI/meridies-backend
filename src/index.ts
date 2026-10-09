import { buildApp } from "./app.js";
import { env } from "./env.js";
import { verifyImportWorkerAtBoot } from "./lib/imports/db.js";

const app = buildApp();

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
