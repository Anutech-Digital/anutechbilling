\set ON_ERROR_STOP on
-- R-1716: quote / invoice / credit note / debit note dates and "customer since" default to the
-- IST calendar day, not CURRENT_DATE (the UTC day on Cloud SQL — a day behind 00:00–05:30 IST).
-- Migration: 20261024013223_r1716_ist_document_dates.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1716_ist_document_dates.test.sql
--
-- Expect "PASS r1716_ist_document_dates".
--
--   DEFAULTS  each of the five columns defaults to (now() at time zone 'Asia/Kolkata')::date
--   VALUE     with the session in UTC, each default evaluates to ist_today(), not current_date's rule
--   MUTATION  put one default back to CURRENT_DATE → the same check refuses it

begin;

create function pg_temp.r1716_check() returns void language plpgsql as $f$
declare
  r record;
  v_expr text;
  v_val date;
begin
  for r in
    select * from (values
      ('quotes', 'created_date'), ('invoices', 'invoice_date'), ('credit_notes', 'credit_date'),
      ('debit_notes', 'debit_date'), ('customers', 'since')) as t(tbl, col)
  loop
    select pg_get_expr(d.adbin, d.adrelid) into v_expr
      from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = format('public.%I', r.tbl)::regclass and a.attname = r.col;
    if v_expr is null or v_expr not ilike '%Asia/Kolkata%' or v_expr ilike '%CURRENT_DATE%' then
      raise exception 'R-1716: %.% defaults to % — must be the IST day', r.tbl, r.col, coalesce(v_expr, '(none)');
    end if;
    execute format('select %s', v_expr) into v_val;
    if v_val is distinct from public.ist_today() then
      raise exception 'R-1716: %.% default gives %, IST today is %', r.tbl, r.col, v_val, public.ist_today();
    end if;
  end loop;
end $f$;

-- The server's own clock is UTC on Cloud SQL — evaluate the defaults the way it does.
set local timezone = 'UTC';

-- The rule itself at the instant that broke it: 00:30 IST 21 Oct = 19:00 UTC 20 Oct.
do $$
begin
  if (timestamptz '2026-10-20 19:00:00+00' at time zone 'Asia/Kolkata')::date <> date '2026-10-21' then
    raise exception 'R-1716: 00:30 IST on 21 Oct must be 21 Oct';
  end if;
end $$;

select pg_temp.r1716_check();

-- MUTATION: the old default must be refused by the same check.
alter table public.quotes alter column created_date set default current_date;
do $$
begin
  perform pg_temp.r1716_check();
  raise exception 'R-1716 MUTATION: CURRENT_DATE default was NOT caught';
exception when raise_exception then
  if sqlerrm like 'R-1716 MUTATION%' then raise; end if;
  raise notice 'mutation caught: %', sqlerrm;
end $$;

select 'PASS r1716_ist_document_dates' as result;
rollback;
