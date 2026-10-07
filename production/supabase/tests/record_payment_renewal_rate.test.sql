-- R-329 (7 Oct 2026): a cart coupon is for the FIRST payment only — the subscription's mrr
-- (what renewals bill) comes from the line's renewal_rate when it has one.
-- Migration 20261007050000_record_payment_renewal_rate. Run on a dev/test DB. Self-asserting;
-- rolled back.
--   psql "$DATABASE_URL" -f record_payment_renewal_rate.test.sql
--
-- Cart: Standard hosting monthly list 300, ANUTECH10 → charged 270 (renewal_rate 300) +
-- domain acme.in 749 (no commitment → no subscription from record_payment).
-- Expect: hosting subscription mrr = 300 (list), NOT 270. A line without renewal_rate keeps
-- the old rule (mrr from the charged rate).

-- ── Coupon line: mrr = qty × renewal_rate ───────────────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-0000000329a1','R329 A','r329a@example.in','07','R329A');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-0000000329a1','dddddddd-0000-0000-0000-0000000329a1','Cust R329');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dddddddd-0000-0000-0000-0000000329a1','purchase_order', public.indian_fiscal_year(current_date), 'PO', 990000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values ('Q-R329-A','dddddddd-0000-0000-0000-0000000329a1','cccccccc-0000-0000-0000-0000000329a1','Cust R329',
          1202, 1019, 0, 18, 'sent', 'awaiting',
          '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":270,"list_rate":300,"renewal_rate":300,"commitment":"monthly","hostingPlan":"standard"},
            {"name":"Domain acme.in — registration, 1 year","qty":1,"rate":749,"domain":"acme.in","registrant":{"name":"X"}}]'::jsonb);
do $$
declare m int; n int;
begin
  perform public.record_payment('Q-R329-A', 1202, 'razorpay', 'r329_a_ref');
  select count(*), max(mrr) into n, m from public.subscriptions where quote_id = 'Q-R329-A';
  if n <> 1 then raise exception 'FAIL: expected 1 subscription (hosting only), got %', n; end if;
  if m <> 300 then raise exception 'FAIL coupon line: mrr should be the list 300 (renewal at list), got %', m; end if;
  raise notice 'PASS coupon line renews at list (mrr 300, charged 270)';
end $$;
rollback;

-- ── No renewal_rate: unchanged — mrr from the charged rate ───────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-0000000329a2','R329 B','r329b@example.in','07','R329B');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-0000000329a2','dddddddd-0000-0000-0000-0000000329a2','Cust R329 B');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dddddddd-0000-0000-0000-0000000329a2','purchase_order', public.indian_fiscal_year(current_date), 'PO', 990000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R329-B','dddddddd-0000-0000-0000-0000000329a2','cccccccc-0000-0000-0000-0000000329a2','Cust R329 B',
          122342, 103680, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"list_rate":11520,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare m int;
begin
  perform public.record_payment('Q-R329-B', 122342, 'upi', 'r329_b_ref');
  select mrr into m from public.subscriptions where quote_id = 'Q-R329-B';
  -- list_rate alone (quote builder / packages) does NOT change the mrr: 103680 / 12.
  if m <> 8640 then raise exception 'FAIL no renewal_rate: expected 8640 (as before), got %', m; end if;
  raise notice 'PASS no renewal_rate → mrr from charged rate, as before';
end $$;
rollback;
