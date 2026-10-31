# AxIS security PR A2: cost caps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model call in meridies-backend passes one budget gate that reserves before the call, settles after, refuses when it can't check, and pauses all AI at a company-wide daily ceiling.

**Architecture:** A new `lib/aiBudget.ts` does reserve and settle over new service-role-only SQL functions on a private counter table keyed by text subjects. Prices are rows in one table, `private.ai_prices`, which both the code and the SQL reports read. `lib/aiPricing.ts` holds only the arithmetic. The six call sites in `lib/anthropic.ts` and `lib/axis/llm.ts` (plus the AxIS loop's per-call hook) go through the gate.

**Tech Stack:** Fastify 5, TypeScript strict (ESM), Supabase Postgres + PostgREST RPC, `@anthropic-ai/sdk`, node:test via tsx, integration suites on local Supabase.

**Spec:** `docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md` (section 1 and the Review round). Read both. Builds on PR A1 (chat files read once), which merges first.

## Global Constraints

- Branch `axis-cost-caps`, created in worktree `meridies-backend-axissec` from PR A1's tip. It is rebased onto `origin/main` once A1 has merged, before this PR opens. PR title "AxIS cost caps". Elvin merges it, after A1.
- Never touch production (no prod queries, env vars or migrations). Local Supabase only.
- Only `src/lib/anthropic.ts` and `src/lib/axis/llm.ts` may call the model.
- Defaults (env vars, spec 1.2): `AI_DAILY_CALLS` 300 per user per UTC day; `AI_MONTHLY_OUTPUT_TOKENS` 5,000,000 per user per calendar month; `AI_MONTHLY_INPUT_TOKENS` 100,000,000 weighted per user per month; `AI_DAILY_CEILING_USD` 100 company-wide per UTC day. Events discovery system budget: 2,000 calls per month.
- Exact copy: 503 `{ code: "ai_budget_unavailable" }` "AI is unavailable right now. Try again in a few minutes."; 429 `{ code: "ai_paused" }` "AI features are paused for today. They come back at midnight UTC."; daily calls "You've hit today's AI limit. It resets at midnight."; monthly output or input "Monthly AI usage limit reached."
- Fallback log line (warn): `AI budget fallback active: migration 20261031000002_ai_budget not applied, caps not enforced`, first time per process, then at most once an hour while it lasts.
- Budget check timeout 2,000 ms. Readiness: "ready" kept for the process, "missing" re-probed after 30 s; any other probe error is an error (refuse).
- Ceiling emails to `env.COMPANY_CONTACT_EMAIL` at 50%, 80% and 100% (paused), once per UTC day per threshold. Body: day's estimated spend, top five subjects by spend (ids and roles, no names), top modules.
- Prices live only in `private.ai_prices`, seeded by this PR's migration. No price figure in `src/`. A price change is a new migration that updates rows. The code reads them through `public.ai_budget_prices()`, cached 10 minutes per process.
- Migration `20261031000002_ai_budget.sql`: header states deploy order (either; without it the gate counts as today), not in `REQUIRED_SCHEMA`. If PR B's migrations merge first, re-timestamp this file newer than production's newest before merge.
- engine.ts: change only the charging lines; the intent-routing session owns the rest of the file. Don't change when the pre-warm runs (the cost session owns that).
- Every new service-client call site goes on `REVIEWED` in `test/unit/service-callsites.test.ts` with a one-line reason.

## Review Focus

1. A counselor closes the panel mid-answer (stream aborted): the reservation must be settled with null (kept, over-counted), and nothing throws. Test in Task 4.
2. A call reserved at 23:59:59 UTC and settled after midnight: settle must adjust the reserved day's row, not the new day's. Test in Task 3.
3. Two replicas reserving at once at the edge of a cap: only reservations within the limit pass. Test in Task 1 (parallel RPCs).
4. A model id with no price row (a new model added later): priced at the table's highest rates, never free. Test in Task 2.
5. A call that fails before any usage (network error, 5xx): the call stays counted, tokens and spend are released. Test in Task 3.

---

### Task 1: The budget migration

**Files:**
- Create: `supabase/migrations/20261031000002_ai_budget.sql`
- Modify: `test/integration/harness.mjs` (export a `serviceRpc(name, args)` helper that POSTs to `/rest/v1/rpc/<name>` with the service key)
- Test: `test/integration/ai-budget-db.test.mjs`

**Interfaces:**
- Produces (SQL, EXECUTE to `service_role` only, revoked from public/anon/authenticated):
  - table `private.ai_budget(subject text, metric text, period text, period_start date, amount numeric(20,6) not null default 0 check (amount >= 0), updated_at timestamptz not null default now(), primary key (subject, metric, period, period_start))`; `subject` checked against `^(user:[0-9a-f-]{36}|company|system:[a-z-]+)$`; `metric in ('calls','output_tokens','input_weighted','spend_usd')`; `period in ('day','month')`. RLS on, no policies.
  - table `private.ai_prices(model text primary key check (model ~ '^claude-[a-z0-9-]+$'), input_usd numeric(10,4) not null check (input_usd > 0), output_usd numeric(10,4) not null check (output_usd > 0), read_mult numeric(6,4) not null check (read_mult > 0 and read_mult <= 1), write_5m_mult numeric(6,4) not null default 1.25, write_1h_mult numeric(6,4) not null default 2, long_above integer check (long_above > 0), long_mult numeric(6,2) not null default 1 check (long_mult >= 1), web_search_usd numeric(10,4) not null default 0.01, updated_at timestamptz not null default now())`, USD per million tokens. RLS on, no policies. Seeded with exactly these rows (input/output/read, then long tier; the cost session's table in `scripts/axis/axis-cost-report.sql`): haiku-5-5 0.10/0.50/0.10, above 100000 x5; haiku-4-5 1.00/5.00/0.10; sonnet-5-5 2.00/10.00/0.05; sonnet-5 2.00/10.00/0.10; sonnet-4-6 3.00/15.00/0.10; sonnet-4-5 3.00/15.00/0.10; opus-5-5 4.00/20.00/0.05; opus-5 5.00/25.00/0.10; opus-4-8, opus-4-7, opus-4-6 5.00/25.00/0.10; fable-5 10.00/50.00/0.10; fable-5-1 and mythos-5-1 10.00/50.00/0.025 (all `claude-` prefixed; no long tier except Haiku 5.5).
  - `public.ai_budget_prices() returns table(model text, input_usd numeric, output_usd numeric, read_mult numeric, write_5m_mult numeric, write_1h_mult numeric, long_above integer, long_mult numeric, web_search_usd numeric)`.
  - `public.ai_budget_reserve(p_lines jsonb) returns jsonb`: lines `[{subject, metric, period, period_start, amount, limit}]`. Inserts missing rows at 0, locks all rows in primary-key order (`for update`), and if every `amount + line.amount <= limit` adds them all and returns `{"ok": true, "totals": {"<subject>|<metric>|<period>": <new amount>}}`; otherwise changes nothing and returns `{"ok": false, "subject", "metric", "period"}` for the first line over.
  - `public.ai_budget_settle(p_lines jsonb) returns void`: lines `[{subject, metric, period, period_start, delta}]`; `amount = greatest(0, amount + delta)`; a missing row is skipped.
  - `public.ai_budget_total(p_subject text, p_metric text, p_period text, p_period_start date) returns numeric` (0 when no row).
  - `public.ai_budget_forget(p_user uuid) returns void`: deletes `user:<p_user>` rows.
  - `public.ai_budget_top(p_period_start date, p_limit int default 5) returns table(subject text, amount numeric)`: today's biggest `spend_usd/day` subjects other than `company`, for the alert email (roles come from `profiles`, modules from today's `ai_runs`).

- [ ] **Step 1: Branch and start the local stack**

Run: `git switch -c axis-cost-caps && npm ci && supabase status`
Expected: on the new branch from A1's tip; local stack running (else `supabase start`).

- [ ] **Step 2: Write the failing integration test** (`ai-budget-db.test.mjs`)

```js
test("reserve adds every line when all fit", ...)        // totals["company|spend_usd|day"] === 0.5 after reserving 0.5 of 100
test("reserve over one cap changes nothing and names it", ...) // calls limit 1, reserve 1 twice: second { ok:false, metric:"calls" }; ai_budget_total still 1
test("parallel reserves never pass the cap", ...)        // 20 concurrent serviceRpc reserves of 1 call, limit 10: exactly 10 ok; total 10
test("settle applies a delta and floors at zero", ...)   // amount 100, delta -150 -> 0
test("a signed-in user can't call the budget functions or read prices", ...) // user token -> PostgREST error (401/403/404), never ok
test("every model the code uses has a price row", ...)   // FAST_MODEL, DEEP_MODEL, RESEARCH_MODEL, AXIS_MODEL, DISCOVERY_MODEL in ai_budget_prices()
test("forget removes only that user's rows", ...)
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --import tsx --test test/integration/ai-budget-db.test.mjs` (API not needed)
Expected: FAIL, function `ai_budget_reserve` not found.

- [ ] **Step 4: Write the migration**, then `supabase migration up` (local).

- [ ] **Step 5: Run the test**: Expected PASS. Also `node --import tsx --test test/integration/approval-db.test.mjs` still passes (private tables, no gate needed).

- [ ] **Step 6: Commit** `feat(ai-budget): counters, the price table, reserve/settle functions`

---

### Task 2: The price arithmetic

**Files:**
- Create: `src/lib/aiPricing.ts`
- Test: `test/unit/ai-pricing.test.ts`

**Interfaces:**
- Produces:
  - `type ModelPrice = { inputUsd: number; outputUsd: number; readMult: number; write5mMult: number; write1hMult: number; longAbove: number | null; longMult: number; webSearchUsd: number }` (USD per million tokens; web search per use).
  - `type PriceTable = ReadonlyMap<string, ModelPrice>`; `priceTableFrom(rows: unknown[]): PriceTable` (the RPC's snake_case rows; PostgREST numerics may arrive as strings; a malformed row throws).
  - `type CallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite5m?: number; cacheWrite1h?: number; webSearches?: number }`.
  - `priceFor(t: PriceTable, model: string): ModelPrice` (no row: the highest of each rate and multiplier in the table, no tier; an empty table throws).
  - `weightedInput(t, model, u: CallUsage): number` = `(input + cacheRead*readMult + w5m*write5mMult + w1h*write1hMult) * tier`, where writes without a split count as 1h, and `tier = longMult` when `input + cacheRead + cacheWrite > longAbove`, else 1.
  - `spendUsd(t, model, u): number` = `(weightedInput*inputUsd + output*outputUsd*tier)/1e6 + webSearches*webSearchUsd`.

- [ ] **Step 1: Write the failing tests** (the table is test data built in the file from three rows: Haiku 5.5, Sonnet 5.5 and Fable 5.1 as seeded; it is not a second product copy)

```ts
test("Haiku 5.5 under 100K: reads at 0.1, unsplit writes at the 1-hour rate", () => {
  const u = { input: 10_000, cacheRead: 50_000, cacheWrite: 20_000, output: 1_000 };
  assert.equal(weightedInput(t, "claude-haiku-5-5", u), 55_000);
  assert.equal(spendUsd(t, "claude-haiku-5-5", u), 0.006);            // compare with 1e-12 tolerance
});
test("Haiku 5.5 over 100K: the whole call at 5x", () => {
  const u = { input: 120_000, cacheRead: 0, cacheWrite: 0, output: 1_000 };
  assert.equal(weightedInput(t, "claude-haiku-5-5", u), 600_000);
  assert.equal(spendUsd(t, "claude-haiku-5-5", u), 0.0625);
});
test("Sonnet 5.5 cache reads at 0.05", ...);                       // cacheRead 100_000 -> 5_000
test("a 5-minute write counts 1.25", ...);                          // cacheWrite 1000, cacheWrite5m 1000 -> 1250
test("a model with no row is priced at the table's highest rates", ...); // priceFor(t, "claude-new-9") -> inputUsd 10, outputUsd 50, readMult 0.1
test("web searches add a cent each", ...);                          // 3 searches -> +0.03
test("priceTableFrom reads numeric strings and refuses a malformed row", ...);
```

- [ ] **Step 2: Run** `npm test -- --test-name-pattern="Haiku 5.5|Sonnet|no row|web searches|priceTableFrom"` → FAIL (module missing).
- [ ] **Step 3: Implement `src/lib/aiPricing.ts`.**
- [ ] **Step 4: Run again** → PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): price arithmetic over the price table`

---

### Task 3: The gate

**Files:**
- Create: `src/lib/aiBudget.ts`
- Modify: `src/env.ts` (the four env vars, defaults above, `z.coerce`, blank is unset)
- Modify: `test/unit/service-callsites.test.ts` (add `lib/aiBudget.ts`: "service-only budget counters, prices and the ceiling email; no student data")
- Test: `test/unit/ai-budget.test.ts`

**Interfaces:**
- Consumes: Task 1's SQL functions; Task 2's `priceTableFrom`, `weightedInput`, `spendUsd`, `CallUsage`; PR A1's `fileTokens`.
- Produces:
  - `type SystemSubject = "events-discovery"`; `SYSTEM_CALLS_PER_MONTH: Record<SystemSubject, number> = { "events-discovery": 2000 }`.
  - `type BudgetSubject = { userId: string } | { system: SystemSubject }`.
  - `type CallEstimate = { model: string; maxOutputTokens: number; promptTokens: number; webSearches?: number; module?: string }`.
  - `type Hold` (opaque to callers; carries subject, model, mode `"enforced" | "fallback" | "memory"`, the reserved lines with their `period_start`).
  - `reserve(subject: BudgetSubject, est: CallEstimate, log: FastifyBaseLogger): Promise<Hold>`: throws `HttpError` 429/503 with the exact copy above.
  - `settle(hold: Hold, actual: CallUsage | null, log: FastifyBaseLogger): Promise<void>`: never throws.
  - `budgetMode(log): Promise<"enforced" | "fallback">`, `spendToday(): Promise<number | null>`, `forgetUser(userId: string): Promise<void>`.
  - `estimatePromptTokens(p: { system?: unknown; tools?: unknown; messages: unknown }): number`: JSON length / 3 with base64 data removed, plus `fileTokens` for every document and image block.
  - Test seams: `setBudgetBackend(b: BudgetBackend | null)`, `setAlertSender(fn)`, `setProductionForTest(on: boolean)`, where `BudgetBackend = { probe(): Promise<void>; prices(): Promise<unknown[]>; reserve(lines): Promise<ReserveResult>; settle(lines): Promise<void>; total(subject, metric, period, start): Promise<number> }`. The default backend calls the Task 1 RPCs on `serviceClient()`.
- Behaviour pinned by the spec:
  - A user reservation is four lines: `calls/day` +1 (limit `AI_DAILY_CALLS`), `output_tokens/month` +`maxOutputTokens`, `input_weighted/month` +`weightedInput(model, { input: promptTokens, ... zeros })`, and `company spend_usd/day` +`spendUsd(model, { input: promptTokens, output: maxOutputTokens, webSearches })`. A system reservation is `system:<key> calls/month` +1 plus the company line.
  - Prices: read on first use and every 10 minutes after. A failed refresh keeps the last table and logs a warning. With no table yet, a failed read refuses like any check error (503).
  - `period_start` is computed in UTC at reserve time and kept on the hold; settle uses it.
  - Refusal mapping: company line → 429 `ai_paused` (and the 100% email); user calls → daily message; user output or input → monthly message; system calls → 429 "This month's system AI budget is used up."
  - Error or timeout while ready → 503 `ai_budget_unavailable`, `log.error`. Schema missing (codes in `isSchemaMissing`, `lib/axis/failsafe.ts`) → fallback: today's `consumeQuota` calls/day for a user (and output after the call in settle, `.catch` as today), the warn line above; no prices needed. No service client → production refuses (503); elsewhere in-memory counters of calls and output only (mode `memory`), no prices.
  - After an ok reserve, when the returned company total crosses 50% or 80% of the ceiling, send that alert once per UTC day (`consumeRateLimit("ai-ceiling:<YYYY-MM-DD>:<pct>", 1, 172_800)`), fire and forget.
  - settle deltas: output `actual.output - reserved`, input `weightedInput(actual) - reserved`, spend `spendUsd(actual) - reserved`; calls unchanged. `actual = null` releases output, input and spend, and keeps the call.

- [ ] **Step 1: Write the failing tests** (fake backend via `setBudgetBackend`; `mock.timers` for time)

```ts
test("a user reservation is one call, max output, weighted input and spend", ...)   // assert the 4 lines and amounts for haiku-5-5, 8_000 max, 20_000 prompt
test("over the daily calls cap: 429 with the daily message, nothing else counted", ...)
test("over the company ceiling: 429 ai_paused and one paused email", ...)
test("once the migration is in, a backend error refuses with 503 ai_budget_unavailable", ...)
test("once the migration is in, a check slower than 2 s refuses", ...)
test("without the migration: counts as today and logs the fallback line once an hour", ...) // 2 calls -> 1 warn; advance 1h -> 2nd warn
test("in production with no service key every call is refused", ...)
test("prices are read once per 10 minutes; a failed refresh keeps the last table", ...)
test("no prices yet and the read fails: 503", ...)
test("settle replaces the reservation with actual usage and keeps the call", ...)
test("settle(null) releases tokens and spend and keeps the call", ...)
test("settle after midnight adjusts the reserved day", ...)                          // Review Focus 2
test("settle never throws when the backend fails", ...)
test("crossing 50% and 80% sends each email once that day", ...)
test("estimatePromptTokens counts text, PDFs and images", ...)                       // file blocks through fileTokens
```

- [ ] **Step 2: Run** `npm test` → the new tests FAIL (module missing).
- [ ] **Step 3: Implement `src/lib/aiBudget.ts` and the env vars.**
- [ ] **Step 4: Run** `npm test` → all PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): reserve and settle gate that fails closed`

---

### Task 4: AxIS calls through the gate

**Files:**
- Modify: `src/lib/axis/loop.ts` (replace `beforeCall` with `gate`), `src/lib/axis/llm.ts` (`chargeCall`/`chargeOutput` removed; `structured`, `prewarm`, new helpers), `src/lib/axis/engine.ts` (charging lines only), `src/lib/axis/planner.ts` if it passes `beforeCall`, `src/routes/axis.ts` (route reservation)
- Test: `test/unit/axis-loop.test.ts`, `test/unit/axis-engine.test.ts`

**Interfaces:**
- Consumes: Task 3's `reserve`, `settle`, `Hold`, `estimatePromptTokens`.
- Produces:
  - `type CallGate = { before(params: StreamParams): Promise<Hold>; after(hold: Hold, usage: Usage | null): Promise<void> }` in `loop.ts`; `LoopOptions.gate?: CallGate`. The loop calls `after` in a `finally` per call with that call's `msg.usage` mapped to `Usage`, or null when the stream threw or was aborted.
  - `axisGate(request: FastifyRequest, prepaid?: Hold): CallGate` in `llm.ts`: the first `before` returns `prepaid` when given; otherwise reserves `{ model: AXIS_MODEL, maxOutputTokens: params.max_tokens, promptTokens: estimatePromptTokens(params) }`.
  - `reserveTurn(request: FastifyRequest): Promise<Hold>` in `llm.ts`: estimate `{ model: AXIS_MODEL, maxOutputTokens: MAX_TOKENS.high, promptTokens: PROMPT_TOKEN_BUDGET }`.
  - `structured(o)`: option `precharged?: boolean` becomes `hold?: Hold`; reserves when absent; settles in `finally`. This covers PR A1's file summaries too. `prewarm`: reserves with `maxOutputTokens: 0`, settles.
  - `runAxisTurn` option `prepaidCalls?: number` becomes `prepaid?: Hold`; an unused prepaid hold is settled with null when the turn ends (keeps the call, as the route's charge does today).
  - `routes/axis.ts`: `await chargeCall(request)` becomes `const prepaid = await reserveTurn(request)`, before the stream opens (so a cap or `ai_paused` is a plain 429/503, not a fallback); the hold is settled with null if anything throws before `runAxisTurn` takes it.

- [ ] **Step 1: Write the failing tests**

```ts
// axis-loop.test.ts
test("the gate wraps every model call with that call's usage", ...)   // 2 scripted rounds -> before x2, after x2 with each round's usage
test("an aborted stream settles with null and doesn't throw", ...)    // Review Focus 1
// axis-engine.test.ts
test("the turn's first call uses the route's reservation", ...)       // reserve spy called (calls - 1) times
test("a direct answer settles the unused reservation", ...)           // settle(prepaid, null) once
```

- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement**; update existing tests that pass `beforeCall` or `prepaidCalls`.
- [ ] **Step 4: Run** `npm test` → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat(ai-budget): AxIS loop, structured calls and pre-warm through the gate`

---

### Task 5: The other model calls through the gate

**Files:**
- Modify: `src/lib/anthropic.ts` (`runStructured`, `streamChat`, `research` used by `runWebResearch` and `runSystemResearch`), `src/lib/eventsDiscovery.ts` (drop `SYSTEM_SUBJECT` and its `consumeQuota`)
- Test: `test/unit/ai-gate-callsites.test.ts`, `test/unit/events-discovery-store.test.ts` (or a new `events-discovery-budget.test.ts`)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `runStructured`: reserve after `assertAiAllowed`, estimate `{ model, maxOutputTokens: opts.maxTokens ?? 2048, promptTokens: estimatePromptTokens({ system, messages }) }`; settle in `finally` with the response's usage (input, output, cache read/write).
  - `streamChat`: the same with `maxTokens ?? 1200`; settle with the final message's usage, or null on error.
  - `research()`: one reservation per API call in its continuation loop (`maxOutputTokens: 16000`, `webSearches: opts.maxSearches ?? 5`); settle with usage plus `usage.server_tool_use?.web_search_requests`. Subject `researchSubject(actorId: string | null): BudgetSubject` (exported): `{ userId }`, or `{ system: "events-discovery" }` with no actor.
  - Events discovery stops cleanly on the gate's 429 exactly where it stopped on `allowed === false` before.

- [ ] **Step 1: Write the failing tests**

```ts
test("only lib/anthropic.ts and lib/axis/llm.ts call the model", ...)
  // scan src/**/*.ts for /\.messages\.(create|stream|countTokens)\b|\.batches\.|new Anthropic\(/ outside those two files -> []
test("each file reserves at least once per model call it makes", ...)
  // count of `reserve(` (+ `axisGate(`/`reserveTurn(` in llm.ts) >= count of model calls, per file
test("research with no actor spends the events-discovery system budget", ...)  // researchSubject(null) deepEqual { system: "events-discovery" }
test("events discovery no longer charges a made-up account", ...)               // source of eventsDiscovery.ts has no SYSTEM_SUBJECT / consumeQuota
```

- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement.** Remove every `enforceQuota(... "ai_calls" ...)` and `"ai_output_tokens"` call from these files.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): research, structured and chat calls through the gate; fix the events budget`

---

### Task 6: Limits, status, account deletion, and the API-level checks

**Files:**
- Modify: `src/routes/tasks.ts` (`limit("ai:hand-in", 20, 60)` on `POST /:id/submissions` and `POST /:id/review`), `src/routes/internal.ts` (`/status` adds `aiBudget: { mode, spendTodayUsd, ceilingUsd }`; mode never changes the status code), `src/routes/account.ts` (`forgetUser(me)` before `deleteUser`)
- Test: `test/integration/ai-budget-api.test.mjs`

**Interfaces:**
- Consumes: Task 3 (`budgetMode`, `spendToday`, `forgetUser`).

- [ ] **Step 1: Write the failing integration tests** (API running locally without `ANTHROPIC_API_KEY`, as in CI; seed counters with `sql()`)

```js
test("a counselor at the daily call cap gets the daily message", ...)  // seed user:<id> calls/day 300; POST /ai/meeting-summary -> 429, error text exact
test("a budget check that errors refuses once the migration is in", ...) // revoke execute on ai_budget_reserve from service_role; -> 503 code ai_budget_unavailable; re-grant in finally
test("at the company ceiling AI pauses and the team gets one email", ...) // seed company spend_usd/day 100 -> 429 code ai_paused; Mailpit has one "paused" email
test("crossing 50% sends the 50% email once", ...)                       // seed 49.999; two calls; Mailpit has exactly one 50% email
test("/internal/status shows the budget mode", ...)                     // aiBudget.mode === "enforced", ceilingUsd === 100
test("deleting an account removes its budget rows", ...)
```

- [ ] **Step 2: Run** `npm run test:integration -- test/integration/ai-budget-api.test.mjs` (API started as in `ci.yml`) → FAIL.
- [ ] **Step 3: Implement the route changes.**
- [ ] **Step 4: Run it again** → PASS; then the full `npm run test:integration` → PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): hand-in limit, status field, account cleanup`

---

### Task 7: Background-job audit, the cost report's prices, docs

**Files:**
- Create: `test/unit/budget-subjects.test.ts`
- Modify: `scripts/axis/axis-cost-report.sql` (PR #85: each `prices` CTE reads `private.ai_prices` instead of its VALUES list; nothing else in the file changes), `AGENTS.md` (Rate limiting, AxIS Limits, Events Hub discovery budget, the price table and how to change a price, the migration's deploy order, the env vars, `/internal/status`)

**Interfaces:**
- Consumes: Task 1 `private.ai_prices`, Task 3 `SystemSubject`.

- [ ] **Step 1: Write the failing test**

```ts
test("no budget is charged to a made-up account", ...)
  // scan src for reserve( / consumeQuota( / enforceQuota(; first argument must not be a string literal,
  // a uuid-shaped literal or an UPPER_CASE identifier, unless it is { system: "<SystemSubject>" }
```

- [ ] **Step 2: Run** `npm test` → FAIL until Task 5's change is in; then PASS.
- [ ] **Step 3: Switch the cost report's prices to the table.** If PR #85 hasn't merged yet, skip this step and say in the PR that whichever lands second makes the switch. Run each of its queries against the local database: they execute and price the seeded models.
- [ ] **Step 4: Write the pre-merge usage check for the PR description.** It is not a repo file: production has no `ai_prices` until this merges, so its `prices` CTE is the migration's seed rows, copied at PR time and used once. `begin read only; ... rollback;`, last 60 days of `ai_runs`, four result sets: each user's busiest day of calls, each user's busiest month of output tokens, each user's busiest month of weighted input, the company's busiest day of estimated spend; each row shows `pct_of_default` and is listed only at 70% or more. Run it against the local database to check it executes.
- [ ] **Step 5: Repeat the audit on main** (`grep -rn "consumeQuota\|enforceQuota\|reserve(" src`) and keep the result for the PR description.
- [ ] **Step 6: Update AGENTS.md.**
- [ ] **Step 7: Commit** `test(ai-budget): constant-subject audit; cost report reads the price table; docs`

---

### Task 8: Whole-branch check and PR

- [ ] **Step 1:** Rebase onto `origin/main` (A1 merged). `npm run typecheck && npm test && npm run test:integration` → all PASS.
- [ ] **Step 2:** Push the branch and open the PR (Elvin merges). The description carries the audit result, the usage check (Task 7) and, as numbered click-by-click steps for Elvin:
  1. Open Supabase, then SQL editor, then New query. Paste the usage check from this description and click Run. Every result set should be empty.
  2. If a row shows up, raise that env var on Railway before merging (the API service, Variables tab, the var named in the row's `env_var` column).
  3. Merge the PR (either order with the migration is safe).
  4. Open the Terminal app and run `cd ~/"Meridies AI/meridies-backend" && git checkout main && git pull`.
  5. Run `supabase db push --linked --dry-run`. It should list exactly `20261031000002_ai_budget.sql`. If it lists anything else, stop and send me the output.
  6. Run `supabase db push --linked`, answer `Y`. It should end "Finished supabase db push."
  7. In Railway, open the API service's Variables tab. Note the `PUBLIC_API_URL` value, and copy the `CRON_SECRET` value.
  8. In Terminal run `read -s CRON_SECRET`, paste, press Return (nothing shows).
  9. Run `curl -s -H "Authorization: Bearer $CRON_SECRET" "<PUBLIC_API_URL>/internal/status"` with the address from step 7. The answer should contain `"aiBudget":{"mode":"enforced"`.
