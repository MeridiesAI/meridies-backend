import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setBudgetBackend, type BudgetBackend, type ReserveLine } from "../../src/lib/aiBudget.js";
import { systemResearch } from "../../src/lib/eventsDiscovery.js";

const log = { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined } as never;
const prices = [{ model: "claude-sonnet-5-5", input_usd: 2, output_usd: 10, read_mult: 0.05, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 }];
function refusing(subject: string): { backend: BudgetBackend; reserves: ReserveLine[][] } {
  const reserves: ReserveLine[][] = [];
  return {
    reserves,
    backend: {
      probe: async () => undefined,
      prices: async () => prices,
      reserve: async (lines) => (reserves.push(lines), { ok: false, subject, metric: subject === "company" ? "spend_usd" : "calls", period: subject === "company" ? "day" : "month" }),
      settle: async () => undefined,
      total: async () => 0,
    },
  };
}
afterEach(() => setBudgetBackend(null));

test("events discovery stops on the gate's refusal: the system budget, or AI paused for the day", async () => {
  for (const subject of ["system:events-discovery", "company"]) {
    const b = refusing(subject);
    setBudgetBackend(b.backend);
    await assert.rejects(systemResearch(log)({ domains: ["stanford.edu"], question: "events?" } as never), (e: Error) => /budget/.test(e.message), subject);
    assert.equal(b.reserves[0]![0]!.subject, "system:events-discovery", "the job reserves on its own system budget");
  }
});
