-- R-2734 (Pratik, 16 Oct; audit 13 Nov): Onboard / Add Subscription dialog → a domain "Register for N
-- years". No new SQL: this proves the line the dialog now writes is filed right by the EXISTING rules
-- (subscription_term_follows_line R-1445/R-2712, tg_subscriptions_term_amount_r2369).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- The dialog's line (onboarding-line.ts): {name, qty: seats, rate: price/yr × N, cost: cost/yr × N,
-- commitment annual_yearly, years N, start_date} — and NO renewal_date when N > 1.
--
--   A. Payment Received: record_payment files start + 1 year, mrr round(line amount / 12) = 200,
--      vendor cost round(1800 / 12) = 150 → the trigger makes it renewal 1 Apr 2028, mrr 67,
--      term_amount 800.00, vendor cost 50.
--   B. Why the line carries no renewal_date for N > 1: with one, the trigger takes that date and
--      returns early → mrr stays 200 (the whole term ÷ 12). Pinned so a later change cannot
--      quietly put renewal_date back on a multi-year line.
--   C. Postpaid: the dialog inserts the row itself — renewal 1 Apr 2028, mrr 67 (yearly ÷ 12) →
--      kept as given (a caller-chosen date); term_amount 800.00 from the quote line.
--   D. 1 year (no years, renewal_date on the line, as before) → renewal from the line, mrr 67,
--      term_amount 800.00 — unchanged behaviour.
--   E. (rev-r2734 BLOCK) Payment Received, ₹999 a year × 2 years: the filer writes mrr round(1998 / 12)
--      = 167 and the old step 2 rounded again (round(167 / 2) = 84 → renewal 84 × 12 = ₹1,008, and
--      term_amount NULL). Now priced from the line: mrr 83, term_amount 999.00 — the same row the
--      Postpaid insert gives (E2).
--   F. ₹797 × 2 years → mrr 66, term_amount 797.00 (was 67 / NULL → ₹804).
--   G. A quote-builder multi-year domain line (own domain, discount 10%): ₹999 × 2 → net 1,798.20 →
--      a year 899.10, mrr 75, term_amount 899.10.
--   H. A row whose seats differ from the line qty → the old rule (mrr ÷ years), no guess.
--   I. ₹1,001 × 2, 3 seats → a year 3,003.00, mrr 250 (round 250.25).

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
  ('dddddddd-0000-0000-0000-000000273401','R2734 Onboard Co','r2734@example.in','07','R734');
insert into public.customers (id, tenant_id, name) values
  ('cccccccc-0000-4000-8000-000000273401','dddddddd-0000-0000-0000-000000273401','Onboard Customer');

create function pg_temp.r2734_q(p_id text, p_line jsonb) returns void
language sql as $f$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle, status, line_items)
  values (p_id, 'dddddddd-0000-0000-0000-000000273401', 'cccccccc-0000-4000-8000-000000273401', 'Onboard Customer',
          18, round(((p_line->>'qty')::numeric * (p_line->>'rate')::numeric) * 1.18), (p_line->>'qty')::numeric * (p_line->>'rate')::numeric,
          'yearly', 'accepted', jsonb_build_array(p_line));
$f$;

/* record_payment's normal-line filing (20261108051500): start = line.start_date, renewal = start + 1
   year, term 12, mrr = round(line amount / 12), vendor cost = round(line cost / 12). */
create function pg_temp.r2734_file_paid(p_quote text) returns void
language plpgsql as $f$
declare v_line jsonb; v_start date;
begin
  select line_items->0 into v_line from public.quotes where id = p_quote;
  v_start := (v_line->>'start_date')::date;
  insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
    start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months, vendor_cost_per_seat_month)
  values ('dddddddd-0000-0000-0000-000000273401', 'cccccccc-0000-4000-8000-000000273401', 'Onboard Customer',
    v_line->>'name', 'domain', coalesce(nullif(current_setting('r2734.seats', true), '')::int, (v_line->>'qty')::int),
    round(round((v_line->>'qty')::numeric * (v_line->>'rate')::numeric
          * (1 - coalesce((v_line->>'discount_pct')::numeric, 0) / 100)) / 12.0)::int,
    v_start, (v_start + interval '1 year')::date, 'active', 0, 'zeus.in', p_quote, 12,
    round((v_line->>'cost')::numeric / 12.0)::int);
end $f$;

create function pg_temp.r2734_row(p_quote text) returns text
language sql as $f$
  select coalesce(max(start_date::text || '|' || renewal_date::text || '|' || term_months || '|' || mrr || '|'
           || coalesce(term_amount::text, 'null') || '|' || coalesce(vendor_cost_per_seat_month::text, 'null')), 'MISSING')
    from public.subscriptions
   where tenant_id = 'dddddddd-0000-0000-0000-000000273401' and quote_id = p_quote;
$f$;

create function pg_temp.r2734_want(p_case text, p_quote text, p_want text) returns void
language plpgsql as $f$
declare v text := pg_temp.r2734_row(p_quote);
begin
  if v is distinct from p_want then
    raise exception 'FAIL %: % = % (want %)', p_case, p_quote, v, p_want;
  end if;
end $f$;

-- ── A. Payment Received, 3 years ────────────────────────────────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-A', '{"id":"l1","name":"Domain .in","qty":1,"rate":2400,"cost":1800,
  "commitment":"annual_yearly","years":3,"start_date":"2025-04-01"}');
select pg_temp.r2734_file_paid('TESTQ-R2734-A');
select pg_temp.r2734_want('A', 'TESTQ-R2734-A', '2025-04-01|2028-04-01|12|67|800.00|50');

-- ── B. the same line WITH a renewal_date: the spread is skipped (why the dialog drops it) ─────
select pg_temp.r2734_q('TESTQ-R2734-B', '{"id":"l1","name":"Domain .in","qty":1,"rate":2400,"cost":1800,
  "commitment":"annual_yearly","years":3,"start_date":"2025-04-01","renewal_date":"2028-04-01"}');
select pg_temp.r2734_file_paid('TESTQ-R2734-B');
do $$
begin
  if pg_temp.r2734_row('TESTQ-R2734-B') not like '2025-04-01|2028-04-01|12|200|%' then
    raise exception 'FAIL B: a line renewal_date should keep the filer''s whole-term mrr 200 (got %) — if this changed, R-2734''s line can carry the date again', pg_temp.r2734_row('TESTQ-R2734-B');
  end if;
end $$;

-- ── C. Postpaid: the dialog's own insert ─────────────────────────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-C', '{"id":"l1","name":"Domain .in","qty":1,"rate":2400,"cost":1800,
  "commitment":"annual_yearly","years":3,"start_date":"2025-04-01"}');
insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, used, mrr, billing_cycle,
  term_months, start_date, renewal_date, payment_due_date, status, domain, quote_id, outstanding_amount, auto_renew)
values ('dddddddd-0000-0000-0000-000000273401', 'cccccccc-0000-4000-8000-000000273401', 'Onboard Customer', 'Domain .in',
  'domain', 1, 0, 67, 'yearly', 12, '2025-04-01', '2028-04-01', '2025-05-01', 'active', 'zeus.in', 'TESTQ-R2734-C', 2832, true);
select pg_temp.r2734_want('C', 'TESTQ-R2734-C', '2025-04-01|2028-04-01|12|67|800.00|null');

-- ── D. 1 year, as before ─────────────────────────────────────────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-D', '{"id":"l1","name":"Domain .in","qty":1,"rate":800,"cost":600,
  "commitment":"annual_yearly","start_date":"2025-04-01","renewal_date":"2026-04-01"}');
select pg_temp.r2734_file_paid('TESTQ-R2734-D');
select pg_temp.r2734_want('D', 'TESTQ-R2734-D', '2025-04-01|2026-04-01|12|67|800.00|50');

-- ── E. ₹999 × 2 years, Payment Received (the BLOCK) ───────────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-E', '{"id":"l1","name":"Domain .in","qty":1,"rate":1998,"cost":1200,
  "commitment":"annual_yearly","years":2,"start_date":"2025-04-01"}');
select pg_temp.r2734_file_paid('TESTQ-R2734-E');
select pg_temp.r2734_want('E', 'TESTQ-R2734-E', '2025-04-01|2027-04-01|12|83|999.00|50');
-- E2. the Postpaid insert for the same sale gives the same money
select pg_temp.r2734_q('TESTQ-R2734-E2', '{"id":"l1","name":"Domain .in","qty":1,"rate":1998,"cost":1200,
  "commitment":"annual_yearly","years":2,"start_date":"2025-04-01"}');
insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, used, mrr, billing_cycle,
  term_months, start_date, renewal_date, payment_due_date, status, domain, quote_id, outstanding_amount, auto_renew)
values ('dddddddd-0000-0000-0000-000000273401', 'cccccccc-0000-4000-8000-000000273401', 'Onboard Customer', 'Domain .in',
  'domain', 1, 0, 83, 'yearly', 12, '2025-04-01', '2027-04-01', '2025-05-01', 'active', 'zeus.in', 'TESTQ-R2734-E2', 2358, true);
select pg_temp.r2734_want('E2', 'TESTQ-R2734-E2', '2025-04-01|2027-04-01|12|83|999.00|null');

-- ── F. ₹797 × 2 years ──────────────────────────────────────────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-F', '{"id":"l1","name":"Domain .in","qty":1,"rate":1594,"cost":1000,
  "commitment":"annual_yearly","years":2,"start_date":"2025-04-01"}');
select pg_temp.r2734_file_paid('TESTQ-R2734-F');
select pg_temp.r2734_want('F', 'TESTQ-R2734-F', '2025-04-01|2027-04-01|12|66|797.00|42');

-- ── G. quote-builder multi-year domain line, discount 10% ─────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-G', '{"id":"l1","name":"Domain .com","domain":"zeus.in","qty":1,"rate":1998,"cost":1200,
  "discount_pct":10,"commitment":"annual_yearly","years":2,"start_date":"2025-04-01"}');
select pg_temp.r2734_file_paid('TESTQ-R2734-G');
select pg_temp.r2734_want('G', 'TESTQ-R2734-G', '2025-04-01|2027-04-01|12|75|899.10|50');

-- ── H. seats differ from the line qty → the old rule ──────────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-H', '{"id":"l1","name":"Domain .net","qty":2,"rate":1998,"cost":1200,
  "commitment":"annual_yearly","years":2,"start_date":"2025-04-01"}');
select set_config('r2734.seats', '1', true);
select pg_temp.r2734_file_paid('TESTQ-R2734-H');
select set_config('r2734.seats', '', true);
do $$
begin
  -- filer mrr round(3996 / 12) = 333 → old rule round(333 / 2) = 167
  if pg_temp.r2734_row('TESTQ-R2734-H') not like '2025-04-01|2027-04-01|12|167|%' then
    raise exception 'FAIL H: seats <> qty must keep the old mrr / years rule (got %)', pg_temp.r2734_row('TESTQ-R2734-H');
  end if;
end $$;

-- ── I. ₹1,001 × 2 years, 3 seats ──────────────────────────────────────────────────────────
select pg_temp.r2734_q('TESTQ-R2734-I', '{"id":"l1","name":"Domain .org","qty":3,"rate":2002,"cost":1200,
  "commitment":"annual_yearly","years":2,"start_date":"2025-04-01"}');
select pg_temp.r2734_file_paid('TESTQ-R2734-I');
select pg_temp.r2734_want('I', 'TESTQ-R2734-I', '2025-04-01|2027-04-01|12|250|3003.00|50');

rollback;
