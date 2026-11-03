-- One budget gate for every model call (AxIS security PR A2; spec
-- docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md, section 1 and the Plan review of 11/2).
-- The API reserves before a call and settles after it (lib/aiBudget.ts), over these service-role-only functions.
--
--   private.ai_budget   counters keyed by subject (user:<id>, company, system:<job>), metric (calls,
--                       output_tokens, input_weighted, spend_usd) and period (a UTC day, a calendar month)
--   private.ai_prices   USD per million tokens per model, the one price list: the code reads it through
--                       public.ai_budget_prices() and the SQL reports join it. A price change is a new
--                       migration that updates rows here.
--
-- Reserve takes every line or none: it locks the rows in key order and adds only when every line stays within
-- its limit, so two replicas at the edge of a cap can't both pass. Settle moves a total by a delta, never below 0.
--
-- Deploy order: either. Without this file the API counts as it does today (the daily call quota and the
-- monthly output quota) and logs a warning; with it and no new code nothing calls these functions. Not in
-- REQUIRED_SCHEMA. Private tables: no client grants, no approval gate needed.

create table if not exists private.ai_budget (
  subject      text not null check (subject ~ '^(user:[0-9a-f-]{36}|company|system:[a-z-]+)$'),
  metric       text not null check (metric in ('calls', 'output_tokens', 'input_weighted', 'spend_usd')),
  period       text not null check (period in ('day', 'month')),
  period_start date not null,
  amount       numeric(20, 6) not null default 0 check (amount >= 0),
  updated_at   timestamptz not null default now(),
  primary key (subject, metric, period, period_start),
  check (period = 'day' or period_start = date_trunc('month', period_start)::date)
);
alter table private.ai_budget enable row level security;
revoke all on private.ai_budget from public, anon, authenticated;

create table if not exists private.ai_prices (
  model          text primary key check (model ~ '^claude-[a-z0-9-]+$'),
  input_usd      numeric(10, 4) not null check (input_usd > 0),
  output_usd     numeric(10, 4) not null check (output_usd > 0),
  read_mult      numeric(6, 4) not null check (read_mult > 0 and read_mult <= 1),
  write_5m_mult  numeric(6, 4) not null default 1.25,
  write_1h_mult  numeric(6, 4) not null default 2,
  long_above     integer check (long_above > 0),
  long_mult      numeric(6, 2) not null default 1 check (long_mult >= 1),
  web_search_usd numeric(10, 4) not null default 0.01,
  updated_at     timestamptz not null default now()
);
alter table private.ai_prices enable row level security;
revoke all on private.ai_prices from public, anon, authenticated;

insert into private.ai_prices (model, input_usd, output_usd, read_mult, long_above, long_mult) values
  ('claude-haiku-5-5',  0.10,  0.50, 0.10, 100000, 5),
  ('claude-haiku-4-5',  1.00,  5.00, 0.10, null, 1),
  ('claude-sonnet-5-5', 2.00, 10.00, 0.05, null, 1),
  ('claude-sonnet-5',   2.00, 10.00, 0.10, null, 1),
  ('claude-sonnet-4-6', 3.00, 15.00, 0.10, null, 1),
  ('claude-sonnet-4-5', 3.00, 15.00, 0.10, null, 1),
  ('claude-opus-5-5',   4.00, 20.00, 0.05, null, 1),
  ('claude-opus-5',     5.00, 25.00, 0.10, null, 1),
  ('claude-opus-4-8',   5.00, 25.00, 0.10, null, 1),
  ('claude-opus-4-7',   5.00, 25.00, 0.10, null, 1),
  ('claude-opus-4-6',   5.00, 25.00, 0.10, null, 1),
  ('claude-fable-5',   10.00, 50.00, 0.10, null, 1),
  ('claude-fable-5-1', 10.00, 50.00, 0.025, null, 1),
  ('claude-mythos-5-1', 10.00, 50.00, 0.025, null, 1)
on conflict (model) do nothing;

-- The lines of one call, one row per key (a key named twice is added up; the tightest limit wins).
create or replace function private.ai_budget_lines(p_lines jsonb, p_field text)
returns table (subject text, metric text, period text, period_start date, amount numeric, lim numeric)
language sql immutable set search_path = '' as $$
  select x.subject, x.metric, x.period, x.period_start,
         sum((x.line ->> p_field)::numeric), min((x.line ->> 'limit')::numeric)
  from (
    select l ->> 'subject' as subject, l ->> 'metric' as metric, l ->> 'period' as period,
           (l ->> 'period_start')::date as period_start, l as line
    from jsonb_array_elements(p_lines) as l
  ) x
  group by x.subject, x.metric, x.period, x.period_start
  order by x.subject, x.metric, x.period, x.period_start;
$$;
revoke all on function private.ai_budget_lines(jsonb, text) from public, anon, authenticated;

create or replace function public.ai_budget_reserve(p_lines jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l        record;
  v_amount numeric;
  v_totals jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 10 then
    raise exception 'ai_budget_reserve takes 1 to 10 lines' using errcode = '22023';
  end if;
  if exists (
    select 1 from private.ai_budget_lines(p_lines, 'amount') x
    where x.amount is null or x.amount < 0 or x.lim is null or x.lim < 0 or x.period_start is null
  ) then
    raise exception 'ai_budget_reserve: every line needs a period_start, an amount >= 0 and a limit >= 0' using errcode = '22023';
  end if;

  -- Rows exist at 0, then every row is locked in key order: two calls at once wait for each other, never deadlock.
  insert into private.ai_budget (subject, metric, period, period_start)
  select x.subject, x.metric, x.period, x.period_start from private.ai_budget_lines(p_lines, 'amount') x
  on conflict do nothing;
  perform 1
  from private.ai_budget b
  join private.ai_budget_lines(p_lines, 'amount') x
    on (b.subject, b.metric, b.period, b.period_start) = (x.subject, x.metric, x.period, x.period_start)
  order by b.subject, b.metric, b.period, b.period_start
  for update of b;

  for l in select * from private.ai_budget_lines(p_lines, 'amount') loop
    select b.amount into v_amount from private.ai_budget b
    where (b.subject, b.metric, b.period, b.period_start) = (l.subject, l.metric, l.period, l.period_start);
    if v_amount + l.amount > l.lim then
      return jsonb_build_object('ok', false, 'subject', l.subject, 'metric', l.metric, 'period', l.period);
    end if;
  end loop;

  for l in select * from private.ai_budget_lines(p_lines, 'amount') loop
    update private.ai_budget b set amount = b.amount + l.amount, updated_at = now()
    where (b.subject, b.metric, b.period, b.period_start) = (l.subject, l.metric, l.period, l.period_start)
    returning b.amount into v_amount;
    v_totals := v_totals || jsonb_build_object(l.subject || '|' || l.metric || '|' || l.period, v_amount);
  end loop;
  return jsonb_build_object('ok', true, 'totals', v_totals);
end;
$$;

create or replace function public.ai_budget_settle(p_lines jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  l record;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) > 10 then
    raise exception 'ai_budget_settle takes up to 10 lines' using errcode = '22023';
  end if;
  for l in select * from private.ai_budget_lines(p_lines, 'delta') loop
    update private.ai_budget b set amount = greatest(0, b.amount + coalesce(l.amount, 0)), updated_at = now()
    where (b.subject, b.metric, b.period, b.period_start) = (l.subject, l.metric, l.period, l.period_start);
  end loop;
end;
$$;

create or replace function public.ai_budget_total(p_subject text, p_metric text, p_period text, p_period_start date)
returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select b.amount from private.ai_budget b
    where b.subject = p_subject and b.metric = p_metric and b.period = p_period and b.period_start = p_period_start
  ), 0);
$$;

create or replace function public.ai_budget_prices()
returns table (model text, input_usd numeric, output_usd numeric, read_mult numeric, write_5m_mult numeric,
               write_1h_mult numeric, long_above integer, long_mult numeric, web_search_usd numeric)
language sql stable security definer set search_path = '' as $$
  select p.model, p.input_usd, p.output_usd, p.read_mult, p.write_5m_mult, p.write_1h_mult, p.long_above, p.long_mult, p.web_search_usd
  from private.ai_prices p
  order by p.model;
$$;

create or replace function public.ai_budget_forget(p_user uuid)
returns void
language sql security definer set search_path = '' as $$
  delete from private.ai_budget where subject = 'user:' || p_user::text;
$$;

-- Today's biggest spenders other than the company line, for the ceiling email (ids only; the API adds roles).
create or replace function public.ai_budget_top(p_period_start date, p_limit int default 5)
returns table (subject text, amount numeric)
language sql stable security definer set search_path = '' as $$
  select b.subject, b.amount from private.ai_budget b
  where b.metric = 'spend_usd' and b.period = 'day' and b.period_start = p_period_start and b.subject <> 'company'
  order by b.amount desc, b.subject
  limit least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

revoke all on function public.ai_budget_reserve(jsonb) from public, anon, authenticated;
revoke all on function public.ai_budget_settle(jsonb) from public, anon, authenticated;
revoke all on function public.ai_budget_total(text, text, text, date) from public, anon, authenticated;
revoke all on function public.ai_budget_prices() from public, anon, authenticated;
revoke all on function public.ai_budget_forget(uuid) from public, anon, authenticated;
revoke all on function public.ai_budget_top(date, int) from public, anon, authenticated;
grant execute on function public.ai_budget_reserve(jsonb) to service_role;
grant execute on function public.ai_budget_settle(jsonb) to service_role;
grant execute on function public.ai_budget_total(text, text, text, date) to service_role;
grant execute on function public.ai_budget_prices() to service_role;
grant execute on function public.ai_budget_forget(uuid) to service_role;
grant execute on function public.ai_budget_top(date, int) to service_role;
