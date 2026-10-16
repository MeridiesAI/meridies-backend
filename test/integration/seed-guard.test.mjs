// The seed's local-only guard (scripts/seed/local-only.mjs) checks DB_URL, but
// libpq also takes a host from the environment: PGHOSTADDR (used when the URL
// has no hostaddr) or a service file named by PGSERVICE. Either would send the
// seed's psql writes (approved fake counselors, Meridies-wide events) to
// another server while DB_URL still reads 127.0.0.1. The seed's psql must
// ignore them, and run no startup file (PSQLRC, ~/.psqlrc), since a startup
// file can \connect to another server before the query runs. 192.0.2.1 is
// TEST-NET-1: nothing answers there.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "./harness.mjs";

process.env.PGCONNECT_TIMEOUT = "3";
const { sql } = await import("../../scripts/seed/e2e-stack.mjs");

const attempt = (label) => {
  try {
    return sql("select 'local'");
  } catch (e) {
    return `error: ${String(e?.message ?? e).split("\n")[0]}`;
  }
};

process.env.PGHOSTADDR = "192.0.2.1";
check("with PGHOSTADDR set elsewhere, the seed's psql still reaches the local stack", attempt() === "local", attempt());
delete process.env.PGHOSTADDR;

const dir = mkdtempSync(join(tmpdir(), "seed-guard-"));
writeFileSync(join(dir, "pg_service.conf"), "[elsewhere]\nhostaddr=192.0.2.1\n");
process.env.PGSERVICEFILE = join(dir, "pg_service.conf");
process.env.PGSERVICE = "elsewhere";
check("with a service file naming another hostaddr, the seed's psql still reaches the local stack", attempt() === "local", attempt());
delete process.env.PGSERVICE;
delete process.env.PGSERVICEFILE;

writeFileSync(join(dir, "evil.psqlrc"), "\\set QUIET 1\n\\connect postgresql://postgres@192.0.2.1/postgres\n");
process.env.PSQLRC = join(dir, "evil.psqlrc");
check("with PSQLRC naming a startup file that connects elsewhere, the seed's psql still reaches the local stack", attempt() === "local", attempt());
delete process.env.PSQLRC;

const home = mkdtempSync(join(tmpdir(), "seed-guard-home-"));
writeFileSync(join(home, ".psqlrc"), "\\set QUIET 1\n\\connect postgresql://postgres@192.0.2.1/postgres\n");
const realHome = process.env.HOME;
process.env.HOME = home;
check("with a ~/.psqlrc that connects elsewhere, the seed's psql still reaches the local stack", attempt() === "local", attempt());
process.env.HOME = realHome;
