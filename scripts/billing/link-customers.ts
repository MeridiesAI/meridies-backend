/**
 * Link Consultants to their Stripe customer by hand: the 5 founding accounts, and any custom deal you made in Stripe.
 *
 *   npm run billing:link -- <file.json> [--dry-run]
 *
 * The file is a list: [{ "email": "...", "stripeCustomerId": "cus_...", "kind": "founding" | "custom" }]. See
 * scripts/billing/founding.placeholder.json. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env) and migration
 * 20261129000002 applied.
 *
 * TEST MODE ONLY: it refuses to run when STRIPE_SECRET_KEY is a live key, and it needs no Stripe key at all (it reads only
 * your database). Rules:
 *   - a founding or custom account never sees prices; its Stripe subscription is whatever you set in Stripe.
 *   - a FOUNDING account that has cancelled is never made founding again (founding lasts only while it stays subscribed):
 *     it is skipped and reported, and can only come back as a standard plan.
 *   - a Consultant who already has a Stripe customer on a different id is skipped and reported, never overwritten.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const entry = z.object({
  email: z.string().trim().email(),
  stripeCustomerId: z.string().regex(/^cus_[A-Za-z0-9]+$/, "must look like cus_..."),
  kind: z.enum(["founding", "custom"]),
});

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));
const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};

if (!file) fail("Usage: npm run billing:link -- <file.json> [--dry-run]");
if (/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY ?? "")) fail("Refusing to run with a live Stripe key. Test mode only.");
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) fail("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env).");

const parsed = z.array(entry).safeParse(JSON.parse(readFileSync(file!, "utf8")));
if (!parsed.success) fail(`The file isn't in the expected shape:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
if (!parsed.success) process.exit(1);

const db = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let linked = 0;
let skipped = 0;

for (const e of parsed.data) {
  const prof = await db.from("profiles").select("id, role").ilike("email", e.email).maybeSingle();
  if (prof.error || !prof.data) {
    console.log(`SKIP ${e.email}: no account with that email`);
    skipped++;
    continue;
  }
  if (prof.data.role !== "counselor") {
    console.log(`SKIP ${e.email}: not a Consultant account`);
    skipped++;
    continue;
  }
  const cur = await db.from("plan_subscriptions").select("kind, status, stripe_customer_id").eq("counselor_id", prof.data.id).maybeSingle();
  if (cur.error) fail(`Could not read plans (${cur.error.code}). Is migration 20261129000002 applied?`);
  if (cur.data?.kind === "founding" && cur.data.status === "canceled") {
    console.log(`SKIP ${e.email}: a cancelled founding account stays cancelled (it can come back as a standard plan)`);
    skipped++;
    continue;
  }
  if (cur.data?.stripe_customer_id && cur.data.stripe_customer_id !== e.stripeCustomerId) {
    console.log(`SKIP ${e.email}: already linked to a different Stripe customer`);
    skipped++;
    continue;
  }
  console.log(`${dry ? "WOULD LINK" : "LINK"} ${e.email} -> ${e.stripeCustomerId} (${e.kind})`);
  if (!dry) {
    const { error } = await db
      .from("plan_subscriptions")
      .upsert({ counselor_id: prof.data.id, kind: e.kind, stripe_customer_id: e.stripeCustomerId, status: "active", started_at: new Date().toISOString() }, { onConflict: "counselor_id" });
    if (error) fail(`Could not save ${e.email}: ${error.code}`);
  }
  linked++;
}
console.log(`${dry ? "Dry run: " : ""}${linked} linked, ${skipped} skipped.`);
