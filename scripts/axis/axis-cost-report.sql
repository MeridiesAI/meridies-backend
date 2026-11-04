-- AxIS cost report: cost per turn, cache hit rate and model calls per turn by mode, the weekly
-- bill by kind of call, answers that needed no model, and whether the cache pre-warm pays off.
--
-- Read-only: each query runs inside `begin read only; ... rollback;`, so Postgres refuses any
-- write and nothing is kept. Every query looks at the last 30 days.
--
-- How to run: Supabase dashboard > SQL Editor > New query. Paste ONE query (its `begin` through
-- its `rollback`) and press Run. The editor shows the query's rows even with the rollback after it.
--
-- Where the numbers come from (src/lib/axis/llm.ts, loop.ts, engine.ts):
--   * module 'axis': one row per AxIS turn that used the model, summing every call in it
--     (the answering agent and, for compound questions, the specialists). 'axis-verify' = the
--     after-answer fact check, 'axis-memory' = the conversation summary, 'axis-warm' = the
--     cache pre-warm when the panel opens.
--   * input_tokens = uncached + cache read + cache write. The output column carries
--     cacheReadTokens, cacheWriteTokens and, on rows written after the logging change,
--     cacheWrite5mTokens / cacheWrite1hTokens (the split), modelCalls (billed calls, helpers
--     included) and longPrompt (the same figures for the calls over Haiku 5.5's 100K line).
--     input.files on a turn is how many attached files it handed the model.
--   * Older rows have no split, no modelCalls and no longPrompt. Their cache writes are priced
--     at the 1-hour rate (the dearer one), their call count is the answering agent's own
--     counter (it misses specialist calls), and which of their calls passed 100K is estimated
--     (below). The old_logging_pct column says how much of a result rests on older rows.
--
-- Prices: Anthropic's price list (platform.claude.com/docs/en/about-claude/pricing), checked
-- 2026-10-30, per million tokens. Cache reads are 0.1x input, 0.05x on Opus 5.5 and Sonnet 5.5,
-- 0.025x on Fable 5.1 and Mythos 5.1. Cache writes are 1.25x input for 5 minutes, 2x for 1 hour.
-- Haiku 5.5 bills a call whose prompt (cached tokens included) passes 100K tokens at 5x on every
-- token, output too (long_above / long_mult). Newer rows say exactly which tokens those were.
-- On older rows, a row whose prompt tokens per call pass 100K counts as all long: an estimate
-- that misses a long call among shorter ones. A model not in the list gets no price and is
-- counted in unpriced_rows.
--
-- The first four parts of queries 1, 2 and 4 (prices, runs, split, costed) are the same
-- apart from the modules they read, so each query can be pasted on its own.


-- 1. Per AxIS turn, by mode. The last row (ALL TURNS) is the total. Each turn's cost includes
--    its fact checks. long_prompt_* are the share of calls and of spend from calls over 100K;
--    files_spend_pct is the share of spend from turns that carried attached files.
begin read only;
with prices (model, input_usd, output_usd, read_mult, long_above, long_mult) as (
  values
    ('claude-haiku-5-5', 0.10, 0.50, 0.10, 100000, 5), ('claude-haiku-4-5', 1.00, 5.00, 0.10, null, 1),
    ('claude-sonnet-5-5', 2.00, 10.00, 0.05, null, 1), ('claude-sonnet-5', 2.00, 10.00, 0.10, null, 1),
    ('claude-sonnet-4-6', 3.00, 15.00, 0.10, null, 1), ('claude-sonnet-4-5', 3.00, 15.00, 0.10, null, 1),
    ('claude-opus-5-5', 4.00, 20.00, 0.05, null, 1), ('claude-opus-5', 5.00, 25.00, 0.10, null, 1),
    ('claude-opus-4-8', 5.00, 25.00, 0.10, null, 1), ('claude-opus-4-7', 5.00, 25.00, 0.10, null, 1),
    ('claude-opus-4-6', 5.00, 25.00, 0.10, null, 1), ('claude-fable-5', 10.00, 50.00, 0.10, null, 1),
    ('claude-fable-5-1', 10.00, 50.00, 0.025, null, 1), ('claude-mythos-5-1', 10.00, 50.00, 0.025, null, 1)
),
runs as (
  select
    r.id, r.actor_id, r.student_id, r.module, r.model, r.status, r.created_at, r.input,
    p.input_usd, p.output_usd, p.read_mult, p.long_above, p.long_mult,
    coalesce(r.input_tokens, 0)::bigint as prompt,
    coalesce(r.output_tokens, 0)::bigint as output_tokens,
    coalesce((r.output ->> 'cacheReadTokens')::bigint, 0) as cache_read,
    coalesce((r.output ->> 'cacheWriteTokens')::bigint, 0) as cache_write,
    coalesce((r.output ->> 'cacheWrite5mTokens')::bigint, 0) as write_5m,
    coalesce((r.output ->> 'cacheWrite1hTokens')::bigint, 0) as write_1h,
    r.output ? 'modelCalls' as new_logging,
    coalesce((r.output ->> 'modelCalls')::int, case when r.module = 'axis' then (r.output ->> 'calls')::int else 1 end, 0) as calls,
    r.output -> 'longPrompt' as lp
  from public.ai_runs r
  left join prices p on p.model = r.model
  where r.module in ('axis', 'axis-verify')
    and r.created_at >= now() - interval '30 days'
),
split as (
  -- The part of each row billed at the higher rate (see the header for older rows).
  select u.*,
    case when u.lp is not null then coalesce((u.lp ->> 'calls')::int, 0) when u.old_long then u.calls else 0 end as l_calls,
    case when u.lp is not null then coalesce((u.lp ->> 'inputTokens')::bigint, 0) when u.old_long then u.prompt else 0 end as l_prompt,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheReadTokens')::bigint, 0) when u.old_long then u.cache_read else 0 end as l_read,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWriteTokens')::bigint, 0) when u.old_long then u.cache_write else 0 end as l_write,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWrite5mTokens')::bigint, 0) when u.old_long then u.write_5m else 0 end as l_5m,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWrite1hTokens')::bigint, 0) when u.old_long then u.write_1h else 0 end as l_1h,
    case when u.lp is not null then coalesce((u.lp ->> 'outputTokens')::bigint, 0) when u.old_long then u.output_tokens else 0 end as l_output
  from (select r.*, r.lp is null and r.prompt > r.long_above * greatest(r.calls, 1) as old_long from runs r) u
),
costed as (
  -- One price formula, applied to the whole row and again to its long part: the long part
  -- costs long_mult times the lower card, so it adds (long_mult - 1) on top of the whole.
  select s.*, c.cost_usd, c.long_usd
  from split s
  cross join lateral (
    select
      sum(b.usd * case when v.part = 'all' then 1 else s.long_mult - 1 end) as cost_usd,
      sum(b.usd * s.long_mult) filter (where v.part = 'long') as long_usd
    from (values
      ('all', s.prompt, s.cache_read, s.cache_write, s.write_5m, s.write_1h, s.output_tokens),
      ('long', s.l_prompt, s.l_read, s.l_write, s.l_5m, s.l_1h, s.l_output)
    ) v (part, prompt, cache_read, cache_write, write_5m, write_1h, output_tokens)
    cross join lateral (
      select (greatest(v.prompt - v.cache_read - v.cache_write, 0) * s.input_usd
        + v.cache_read * s.input_usd * s.read_mult
        + v.write_5m * s.input_usd * 1.25
        + (v.write_1h + greatest(v.cache_write - v.write_5m - v.write_1h, 0)) * s.input_usd * 2
        + v.output_tokens * s.output_usd) / 1e6 as usd
    ) b
  ) c
),
turns as (
  select c.*,
    case when c.input ->> 'path' = 'specialists' then 'synthesis (specialists)' else coalesce(c.input ->> 'intent', 'unknown') end as mode,
    coalesce((c.input ->> 'files')::int, 0) > 0 as has_files,
    -- A cold cache: the turn rewrote 10K+ tokens of the 1-hour cached prompt (all writes on older rows).
    (case when c.new_logging then c.write_1h else c.cache_write end) >= 10000 as cold
  from costed c
  where c.module = 'axis'
),
checks as (
  -- Each fact check belongs to the latest turn by the same counselor about the same student
  -- in the 3 minutes before it (the rows carry no turn id).
  select t.id as turn_id, count(*) as n, sum(v.calls) as calls, sum(v.l_calls) as l_calls,
    sum(v.cost_usd) as cost_usd, sum(v.long_usd) as long_usd
  from costed v
  join lateral (
    select t.id from turns t
    where t.actor_id is not distinct from v.actor_id
      and t.student_id is not distinct from v.student_id
      and t.created_at <= v.created_at
      and t.created_at > v.created_at - interval '3 minutes'
    order by t.created_at desc
    limit 1
  ) t on true
  where v.module = 'axis-verify'
  group by t.id
),
per_turn as (
  select t.*,
    coalesce(c.n, 0) as fact_checks,
    t.cost_usd + coalesce(c.cost_usd, 0) as turn_usd,
    coalesce(t.long_usd, 0) + coalesce(c.long_usd, 0) as turn_long_usd,
    t.calls + coalesce(c.calls, 0) as all_calls,
    t.l_calls + coalesce(c.l_calls, 0) as all_l_calls
  from turns t
  left join checks c on c.turn_id = t.id
)
select
  coalesce(mode, 'ALL TURNS') as mode,
  count(*) as turns,
  round(avg(calls), 2) as avg_model_calls,
  max(calls) as max_model_calls,
  round(avg(fact_checks), 2) as avg_fact_checks,
  round(100.0 * sum(cache_read) / nullif(sum(prompt), 0), 1) as cache_hit_pct,
  round(100.0 * count(*) filter (where cold) / count(*), 1) as cold_cache_turns_pct,
  round(avg(prompt)) as avg_input_tokens,
  round(avg(output_tokens)) as avg_output_tokens,
  round(avg(turn_usd), 5) as avg_usd_per_turn,
  round(percentile_cont(0.5) within group (order by turn_usd::float8)::numeric, 5) as median_usd_per_turn,
  round(percentile_cont(0.9) within group (order by turn_usd::float8)::numeric, 5) as p90_usd_per_turn,
  round(sum(turn_usd), 4) as total_usd,
  round(100.0 * sum(all_l_calls) / nullif(sum(all_calls), 0), 1) as long_prompt_calls_pct,
  round(100.0 * sum(turn_long_usd) / nullif(sum(turn_usd), 0), 1) as long_prompt_spend_pct,
  count(*) filter (where l_calls > 0) as turns_with_long_prompts,
  count(*) filter (where has_files) as turns_with_files,
  round(100.0 * coalesce(sum(turn_usd) filter (where has_files), 0) / nullif(sum(turn_usd), 0), 1) as files_spend_pct,
  count(*) filter (where status <> 'succeeded') as turns_not_succeeded,
  count(*) filter (where cost_usd is null) as unpriced_rows,
  round(100.0 * count(*) filter (where not new_logging) / count(*), 1) as old_logging_pct
from per_turn
group by rollup (mode)
order by grouping(mode), total_usd desc nulls last;
rollback;


-- 2. The whole AxIS bill by week and kind of call, including the pre-warm and memory calls
--    that don't belong to one turn.
begin read only;
with prices (model, input_usd, output_usd, read_mult, long_above, long_mult) as (
  values
    ('claude-haiku-5-5', 0.10, 0.50, 0.10, 100000, 5), ('claude-haiku-4-5', 1.00, 5.00, 0.10, null, 1),
    ('claude-sonnet-5-5', 2.00, 10.00, 0.05, null, 1), ('claude-sonnet-5', 2.00, 10.00, 0.10, null, 1),
    ('claude-sonnet-4-6', 3.00, 15.00, 0.10, null, 1), ('claude-sonnet-4-5', 3.00, 15.00, 0.10, null, 1),
    ('claude-opus-5-5', 4.00, 20.00, 0.05, null, 1), ('claude-opus-5', 5.00, 25.00, 0.10, null, 1),
    ('claude-opus-4-8', 5.00, 25.00, 0.10, null, 1), ('claude-opus-4-7', 5.00, 25.00, 0.10, null, 1),
    ('claude-opus-4-6', 5.00, 25.00, 0.10, null, 1), ('claude-fable-5', 10.00, 50.00, 0.10, null, 1),
    ('claude-fable-5-1', 10.00, 50.00, 0.025, null, 1), ('claude-mythos-5-1', 10.00, 50.00, 0.025, null, 1)
),
runs as (
  select
    r.id, r.actor_id, r.student_id, r.module, r.model, r.status, r.created_at, r.input,
    p.input_usd, p.output_usd, p.read_mult, p.long_above, p.long_mult,
    coalesce(r.input_tokens, 0)::bigint as prompt,
    coalesce(r.output_tokens, 0)::bigint as output_tokens,
    coalesce((r.output ->> 'cacheReadTokens')::bigint, 0) as cache_read,
    coalesce((r.output ->> 'cacheWriteTokens')::bigint, 0) as cache_write,
    coalesce((r.output ->> 'cacheWrite5mTokens')::bigint, 0) as write_5m,
    coalesce((r.output ->> 'cacheWrite1hTokens')::bigint, 0) as write_1h,
    r.output ? 'modelCalls' as new_logging,
    coalesce((r.output ->> 'modelCalls')::int, case when r.module = 'axis' then (r.output ->> 'calls')::int else 1 end, 0) as calls,
    r.output -> 'longPrompt' as lp
  from public.ai_runs r
  left join prices p on p.model = r.model
  where r.module in ('axis', 'axis-verify', 'axis-memory', 'axis-warm')
    and r.created_at >= now() - interval '30 days'
),
split as (
  -- The part of each row billed at the higher rate (see the header for older rows).
  select u.*,
    case when u.lp is not null then coalesce((u.lp ->> 'calls')::int, 0) when u.old_long then u.calls else 0 end as l_calls,
    case when u.lp is not null then coalesce((u.lp ->> 'inputTokens')::bigint, 0) when u.old_long then u.prompt else 0 end as l_prompt,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheReadTokens')::bigint, 0) when u.old_long then u.cache_read else 0 end as l_read,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWriteTokens')::bigint, 0) when u.old_long then u.cache_write else 0 end as l_write,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWrite5mTokens')::bigint, 0) when u.old_long then u.write_5m else 0 end as l_5m,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWrite1hTokens')::bigint, 0) when u.old_long then u.write_1h else 0 end as l_1h,
    case when u.lp is not null then coalesce((u.lp ->> 'outputTokens')::bigint, 0) when u.old_long then u.output_tokens else 0 end as l_output
  from (select r.*, r.lp is null and r.prompt > r.long_above * greatest(r.calls, 1) as old_long from runs r) u
),
costed as (
  -- One price formula, applied to the whole row and again to its long part: the long part
  -- costs long_mult times the lower card, so it adds (long_mult - 1) on top of the whole.
  select s.*, c.cost_usd, c.long_usd
  from split s
  cross join lateral (
    select
      sum(b.usd * case when v.part = 'all' then 1 else s.long_mult - 1 end) as cost_usd,
      sum(b.usd * s.long_mult) filter (where v.part = 'long') as long_usd
    from (values
      ('all', s.prompt, s.cache_read, s.cache_write, s.write_5m, s.write_1h, s.output_tokens),
      ('long', s.l_prompt, s.l_read, s.l_write, s.l_5m, s.l_1h, s.l_output)
    ) v (part, prompt, cache_read, cache_write, write_5m, write_1h, output_tokens)
    cross join lateral (
      select (greatest(v.prompt - v.cache_read - v.cache_write, 0) * s.input_usd
        + v.cache_read * s.input_usd * s.read_mult
        + v.write_5m * s.input_usd * 1.25
        + (v.write_1h + greatest(v.cache_write - v.write_5m - v.write_1h, 0)) * s.input_usd * 2
        + v.output_tokens * s.output_usd) / 1e6 as usd
    ) b
  ) c
)
select
  date_trunc('week', created_at)::date as week,
  case module
    when 'axis' then 'turn (answer)'
    when 'axis-verify' then 'fact check'
    when 'axis-memory' then 'memory summary'
    when 'axis-warm' then 'cache pre-warm'
  end as kind,
  count(*) as run_rows,
  sum(calls) as model_calls,
  round(100.0 * sum(cache_read) / nullif(sum(prompt), 0), 1) as cache_hit_pct,
  sum(write_5m) as write_5m_tokens,
  sum(write_1h) as write_1h_tokens,
  sum(greatest(cache_write - write_5m - write_1h, 0)) as write_unsplit_tokens,
  round(sum(cost_usd), 4) as total_usd,
  round(100.0 * sum(cost_usd) / nullif(sum(sum(cost_usd)) over (partition by date_trunc('week', created_at)), 0), 1) as pct_of_week,
  count(*) filter (where cost_usd is null) as unpriced_rows
from costed
group by date_trunc('week', created_at), module
order by week desc, total_usd desc nulls last;
rollback;


-- 3. How many AxIS answers needed no model at all: direct answers from the record and
--    essay-advice bullets save no 'axis' run on the message.
begin read only;
select
  count(*) as answers,
  count(*) filter (where m.ai_run_id is not null) as used_answer_model,
  count(*) filter (where m.ai_run_id is null) as no_answer_model,
  round(100.0 * count(*) filter (where m.ai_run_id is null) / nullif(count(*), 0), 1) as no_answer_model_pct
from public.ai_messages m
join public.ai_conversations c on c.id = m.conversation_id
where c.module = 'axis'
  and m.role = 'assistant'
  and m.created_at >= now() - interval '30 days';
rollback;


-- 4. Does the pre-warm pay off? Each pre-warm either found the cache warm already (a cheap
--    read), or wrote it and a turn by the same counselor about the same student used it within
--    the hour, or wrote it for nothing. extra_usd is what a pre-warm cost beyond what that turn
--    would have paid without it: its whole cost, less (when a turn followed) the 5-minute write
--    at 1.25x that the turn would have made itself instead of reading the pre-warm's copy, at
--    the turn's rate card. Every written token counts as such a write, so extra_usd is the most
--    a pre-warm could have cost: today turns write the student block at 1 hour (2x), and the
--    shared tools + system prefix is written at 1 hour either way. The last row totals the
--    pre-warms. Rows 4 and 5 are turns with no pre-warm in the hour before them: if those are
--    rarely cold, the cache stays warm without the pre-warm.
begin read only;
with prices (model, input_usd, output_usd, read_mult, long_above, long_mult) as (
  values
    ('claude-haiku-5-5', 0.10, 0.50, 0.10, 100000, 5), ('claude-haiku-4-5', 1.00, 5.00, 0.10, null, 1),
    ('claude-sonnet-5-5', 2.00, 10.00, 0.05, null, 1), ('claude-sonnet-5', 2.00, 10.00, 0.10, null, 1),
    ('claude-sonnet-4-6', 3.00, 15.00, 0.10, null, 1), ('claude-sonnet-4-5', 3.00, 15.00, 0.10, null, 1),
    ('claude-opus-5-5', 4.00, 20.00, 0.05, null, 1), ('claude-opus-5', 5.00, 25.00, 0.10, null, 1),
    ('claude-opus-4-8', 5.00, 25.00, 0.10, null, 1), ('claude-opus-4-7', 5.00, 25.00, 0.10, null, 1),
    ('claude-opus-4-6', 5.00, 25.00, 0.10, null, 1), ('claude-fable-5', 10.00, 50.00, 0.10, null, 1),
    ('claude-fable-5-1', 10.00, 50.00, 0.025, null, 1), ('claude-mythos-5-1', 10.00, 50.00, 0.025, null, 1)
),
runs as (
  select
    r.id, r.actor_id, r.student_id, r.module, r.model, r.status, r.created_at, r.input,
    p.input_usd, p.output_usd, p.read_mult, p.long_above, p.long_mult,
    coalesce(r.input_tokens, 0)::bigint as prompt,
    coalesce(r.output_tokens, 0)::bigint as output_tokens,
    coalesce((r.output ->> 'cacheReadTokens')::bigint, 0) as cache_read,
    coalesce((r.output ->> 'cacheWriteTokens')::bigint, 0) as cache_write,
    coalesce((r.output ->> 'cacheWrite5mTokens')::bigint, 0) as write_5m,
    coalesce((r.output ->> 'cacheWrite1hTokens')::bigint, 0) as write_1h,
    r.output ? 'modelCalls' as new_logging,
    coalesce((r.output ->> 'modelCalls')::int, case when r.module = 'axis' then (r.output ->> 'calls')::int else 1 end, 0) as calls,
    r.output -> 'longPrompt' as lp
  from public.ai_runs r
  left join prices p on p.model = r.model
  where r.module in ('axis', 'axis-warm')
    and r.created_at >= now() - interval '30 days'
),
split as (
  -- The part of each row billed at the higher rate (see the header for older rows).
  select u.*,
    case when u.lp is not null then coalesce((u.lp ->> 'calls')::int, 0) when u.old_long then u.calls else 0 end as l_calls,
    case when u.lp is not null then coalesce((u.lp ->> 'inputTokens')::bigint, 0) when u.old_long then u.prompt else 0 end as l_prompt,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheReadTokens')::bigint, 0) when u.old_long then u.cache_read else 0 end as l_read,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWriteTokens')::bigint, 0) when u.old_long then u.cache_write else 0 end as l_write,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWrite5mTokens')::bigint, 0) when u.old_long then u.write_5m else 0 end as l_5m,
    case when u.lp is not null then coalesce((u.lp ->> 'cacheWrite1hTokens')::bigint, 0) when u.old_long then u.write_1h else 0 end as l_1h,
    case when u.lp is not null then coalesce((u.lp ->> 'outputTokens')::bigint, 0) when u.old_long then u.output_tokens else 0 end as l_output
  from (select r.*, r.lp is null and r.prompt > r.long_above * greatest(r.calls, 1) as old_long from runs r) u
),
costed as (
  -- One price formula, applied to the whole row and again to its long part: the long part
  -- costs long_mult times the lower card, so it adds (long_mult - 1) on top of the whole.
  select s.*, c.cost_usd, c.long_usd
  from split s
  cross join lateral (
    select
      sum(b.usd * case when v.part = 'all' then 1 else s.long_mult - 1 end) as cost_usd,
      sum(b.usd * s.long_mult) filter (where v.part = 'long') as long_usd
    from (values
      ('all', s.prompt, s.cache_read, s.cache_write, s.write_5m, s.write_1h, s.output_tokens),
      ('long', s.l_prompt, s.l_read, s.l_write, s.l_5m, s.l_1h, s.l_output)
    ) v (part, prompt, cache_read, cache_write, write_5m, write_1h, output_tokens)
    cross join lateral (
      select (greatest(v.prompt - v.cache_read - v.cache_write, 0) * s.input_usd
        + v.cache_read * s.input_usd * s.read_mult
        + v.write_5m * s.input_usd * 1.25
        + (v.write_1h + greatest(v.cache_write - v.write_5m - v.write_1h, 0)) * s.input_usd * 2
        + v.output_tokens * s.output_usd) / 1e6 as usd
    ) b
  ) c
),
turns as (
  select c.*, (case when c.new_logging then c.write_1h else c.cache_write end) >= 10000 as cold
  from costed c
  where c.module = 'axis'
),
warms as (
  -- The first turn by the same counselor about the same student within the hour, if any.
  select w.*, nt.id as turn_id, coalesce(nt.l_calls > 0, false) as turn_long
  from costed w
  left join lateral (
    select t.id, t.l_calls from turns t
    where t.actor_id is not distinct from w.actor_id
      and t.student_id is not distinct from w.student_id
      and t.created_at >= w.created_at
      and t.created_at < w.created_at + interval '60 minutes'
    order by t.created_at
    limit 1
  ) nt on true
  where w.module = 'axis-warm'
),
outcomes as (
  select
    true as is_warm,
    case
      when w.cache_write < 1000 then '1. found the cache warm (a read)'
      when w.turn_id is not null then '2. wrote the cache, a turn used it'
      else '3. wrote the cache, no turn within the hour'
    end as outcome,
    w.cost_usd, w.cache_write,
    w.cost_usd - case when w.turn_id is null then 0
      else w.cache_write * w.input_usd * (1.25 - w.read_mult) * (case when w.turn_long then w.long_mult else 1 end) / 1e6
    end as extra_usd
  from warms w
  union all
  select false, case when t.cold then '4. turn, no pre-warm before it: cold cache' else '5. turn, no pre-warm before it: warm cache' end,
    t.cost_usd, t.cache_write, null
  from turns t
  where not exists (
    select 1 from costed w
    where w.module = 'axis-warm'
      and w.actor_id is not distinct from t.actor_id
      and w.student_id is not distinct from t.student_id
      and w.created_at <= t.created_at
      and w.created_at > t.created_at - interval '60 minutes'
  )
)
select
  outcome,
  count(*) as run_rows,
  round(avg(cost_usd), 5) as avg_usd,
  round(sum(cost_usd), 4) as total_usd,
  round(avg(extra_usd), 5) as avg_extra_usd,
  round(sum(extra_usd), 4) as total_extra_usd,
  round(avg(cache_write)) as avg_cache_write_tokens
from outcomes
group by outcome
union all
select 'all pre-warms (rows 1-3)', count(*), round(avg(cost_usd), 5), round(sum(cost_usd), 4),
  round(avg(extra_usd), 5), round(sum(extra_usd), 4), round(avg(cache_write))
from outcomes
where is_warm
order by outcome;
rollback;
