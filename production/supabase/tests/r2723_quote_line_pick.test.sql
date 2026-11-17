-- R-2723: a subscription filed from a quote takes its term from ITS quote line — the filer names
-- the line (app.r2723_quote_line = '<quote id>|<line index>'), the trigger
-- subscription_term_follows_line no longer has to count rows. Migration …_r2723_quote_line_hint.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
-- The REAL filers are called (record_payment, activate_quote_on_credit) — not a copy of them.
--
--   a. Credit path, [Plan X qty 1 ₹1,000, NO commitment] + [bulk Plan X 3 years listing the
--      customer's domain + b2723.com]: the normal row (it borrowed the customer's domain) keeps
--      its own line — 2027 / mrr 83 / ₹1,000.00; the bulk row is 2029 / 67 / ₹800.00.
--      (Before: the normal row took the bulk line — 2029 / 67 / 800.)
--   b. Paid first, [bulk 3y a2723.com] [normal qty 1 ₹1,000] [bulk 2y customer's domain +
--      c2723.com]: a2723.com 3 years, the normal row 1 year / 83 / ₹1,000.00, c2723.com 2 years.
--      (Before: the normal row took the second bulk line — 2028 / 67 / 800.)
--   c. Two normal lines of one plan, 1 year and 3 years: each row takes ITS line.
--      (Before: both took the first line.)
--   d. A setting that is not this row's — another quote, an index past the end, junk, a line of
--      another plan, a bulk line that does not list the domain — is ignored: the R-2712 pick.
--   e. The setting never leaks out of a filer.
--   f. A 1-year bulk sale: 3 domains × ₹800 → each ₹800.00 a year, mrr 67 (before 66 / 66 / 68,
--      no term_amount); 2 + 1 seats at ₹799 less 10% → 1,438.20 / 719.10; +1 seat scales it.
--   g. A 1-year bulk row that cannot be priced keeps the filer's figures: a Flexible bulk line, a
--      rate of 0, a term_amount the caller gave.

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
  ('dddddddd-0000-0000-0000-000000272301','R2723 Line Co','r2723@example.in','07','R723');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-4000-8000-000000272301','dddddddd-0000-0000-0000-000000272301','Line Customer','07','cust2723.com');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000272301','owner2723@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000272301','dddddddd-0000-0000-0000-000000272301','owner2723@example.in','Owner 2723','owner', now() - interval '1 day');

create function pg_temp.r2723_q(p_id text, p_subtotal int, p_status text, p_lines jsonb) returns void
language sql as $f$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values (p_id, 'dddddddd-0000-0000-0000-000000272301', 'cccccccc-0000-4000-8000-000000272301', 'Line Customer',
          round(p_subtotal * 1.18)::int, p_subtotal, 0, 18, p_status::public.quote_status, 'awaiting', p_lines);
$f$;

/* One row's facts as text: renewal|term_months|mrr|term_amount. */
create function pg_temp.r2723_row(p_quote text, p_domain text) returns text
language sql as $f$
  select coalesce(max(renewal_date::text || '|' || term_months || '|' || mrr || '|' || coalesce(term_amount::text, 'null')), 'MISSING')
    from public.subscriptions
   where tenant_id = 'dddddddd-0000-0000-0000-000000272301' and quote_id = p_quote
     and domain is not distinct from p_domain;
$f$;

create function pg_temp.r2723_want(p_case text, p_quote text, p_domain text, p_want text) returns void
language plpgsql as $f$
declare v text := pg_temp.r2723_row(p_quote, p_domain);
begin
  if v is distinct from p_want then
    raise exception 'FAIL %: % / % = % (want %)', p_case, p_quote, coalesce(p_domain, '(no domain)'), v, p_want;
  end if;
end $f$;

/* A hand insert (an "old caller": import, a filer from before R-2723) of one yearly row. */
create function pg_temp.r2723_hand(p_quote text, p_plan text, p_domain text, p_seats int, p_mrr int,
                                   p_monthly boolean default false, p_term_amount numeric default null) returns void
language sql as $f$
  insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
    start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months, term_amount)
  values ('dddddddd-0000-0000-0000-000000272301', 'cccccccc-0000-4000-8000-000000272301', 'Line Customer', p_plan, 'other',
    p_seats, p_mrr, date '2026-09-01',
    (date '2026-09-01' + case when p_monthly then interval '1 month' else interval '1 year' end)::date,
    'active', 0, p_domain, p_quote, case when p_monthly then 1 else 12 end, p_term_amount);
$f$;

-- ── quotes ──────────────────────────────────────────────────────────────────────────────────
select pg_temp.r2723_q('TESTQ-R2723-A', 5800, 'accepted', '[
  {"name":"Plan X","qty":1,"rate":1000,"start_date":"2026-09-01"},
  {"name":"Plan X","qty":2,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,"start_date":"2026-09-01",
   "domains":[{"domain":"cust2723.com","seats":1},{"domain":"b2723.com","seats":1}]}]');
select pg_temp.r2723_q('TESTQ-R2723-B', 6600, 'sent', '[
  {"name":"Plan Y","qty":1,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":3,"start_date":"2026-09-01",
   "domains":[{"domain":"a2723.com","seats":1}]},
  {"name":"Plan Y","qty":1,"rate":1000,"commitment":"annual_yearly","start_date":"2026-09-01"},
  {"name":"Plan Y","qty":2,"rate":1600,"commitment":"annual_yearly","bulk":true,"years":2,"start_date":"2026-09-01",
   "domains":[{"domain":"cust2723.com","seats":1},{"domain":"c2723.com","seats":1}]}]');
select pg_temp.r2723_q('TESTQ-R2723-C', 3600, 'sent', '[
  {"name":"Domain Z","qty":1,"rate":900,"commitment":"annual_yearly","start_date":"2026-09-01"},
  {"name":"Domain Z","qty":1,"rate":2700,"commitment":"annual_yearly","years":3,"start_date":"2026-09-01"}]');
select pg_temp.r2723_q('TESTQ-R2723-D', 4800, 'sent', '[
  {"name":"Plan D","qty":1,"rate":1200,"commitment":"annual_yearly"},
  {"name":"Other D","qty":1,"rate":3600,"commitment":"annual_yearly","years":3},
  {"name":"Plan D","qty":1,"rate":2400,"commitment":"annual_yearly","bulk":true,"years":2,
   "domains":[{"domain":"listed-d.com","seats":1}]}]');
select pg_temp.r2723_q('TESTQ-R2723-F', 2400, 'sent', '[
  {"name":"Domain F","qty":3,"rate":800,"commitment":"annual_yearly","bulk":true,"start_date":"2026-09-01",
   "domains":[{"domain":"f1.in","seats":1},{"domain":"f2.in","seats":1},{"domain":"f3.in","seats":1}]}]');
select pg_temp.r2723_q('TESTQ-R2723-F2', 2157, 'sent', '[
  {"name":"Domain G","qty":3,"rate":799,"discount_pct":10,"commitment":"annual_yearly","bulk":true,"start_date":"2026-09-01",
   "domains":[{"domain":"g1.in","seats":2},{"domain":"g2.in","seats":1}]}]');
select pg_temp.r2723_q('TESTQ-R2723-F3', 2400, 'sent', '[
  {"name":"Domain R","qty":3,"rate":800,"renewal_rate":900,"commitment":"annual_yearly","bulk":true,"start_date":"2026-09-01",
   "domains":[{"domain":"r1.in","seats":3}]}]');
select pg_temp.r2723_q('TESTQ-R2723-G', 200, 'sent', '[
  {"name":"Flex G","qty":2,"rate":100,"commitment":"monthly","bulk":true,
   "domains":[{"domain":"m1.in","seats":1},{"domain":"m2.in","seats":1}]},
  {"name":"Zero G","qty":1,"rate":0,"commitment":"annual_yearly","bulk":true,
   "domains":[{"domain":"z1.in","seats":1}]},
  {"name":"Given G","qty":1,"rate":800,"commitment":"annual_yearly","bulk":true,
   "domains":[{"domain":"t1.in","seats":1}]},
  {"name":"Text G","qty":1,"rate":"abc","commitment":"annual_yearly","bulk":true,
   "domains":[{"domain":"x1.in","seats":1}]}]');

-- ── a. credit path: a normal line with no commitment + a bulk line listing the borrowed domain ─
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000272301","role":"authenticated"}', true);
do $$
declare v_n int;
begin
  perform public.activate_quote_on_credit('TESTQ-R2723-A', 15, false, 'R-2723 test: long-standing customer');
  perform pg_temp.r2723_want('a normal row (no commitment, borrowed domain)', 'TESTQ-R2723-A', 'cust2723.com', '2027-09-01|12|83|1000.00');
  perform pg_temp.r2723_want('a bulk row', 'TESTQ-R2723-A', 'b2723.com', '2029-09-01|12|67|800.00');
  select count(*) into v_n from public.subscriptions where quote_id = 'TESTQ-R2723-A';
  if v_n <> 2 then raise exception 'FAIL a: % rows (want 2)', v_n; end if;
  if coalesce(current_setting('app.r2723_quote_line', true), '') <> '' then
    raise exception 'FAIL e: the setting leaked out of activate_quote_on_credit: %', current_setting('app.r2723_quote_line', true);
  end if;
  -- A second click: refused or a no-op — never a second set of rows, never changed dates.
  begin
    perform public.activate_quote_on_credit('TESTQ-R2723-A', 15, false, 'R-2723 test: second click');
  exception when others then null;
  end;
  select count(*) into v_n from public.subscriptions where quote_id = 'TESTQ-R2723-A';
  if v_n <> 2 then raise exception 'FAIL a (second click): % rows (want 2)', v_n; end if;
  perform pg_temp.r2723_want('a normal row after a second click', 'TESTQ-R2723-A', 'cust2723.com', '2027-09-01|12|83|1000.00');
  raise notice 'PASS a: credit path — the no-commitment normal row keeps its own 1-year line';
end $$;

-- ── b, c, f. paid first (record_payment) ─────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare v_n int;
begin
  perform public.record_payment('TESTQ-R2723-B', 7788, 'upi', 'r2723_b_ref');
  perform pg_temp.r2723_want('b first bulk line', 'TESTQ-R2723-B', 'a2723.com', '2029-09-01|12|67|800.00');
  perform pg_temp.r2723_want('b normal row between two bulk lines', 'TESTQ-R2723-B', 'cust2723.com', '2027-09-01|12|83|1000.00');
  perform pg_temp.r2723_want('b second bulk line', 'TESTQ-R2723-B', 'c2723.com', '2028-09-01|12|67|800.00');
  select count(*) into v_n from public.subscriptions where quote_id = 'TESTQ-R2723-B';
  if v_n <> 3 then raise exception 'FAIL b: % rows (want 3)', v_n; end if;
  if coalesce(current_setting('app.r2723_quote_line', true), '') <> '' then
    raise exception 'FAIL e: the setting leaked out of record_payment: %', current_setting('app.r2723_quote_line', true);
  end if;
  raise notice 'PASS b: bulk + normal + bulk of one plan — every row takes its own line';

  perform public.record_payment('TESTQ-R2723-C', 4248, 'upi', 'r2723_c_ref');
  perform pg_temp.r2723_want('c 1-year line', 'TESTQ-R2723-C', 'cust2723.com', '2027-09-01|12|75|null');
  perform pg_temp.r2723_want('c 3-year line of the same plan', 'TESTQ-R2723-C', null, '2029-09-01|12|75|900.00');  -- R-2734: a normal multi-year line is priced from the line (term_amount = the year, mrr unchanged)
  raise notice 'PASS c: two normal lines of one plan — 1 year and 3 years';

  perform public.record_payment('TESTQ-R2723-F', 2832, 'upi', 'r2723_f_ref');
  perform pg_temp.r2723_want('f 1-year bulk', 'TESTQ-R2723-F', 'f1.in', '2027-09-01|12|67|800.00');
  perform pg_temp.r2723_want('f 1-year bulk', 'TESTQ-R2723-F', 'f2.in', '2027-09-01|12|67|800.00');
  perform pg_temp.r2723_want('f 1-year bulk (last domain)', 'TESTQ-R2723-F', 'f3.in', '2027-09-01|12|67|800.00');
  -- +1 seat later (mrrForSeats): the exact yearly amount scales per seat (R-2369).
  update public.subscriptions set seats = 2, mrr = 133 where quote_id = 'TESTQ-R2723-F' and domain = 'f1.in';
  perform pg_temp.r2723_want('f +1 seat', 'TESTQ-R2723-F', 'f1.in', '2027-09-01|12|133|1600.00');

  perform public.record_payment('TESTQ-R2723-F2', 2545, 'upi', 'r2723_f2_ref');
  perform pg_temp.r2723_want('f uneven seats, 10% line discount', 'TESTQ-R2723-F2', 'g1.in', '2027-09-01|12|120|1438.20');
  perform pg_temp.r2723_want('f uneven seats, 10% line discount', 'TESTQ-R2723-F2', 'g2.in', '2027-09-01|12|60|719.10');

  perform public.record_payment('TESTQ-R2723-F3', 2832, 'upi', 'r2723_f3_ref');
  perform pg_temp.r2723_want('f renewal_rate (cart coupon)', 'TESTQ-R2723-F3', 'r1.in', '2027-09-01|12|225|2700.00');
  raise notice 'PASS f: a 1-year bulk row carries its exact yearly amount';
end $$;

-- ── d. a setting that is not this row's is ignored (the R-2712 pick decides) ─────────────────
do $$
begin
  perform set_config('app.r2723_quote_line', 'TESTQ-R2723-C|1', true);      -- another quote's line
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'd1.com', 1, 100);
  perform set_config('app.r2723_quote_line', 'TESTQ-R2723-D|99', true);     -- past the end
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'd2.com', 1, 100);
  perform set_config('app.r2723_quote_line', 'junk', true);
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'd3.com', 1, 100);
  perform set_config('app.r2723_quote_line', 'TESTQ-R2723-D|1', true);      -- a line of another plan (3 years)
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'd4.com', 1, 100);
  perform set_config('app.r2723_quote_line', 'TESTQ-R2723-D|2', true);      -- a bulk line that does not list d5.com
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'd5.com', 1, 100);
  perform set_config('app.r2723_quote_line', 'TESTQ-R2723-D|-1', true);
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'd6.com', 1, 100);
  perform set_config('app.r2723_quote_line', '', true);                     -- no setting: an old caller
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'd7.com', 1, 100);
  perform pg_temp.r2723_want('d another quote', 'TESTQ-R2723-D', 'd1.com', '2027-09-01|12|100|1200.00');
  perform pg_temp.r2723_want('d index past the end', 'TESTQ-R2723-D', 'd2.com', '2027-09-01|12|100|1200.00');
  perform pg_temp.r2723_want('d junk', 'TESTQ-R2723-D', 'd3.com', '2027-09-01|12|100|1200.00');
  perform pg_temp.r2723_want('d another plan', 'TESTQ-R2723-D', 'd4.com', '2027-09-01|12|100|1200.00');
  perform pg_temp.r2723_want('d bulk line without the domain', 'TESTQ-R2723-D', 'd5.com', '2027-09-01|12|100|1200.00');
  perform pg_temp.r2723_want('d negative index', 'TESTQ-R2723-D', 'd6.com', '2027-09-01|12|100|1200.00');
  perform pg_temp.r2723_want('d no setting', 'TESTQ-R2723-D', 'd7.com', '2027-09-01|12|100|1200.00');

  -- The right setting on a hand insert works like the filer's: line 1 (3 years), line 2 (bulk 2 years).
  perform set_config('app.r2723_quote_line', 'TESTQ-R2723-D|1', true);
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Other D', 'd8.com', 1, 300);
  perform set_config('app.r2723_quote_line', 'TESTQ-R2723-D|2', true);
  perform pg_temp.r2723_hand('TESTQ-R2723-D', 'Plan D', 'listed-d.com', 1, 200);
  perform set_config('app.r2723_quote_line', '', true);
  perform pg_temp.r2723_want('d named 3-year line', 'TESTQ-R2723-D', 'd8.com', '2029-09-01|12|100|1200.00');
  perform pg_temp.r2723_want('d named bulk 2-year line', 'TESTQ-R2723-D', 'listed-d.com', '2028-09-01|12|100|1200.00');
  raise notice 'PASS d: a setting that is not this row''s is ignored';
end $$;

-- ── g. a 1-year bulk row that cannot be priced keeps the filer's figures ─────────────────────
do $$
begin
  perform pg_temp.r2723_hand('TESTQ-R2723-G', 'Flex G', 'm1.in', 1, 100, true);
  perform pg_temp.r2723_hand('TESTQ-R2723-G', 'Zero G', 'z1.in', 1, 5);
  perform pg_temp.r2723_hand('TESTQ-R2723-G', 'Given G', 't1.in', 1, 46, false, 555);
  perform pg_temp.r2723_hand('TESTQ-R2723-G', 'Text G', 'x1.in', 1, 7);
  perform pg_temp.r2723_want('g Flexible bulk row', 'TESTQ-R2723-G', 'm1.in', '2026-10-01|1|100|null');
  perform pg_temp.r2723_want('g rate 0', 'TESTQ-R2723-G', 'z1.in', '2027-09-01|12|5|null');
  perform pg_temp.r2723_want('g term_amount given by the caller', 'TESTQ-R2723-G', 't1.in', '2027-09-01|12|46|555.00');
  perform pg_temp.r2723_want('g a rate that is not a number', 'TESTQ-R2723-G', 'x1.in', '2027-09-01|12|7|null');
  raise notice 'PASS g: an unpriceable 1-year bulk row is left as filed';
end $$;

rollback;
