-- R-2072 (29 Oct 2026) — a MONTHLY support plan renews in a month, not a year.
--
-- THE WORRY (audit-support, 28 Oct): baseline.sql's record_payment filed every subscription
-- line with renewal_date = start + 1 year and mrr = amount / 12. A SUP-*-MO line's rate is
-- ONE MONTH (lib/support/catalog-row.ts supportLineRate, R-369), so a ₹999/month plan would
-- have renewed a year out — and once R-2067 syncs plan_expiry to the support desk, ₹999
-- would have bought a year of support.
--
-- VERIFIED, NOT A BUG ANY MORE: the latest record_payment
-- (migrations/20261024030326_r1816_money_rpcs_ist_today.sql) decides by the line's
-- commitment (v_is_monthly := commitment = 'monthly'): renewal_date = start + 1 month,
-- term_months = 1, mrr = amount (not /12). The support plan picker
-- (components/features/quotes/support-plan-picker.tsx addPlan) writes a monthly plan as
-- commitment 'monthly' and a yearly plan as 'annual_yearly'. This test pins that for the
-- support-plan line shape exactly as the picker writes it, so a later rewrite of
-- record_payment cannot quietly send a monthly plan back to +1 year.
--
-- CASES (self-asserting; every one raises on failure)
--   1. Standard Support (Monthly) ₹999, commitment monthly → renewal +1 month, term 1, mrr 999.
--   2. Standard Support (Yearly) ₹9,990, commitment annual_yearly → renewal +1 year, term 12, mrr 833.
--   3. A non-support annual Workspace line is unchanged → +1 year, term 12, mrr amount/12.
--
-- SAFETY: synthetic tenant, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier)
values ('20720000-0000-4000-8000-000000000001', 'ZZ R2072 TEST', 'zz-r2072@example.invalid', 'ZZ2072', 'reseller');

insert into public.customers (id, tenant_id, name, state_code, state)
values ('20720000-0000-4000-8000-0000000000c1', '20720000-0000-4000-8000-000000000001', 'ZZ R2072 Buyer', '07', 'Delhi');

-- The support catalogue rows as supportCatalogRow writes them (monthly price in msrp,
-- yearly as prices.annual_total).
insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active, item_type, kind, prices) values
  ('SUP-STANDARD-MO-r2072', '20720000-0000-4000-8000-000000000001', 'Standard Support (Monthly)', 'support', '998313',
   999, 0, true, 'subscription', 'main', '{}'::jsonb),
  ('SUP-STANDARD-YR-r2072', '20720000-0000-4000-8000-000000000001', 'Standard Support (Yearly)', 'support', '998313',
   0, 0, true, 'subscription', 'main', '{"annual_total":{"msrp":9990,"wholesale":0}}'::jsonb);

-- Lines exactly as support-plan-picker addPlan builds them (qty 1, cost 0, commitment by cycle).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, status, payment_status,
                           discount_pct, billing_cycle, line_items)
values
  ('ZZ-R2072-MO', '20720000-0000-4000-8000-000000000001', '20720000-0000-4000-8000-0000000000c1',
   'ZZ R2072 Buyer', 999, 999, 'sent', 'none', 0, 'monthly',
   '[{"id":"sup-standard-monthly-1","item_id":"SUP-STANDARD-MO-r2072","name":"Standard Support (Monthly)","qty":1,"rate":999,"cost":0,"commitment":"monthly"}]'::jsonb),
  ('ZZ-R2072-YR', '20720000-0000-4000-8000-000000000001', '20720000-0000-4000-8000-0000000000c1',
   'ZZ R2072 Buyer', 9990, 9990, 'sent', 'none', 0, 'yearly',
   '[{"id":"sup-standard-yearly-1","item_id":"SUP-STANDARD-YR-r2072","name":"Standard Support (Yearly)","qty":1,"rate":9990,"cost":0,"commitment":"annual_yearly"}]'::jsonb),
  ('ZZ-R2072-GW', '20720000-0000-4000-8000-000000000001', '20720000-0000-4000-8000-0000000000c1',
   'ZZ R2072 Buyer', 16560, 16560, 'sent', 'none', 0, 'yearly',
   '[{"name":"Google Workspace Business Starter","qty":10,"rate":1656,"commitment":"annual_yearly"}]'::jsonb);

do $$
declare
  s record;
  n integer;
begin
  -- ── 1. monthly support plan ───────────────────────────────────────────────
  perform public.record_payment('ZZ-R2072-MO', 999, 'bank_transfer', 'ZZ-R2072-1');
  select count(*) into n from public.subscriptions where quote_id = 'ZZ-R2072-MO';
  if n <> 1 then
    raise exception 'CASE 1 FAIL: monthly support quote produced % subscriptions, expected 1', n;
  end if;
  select * into s from public.subscriptions where quote_id = 'ZZ-R2072-MO';
  if s.renewal_date is distinct from (s.start_date + interval '1 month')::date then
    raise exception 'CASE 1 FAIL: monthly support renewal_date % for start % — expected one MONTH out (₹999 must not buy a year)',
      s.renewal_date, s.start_date;
  end if;
  if s.start_date is distinct from public.ist_today() then
    raise exception 'CASE 1 FAIL: start_date % is not IST today %', s.start_date, public.ist_today();
  end if;
  if s.term_months is distinct from 1 then
    raise exception 'CASE 1 FAIL: monthly support term_months %, expected 1', s.term_months;
  end if;
  if s.mrr is distinct from 999 then
    raise exception 'CASE 1 FAIL: monthly support mrr %, expected 999 (the rate is one month; /12 would give 83)', s.mrr;
  end if;
  if s.vendor::text <> 'support' then
    raise exception 'CASE 1 FAIL: vendor %, expected support (from the catalogue item)', s.vendor;
  end if;

  -- ── 2. yearly support plan ────────────────────────────────────────────────
  perform public.record_payment('ZZ-R2072-YR', 9990, 'bank_transfer', 'ZZ-R2072-2');
  select * into s from public.subscriptions where quote_id = 'ZZ-R2072-YR';
  if s is null then
    raise exception 'CASE 2 FAIL: yearly support quote produced no subscription';
  end if;
  if s.renewal_date is distinct from (s.start_date + interval '1 year')::date then
    raise exception 'CASE 2 FAIL: yearly support renewal_date % for start %, expected one year out', s.renewal_date, s.start_date;
  end if;
  if s.term_months is distinct from 12 then
    raise exception 'CASE 2 FAIL: yearly support term_months %, expected 12', s.term_months;
  end if;
  if s.mrr is distinct from 833 then
    raise exception 'CASE 2 FAIL: yearly support mrr %, expected 833 (9990/12)', s.mrr;
  end if;

  -- ── 3. non-support annual line unchanged ──────────────────────────────────
  perform public.record_payment('ZZ-R2072-GW', 16560, 'bank_transfer', 'ZZ-R2072-3');
  select * into s from public.subscriptions where quote_id = 'ZZ-R2072-GW';
  if s is null then
    raise exception 'CASE 3 FAIL: annual Workspace quote produced no subscription';
  end if;
  if s.renewal_date is distinct from (s.start_date + interval '1 year')::date
     or s.term_months is distinct from 12 or s.mrr is distinct from 1380 then
    raise exception 'CASE 3 FAIL: annual Workspace now renewal % (start %), term %, mrr % — expected +1 year, 12, 1380',
      s.renewal_date, s.start_date, s.term_months, s.mrr;
  end if;

  raise notice 'R-2072: ALL 3 CASES PASS';
end $$;

select 'PASS' as result;

rollback;
