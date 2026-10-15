#!/usr/bin/env node
/**
 * The "Apply migrations" workflow's reader (.github/workflows/migrations.yml).
 * Plain Node, no dependencies, so the workflow needs no `npm ci`.
 *
 * It reads what the Supabase CLI printed, never the database itself, and it
 * fails closed: output it can't read is an error, never "nothing to do".
 * The CLI is run with `--agent no --output-format json`, because with agent
 * detection on (`--agent auto`, the default) the same command prints a
 * different shape depending on who runs it. The fixtures in test/fixtures were
 * captured from CLI 2.121.0 that way.
 *
 *   plan   --dry-run <stdout file> --exit-code <n> [--dir supabase/migrations]
 *          [--summary <file>] [--outputs <file>] [--mode push|workflow_dispatch]
 *          [--sha <commit>] [--expect-hash <hash>]
 *       Reads `supabase db push --dry-run`. Writes the run summary (the files,
 *       what each says it does, destructive statements) and the job outputs
 *       pending, count, newest, hash. With --expect-hash, refuses when the
 *       pending list is no longer the one the plan showed.
 *
 *   gate   --after <json> [--before <json>] [--summary <file>] [--warn-only]
 *          Reads `supabase db query -f scripts/migrations/problems.sql`: public
 *          tables without RLS or the approval gate. With --before, fails only on
 *          a problem that wasn't there before the apply; --warn-only never fails.
 *
 *   pooler --file supabase/.temp/pooler-url [--summary <file>]
 *          Prints the host and port the CLI linked through (never the user or
 *          password), and warns on the transaction pooler's port.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FILE_RE = /^(\d{14})_[a-z0-9_]+\.sql$/;

/**
 * The last JSON value in `text`: the whole text, or else the last line that
 * parses on its own. Null when none does.
 */
export function lastJson(text) {
  const whole = String(text ?? "").trim();
  if (!whole) return null;
  try {
    return JSON.parse(whole);
  } catch {
    // fall through to line by line
  }
  const lines = whole.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * What a dry run said.
 *   { kind: "pending", files }       migrations to apply (files may be empty only when upToDate)
 *   { kind: "up-to-date" }
 *   { kind: "out-of-order", files }  a pending file is older than production's newest (DbPushMissingRemoteError)
 *   { kind: "cli-error", code }      any other error the CLI reported
 *   { kind: "unreadable", reason }
 */
export function parseDryRun(stdout, exitCode = 0) {
  const v = lastJson(stdout);
  if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "unreadable", reason: "no JSON result in the CLI output" };
  if (v._tag === "Error") {
    const err = v.error && typeof v.error === "object" ? v.error : {};
    const code = typeof err.code === "string" ? err.code : "unknown";
    if (code === "DbPushMissingRemoteError") {
      const text = `${typeof err.suggestion === "string" ? err.suggestion : ""}`;
      const files = [...text.matchAll(/(?:^|[\s/])(\d{14}_[a-z0-9_]+\.sql)\b/gi)].map((m) => m[1]);
      return { kind: "out-of-order", files: [...new Set(files)] };
    }
    return { kind: "cli-error", code };
  }
  if (exitCode !== 0) return { kind: "unreadable", reason: `the CLI exited ${exitCode} without reporting an error` };
  if (v.dryRun !== true) return { kind: "unreadable", reason: "the result is not a dry run" };
  if (typeof v.upToDate !== "boolean" || !Array.isArray(v.migrations)) return { kind: "unreadable", reason: "no upToDate/migrations in the result" };
  if (!v.migrations.every((m) => typeof m === "string")) return { kind: "unreadable", reason: "a migration entry is not a file name" };
  for (const extra of ["seeds", "roles"]) {
    if (Array.isArray(v[extra]) && v[extra].length > 0) return { kind: "unreadable", reason: `the dry run would also push ${extra}` };
  }
  if (v.upToDate) {
    return v.migrations.length === 0 ? { kind: "up-to-date" } : { kind: "unreadable", reason: "up to date, yet migrations are listed" };
  }
  if (v.migrations.length === 0) return { kind: "unreadable", reason: "not up to date, yet no migrations are listed" };
  return { kind: "pending", files: v.migrations.map((m) => m.split("/").pop()) };
}

/** Throws unless every file is a well-named, existing migration and the list ascends. */
export function validateFiles(files, dir) {
  let prev = "";
  for (const f of files) {
    if (!FILE_RE.test(f)) throw new Error(`not a migration file name: ${f}`);
    if (!existsSync(join(dir, f))) throw new Error(`not in ${dir}: ${f}`);
    if (f <= prev) throw new Error(`out of order: ${f} after ${prev}`);
    prev = f;
  }
}

/** The file's first comment line that says something (not a rule of dashes), at most 160 characters. */
export function describe(sql) {
  for (const raw of String(sql).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("--")) return "";
    const text = line.replace(/^-+\s*/, "").trim();
    if (/[a-z0-9]/i.test(text)) return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  }
  return "";
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const DEFINES_ROUTINE = /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i;

/**
 * The SQL with comments and string literals blanked and function/procedure
 * bodies replaced by a marker. DO blocks are kept and read like any other
 * statement: they are where this repo changes rows (the approval gate's
 * grandfathering update runs inside one). `doBlocks` lists each DO body's code.
 */
export function codeOf(sql) {
  const s = String(sql);
  let out = "";
  const doBlocks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "-" && next === "-") {
      const end = s.indexOf("\n", i);
      i = end === -1 ? s.length : end;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "/" && s[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (s[i] === "*" && s[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      out += " ";
      continue;
    }
    if (c === "'") {
      // A string literal, '' escaped. Its words are data, not statements.
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += "''";
      continue;
    }
    if (c === '"') {
      const end = s.indexOf('"', i + 1);
      const stop = end === -1 ? s.length : end + 1;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$" && !/[A-Za-z0-9_]/.test(s[i - 1] ?? "")) {
      const m = DOLLAR_TAG.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const close = s.indexOf(tag, i + tag.length);
        const bodyEnd = close === -1 ? s.length : close;
        const body = s.slice(i + tag.length, bodyEnd);
        i = close === -1 ? s.length : close + tag.length;
        const statement = out.slice(out.lastIndexOf(";") + 1);
        if (DEFINES_ROUTINE.test(statement)) {
          out += " <routine body> ";
        } else {
          const inner = codeOf(body);
          if (/^\s*do\b/i.test(statement)) doBlocks.push(inner.code);
          doBlocks.push(...inner.doBlocks);
          out += ` ${inner.code} `;
        }
        continue;
      }
    }
    out += c;
    i++;
  }
  return { code: out, doBlocks };
}

/** Statements an approver should read twice. Advice, not a gate. */
export function scanDestructive(sql) {
  const { code, doBlocks } = codeOf(sql);
  const t = code.toLowerCase().replace(/\s+/g, " ");
  const flags = new Set();
  for (const m of t.matchAll(/\bdrop (table|schema|view|materialized view|type|sequence|extension)\b/g)) flags.add(`drops a ${m[1]}`);
  if (/\bdrop column\b/.test(t) || /\balter table\b[^;]*\bdrop (?!constraint\b|column\b|not null\b|default\b|expression\b|identity\b)(?:if exists )?[a-z_"]/.test(t)) {
    flags.add("drops a column");
  }
  if (/\bdelete from\b/.test(t)) flags.add("deletes rows");
  if (/\btruncate\b/.test(t)) flags.add("truncates a table");
  if (/\bupdate (?:only )?[\w."]+(?: (?:as )?(?!set\b)\w+)? set\b/.test(t)) flags.add("changes rows in place");
  if (/\balter column [\w"]+ (?:set data )?type\b/.test(t)) flags.add("changes a column type");
  if (doBlocks.some((b) => /\bexecute\b(?! (?:function|procedure)\b)/i.test(b.replace(/\s+/g, " ")))) {
    flags.add("runs dynamic SQL in a DO block (read it)");
  }
  return [...flags];
}

/** A file that creates a table without RLS or the approval gate. Advice; the database check after the apply decides. */
export function scanGate(sql) {
  const t = codeOf(sql).code.toLowerCase().replace(/\s+/g, " ");
  if (!/\bcreate table\b/.test(t)) return [];
  const out = [];
  // private.attach_student_policies enables RLS itself.
  if (!/\benable row level security\b|\battach_student_policies\b/.test(t)) out.push("creates a table without enabling RLS");
  if (!/\battach_approval_gate\b/.test(t)) out.push("creates a table without private.attach_approval_gate");
  return out;
}

/** A stable fingerprint of the pending list: names and contents, in order. */
export function planHash(files, dir) {
  if (files.length === 0) return "none";
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"));
    h.update("\n");
  }
  return h.digest("hex");
}

const cell = (s) => String(s).replace(/[|<>`]/g, (c) => ({ "|": "\\|", "<": "&lt;", ">": "&gt;", "`": "'" })[c]).replace(/\r?\n/g, " ");

export function renderSummary({ files, details, sha, mode }) {
  const short = sha ? String(sha).slice(0, 7) : "this commit";
  const lines = [`### Migrations plan for ${short}`, ""];
  if (files.length === 0) {
    lines.push("Production is up to date. Nothing to apply.", "");
    return lines.join("\n");
  }
  lines.push(`${files.length} file${files.length === 1 ? "" : "s"} to apply, in this order:`, "");
  lines.push("| # | File | What it says | Flags |", "|---|---|---|---|");
  files.forEach((f, i) => {
    const d = details[i] ?? { description: "", flags: [], gate: [] };
    const flags = [...d.flags, ...d.gate].map(cell).join("; ");
    lines.push(`| ${i + 1} | \`${f}\` | ${cell(d.description)} | ${flags} |`);
  });
  lines.push("");
  if (details.some((d) => d.flags.length > 0)) {
    lines.push(
      "**Flagged statements.** Before approving, confirm a recent backup exists (Supabase > Database > Backups) and read the flagged files. The scan skips function bodies and dynamic SQL, so it is advice, not a guarantee.",
      "",
    );
  }
  if (mode === "workflow_dispatch") {
    const newest = FILE_RE.exec(files[files.length - 1])?.[1] ?? "";
    lines.push(`To apply exactly this list, run the workflow on \`main\` with **apply** on and **confirm** = \`${newest}\`.`, "");
  } else {
    lines.push("Applying waits for an approver on the `production-db` environment, or for a manual run (DATABASE_MIGRATION_INSTRUCTIONS.md).", "");
  }
  return lines.join("\n");
}

/** Rows of `problems.sql` as JSON: an array of { problem: string }. Throws on any other shape. */
export function parseProblems(text) {
  const v = lastJson(text);
  if (!Array.isArray(v) || !v.every((r) => r && typeof r === "object" && typeof r.problem === "string")) {
    throw new Error("could not read the database check");
  }
  return v.map((r) => r.problem);
}

/** host:port of the pooler URL the CLI recorded. Never the user or password. */
export function poolerInfo(text) {
  try {
    const u = new URL(String(text).trim());
    return { host: u.hostname, port: u.port || "5432" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (!(name in known)) throw new Error(`unknown flag: ${a}`);
    if (known[name] === "bool") out[name] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      out[name] = v;
    }
  }
  return out;
}

const annotate = (level, msg) => console.log(`::${level}::${msg.replace(/\r?\n/g, " ")}`);
const append = (path, text) => {
  if (path) appendFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
};

function cmdPlan(argv) {
  const a = parseArgs(argv, {
    "dry-run": "value", "exit-code": "value", dir: "value", summary: "value",
    outputs: "value", mode: "value", sha: "value", "expect-hash": "value",
  });
  if (!a["dry-run"] || a["exit-code"] === undefined) throw new Error("plan needs --dry-run and --exit-code");
  if (!/^\d+$/.test(a["exit-code"])) throw new Error("--exit-code must be a number");
  if (a.mode && !["push", "workflow_dispatch"].includes(a.mode)) throw new Error("--mode must be push or workflow_dispatch");
  const dir = a.dir ?? "supabase/migrations";
  const result = parseDryRun(readFileSync(a["dry-run"], "utf8"), Number(a["exit-code"]));

  if (result.kind === "out-of-order") {
    const which = result.files.length ? ` (${result.files.join(", ")})` : "";
    annotate("error", `A pending migration${which} is older than the newest one on production. Give it a later timestamp in a new PR. Never use --include-all on production without reading DATABASE_MIGRATION_INSTRUCTIONS.md.`);
    append(a.summary, `### Migrations: refused\n\nA pending migration${which} is older than the newest one on production. Rename it with a later timestamp.\n`);
    return 1;
  }
  if (result.kind === "cli-error") {
    annotate("error", `The Supabase CLI reported ${result.code}. Its log is in the step above.`);
    return 1;
  }
  if (result.kind === "unreadable") {
    annotate("error", `Could not read the dry run: ${result.reason}.`);
    return 1;
  }

  const files = result.kind === "pending" ? result.files : [];
  validateFiles(files, dir);
  const hash = planHash(files, dir);
  if (a["expect-hash"] !== undefined && a["expect-hash"] !== hash) {
    annotate("error", "The pending list changed since the plan was shown (another apply, or a file applied by hand). Re-run all jobs, or start a new run.");
    append(a.summary, "### Migrations: refused\n\nThe pending list changed since the plan was shown. Nothing was applied.\n");
    return 1;
  }
  const details = files.map((f) => {
    const sql = readFileSync(join(dir, f), "utf8");
    return { description: describe(sql), flags: scanDestructive(sql), gate: scanGate(sql) };
  });
  if (a["expect-hash"] === undefined) append(a.summary, renderSummary({ files, details, sha: a.sha, mode: a.mode }));
  const newest = files.length ? FILE_RE.exec(files[files.length - 1])[1] : "";
  append(a.outputs, [`pending=${files.length > 0}`, `count=${files.length}`, `newest=${newest}`, `hash=${hash}`].join("\n"));
  console.log(files.length ? `${files.length} pending: ${files.join(", ")}` : "Up to date.");
  return 0;
}

function cmdGate(argv) {
  const a = parseArgs(argv, { after: "value", before: "value", summary: "value", "warn-only": "bool" });
  if (!a.after) throw new Error("gate needs --after");
  const after = parseProblems(readFileSync(a.after, "utf8"));
  const before = a.before ? new Set(parseProblems(readFileSync(a.before, "utf8"))) : null;
  const fresh = before ? after.filter((p) => !before.has(p)) : after;
  const old = before ? after.filter((p) => before.has(p)) : [];
  const lines = ["### Database check", ""];
  if (after.length === 0) lines.push("Every public table has RLS and the approval gate, and so does storage.objects.");
  for (const p of fresh) lines.push(`- ${a["warn-only"] ? "" : "**new** "}\`${cell(p)}\``);
  for (const p of old) lines.push(`- \`${cell(p)}\` (was already there before this apply)`);
  append(a.summary, `${lines.join("\n")}\n`);
  if (old.length) annotate("warning", `Already missing before this apply: ${old.join(", ")}`);
  if (fresh.length === 0) return 0;
  if (a["warn-only"]) {
    annotate("warning", `Missing RLS or the approval gate: ${fresh.join(", ")}`);
    return 0;
  }
  annotate("error", `This apply left a table without RLS or the approval gate: ${fresh.join(", ")}. The migration is applied; fix it forward with a new migration.`);
  return 1;
}

function cmdPooler(argv) {
  const a = parseArgs(argv, { file: "value", summary: "value" });
  if (!a.file) throw new Error("pooler needs --file");
  const info = existsSync(a.file) ? poolerInfo(readFileSync(a.file, "utf8")) : null;
  if (!info) {
    console.log("The CLI recorded no pooler URL (it may be connecting directly).");
    append(a.summary, "Connection: no pooler URL recorded by `supabase link`.\n");
    return 0;
  }
  console.log(`Linked through ${info.host}:${info.port}`);
  append(a.summary, `Connection: \`${cell(info.host)}:${info.port}\`\n`);
  if (info.port === "6543") annotate("warning", "The CLI linked through port 6543, the transaction pooler. Migrations belong on the session pooler (5432); check before approving.");
  return 0;
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "plan") return cmdPlan(rest);
    if (cmd === "gate") return cmdGate(rest);
    if (cmd === "pooler") return cmdPooler(rest);
    throw new Error(`unknown command: ${cmd ?? "(none)"}; use plan, gate or pooler`);
  } catch (err) {
    annotate("error", err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
