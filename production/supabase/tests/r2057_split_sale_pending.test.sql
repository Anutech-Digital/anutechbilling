-- R-2057 (28 Oct 2026, Pardeep, staging): "Pending GST invoice generation" listed a quarterly sale
-- with Q1 paid, and its Generate refused ("billed quarterly … invoiced one period at a time").
-- Migration 20261028151322_r2057_split_sale_pending: split_sale_invoice_status() tells the list
-- what each sale's part stands at, from bill_subscription_instalment's dry run.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Annual commitment billed quarterly: ₹2,000 taxable a part + 18% = ₹2,360 (term ₹9,440).
--   A. Q1 paid, not invoiced        → 'ready' Q1 ₹2,360; the billing path raises ONE ₹2,360
--                                     invoice (not ₹9,440); then 'invoiced' with that invoice;
--                                     billing again → the same invoice (no duplicate)
--   B. ₹2,300 received (₹60 short)  → 'short', gross 2360, credit 2300; nothing written
--   C. no schedule rows yet         → 'not_laid'
--   D. Q1 invoiced, Q2 due on its own unpaid request → 'on_request' (the sale is not pending)
--   E. yearly sale                  → no row (the whole-term invoice path, unchanged)
--   F. a billing user of ANOTHER company asks about these quotes → no rows
--   G. a part's own payment request, paid, invoice not raised (e.g. it was refused then) → 'ready';
--      unpaid → 'short' (R-2044: invoiced only when paid)

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
  ('dddddddd-0000-0000-0000-000000205701','R2057 Co','r2057@example.in','07','R2057'),
  ('dddddddd-0000-0000-0000-000000205702','R2057 Other','r2057o@example.in','07','R2058');
insert into auth.users (id, email) values ('e2057000-0000-4000-8000-0000000000b2', 'r2057-other@example.test');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2057000-0000-4000-8000-0000000000b2', 'dddddddd-0000-0000-0000-000000205702', 'r2057-other@example.in', 'R2057 Other Billing', 'billing', true);

insert into public.customers (id, tenant_id, name, state_code, country)
  values ('cccccccc-0000-0000-0000-000000205701','dddddddd-0000-0000-0000-000000205701','Delhi 2057','07','India');

-- Sale quotes 1..5, accepted; 5 is yearly.
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
select 'TESTQ-R2057-' || n, 'dddddddd-0000-0000-0000-000000205701', 'Delhi 2057', 'cccccccc-0000-0000-0000-000000205701',
       18, 9440, 8000, case when n = 5 then 'yearly' else 'quarterly' end, 'accepted',
       '[{"name":"Workspace Starter","qty":1,"rate":8000,"commitment":"annual_quarterly"}]'::jsonb
  from generate_series(1, 5) n;

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, reference, received_at, created_at)
select gen_random_uuid(), 'dddddddd-0000-0000-0000-000000205701', 'TESTQ-R2057-' || n,
       'cccccccc-0000-0000-0000-000000205701', a, 'upi', 'received', 'R2057-SALE-' || n, now(), now()
  from (values (1, 2360), (2, 2300), (3, 2360), (4, 2360), (5, 9440)) v(n, a);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status)
select ('eeeeeeee-0000-0000-0000-00000020570' || n)::uuid, 'dddddddd-0000-0000-0000-000000205701',
       'cccccccc-0000-0000-0000-000000205701', 'Delhi 2057', 'Workspace Starter', 'google'::vendor, 2, 667,
       (case when n = 5 then 'yearly' else 'quarterly' end)::billing_cycle, 'TESTQ-R2057-' || n,
       public.ist_today() - 100, 'active'
  from generate_series(1, 5) n;

-- Part rows for sales 1, 2, 4 (sale 3: none laid yet). Q1 began 100 days ago; Q2 10 days ago (due).
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-0000002057' || n || p)::uuid, 'dddddddd-0000-0000-0000-000000205701',
       ('eeeeeeee-0000-0000-0000-00000020570' || n)::uuid, public.ist_today() - 100, p,
       case p when 1 then public.ist_today() - 100 else public.ist_today() - 10 end,
       case p when 1 then public.ist_today() - 100 else public.ist_today() - 10 end,
       case p when 1 then public.ist_today() - 10 else public.ist_today() + 80 end,
       2000, 18
  from (values (1), (2), (4)) s(n) cross join (values (1), (2)) pp(p);

-- Sale 1: only Q1 is due (Q2 moved to the future).
update public.subscription_billings
   set bill_on = public.ist_today() + 5, period_start = public.ist_today() + 5
 where id = 'bbbbbbbb-0000-0000-0000-000000205712';
update public.subscription_billings
   set period_end = public.ist_today() + 5
 where id = 'bbbbbbbb-0000-0000-0000-000000205711';
-- Sale 2: only Q1 due too.
update public.subscription_billings
   set bill_on = public.ist_today() + 5, period_start = public.ist_today() + 5
 where id = 'bbbbbbbb-0000-0000-0000-000000205722';

do $$
declare
  r record; v_n integer; v_inv text; j jsonb;
begin
  -- A. Q1 paid, not invoiced → ready
  select * into r from public.split_sale_invoice_status(array['TESTQ-R2057-1']);
  if r.quote_id is null or r.state <> 'ready' or r.period_index <> 1 or r.period_label <> 'Q1' or r.gross <> 2360
     or r.billing_id <> 'bbbbbbbb-0000-0000-0000-000000205711' then
    raise exception 'A FAIL (before): %', row_to_json(r);
  end if;
  -- the status read wrote nothing
  if exists (select 1 from public.invoices where tenant_id = 'dddddddd-0000-0000-0000-000000205701') then
    raise exception 'A FAIL: reading the status raised an invoice'; end if;
  -- Generate = the billing cron's path for the due part
  j := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000205711', false);
  if j->>'action' <> 'invoice' then raise exception 'A FAIL (bill): %', j; end if;
  v_inv := j->>'invoice_id';
  if (select amount from public.invoices where id = v_inv) <> 2360 then
    raise exception 'A FAIL: Q1 invoice is ₹% (want 2360, not the term)', (select amount from public.invoices where id = v_inv); end if;
  select * into r from public.split_sale_invoice_status(array['TESTQ-R2057-1']);
  if r.state <> 'invoiced' or r.invoice_id is distinct from v_inv or r.gross <> 2360 then
    raise exception 'A FAIL (after): %', row_to_json(r); end if;
  j := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000205711', false);
  if j->>'action' <> 'already_invoiced' or j->>'invoice_id' <> v_inv then raise exception 'A FAIL (again): %', j; end if;
  select count(*) into v_n from public.invoices i
    join public.subscription_billings b on b.invoice_id = i.id
   where b.subscription_id = 'eeeeeeee-0000-0000-0000-000000205701';
  if v_n <> 1 then raise exception 'A FAIL: % invoices for sale 1', v_n; end if;
  raise notice 'A PASS: ready Q1 → % (₹2,360), again → same invoice', v_inv;

  -- B. ₹60 short → short, nothing written
  select * into r from public.split_sale_invoice_status(array['TESTQ-R2057-2']);
  if r.state <> 'short' or r.gross <> 2360 or r.credit <> 2300 or r.period_label <> 'Q1' then
    raise exception 'B FAIL: %', row_to_json(r); end if;
  if exists (select 1 from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000205721') then
    raise exception 'B FAIL: a payment request was made by a read'; end if;
  raise notice 'B PASS: short by ₹60 → short';

  -- C. nothing laid yet
  select * into r from public.split_sale_invoice_status(array['TESTQ-R2057-3']);
  if r.state <> 'not_laid' or r.cycle <> 'quarterly' or r.term_start <> public.ist_today() - 100 then
    raise exception 'C FAIL: %', row_to_json(r); end if;
  raise notice 'C PASS: not laid';

  -- D. Q1 invoiced, Q2 due on its own request (unpaid)
  j := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000205741', false);
  if j->>'action' <> 'invoice' then raise exception 'D FAIL (Q1): %', j; end if;
  j := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000205742', false);
  if j->>'action' <> 'request' then raise exception 'D FAIL (Q2 request): %', j; end if;
  select * into r from public.split_sale_invoice_status(array['TESTQ-R2057-4']);
  if r.state <> 'on_request' or r.period_index <> 2 then raise exception 'D FAIL: %', row_to_json(r); end if;
  raise notice 'D PASS: Q1 invoiced, Q2 on its request → on_request';

  -- G. the Q2 request itself: unpaid → short; (its invoice is raised by the payment trigger when paid)
  select * into r from public.split_sale_invoice_status(array[(j->>'quote_id')]);
  if r.state <> 'short' or r.period_label <> 'Q2' then raise exception 'G FAIL (unpaid): %', row_to_json(r); end if;
  raise notice 'G PASS: unpaid part request → short';

  -- E. yearly → no row
  select count(*) into v_n from public.split_sale_invoice_status(array['TESTQ-R2057-5']);
  if v_n <> 0 then raise exception 'E FAIL: yearly sale got % row(s)', v_n; end if;
  raise notice 'E PASS: yearly → no row';
end $$;

-- F. another company's billing user sees nothing of these quotes
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'e2057000-0000-4000-8000-0000000000b2', 'role', 'authenticated')::text, true);
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.split_sale_invoice_status(array['TESTQ-R2057-1','TESTQ-R2057-2','TESTQ-R2057-3']);
  if v_n <> 0 then raise exception 'F FAIL: another company read % row(s)', v_n; end if;
  raise notice 'F PASS: other company → no rows';
end $$;
reset role;

select 'R-2057 split sale pending: ALL PASS' as result;

rollback;
