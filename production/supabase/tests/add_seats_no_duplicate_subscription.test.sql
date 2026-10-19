-- Regression test: add-seats must NOT create a duplicate subscription (migration 0052, audit bug #3/#4)
--
-- Run against a dev/test DB (NOT prod). Self-asserting (RAISEs on failure),
-- all inside rolled-back transactions so the DB stays clean.
--
--   psql "$DATABASE_URL" -f add_seats_no_duplicate_subscription.test.sql
--
-- Proves:
--   1. Paying an add-seats quote (is_add_seats=true) for a customer who ALREADY
--      has a subscription does NOT create a second one (was the bug: 2 subs).
--   2. A genuine new sale (is_add_seats=false, new customer) STILL creates 1 sub
--      (we didn't break normal subscription creation).

-- ── Test 1: add-seats quote does not duplicate the subscription ───────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dddddddd-0000-0000-0000-0000000000d1', 'ADDSEAT TEST', 'addseat@example.in', '07');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-0000000000c1', 'dddddddd-0000-0000-0000-0000000000d1', 'Cust AddSeat');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date)
  values (gen_random_uuid(), 'dddddddd-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-0000000000c1',
          'Cust AddSeat', 'Google Workspace Plus', 'google', 10, 5000, 'active', (current_date + interval '1 year')::date);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_add_seats)
  values ('Q-ADDSEAT-T1', 'dddddddd-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-0000000000c1',
          'Cust AddSeat', 6000, 'sent', 'awaiting',
          '[{"name":"Google Workspace Plus","qty":5,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, true);

do $$
declare n integer;
begin
  perform public.record_payment('Q-ADDSEAT-T1', 6000, 'razorpay', 'rzp_addseat_t1');
  select count(*) into n from public.subscriptions where customer_id = 'cccccccc-0000-0000-0000-0000000000c1';
  if n <> 1 then
    raise exception 'FAIL add-seats: expected 1 subscription (no duplicate), got %', n;
  end if;
  raise notice 'PASS: add-seats quote paid -> still 1 subscription (no duplicate)';
end $$;
rollback;

-- ── Test 2: genuine new sale still creates exactly 1 subscription ─────────────
-- (PO series seeded high to avoid the separate global PO-id collision bug.)
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dddddddd-0000-0000-0000-0000000000d2', 'NEWSALE TEST', 'newsale@example.in', '07');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-0000000000c2', 'dddddddd-0000-0000-0000-0000000000d2', 'Cust NewSale');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dddddddd-0000-0000-0000-0000000000d2', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-NEWSALE-T2', 'dddddddd-0000-0000-0000-0000000000d2', 'cccccccc-0000-0000-0000-0000000000c2',
          'Cust NewSale', 12000, 'sent', 'awaiting',
          '[{"name":"Google Workspace Plus","qty":10,"rate":1200,"commitment":"annual_yearly"}]'::jsonb);

do $$
declare n integer;
begin
  perform public.record_payment('Q-NEWSALE-T2', 12000, 'razorpay', 'rzp_newsale_t2');
  select count(*) into n from public.subscriptions where customer_id = 'cccccccc-0000-0000-0000-0000000000c2';
  if n <> 1 then
    raise exception 'FAIL new-sale: expected 1 subscription, got %', n;
  end if;
  raise notice 'PASS: new sale -> 1 subscription (normal flow intact)';
end $$;
rollback;
