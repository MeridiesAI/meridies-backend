-- How long a payment package runs, in months (Payment Tracker: "6 payments over 6 months").
alter table public.pipeline_packages
  add column if not exists duration_months integer check (duration_months is null or duration_months between 1 and 120);
