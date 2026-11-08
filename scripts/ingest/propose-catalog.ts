/**
 * Cited catalog proposals for one college, from its own pages (src/lib/catalogProposals.ts):
 *
 *   npx tsx scripts/ingest/propose-catalog.ts --unitid 166683 [--dry-run]
 *
 * Reads the school's home page and a few of its admissions pages (its own domain only), has the model pull out
 * the personal-statement flag, how test scores are reported and this cycle's supplement prompts, keeps each only
 * when its quote is on the page, and writes PENDING catalog_change_proposals for a catalog editor to approve.
 * Nothing curated is written. --dry-run prints what would be proposed and writes nothing.
 *
 * LOCAL STACK ONLY: SUPABASE_URL must be this machine (scripts/seed/local-only.mjs), never the production
 * project. Production runs go through POST /internal/catalog/propose, which a person approves the result of.
 * Needs SUPABASE_SERVICE_ROLE_KEY, and ANTHROPIC_API_KEY unless RESEARCH_FAKE=fixture (NODE_ENV development/test).
 */
import { assertLocalStack } from "../seed/local-only.mjs";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const unitid = Number(arg("unitid"));
const dryRun = process.argv.includes("--dry-run");
if (!Number.isInteger(unitid) || unitid <= 0) {
  console.error("Usage: --unitid <IPEDS unitid> [--dry-run]");
  process.exit(1);
}

// Before anything reads the environment's keys: refuse a database that isn't this machine's.
try {
  assertLocalStack({ SUPABASE_URL: process.env.SUPABASE_URL });
} catch (err) {
  console.error(err instanceof Error ? err.message.replace(/This script creates[^.]*\./, "This script writes catalog proposals.") : String(err));
  process.exit(1);
}

const { serviceClient } = await import("../../src/lib/supabase.js");
const { runCatalogProposal } = await import("../../src/lib/catalogProposalsRun.js");

const svc = serviceClient();
if (!svc) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(1);
}
const { data, error } = await svc.from("colleges").select("id, name").eq("unitid", unitid).maybeSingle();
if (error) {
  console.error(error.message);
  process.exit(1);
}
if (!data) {
  console.error(`unitid ${unitid} isn't in the catalog.`);
  process.exit(1);
}

const log = { warn: (o: unknown, m?: string) => console.warn(m ?? "", o), error: (o: unknown, m?: string) => console.error(m ?? "", o) };
const r = await runCatalogProposal(String(data.id), { dryRun }, log);
if (!r.ok) {
  console.error(r.message);
  process.exit(1);
}
const x = r.result;
console.log(`${String(data.name)} (${x.cycle}): read ${x.pagesRead.length} page(s).`);
for (const c of x.candidates) {
  const what = c.field === "supplement" ? `supplement #${c.payload.sortOrder} "${c.payload.title}"` : `${c.field} = ${c.value}`;
  console.log(`  ${what}\n    ${c.sourceUrl}\n    "${c.evidence}"`);
}
console.log(
  `Dropped: ${x.droppedNoQuote} without a quote on the page, ${x.droppedOffDomain} off the school's domain, ` +
    `${x.droppedInvalid} invalid, ${x.droppedOtherCycle} for another cycle. Already on file: ${x.unchanged}.`
);
console.log(dryRun ? "Dry run, nothing written." : `Proposed ${x.proposed} (pending review); ${x.duplicates} already pending or approved.`);
process.exit(0);
