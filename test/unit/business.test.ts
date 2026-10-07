import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { rankPercentile } from "../../src/lib/classRank.js";
import { acceptProposals, incomeBand, nlFiltersToQuery, studentCollegeSummary } from "../../src/lib/collegeIntel.js";
import { searchQuery } from "../../src/lib/collegesV10.js";
import { intervalMs, isStale } from "../../src/lib/heartbeat.js";
import { deriveAccount } from "../../src/lib/payments.js";
import { DEFAULT_PRIVACY, toPrivacySettings } from "../../src/lib/practiceSettings.js";
import { resendStatus, twilioStatus, verifySvix, verifyTwilio } from "../../src/routes/webhooks.js";

test("payments settle the oldest invoice first", () => {
  const inv = (id: string, cents: number, issued: string, due: string) => ({ id, number: id, label: id, amount_cents: cents, issued_on: issued, due_on: due, created_at: issued });
  const a = deriveAccount(
    { contact_id: "c", package_name: "Full", total_cents: 300000, installments: 3 },
    [inv("1", 100000, "2026-01-01", "2026-01-15"), inv("2", 100000, "2026-02-01", "2026-02-15")],
    [{ id: "p", amount_cents: 150000, received_on: "2026-01-10", method: "card", created_at: "2026-01-10" }],
    "2026-03-01"
  );
  assert.equal(a.invoices[0]!.state, "paid");
  assert.equal(a.invoices[1]!.state, "overdue");
  assert.equal(a.overdueCents, 50000);
  assert.equal(a.status, "overdue");
  assert.equal(a.suggestedInstallmentCents, 100000);
});

test("class rank never extrapolates past the school's bands", () => {
  const bands = [{ label: "Top 10%", minWeightedGpa: 4.5, percentile: 10 }, { label: "Top 25%", minWeightedGpa: 4.0, percentile: 25 }];
  assert.equal(rankPercentile(bands, 4.9)!.percentile, 10);
  assert.equal(rankPercentile(bands, 4.25)!.percentile, 18);
  assert.equal(rankPercentile(bands, 3.5), null);
  assert.equal(rankPercentile([], 4), null);
});

test("privacy settings default on", () => {
  assert.deepEqual(toPrivacySettings(null), DEFAULT_PRIVACY);
  assert.equal(toPrivacySettings({ ai_summaries: false }).aiSummaries, false);
});

test("NL filters are validated like any query", () => {
  const q = nlFiltersToQuery({ states: ["CA"], majors: ["computer, science"], admitMax: 0.5, hbcu: false, sort: "net-price", unsupported: ["vibes"] });
  assert.deepEqual(q, { states: "CA", majors: "computer science", admitMax: "0.5", sort: "net-price" });
  assert.equal(searchQuery.safeParse(q).success, true);
  assert.equal(searchQuery.safeParse(nlFiltersToQuery({ states: ["California"] })).success, false);
});

test("proposals: allowed fields and values, cited sources, real changes only", () => {
  const cited = new Set(["https://admission.stanford.edu/testing"]);
  const raw = {
    proposals: [
      { field: "test_policy", proposedValue: "Required", sourceUrl: "https://admission.stanford.edu/testing", evidence: "required" },
      { field: "test_policy", proposedValue: "optional", sourceUrl: "https://admission.stanford.edu/testing", evidence: "dup field" },
      { field: "superscore", proposedValue: "both", sourceUrl: "https://elsewhere.com", evidence: "uncited" },
      { field: "name", proposedValue: "x", sourceUrl: "https://admission.stanford.edu/testing", evidence: "not allowed" },
      { field: "css_profile_required", proposedValue: "true", sourceUrl: "https://admission.stanford.edu/testing", evidence: "same as now" },
    ],
  };
  const out = acceptProposals(raw, cited, { test_policy: "optional", css_profile_required: "true" });
  assert.deepEqual(out.map((p) => `${p.field}=${p.proposedValue}`), ["test_policy=required"]);
});

test("summary bullets come only from facts on file", () => {
  assert.equal(incomeBand(9_000_000), "75001-110000");
  assert.equal(incomeBand(null), null);
  const s = studentCollegeSummary({
    collegeName: "X",
    student: { sat: 1450, gpaUnweighted: 3.9, intendedMajors: ["Nursing"], agiCents: null },
    stats: { admit_rate: 0.5, sat_total_25: 1300, sat_total_75: 1450, avg_net_price: 20000, net_price_by_income: {}, source_url: "https://s" },
    factors: null,
    policies: null,
    requirements: null,
    majorAdmits: [],
    majors: [{ title: "Biology" }],
  });
  assert.ok(s.bullets.some((b) => b.text.includes("inside the middle 50%")));
  assert.ok(s.bullets.some((b) => b.text.includes('No bachelor\'s program matching "nursing"')));
  assert.ok(!s.bullets.some((b) => /CSS|superscore/i.test(b.text)), "no curated policy on file, nothing said");
  assert.equal(s.fit, "target");
});

test("webhook signatures", () => {
  const secret = "whsec_" + Buffer.from("k3y").toString("base64");
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"email.delivered"}';
  const sig = createHmac("sha256", Buffer.from("k3y")).update(`m1.${ts}.${body}`).digest("base64");
  assert.equal(verifySvix(secret, { id: "m1", timestamp: ts, signature: `v1,${sig}` }, body, now), true);
  assert.equal(verifySvix(secret, { id: "m1", timestamp: ts, signature: `v1,${sig}` }, body + " ", now), false);
  assert.equal(verifySvix(secret, { id: "m1", timestamp: String(now / 1000 - 900), signature: `v1,${sig}` }, body, now), false, "replay window");
  const url = "https://api.example.com/webhooks/twilio/status";
  const params = { MessageStatus: "delivered", MessageSid: "SM1" };
  const tsig = createHmac("sha1", "tok").update(url + "MessageSidSM1MessageStatusdelivered").digest("base64");
  assert.equal(verifyTwilio("tok", url, params, tsig), true);
  assert.equal(verifyTwilio("tok", url, { ...params, MessageStatus: "failed" }, tsig), false);
  assert.equal(resendStatus("email.complained")?.status, "bounced");
  assert.equal(twilioStatus("undelivered"), "failed");
});

test("heartbeats go stale after twice their interval", () => {
  assert.equal(intervalMs("00:15:00"), 900_000);
  assert.equal(intervalMs("7 days"), 604_800_000);
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(isStale("2026-10-07T11:40:00Z", "00:15:00", now), false);
  assert.equal(isStale("2026-10-07T11:20:00Z", "00:15:00", now), true);
  assert.equal(isStale(null, "7 days", now), true);
});
