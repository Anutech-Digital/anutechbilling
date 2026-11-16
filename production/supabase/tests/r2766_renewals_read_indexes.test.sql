-- R-2766 (14 Nov 2026, R-2742 PERF-3) — migration 20261114062123_r2766_renewals_read_indexes.
-- Self-asserting, ONE transaction, rolled back. Local DB only. RED without the migration (the three indexes
-- do not exist).
--
--   1. The three indexes exist, partial (where <col> is not null), on the right columns.
--   2. The Renewals reads can use them (seq scans switched off so the tiny local tables cannot hide it):
--      a. quotes where renewal_subscription_id in (…) or add_seats_subscription_id in (…)  → BitmapOr of two indexes
--      b. payment_followups where subscription_id in (…)                                     → payment_followups_subscription_idx
--      c. quotes where tenant_id = … and is_renewal and renewal_term_date between …         → quotes_renewal_term_date_idx

begin;

do $t$
declare
  v_def text;
begin
  select indexdef into v_def from pg_indexes where schemaname = 'public' and indexname = 'quotes_add_seats_subscription_idx';
  if v_def is null or v_def not ilike '%(add_seats_subscription_id)%' or v_def not ilike '%where (add_seats_subscription_id is not null)%' then
    raise exception 'R-2766 1: quotes_add_seats_subscription_idx missing or wrong: %', v_def;
  end if;
  select indexdef into v_def from pg_indexes where schemaname = 'public' and indexname = 'payment_followups_subscription_idx';
  if v_def is null or v_def not ilike '%(subscription_id)%' or v_def not ilike '%where (subscription_id is not null)%' then
    raise exception 'R-2766 1: payment_followups_subscription_idx missing or wrong: %', v_def;
  end if;
  select indexdef into v_def from pg_indexes where schemaname = 'public' and indexname = 'quotes_renewal_term_date_idx';
  if v_def is null or v_def not ilike '%(tenant_id, renewal_term_date)%' or v_def not ilike '%where (renewal_term_date is not null)%' then
    raise exception 'R-2766 1: quotes_renewal_term_date_idx missing or wrong: %', v_def;
  end if;
end $t$;

set local enable_seqscan = off;

create function pg_temp.plan_of(p_sql text) returns text language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain (costs off) ' || p_sql loop v := v || r."QUERY PLAN" || E'\n'; end loop;
  return v;
end $f$;

do $t$
declare
  v_plan text;
  s1 uuid := 'b2766000-0000-0000-0000-000000000001';
  s2 uuid := 'b2766000-0000-0000-0000-000000000002';
begin
  v_plan := pg_temp.plan_of(format(
    'select id from public.quotes where renewal_subscription_id in (%L, %L) or add_seats_subscription_id in (%L, %L)', s1, s2, s1, s2));
  if v_plan not like '%quotes_add_seats_subscription_idx%' then
    raise exception 'R-2766 2a: the renewals OR read does not use quotes_add_seats_subscription_idx:%', E'\n' || v_plan;
  end if;

  v_plan := pg_temp.plan_of(format('select id from public.payment_followups where subscription_id in (%L, %L)', s1, s2));
  if v_plan not like '%payment_followups_subscription_idx%' then
    raise exception 'R-2766 2b: follow-ups by subscription do not use payment_followups_subscription_idx:%', E'\n' || v_plan;
  end if;

  v_plan := pg_temp.plan_of(format(
    'select id from public.quotes where tenant_id = %L and is_renewal and renewal_term_date >= %L and renewal_term_date <= %L',
    'b2766000-0000-0000-0000-0000000000f1', '2026-11-01', '2026-11-30'));
  if v_plan not like '%quotes_renewal_term_date_idx%' then
    raise exception 'R-2766 2c: Renewed-this-month does not use quotes_renewal_term_date_idx:%', E'\n' || v_plan;
  end if;
end $t$;

select 'R-2766 renewals read indexes: ok' as result;

rollback;
