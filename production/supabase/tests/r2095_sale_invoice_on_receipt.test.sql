-- R-2095 (30 Oct 2026, September reconcile on staging): a part-paid NEW SALE booked from a bank
-- receipt issued no GST invoice; a half-yearly sale was filed with the next half's date as its
-- renewal date; receipts did not name their bank line.
-- Migration 20261030123423_r2095_sale_invoice_on_receipt.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. Yearly sale ₹14,868, bank ₹14,860 (₹8 short) → GST invoice issued on that receipt, pending,
--      ₹8 due; the receipt names its bank line (payments.bank_txn_id).
--   B. A quote SENT before payment, part-paid from a bank line → still no invoice (unchanged rule).
--   C. Half-yearly sale on a 1-year commitment with renewal = the next half's date → refused (22023).
--   D. Half-yearly sale, default renewal, H1 part-paid (₹91,350 of ₹92,925) → its first part's
--      invoice is raised on that receipt (bill_subscription_instalment 'invoice'), ₹1,575 due.
--   E. Paid in full with the shortfall as TDS (₹91,350 + ₹1,575 TDS) → first part invoiced, paid.
--   F. A subscription line keeps its own end-domain (Zoho bills per end-domain); a bad one is refused.

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
  ('dddddddd-0000-0000-0000-000000209561','R2095 Receipt Co','r2095s@example.in','07','R95S');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000209561','owner2095s@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209561','dddddddd-0000-0000-0000-000000209561','owner2095s@example.in','Owner 2095s','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000209561','dddddddd-0000-0000-0000-000000209561','Global 2095','07','global2095.in'),
  ('cccccccc-0000-0000-0000-000000209562','dddddddd-0000-0000-0000-000000209561','Sent 2095','07','sent2095.in'),
  ('cccccccc-0000-0000-0000-000000209563','dddddddd-0000-0000-0000-000000209561','Half 2095','07','half2095.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000209561','dddddddd-0000-0000-0000-000000209561','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209561','dddddddd-0000-0000-0000-000000209561','bbbbbbbb-0000-0000-0000-000000209561','2026-09-24','NEFT GLOBAL 2095',0,14860,'UTR2095SA','manual'),
  ('11111111-0000-0000-0000-000000209562','dddddddd-0000-0000-0000-000000209561','bbbbbbbb-0000-0000-0000-000000209561','2026-09-25','NEFT SENT 2095',0,5000,'UTR2095SB','manual'),
  ('11111111-0000-0000-0000-000000209563','dddddddd-0000-0000-0000-000000209561','bbbbbbbb-0000-0000-0000-000000209561','2026-09-19','NEFT HALF 2095 C',0,91350,'UTR2095SC','manual'),
  ('11111111-0000-0000-0000-000000209564','dddddddd-0000-0000-0000-000000209561','bbbbbbbb-0000-0000-0000-000000209561','2026-09-19','NEFT HALF 2095 D',0,91350,'UTR2095SD','manual'),
  ('11111111-0000-0000-0000-000000209565','dddddddd-0000-0000-0000-000000209561','bbbbbbbb-0000-0000-0000-000000209561','2026-09-19','NEFT HALF 2095 E',0,91350,'UTR2095SE','manual'),
  ('11111111-0000-0000-0000-000000209566','dddddddd-0000-0000-0000-000000209561','bbbbbbbb-0000-0000-0000-000000209561','2026-09-20','NEFT GLOBAL 2095 F',0,2360,'UTR2095SF','manual'),
  ('11111111-0000-0000-0000-000000209567','dddddddd-0000-0000-0000-000000209561','bbbbbbbb-0000-0000-0000-000000209561','2026-09-20','NEFT GLOBAL 2095 G',0,1180,'UTR2095SG','manual');

-- B's quote: made and sent before any money (the normal path).
insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle, status, is_one_off, line_items)
values ('TESTQ-R2095S-B', 'dddddddd-0000-0000-0000-000000209561', 'cccccccc-0000-0000-0000-000000209562', 'Sent 2095', 18, 11800, 10000,
        'yearly', 'sent', true, '[{"name":"Setup","qty":1,"rate":10000,"one_time":true}]'::jsonb);

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000209561","role":"authenticated"}', true);

do $$
declare r jsonb; q record; i record; ok boolean := false; v_sub uuid; v_b uuid;
begin
  -- A. part-paid yearly sale → invoice on the first receipt
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209561', 'cccccccc-0000-0000-0000-000000209561',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":12600,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-08-13', null, 0, null, null, 'yearly');
  select * into q from public.quotes where id = r->>'quote_id';
  if q.amount is distinct from 14868 then raise exception 'FAIL A setup: amount %', q.amount; end if;
  if q.invoice_id is null then raise exception 'FAIL A: part-paid sale from a bank receipt has no GST invoice (%)', r; end if;
  select * into i from public.invoices where id = q.invoice_id;
  if i.status::text <> 'pending' or i.amount <> 14868 or i.net_payable <> 8 then
    raise exception 'FAIL A: invoice % status % amount % due % (want pending / 14,868 / 8)', i.id, i.status, i.amount, i.net_payable;
  end if;
  if (select p.bank_txn_id from public.payments p where p.quote_id = q.id and p.status = 'received' limit 1)
     is distinct from '11111111-0000-0000-0000-000000209561'::uuid then
    raise exception 'FAIL A: the receipt does not name its bank line';
  end if;
  raise notice 'A PASS: % pending, ₹8 due, receipt → bank line', i.id;

  -- B. a sent quote part-paid → no invoice (unchanged)
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000209562', 'TESTQ-R2095S-B', null, 0, null, null, false, null, null);
  if (select invoice_id from public.quotes where id = 'TESTQ-R2095S-B') is not null then
    raise exception 'FAIL B: a quote sent before payment was invoiced on a part payment';
  end if;
  raise notice 'B PASS: sent quote part-paid → no invoice';

  -- C. half-yearly, renewal = the next half's date → refused
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209563', 'cccccccc-0000-0000-0000-000000209563',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":50,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-06-19', '2026-12-19', 0, null, null, 'half_yearly');
  exception when sqlstate '22023' then ok := true;
  end;
  if not ok then raise exception 'FAIL C: a renewal date six months in was taken for a 1-year commitment billed half-yearly'; end if;
  raise notice 'C PASS: next-half date as renewal refused';

  -- D. half-yearly, H1 part-paid → its first part is invoiced on that receipt
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209564', 'cccccccc-0000-0000-0000-000000209563',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":50,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-06-19', null, 0, null, null, 'half_yearly');
  if r->>'invoice_issued' is not null then raise exception 'FAIL D: a whole-term invoice on a split-billed sale (%)', r; end if;
  select s.id into v_sub from public.subscriptions s where s.quote_id = r->>'quote_id' limit 1;
  if v_sub is null then raise exception 'FAIL D setup: no subscription (%)', r; end if;
  v_b := gen_random_uuid();
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate)
  values (v_b, 'dddddddd-0000-0000-0000-000000209561', v_sub, '2026-06-19', 1, '2026-06-19', '2026-06-19', '2026-12-19', 78750, 18);
  r := public.bill_subscription_instalment(v_b, true);
  if r->>'action' <> 'invoice' or r->>'reason' <> 'first_receipt_of_sale' then raise exception 'FAIL D (dry): %', r; end if;
  r := public.bill_subscription_instalment(v_b, false);
  if r->>'action' <> 'invoice' then raise exception 'FAIL D: part-paid half-yearly sale, first part not invoiced: %', r; end if;
  select * into i from public.invoices where id = r->>'invoice_id';
  if i.status::text = 'paid' or i.amount <> 92925 then raise exception 'FAIL D: invoice % status % amount %', i.id, i.status, i.amount; end if;
  raise notice 'D PASS: first part % raised on the part receipt (%)', i.id, i.status;

  -- E. shortfall as TDS → first part invoiced and paid
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209565', 'cccccccc-0000-0000-0000-000000209563',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":50,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-06-19', null, 1575, 2, '194C', 'half_yearly');
  select s.id into v_sub from public.subscriptions s where s.quote_id = r->>'quote_id' limit 1;
  v_b := gen_random_uuid();
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate)
  values (v_b, 'dddddddd-0000-0000-0000-000000209561', v_sub, '2026-06-19', 1, '2026-06-19', '2026-06-19', '2026-12-19', 78750, 18);
  r := public.bill_subscription_instalment(v_b, false);
  if r->>'action' <> 'invoice' then raise exception 'FAIL E: %', r; end if;
  if (select status::text from public.invoices where id = r->>'invoice_id') <> 'paid' then
    raise exception 'FAIL E: TDS-settled first part not paid';
  end if;
  raise notice 'E PASS: TDS counts as paid';

  -- F. one sale, two subscription lines, each with its own end-domain (Zoho bills per end-domain);
  --    a line without one keeps the customer's domain; a bad domain is refused
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209566', 'cccccccc-0000-0000-0000-000000209561',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly","domain":"Shop.Global2095.in"},
           {"item_id":null,"name":"Google Workspace Business Standard","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-09-01', null, 0, null, null, 'yearly');
  if (select line_items->0->>'domain' from public.quotes where id = r->>'quote_id') is distinct from 'shop.global2095.in' then
    raise exception 'FAIL F: the line domain was not kept on the quote (%)', (select line_items from public.quotes where id = r->>'quote_id');
  end if;
  if not exists (select 1 from public.subscriptions s where s.quote_id = r->>'quote_id' and s.domain = 'shop.global2095.in') then
    raise exception 'FAIL F: no subscription on the line''s end-domain (%)', r->'subscriptions';
  end if;
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209567', 'cccccccc-0000-0000-0000-000000209561',
         '[{"item_id":null,"name":"X","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly","domain":"not a domain"}]'::jsonb,
         true, '2026-09-01', null, 0, null, null, 'yearly');
  exception when sqlstate '22023' then ok := true;
  end;
  if not ok then raise exception 'FAIL F: a malformed domain was taken'; end if;
  raise notice 'F PASS: per-line end-domain kept; bad domain refused';
end $$;

select 'R-2095 sale invoice on receipt: ALL PASS' as result;

rollback;
