\set ON_ERROR_STOP on
-- R-1826: the night check in SQL — "today" at 00:30 IST is the IST day, not the UTC day.
-- R-1653 / R-1716 / R-1816 only showed between 00:00 and 05:30 IST, when CURRENT_DATE (the UTC
-- day on Cloud SQL) is still yesterday. This file pins that instant and checks the whole schema,
-- not a fixed list, so a new table or function cannot bring the bug back quietly.
-- Twin of src/lib/dates/night-ist.test.tsx (the app side). Self-asserting, ONE transaction,
-- rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/night_ist_pin.test.sql
--
-- Expect "PASS night_ist_pin".
--
--   RULE       00:30 IST 21 Oct (19:00 UTC 20 Oct): IST day 21 Oct, UTC day 20 Oct
--   IST_TODAY  public.ist_today()'s own body, run at that instant, gives 21 Oct
--   DEFAULTS   EVERY public column default that names Asia/Kolkata or ist_today() gives 21 Oct
--              at that instant (now() swapped for the instant — now() itself cannot be moved)
--   RATCHET    no date column default and no public function uses CURRENT_DATE; R-1828 fixed
--              the last 7 defaults + 14 functions, so both known lists are empty and stay empty
--   MONEY      ist_today() pinned to 21 Oct inside this transaction; record_payment settles an
--              invoice and stamps paid_date 21 Oct, not the server's day
--   MUTATION   CURRENT_DATE put back into record_payment → MONEY refuses it

begin;
set local timezone = 'UTC';   -- Cloud SQL's clock

-- ── RULE ────────────────────────────────────────────────────────────────────────────────
do $$
declare c constant timestamptz := timestamptz '2026-10-20 19:00:00+00';
begin
  if (c at time zone 'Asia/Kolkata')::date <> date '2026-10-21' then raise exception 'R-1826: 00:30 IST 21 Oct must be 21 Oct'; end if;
  if c::date <> date '2026-10-20' then raise exception 'R-1826: the UTC day of that instant must be 20 Oct'; end if;
end $$;

-- now() → the night instant, inside an expression's text.
create function pg_temp.at_night(p_expr text) returns text language sql immutable as $f$
  select regexp_replace(p_expr, '\mnow\(\)', $q$(timestamptz '2026-10-20 19:00:00+00')$q$, 'gi');
$f$;

-- ── IST_TODAY ───────────────────────────────────────────────────────────────────────────
do $$
declare v_src text; v_val date;
begin
  select regexp_replace(prosrc, '/\*.*?\*/', '', 'g') into v_src from pg_proc where oid = 'public.ist_today()'::regprocedure;
  if v_src !~* 'asia/kolkata' then raise exception 'R-1826: ist_today() no longer reads Asia/Kolkata: %', v_src; end if;
  execute pg_temp.at_night(trim(trailing ';' from trim(v_src))) into v_val;
  if v_val is distinct from date '2026-10-21' then
    raise exception 'R-1826: ist_today() at 00:30 IST 21 Oct gives %', v_val;
  end if;
end $$;

-- ── DEFAULTS (every column, discovered) ─────────────────────────────────────────────────
create temp table night_ist_known_defaults (col text primary key);
-- Empty since R-1828 (20261024085113) moved the last 7 to the IST day. Adding one = not allowed.

do $$
declare r record; v_val date; v_checked int := 0; v_new text[] := '{}';
begin
  for r in
    select c.relname || '.' || a.attname as col, pg_get_expr(d.adbin, d.adrelid) as expr
      from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      join pg_class c on c.oid = d.adrelid
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and format_type(a.atttypid, a.atttypmod) = 'date'
  loop
    if r.expr ~* 'asia/kolkata|ist_today\(\)' then
      if r.expr ~* 'ist_today\(\)' then
        execute format('select %s', replace(r.expr, 'ist_today()', '(timestamptz ''2026-10-20 19:00:00+00'' at time zone ''Asia/Kolkata'')::date')) into v_val;
      else
        execute format('select %s', pg_temp.at_night(r.expr)) into v_val;
      end if;
      if v_val is distinct from date '2026-10-21' then
        raise exception 'R-1826: % defaults to % → % at 00:30 IST 21 Oct', r.col, r.expr, v_val;
      end if;
      v_checked := v_checked + 1;
    elsif r.expr ~* '\mcurrent_date\M|\mnow\(\)|current_timestamp' then
      if not exists (select 1 from night_ist_known_defaults k where k.col = r.col) then v_new := v_new || r.col; end if;
    end if;
  end loop;
  if v_checked < 12 then raise exception 'R-1826: only % IST column defaults found — expected the R-1716 five + the R-1828 seven at least', v_checked; end if;
  if cardinality(v_new) > 0 then
    raise exception 'R-1826: new date column default on the UTC day: % — use public.ist_today()', array_to_string(v_new, ', ');
  end if;
  for r in select k.col from night_ist_known_defaults k
            where not exists (select 1 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                               join pg_class c on c.oid = d.adrelid
                              where c.relnamespace = 'public'::regnamespace and c.relname || '.' || a.attname = k.col
                                and pg_get_expr(d.adbin, d.adrelid) ~* '\mcurrent_date\M')
  loop
    raise notice 'R-1826: % is fixed — delete it from night_ist_known_defaults', r.col;
  end loop;
end $$;

-- ── RATCHET: functions ──────────────────────────────────────────────────────────────────
create temp table night_ist_known_fns (fn text primary key);
-- Empty since R-1828 (20261024085113) moved the last 14 to public.ist_today(). Adding one = not allowed.

create function pg_temp.night_ist_fn_scan() returns text[] language sql stable as $f$
  select coalesce(array_agg(distinct p.proname order by p.proname), '{}')
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') ~* '\mcurrent_date\M'
     and not exists (select 1 from night_ist_known_fns k where k.fn = p.proname);
$f$;

do $$
declare v_new text[] := pg_temp.night_ist_fn_scan();
begin
  if cardinality(v_new) > 0 then
    raise exception 'R-1826: new function stamping CURRENT_DATE (UTC day): % — use public.ist_today()', array_to_string(v_new, ', ');
  end if;
end $$;

-- ── MONEY: ist_today() pinned to the night day; record_payment settles an invoice ──────
create or replace function public.ist_today() returns date language sql stable as $function$
  select (timestamptz '2026-10-20 19:00:00+00' at time zone 'Asia/Kolkata')::date;
$function$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('a5a5a5a5-0000-4000-8000-000000001826', 'NIGHT IST TEST', 'night-ist@example.in', '07', 'NIST');
insert into public.customers (id, tenant_id, name, state_code)
  values ('a5a5a5a5-0000-4000-8000-0000000018c1', 'a5a5a5a5-0000-4000-8000-000000001826', 'Night Co', '07');

create function pg_temp.night_ist_money(p_tag text) returns void language plpgsql as $f$
declare v_q text := 'Q-NIST-' || p_tag; v_inv text := 'INV-NIST-' || p_tag; v_paid date; v_status text;
begin
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
    values (v_q, 'a5a5a5a5-0000-4000-8000-000000001826', 'a5a5a5a5-0000-4000-8000-0000000018c1',
            'Night Co', 1000, 1000, 0, 'accepted', 'awaiting', '[]'::jsonb);
  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status,
                               invoice_date, paid_amount, adjusted_advances, quote_id)
    values (v_inv, 'a5a5a5a5-0000-4000-8000-000000001826', 'a5a5a5a5-0000-4000-8000-0000000018c1',
            'Night Co', 1000, 1000, 'pending', date '2026-10-21', 0, '[]'::jsonb, v_q);
  update public.quotes set invoice_id = v_inv where id = v_q;

  perform public.record_payment(v_q, 1000, 'bank_transfer', 'REF-NIST-' || p_tag, null);
  select paid_date, status::text into v_paid, v_status from public.invoices where id = v_inv;
  if v_status is distinct from 'paid' then
    raise exception 'R-1826 SETUP: a full payment left the invoice %', v_status;
  end if;
  if v_paid is distinct from date '2026-10-21' then
    raise exception 'R-1826 MONEY: record_payment stamped paid_date % at 00:30 IST 21 Oct', v_paid;
  end if;
end $f$;

select pg_temp.night_ist_money('ok');

-- ── MUTATION: CURRENT_DATE back in record_payment must be refused ───────────────────────
do $$
declare v_def text := pg_get_functiondef('public.record_payment(text,integer,text,text,text)'::regprocedure);
begin
  if position('public.ist_today()' in v_def) = 0 then raise exception 'R-1826 MUTATION: record_payment has no ist_today() to swap'; end if;
  execute replace(v_def, 'public.ist_today()', 'current_date');
end $$;

do $$
begin
  begin
    if pg_temp.night_ist_fn_scan() = '{}' then raise exception 'R-1826 MUTATION: RATCHET missed record_payment'; end if;
    raise notice 'mutation caught (ratchet): %', pg_temp.night_ist_fn_scan();
  end;
  if current_date = date '2026-10-21' then
    raise notice 'MONEY mutation skipped: the server day is the pinned day';
    return;
  end if;
  begin
    perform pg_temp.night_ist_money('mut');
    raise exception 'R-1826 MUTATION: MONEY check missed CURRENT_DATE';
  exception when raise_exception then
    if sqlerrm like 'R-1826 MUTATION%' then raise; end if;
    raise notice 'mutation caught (money): %', sqlerrm;
  end;
end $$;

select 'PASS night_ist_pin' as result;
rollback;
