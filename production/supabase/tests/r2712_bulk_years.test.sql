-- R-2712 (Pratik, 16 Oct; audit 12 Nov): quote "Bulk / many domains" → "Register for N years" + start date.
-- Migration 20261113004902_r2712_bulk_line_years (subscription_term_follows_line + its helper).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- pg_temp.r2712_file() files a quote line's subscriptions the way record_payment /
-- activate_quote_on_credit / file_invoiced_quote_subscriptions do (their bulk loop, copied):
-- start = line.start_date, renewal = start + 1 year, term 12, mrr = round(line amount / 12) split by
-- seats with the last domain taking the remainder, on conflict (quote, domain, plan) do nothing.
--
--   A. Owner example: 3 domains × 1 seat, ₹800 a year, 3 years (rate 2,400), start 1 Sep 2026 →
--      3 rows: start 1 Sep 2026, renewal 1 Sep 2029, term_months 12, mrr 67, term_amount 800.00.
--      Then +1 seat on one row (mrr 133) → term_amount 1,600.00 (R-2369 keeps scaling it).
--   B. Rounding: ₹799 a year × 3 (rate 2,397), 2 seats + 1 seat → 1,598.00 / 799.00, mrr 133 / 67.
--      2 years at ₹1,250 (rate 2,500), 3 equal domains → every row mrr 104, 1,250.00 (the pool
--      split + a second rounding gave the last domain 105).
--   C. discount_pct 10 → the net rate; a cart renewal_rate → that rate.
--   D. A bulk line without years → exactly as before: + 1 year, pool-split mrr, no term_amount.
--   E. A domain with 0 seats / a rate of 0 → the old rule (mrr ÷ years), no term_amount, no error.
--   F. Start 29 Feb 2028 + 3 years → 28 Feb 2031.
--   G. Filed twice (retry / Generate invoice after payment) → still one row per domain, same values.
--   H. The same plan as a normal 1-year line AND a bulk 3-year line: each row takes its own line,
--      in either line order.
--   I. A caller-chosen renewal date, and a row with no quote → untouched.
--   J. A quarterly (split-billed) quote with a 3-year bulk line → filed, renewal = start + 3 years.
--   K. The helper never errors on a malformed line.
--   L. vendor_cost_per_seat_month: cost ₹600 a year × 3 (line cost 1,800) → 50 a month, not 150 —
--      on a bulk row and on a normal multi-year row; a 1-year row keeps round(cost / 12).
--      One division, rounded once: cost ₹30 for 2 years → round(30 / 24) = 1 (÷ 12 then ÷ 2,
--      each rounded, gave 2).
--   N. Reviewer's case: a normal 1-year line (qty 1, ₹1,000, no domain of its own) whose row
--      borrowed the customer's domain + a 3-year bulk line listing that domain with the SAME
--      seats → the normal row keeps its line: renewal + 1 year, mrr 83, term_amount 1,000.00;
--      the bulk line's other domain is still 3 years. Filed in line order, as the filers do.
--   M. A normal 1-year line (5 seats, no domain of its own) whose row borrowed the customer's
--      domain, next to a bulk 3-year line that also lists that domain → the row keeps ITS line.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000271201','R2712 Bulk Co','r2712@example.in','07','R712');
insert into public.customers (id, tenant_id, name) values
  ('cccccccc-0000-4000-8000-000000271201','dddddddd-0000-0000-0000-000000271201','Bulk Customer');

/* The filers' own code for one line of a quote (record_payment 20261108051500, lines 503–606). */
create function pg_temp.r2712_file(p_quote text, p_idx int default 0) returns int
language plpgsql as $f$
declare
  v_t uuid := 'dddddddd-0000-0000-0000-000000271201';
  v_c uuid := 'cccccccc-0000-4000-8000-000000271201';
  v_line jsonb; v_start date; v_amount int; v_renew int; v_pool int; v_running int := 0;
  v_total int; v_n int; v_i int := 0; v_d jsonb; v_dom text; v_seats int; v_mrr int; v_made int := 0; v_id uuid;
  v_cost_pm int;
begin
  select line_items->p_idx into v_line from public.quotes where id = p_quote and tenant_id = v_t;
  v_start := coalesce(nullif(v_line->>'start_date', '')::date, public.ist_today());
  v_amount := round(coalesce((v_line->>'qty')::numeric, 0) * coalesce((v_line->>'rate')::numeric, 0)
                * (1 - coalesce((v_line->>'discount_pct')::numeric, 0) / 100))::int;
  v_renew := case when nullif(v_line->>'renewal_rate', '') is not null
                  then round(coalesce((v_line->>'qty')::numeric, 0) * (v_line->>'renewal_rate')::numeric)::int
                  else v_amount end;
  v_cost_pm := case when jsonb_typeof(v_line->'cost') = 'number' and (v_line->>'cost')::numeric > 0
                    then round((v_line->>'cost')::numeric / 12.0)::int else null end;
  if coalesce((v_line->>'bulk')::boolean, false) then
    select coalesce(sum((e->>'seats')::int), 0) into v_total from jsonb_array_elements(v_line->'domains') e;
    v_pool := greatest(0, round(v_renew / 12.0))::int;
    v_n := jsonb_array_length(v_line->'domains');
    for v_d in select e from jsonb_array_elements(v_line->'domains') e loop
      v_i := v_i + 1;
      v_dom := lower(trim(v_d->>'domain'));
      v_seats := coalesce((v_d->>'seats')::int, 0);
      if v_i < v_n then v_mrr := floor(v_pool::numeric * v_seats / v_total)::int;
      else v_mrr := v_pool - v_running; end if;
      v_running := v_running + v_mrr;
      insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
        start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months, vendor_cost_per_seat_month)
      values (v_t, v_c, 'Bulk Customer', v_line->>'name', 'other', v_seats, v_mrr, v_start,
        (v_start + interval '1 year')::date, 'active', 0, v_dom, p_quote, 12, v_cost_pm)
      on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null
        do nothing
      returning id into v_id;
      if v_id is not null then v_made := v_made + 1; end if;
      v_id := null;
    end loop;
  else
    insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
      start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months, vendor_cost_per_seat_month)
    values (v_t, v_c, 'Bulk Customer', v_line->>'name', 'other', (v_line->>'qty')::int,
      greatest(0, round(v_renew / 12.0))::int, v_start, (v_start + interval '1 year')::date, 'active', 0,
      coalesce(nullif(lower(trim(v_line->>'domain')), ''), nullif(current_setting('r2712.borrowed_domain', true), '')),
      p_quote, 12, v_cost_pm);
    v_made := 1;
  end if;
  return v_made;
end $f$;

create function pg_temp.r2712_q(p_id text, p_lines jsonb, p_cycle text default null) returns void
language sql as $f$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle, status, line_items)
  values (p_id, 'dddddddd-0000-0000-0000-000000271201', 'cccccccc-0000-4000-8000-000000271201', 'Bulk Customer',
          18, 1180, 1000, coalesce(p_cycle, 'yearly')::public.billing_cycle, 'accepted', p_lines);
$f$;

/* One row's facts as text: renewal|term_months|mrr|term_amount. */
create function pg_temp.r2712_row(p_quote text, p_domain text) returns text
language sql as $f$
  select coalesce(max(renewal_date::text || '|' || term_months || '|' || mrr || '|' || coalesce(term_amount::text, 'null')), 'MISSING')
    from public.subscriptions
   where tenant_id = 'dddddddd-0000-0000-0000-000000271201' and quote_id = p_quote
     and domain is not distinct from p_domain;
$f$;

create function pg_temp.r2712_want(p_case text, p_quote text, p_domain text, p_want text) returns void
language plpgsql as $f$
declare v text := pg_temp.r2712_row(p_quote, p_domain);
begin
  if v is distinct from p_want then
    raise exception 'FAIL %: % / % = % (want %)', p_case, p_quote, coalesce(p_domain, '(no domain)'), v, p_want;
  end if;
end $f$;

-- ── A. the owner example ────────────────────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-A', '[{"name":"Domain .in","qty":3,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2026-09-01","domains":[{"domain":"a1.in","seats":1},{"domain":"a2.in","seats":1},{"domain":"A3.in","seats":1}]}]');
do $$
begin
  if pg_temp.r2712_file('TESTQ-R2712-A') <> 3 then raise exception 'FAIL A: 3 subscriptions expected'; end if;
  perform pg_temp.r2712_want('A', 'TESTQ-R2712-A', 'a1.in', '2029-09-01|12|67|800.00');
  perform pg_temp.r2712_want('A', 'TESTQ-R2712-A', 'a2.in', '2029-09-01|12|67|800.00');
  perform pg_temp.r2712_want('A (domain typed in capitals)', 'TESTQ-R2712-A', 'a3.in', '2029-09-01|12|67|800.00');
  if exists (select 1 from public.subscriptions where quote_id = 'TESTQ-R2712-A' and start_date <> '2026-09-01') then
    raise exception 'FAIL A: the start date must be the line''s 1 Sep 2026';
  end if;
  -- +1 seat later (mrrForSeats): the exact yearly amount scales per seat (R-2369).
  update public.subscriptions set seats = 2, mrr = 133 where quote_id = 'TESTQ-R2712-A' and domain = 'a1.in';
  perform pg_temp.r2712_want('A +1 seat', 'TESTQ-R2712-A', 'a1.in', '2029-09-01|12|133|1600.00');
end $$;

-- ── B. rounding ─────────────────────────────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-B1', '[{"name":"Domain .com","qty":3,"rate":2397,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2026-09-01","domains":[{"domain":"b1.com","seats":2},{"domain":"b2.com","seats":1}]}]');
select pg_temp.r2712_q('TESTQ-R2712-B2', '[{"name":"Domain .com","qty":3,"rate":2500,"commitment":"annual_yearly","bulk":true,"years":2,
  "start_date":"2026-09-01","domains":[{"domain":"b3.com","seats":1},{"domain":"b4.com","seats":1},{"domain":"b5.com","seats":1}]}]');
do $$
begin
  perform pg_temp.r2712_file('TESTQ-R2712-B1');
  perform pg_temp.r2712_want('B1', 'TESTQ-R2712-B1', 'b1.com', '2029-09-01|12|133|1598.00');
  perform pg_temp.r2712_want('B1', 'TESTQ-R2712-B1', 'b2.com', '2029-09-01|12|67|799.00');
  perform pg_temp.r2712_file('TESTQ-R2712-B2');
  perform pg_temp.r2712_want('B2', 'TESTQ-R2712-B2', 'b3.com', '2028-09-01|12|104|1250.00');
  perform pg_temp.r2712_want('B2', 'TESTQ-R2712-B2', 'b4.com', '2028-09-01|12|104|1250.00');
  perform pg_temp.r2712_want('B2 (last domain, no remainder)', 'TESTQ-R2712-B2', 'b5.com', '2028-09-01|12|104|1250.00');
end $$;

-- ── C. line discount, cart renewal_rate ─────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-C1', '[{"name":"Domain .in","qty":2,"rate":2400,"discount_pct":10,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2026-09-01","domains":[{"domain":"c1.in","seats":2}]}]');
select pg_temp.r2712_q('TESTQ-R2712-C2', '[{"name":"Domain .in","qty":1,"rate":100,"renewal_rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2026-09-01","domains":[{"domain":"c2.in","seats":1}]}]');
do $$
begin
  perform pg_temp.r2712_file('TESTQ-R2712-C1');
  perform pg_temp.r2712_want('C1 discount 10%', 'TESTQ-R2712-C1', 'c1.in', '2029-09-01|12|120|1440.00');
  perform pg_temp.r2712_file('TESTQ-R2712-C2');
  perform pg_temp.r2712_want('C2 renewal_rate', 'TESTQ-R2712-C2', 'c2.in', '2029-09-01|12|67|800.00');
end $$;

-- ── D. no years → as before ─────────────────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-D', '[{"name":"Domain .in","qty":2,"rate":800,"commitment":"annual_yearly","bulk":true,
  "start_date":"2026-09-01","domains":[{"domain":"d1.in","seats":1},{"domain":"d2.in","seats":1}]}]');
do $$
begin
  perform pg_temp.r2712_file('TESTQ-R2712-D');
  perform pg_temp.r2712_want('D', 'TESTQ-R2712-D', 'd1.in', '2027-09-01|12|66|null');
  perform pg_temp.r2712_want('D', 'TESTQ-R2712-D', 'd2.in', '2027-09-01|12|67|null');
end $$;

-- ── E. 0 seats on a domain; a rate of 0 ─────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-E1', '[{"name":"Domain .in","qty":1,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2026-09-01","domains":[{"domain":"e1.in","seats":0},{"domain":"e2.in","seats":1}]}]');
select pg_temp.r2712_q('TESTQ-R2712-E2', '[{"name":"Domain .in","qty":1,"rate":0,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2026-09-01","domains":[{"domain":"e3.in","seats":1}]}]');
do $$
begin
  perform pg_temp.r2712_file('TESTQ-R2712-E1');
  perform pg_temp.r2712_want('E1 0 seats', 'TESTQ-R2712-E1', 'e1.in', '2029-09-01|12|0|null');
  perform pg_temp.r2712_want('E1', 'TESTQ-R2712-E1', 'e2.in', '2029-09-01|12|67|800.00');
  perform pg_temp.r2712_file('TESTQ-R2712-E2');
  perform pg_temp.r2712_want('E2 rate 0', 'TESTQ-R2712-E2', 'e3.in', '2029-09-01|12|0|null');
end $$;

-- ── F. leap day ─────────────────────────────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-F', '[{"name":"Domain .in","qty":1,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2028-02-29","domains":[{"domain":"f1.in","seats":1}]}]');
do $$
begin
  perform pg_temp.r2712_file('TESTQ-R2712-F');
  perform pg_temp.r2712_want('F', 'TESTQ-R2712-F', 'f1.in', '2031-02-28|12|67|800.00');
end $$;

-- ── G. filed twice ──────────────────────────────────────────────────────────────────────────
do $$
declare v_n int;
begin
  if pg_temp.r2712_file('TESTQ-R2712-B2') <> 0 then raise exception 'FAIL G: a second filing made new subscriptions'; end if;
  select count(*) into v_n from public.subscriptions where quote_id = 'TESTQ-R2712-B2';
  if v_n <> 3 then raise exception 'FAIL G: % rows after a second filing (want 3)', v_n; end if;
  perform pg_temp.r2712_want('G', 'TESTQ-R2712-B2', 'b4.com', '2028-09-01|12|104|1250.00');
end $$;

-- ── H. the same plan as a normal line and a bulk line ───────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-H1', '[
  {"name":"Domain .in","qty":1,"rate":900,"commitment":"annual_yearly","start_date":"2026-09-01","domain":"h0.in"},
  {"name":"Domain .in","qty":2,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,"start_date":"2026-09-01",
   "domains":[{"domain":"h1.in","seats":1},{"domain":"h2.in","seats":1}]}]');
select pg_temp.r2712_q('TESTQ-R2712-H2', '[
  {"name":"Domain .in","qty":2,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,"start_date":"2026-09-01",
   "domains":[{"domain":"h3.in","seats":1},{"domain":"h4.in","seats":1}]},
  {"name":"Domain .in","qty":1,"rate":900,"commitment":"annual_yearly","start_date":"2026-09-01"}]');
do $$
begin
  perform pg_temp.r2712_file('TESTQ-R2712-H1', 0);
  perform pg_temp.r2712_file('TESTQ-R2712-H1', 1);
  perform pg_temp.r2712_want('H1 normal line', 'TESTQ-R2712-H1', 'h0.in', '2027-09-01|12|75|900.00');
  perform pg_temp.r2712_want('H1 bulk line', 'TESTQ-R2712-H1', 'h1.in', '2029-09-01|12|67|800.00');
  perform pg_temp.r2712_want('H1 bulk line', 'TESTQ-R2712-H1', 'h2.in', '2029-09-01|12|67|800.00');
  perform pg_temp.r2712_file('TESTQ-R2712-H2', 0);
  perform pg_temp.r2712_file('TESTQ-R2712-H2', 1);
  perform pg_temp.r2712_want('H2 bulk line first', 'TESTQ-R2712-H2', 'h3.in', '2029-09-01|12|67|800.00');
  perform pg_temp.r2712_want('H2 normal line (no domain) after a bulk line', 'TESTQ-R2712-H2', null, '2027-09-01|12|75|900.00');
end $$;

-- ── I. caller-chosen date; no quote ─────────────────────────────────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
                                  status, start_date, renewal_date, quote_id, domain) values
  ('eeeeeeee-0000-4000-8000-000000271201','dddddddd-0000-0000-0000-000000271201','cccccccc-0000-4000-8000-000000271201','Bulk Customer',
   'Domain .in','other',1,200,12,'active','2026-09-01','2027-08-31','TESTQ-R2712-F','i1.in'),
  ('eeeeeeee-0000-4000-8000-000000271202','dddddddd-0000-0000-0000-000000271201','cccccccc-0000-4000-8000-000000271201','Bulk Customer',
   'Domain .in','other',1,200,12,'active','2026-09-01','2027-09-01',null,'i2.in');
do $$
declare v text;
begin
  select renewal_date::text || '|' || mrr || '|' || coalesce(term_amount::text, 'null') into v
    from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000271201';
  if v <> '2027-08-31|200|null' then raise exception 'FAIL I: caller-chosen date row changed: %', v; end if;
  select renewal_date::text || '|' || mrr || '|' || coalesce(term_amount::text, 'null') into v
    from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000271202';
  if v <> '2027-09-01|200|null' then raise exception 'FAIL I: no-quote row changed: %', v; end if;
end $$;

-- ── J. split-billed quote ───────────────────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-J', '[{"name":"Domain .in","qty":1,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,
  "start_date":"2026-09-01","domains":[{"domain":"j1.in","seats":1}]}]', 'quarterly');
do $$
begin
  if pg_temp.r2712_file('TESTQ-R2712-J') <> 1 then raise exception 'FAIL J: the quarterly bulk row was not filed'; end if;
  perform pg_temp.r2712_want('J', 'TESTQ-R2712-J', 'j1.in', '2029-09-01|12|67|800.00');
end $$;

-- ── L. vendor cost per seat per month ───────────────────────────────────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-L', '[
  {"name":"Domain .in","qty":1,"rate":2400,"cost":1800,"commitment":"annual_yearly","bulk":true,"years":3,"start_date":"2026-09-01",
   "domains":[{"domain":"l1.in","seats":1}]},
  {"name":"Domain l2.in","qty":1,"rate":2400,"cost":1800,"commitment":"annual_yearly","years":3,"start_date":"2026-09-01","domain":"l2.in"},
  {"name":"Domain l3.in","qty":1,"rate":800,"cost":600,"commitment":"annual_yearly","start_date":"2026-09-01","domain":"l3.in"},
  {"name":"Domain l4.in","qty":1,"rate":80,"cost":30,"commitment":"annual_yearly","years":2,"start_date":"2026-09-01","domain":"l4.in"}]');
do $$
declare v text;
begin
  perform pg_temp.r2712_file('TESTQ-R2712-L', 0);
  perform pg_temp.r2712_file('TESTQ-R2712-L', 1);
  perform pg_temp.r2712_file('TESTQ-R2712-L', 2);
  perform pg_temp.r2712_file('TESTQ-R2712-L', 3);
  select string_agg(domain || '=' || coalesce(vendor_cost_per_seat_month::text, 'null') || '/' || renewal_date, ' ' order by domain) into v
    from public.subscriptions where quote_id = 'TESTQ-R2712-L';
  if v is distinct from 'l1.in=50/2029-09-01 l2.in=50/2029-09-01 l3.in=50/2027-09-01 l4.in=1/2028-09-01' then
    raise exception 'FAIL L: monthly vendor cost per seat = % (want 50 on three, and 1 on l4 — one division, one rounding)', v;
  end if;
end $$;

-- ── M. a normal row that borrowed a domain the bulk line also lists ─────────────────────────
select pg_temp.r2712_q('TESTQ-R2712-M', '[
  {"name":"Plan X","qty":5,"rate":1000,"commitment":"annual_yearly","start_date":"2026-09-01"},
  {"name":"Plan X","qty":2,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,"start_date":"2026-09-01",
   "domains":[{"domain":"cust.com","seats":1},{"domain":"m2.com","seats":1}]}]');
do $$
begin
  perform set_config('r2712.borrowed_domain', 'cust.com', true);   -- record_payment: the customer's domain
  perform pg_temp.r2712_file('TESTQ-R2712-M', 0);
  perform set_config('r2712.borrowed_domain', '', true);
  perform pg_temp.r2712_file('TESTQ-R2712-M', 1);   -- cust.com is taken (R-829): only m2.com is filed
  perform pg_temp.r2712_want('M normal row, borrowed domain', 'TESTQ-R2712-M', 'cust.com', '2027-09-01|12|417|5000.00');
  perform pg_temp.r2712_want('M bulk row', 'TESTQ-R2712-M', 'm2.com', '2029-09-01|12|67|800.00');
end $$;

-- ── N. same seats: a normal row with a borrowed, bulk-listed domain keeps its own line ──────
select pg_temp.r2712_q('TESTQ-R2712-N', '[
  {"name":"Plan N","qty":1,"rate":1000,"commitment":"annual_yearly","start_date":"2026-09-01"},
  {"name":"Plan N","qty":2,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,"start_date":"2026-09-01",
   "domains":[{"domain":"custn.com","seats":1},{"domain":"n2.com","seats":1}]}]');
do $$
declare v_n int;
begin
  perform set_config('r2712.borrowed_domain', 'custn.com', true);   -- record_payment: the customer's domain
  perform pg_temp.r2712_file('TESTQ-R2712-N', 0);
  perform set_config('r2712.borrowed_domain', '', true);
  perform pg_temp.r2712_file('TESTQ-R2712-N', 1);   -- custn.com is taken (R-829): only n2.com is filed
  perform pg_temp.r2712_want('N normal row, borrowed domain, same seats', 'TESTQ-R2712-N', 'custn.com', '2027-09-01|12|83|1000.00');
  perform pg_temp.r2712_want('N bulk row', 'TESTQ-R2712-N', 'n2.com', '2029-09-01|12|67|800.00');
  select count(*) into v_n from public.subscriptions where quote_id = 'TESTQ-R2712-N';
  if v_n <> 2 then raise exception 'FAIL N: % rows (want 2)', v_n; end if;
end $$;

-- ── K. the helper on malformed lines ────────────────────────────────────────────────────────
do $$
begin
  if public.r2712_bulk_line_lists_domain(null, 'a.in', null)
     or public.r2712_bulk_line_lists_domain('"text"'::jsonb, 'a.in', null)
     or public.r2712_bulk_line_lists_domain('{"bulk":true}'::jsonb, 'a.in', null)
     or public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":"a.in"}'::jsonb, 'a.in', null)
     or public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":["a.in", 5]}'::jsonb, 'a.in', null)
     or public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":[{"domain":"a.in"}]}'::jsonb, '  ', null)
     or public.r2712_bulk_line_lists_domain('{"bulk":false,"domains":[{"domain":"a.in"}]}'::jsonb, 'a.in', null) then
    raise exception 'FAIL K: a malformed / non-bulk line must never list a domain';
  end if;
  if not public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":[{"domain":" A.in "}]}'::jsonb, 'a.IN', null) then
    raise exception 'FAIL K: the listed domain must match, whatever its case or spaces';
  end if;
  if not public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":[{"domain":"a.in","seats":2}]}'::jsonb, 'a.in', 2)
     or public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":[{"domain":"a.in","seats":2}]}'::jsonb, 'a.in', 1)
     or not public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":[{"domain":"A.in","seats":2}]}'::jsonb, 'a.in', 2)
     or public.r2712_bulk_line_lists_domain('{"bulk":true,"domains":[{"domain":"A.in","seats":"x"}]}'::jsonb, 'a.in', 2) then
    raise exception 'FAIL K: seats must agree exactly when asked';
  end if;
end $$;

rollback;
