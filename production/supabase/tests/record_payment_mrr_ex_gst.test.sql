-- Regression test: subscription MRR is EX-GST (migration 0057, bug #36).
-- Run on a dev/test DB. Self-asserting; rolled back.
--   psql "$DATABASE_URL" -f record_payment_mrr_ex_gst.test.sql
--
-- record_payment derived sub.mrr from quote.amount/term, but amount is GST-INCLUSIVE,
-- so MRR was ~18% inflated. Now it derives from quote.subtotal (ex-GST taxable).
-- A Standard ×10 annual quote: subtotal 1,03,680 / 12 = 8,640/mo (NOT 1,22,342/12=10,195).

-- ── New-sale: mrr = subtotal/12 (ex-GST) ────────────────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-0000000000a1','MRR NEW','m1@example.in','07','MRR1');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-0000000000a1','dddddddd-0000-0000-0000-0000000000a1','Cust MRR');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dddddddd-0000-0000-0000-0000000000a1','purchase_order', public.indian_fiscal_year(current_date), 'PO', 9000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-MRR-NEW','dddddddd-0000-0000-0000-0000000000a1','cccccccc-0000-0000-0000-0000000000a1','Cust MRR',122342,103680,18,'sent','awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare m int;
begin
  perform public.record_payment('Q-MRR-NEW', 122342, 'upi', 'mrr_new_ref');
  select mrr into m from public.subscriptions where customer_id='cccccccc-0000-0000-0000-0000000000a1';
  if m <> 8640 then raise exception 'FAIL new-sale MRR: expected 8640 (ex-GST), got %', m; end if;
  raise notice 'PASS new-sale MRR ex-GST = 8640';
end $$;
rollback;

-- ── Renewal roll-forward: mrr = subtotal/term (ex-GST) ──────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-0000000000a2','MRR REN','m2@example.in','07','MRR2');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-0000000000a2','dddddddd-0000-0000-0000-0000000000a2','Cust MRR2');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dddddddd-0000-0000-0000-0000000000a2','purchase_order', public.indian_fiscal_year(current_date), 'PO', 9000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, extension_months)
  values ('Q-MRR-REN','dddddddd-0000-0000-0000-0000000000a2','cccccccc-0000-0000-0000-0000000000a2','Cust MRR2',122342,103680,18,'sent','awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb, 12);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date, renewal_quote_id)
  values ('aaaaaaaa-0000-0000-0000-0000000000a2','dddddddd-0000-0000-0000-0000000000a2','cccccccc-0000-0000-0000-0000000000a2','Cust MRR2','Google Workspace Standard','google',10,9999,'active',current_date,'Q-MRR-REN');
do $$
declare m int; n int;
begin
  perform public.record_payment('Q-MRR-REN', 122342, 'upi', 'mrr_ren_ref');
  select count(*), max(mrr) into n, m from public.subscriptions where customer_id='cccccccc-0000-0000-0000-0000000000a2';
  if n <> 1 then raise exception 'FAIL renewal: expected 1 sub, got %', n; end if;
  if m <> 8640 then raise exception 'FAIL renewal MRR: expected 8640 (ex-GST), got %', m; end if;
  raise notice 'PASS renewal MRR ex-GST = 8640, 1 sub';
end $$;
rollback;
