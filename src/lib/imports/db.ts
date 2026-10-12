/**
 * The import pipeline's database connection (spec §6.2).
 *
 * Save, undo and applying held data run as one transaction each, longer than
 * an HTTP request through PostgREST may last, so they use a direct `pg`
 * connection. That connection must log in as `import_worker`, a role that
 * can execute the job functions and nothing else. A pasted superuser string
 * would bypass every access rule, so it is refused at boot and before the
 * first job in each process.
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { env } from "../../env.js";
import { redactText } from "../requestLog.js";

export type Queryable = {
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export class ImportWorkerUnavailable extends Error {
  constructor(message = "IMPORT_DATABASE_URL is not set") {
    super(message);
    this.name = "ImportWorkerUnavailable";
  }
}

export class WrongWorkerRoleError extends Error {
  constructor(actual: string) {
    super(`IMPORT_DATABASE_URL must log in as import_worker, not ${actual}`);
    this.name = "WrongWorkerRoleError";
  }
}

let pool: Pool | null = null;
let verified: Promise<void> | null = null;

export function importPool(): Pool | null {
  if (!env.IMPORT_DATABASE_URL) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.IMPORT_DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "meridies-import-worker",
    });
    // An idle client dropped by the pooler must not crash the process.
    // Log the code and message only, never the connection string.
    pool.on("error", (err) => {
      console.error("import worker pool error", { code: (err as { code?: string }).code, message: redactText(err.message) });
    });
  }
  return pool;
}

export async function assertWorkerRole(client: Queryable): Promise<void> {
  const { rows } = await client.query("select current_user");
  const actual = String(rows[0]?.current_user ?? "unknown");
  if (actual !== "import_worker") throw new WrongWorkerRoleError(actual);
}

/** One transaction on the worker connection, with the job statement timeout. */
export async function withWorkerTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = importPool();
  if (!p) throw new ImportWorkerUnavailable();
  const client = await p.connect();
  try {
    verified ??= assertWorkerRole(client).catch((err: unknown) => {
      verified = null;
      throw err;
    });
    await verified;
    await client.query("begin");
    await client.query("set local statement_timeout = '300s'");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type BootLog = { info: (m: string) => void; error: (o: object, m?: string) => void };

/**
 * Called once at boot. A wrong role is fatal (exit 1); an unreachable
 * database only disables imports until it answers.
 */
export async function verifyImportWorkerAtBoot(log: BootLog): Promise<void> {
  const p = importPool();
  if (!p) {
    log.info("IMPORT_DATABASE_URL unset: import save/undo/apply are disabled");
    return;
  }
  try {
    const client = await p.connect();
    try {
      await assertWorkerRole(client);
      log.info("import worker connection verified (import_worker)");
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof WrongWorkerRoleError) {
      log.error({ err: redactText(err.message) }, "refusing to start: IMPORT_DATABASE_URL is not the import_worker login");
      process.exit(1);
    }
    log.error({ err }, "import worker connection failed at boot; imports will retry per job");
  }
}
