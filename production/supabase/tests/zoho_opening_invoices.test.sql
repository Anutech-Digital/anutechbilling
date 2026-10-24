-- R-1739 — old open invoices imported from Zoho Books (migration 20261022013149).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/zoho_opening_invoices.test.sql
--
-- The owner's example (card R-1739): Zoho INV-000245, T-ABC Pvt Ltd (GSTIN 07…), Total ₹59,000,
-- Balance ₹20,000, due 15 Sep 2026 → dues show ₹20,000 and the GST report does not count it;
-- importing the same CSV again says "INV-000245 already imported" and skips it.
--
-- What it proves:
--   1. import_opening_invoices makes one batch + opening invoices: amount = Total,
--      paid_amount = Total − Balance, opening_balance = Balance, no tax, kind opening_invoice.
--   2. Dues: the open balance is in the Balance Sheet receivables and the invoices badge count;
--      the party ledger shows it as 'Opening balance' for the Balance only.
--   3. NOT GST / revenue: report_pnl (revenue + GST), report_pnl_monthly, report_balance_sheet
--      gst_output and report_day_book Sales are exactly what they were before the import.
--   4. The same CSV again: nothing new, INV-000245 returned as skipped.
--   5. Refusals: a sales role; an opening invoice written outside the import; a credit note
--      against it; another company reading the batch.
--   6. A payment through record_multi_invoice_payment reduces the balance (₹20,000 → ₹5,000),
--      writes a receipt voucher; the batch can no longer be removed; deleting the payment
--      gives the balance back; then the batch is removed (invoices gone, batch row kept).

begin;

-- ── Fixtures ─────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1739000-0000-0000-0000-0000000000a1'::uuid, 'T-R1739 A', 'r1739-a@example.in', '07', 'TZA'),
  ('c1739000-0000-0000-0000-0000000000b1'::uuid, 'T-R1739 B', 'r1739-b@example.in', '07', 'TZB');

insert into auth.users (id, email) values
  ('c1739000-0000-0000-0000-00000000a0a1', 'r1739-owner-a@example.test'),
  ('c1739000-0000-0000-0000-00000000a0a3', 'r1739-sales-a@example.test'),
  ('c1739000-0000-0000-0000-00000000b0b1', 'r1739-owner-b@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1739000-0000-0000-0000-00000000a0a1', 'c1739000-0000-0000-0000-0000000000a1', 'r1739-owner-a@example.in', 'owner', 'Owner A'),
  ('c1739000-0000-0000-0000-00000000a0a3', 'c1739000-0000-0000-0000-0000000000a1', 'r1739-sales-a@example.in', 'sales', 'Sales A'),
  ('c1739000-0000-0000-0000-00000000b0b1', 'c1739000-0000-0000-0000-0000000000b1', 'r1739-owner-b@example.in', 'owner', 'Owner B');

insert into public.customers (id, tenant_id, name, gstin, state_code) values
  ('c1739000-0000-0000-0000-0000000c0001', 'c1739000-0000-0000-0000-0000000000a1', 'T-ABC Pvt Ltd', '07AAACT1234A1Z3', '07'),
  ('c1739000-0000-0000-0000-0000000c0002', 'c1739000-0000-0000-0000-0000000000a1', 'T-Bharat Traders', null, '07');

create temp table r1739_ids (k text primary key, v text);
create temp table r1739_before (k text primary key, v bigint);
grant all on r1739_ids, r1739_before to authenticated;

set local role authenticated;

-- ── 0. The GST / revenue figures BEFORE the import ───────────────────────────────────
do $$
declare v_pnl record; v_bs record; v_m jsonb; v_db int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  select * into v_pnl from public.report_pnl('2026-04-01', '2027-03-31');
  select * into v_bs from public.report_balance_sheet(null);
  v_m := public.report_pnl_monthly('2026-04-01', '2027-03-31');
  select count(*) into v_db from jsonb_array_elements(public.report_day_book('2026-04-01', '2026-10-31')) d where d->>'voucher' = 'Sales';
  insert into r1739_before values
    ('inv_taxable', v_pnl.inv_taxable), ('inv_tax', v_pnl.inv_tax), ('revenue_count', v_pnl.revenue_count),
    ('gst_output', v_bs.gst_output), ('receivables', v_bs.receivables),
    ('monthly_revenue', (select coalesce(sum((m->>'revenue')::bigint), 0) from jsonb_array_elements(v_m) m)),
    ('daybook_sales', v_db);
end $$;

-- ── 1. Import ─────────────────────────────────────────────────────────────────────────
do $$
declare v jsonb; v_b uuid; v_inv record; v_batch record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.import_opening_invoices(
    '[{"number":"INV-000245","invoice_date":"2026-08-16","due_date":"2026-09-15","customer_id":"c1739000-0000-0000-0000-0000000c0001",
       "total":59000,"balance":20000,"currency":"INR","gstin":"07AAACT1234A1Z3","pos_state_code":"07"},
      {"number":"INV-000246","invoice_date":"2026-09-01","due_date":"2026-10-01","customer_id":"c1739000-0000-0000-0000-0000000c0002",
       "total":11800,"balance":11800,"currency":"INR"}]'::jsonb,
    'Invoice.csv');
  v_b := (v->>'batch_id')::uuid;
  insert into r1739_ids values ('batch', v_b::text);
  if (v->>'imported')::int <> 2 or (v->>'total_balance')::bigint <> 31800 or jsonb_array_length(v->'skipped') <> 0 then
    raise exception 'FAIL 1a: import result %', v;
  end if;
  select * into v_inv from public.invoices where id = 'INV-000245';
  if v_inv.document_kind <> 'opening_invoice' or v_inv.amount <> 59000 or v_inv.net_payable <> 59000
     or v_inv.paid_amount <> 39000 or v_inv.opening_balance <> 20000 or v_inv.due_date <> '2026-09-15'
     or v_inv.external_number <> 'INV-000245' or coalesce(v_inv.tax_amount, -1) <> 0 or v_inv.quote_id is not null
     or v_inv.import_batch_id <> v_b or v_inv.customer_name <> 'T-ABC Pvt Ltd' then
    raise exception 'FAIL 1b: invoice row wrong: %', row_to_json(v_inv);
  end if;
  select * into v_batch from public.invoice_import_batches where id = v_b;
  if v_batch.row_count <> 2 or v_batch.total_balance <> 31800 or v_batch.file_name <> 'Invoice.csv'
     or v_batch.created_by <> 'c1739000-0000-0000-0000-00000000a0a1' then
    raise exception 'FAIL 1c: batch row wrong: %', row_to_json(v_batch);
  end if;
  raise notice 'PASS 1: INV-000245 imported — Total 59000, paid 39000, due 20000, opening_invoice';
end $$;

-- ── 2. In dues / open balance ─────────────────────────────────────────────────────────
do $$
declare v_bs record; v_led jsonb; v_row jsonb; v_badge int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  select * into v_bs from public.report_balance_sheet(null);
  if v_bs.receivables - (select t.v from r1739_before t where k = 'receivables') <> 31800 then
    raise exception 'FAIL 2a: receivables moved by % (want 31800)', v_bs.receivables - (select t.v from r1739_before t where k = 'receivables');
  end if;
  if (select sum(coalesce(net_payable, amount) - paid_amount) from public.invoices
       where status in ('pending', 'overdue') and customer_id = 'c1739000-0000-0000-0000-0000000c0001') <> 20000 then
    raise exception 'FAIL 2b: aging/dues balance for T-ABC is not 20000';
  end if;
  v_badge := (public.nav_badges(array[]::text[]) ->> 'invoices')::int;
  if v_badge < 2 then raise exception 'FAIL 2c: invoices badge % does not count the open imported invoices', v_badge; end if;
  v_led := public.report_party_ledger('customer', 'c1739000-0000-0000-0000-0000000c0001', '2026-04-01', '2027-03-31');
  select e into v_row from jsonb_array_elements(v_led->'entries') e
   where e->>'reference' = 'INV-000245' limit 1;
  if v_row is null or v_row->>'voucher' <> 'Opening balance' or (v_row->>'amount')::bigint is distinct from 20000 then
    raise exception 'FAIL 2d: party ledger line for INV-000245: % (ledger %)', v_row, left(v_led::text, 400);
  end if;
  raise notice 'PASS 2: receivables +31800, T-ABC owes 20000, badge counts it, ledger shows Opening balance 20000';
end $$;

-- ── 3. Not GST, not revenue ───────────────────────────────────────────────────────────
do $$
declare v_pnl record; v_bs record; v_m jsonb; v_db int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  select * into v_pnl from public.report_pnl('2026-04-01', '2027-03-31');
  select * into v_bs from public.report_balance_sheet(null);
  v_m := public.report_pnl_monthly('2026-04-01', '2027-03-31');
  select count(*) into v_db from jsonb_array_elements(public.report_day_book('2026-04-01', '2026-10-31')) d where d->>'voucher' = 'Sales';
  if v_pnl.inv_taxable <> (select t.v from r1739_before t where k = 'inv_taxable')
     or v_pnl.inv_tax <> (select t.v from r1739_before t where k = 'inv_tax')
     or v_pnl.revenue_count <> (select t.v from r1739_before t where k = 'revenue_count') then
    raise exception 'FAIL 3a: P&L counted the imported invoices: taxable %, tax %, count %', v_pnl.inv_taxable, v_pnl.inv_tax, v_pnl.revenue_count;
  end if;
  if v_bs.gst_output <> (select t.v from r1739_before t where k = 'gst_output') then
    raise exception 'FAIL 3b: GST output moved to % on import', v_bs.gst_output;
  end if;
  if (select coalesce(sum((m->>'revenue')::bigint), 0) from jsonb_array_elements(v_m) m) <> (select t.v from r1739_before t where k = 'monthly_revenue') then
    raise exception 'FAIL 3c: P&L trend counted the imported invoices';
  end if;
  if v_db <> (select t.v from r1739_before t where k = 'daybook_sales') then
    raise exception 'FAIL 3d: day book shows the imported invoices as Sales';
  end if;
  if public.invoice_is_sale('opening_invoice') or not public.invoice_is_sale('tax_invoice')
     or not public.invoice_is_sale('bill_of_supply') or not public.invoice_is_sale(null) then
    raise exception 'FAIL 3e: invoice_is_sale predicate wrong';
  end if;
  raise notice 'PASS 3: P&L, P&L trend, GST output and day book unchanged by the import';
end $$;

-- ── 4. Same CSV again → skipped ───────────────────────────────────────────────────────
do $$
declare v jsonb; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.import_opening_invoices(
    '[{"number":"inv-000245","invoice_date":"2026-08-16","due_date":"2026-09-15","customer_id":"c1739000-0000-0000-0000-0000000c0001","total":59000,"balance":20000}]'::jsonb,
    'Invoice.csv');
  if (v->>'imported')::int <> 0 or v->'skipped' <> '["inv-000245"]'::jsonb then
    raise exception 'FAIL 4a: second import result % (want 0 imported, inv-000245 skipped)', v;
  end if;
  select count(*) into v_n from public.invoices where upper(external_number) = 'INV-000245';
  if v_n <> 1 then raise exception 'FAIL 4b: % invoices numbered INV-000245 (want 1)', v_n; end if;
  -- a number twice in one file is refused whole
  begin
    perform public.import_opening_invoices(
      '[{"number":"INV-9","invoice_date":"2026-08-16","customer_id":"c1739000-0000-0000-0000-0000000c0001","total":100,"balance":100},
        {"number":"INV-9","invoice_date":"2026-08-16","customer_id":"c1739000-0000-0000-0000-0000000c0001","total":100,"balance":100}]'::jsonb, 'x.csv');
    raise exception 'FAIL 4c: a number twice in one file was accepted';
  exception when others then
    if sqlerrm not like '%in the file twice%' then raise; end if;
  end;
  raise notice 'PASS 4: same CSV again imports nothing, INV-000245 reported as already imported';
end $$;

-- ── 5. Refusals ───────────────────────────────────────────────────────────────────────
do $$
declare v_b uuid := (select t.v from r1739_ids t where k = 'batch')::uuid;
begin
  -- 5a. sales role
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a3', 'role', 'authenticated')::text, true);
  begin
    perform public.import_opening_invoices('[{"number":"INV-1","invoice_date":"2026-08-16","customer_id":"c1739000-0000-0000-0000-0000000c0001","total":100,"balance":100}]'::jsonb, 'x.csv');
    raise exception 'FAIL 5a: sales role imported';
  exception when insufficient_privilege then null;
  end;
  -- 5b. another company: cannot see the batch, cannot remove it
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  if exists (select 1 from public.invoice_import_batches) then raise exception 'FAIL 5b: company B reads A''s batch'; end if;
  begin
    perform public.remove_opening_invoice_import(v_b, 'not mine');
    raise exception 'FAIL 5c: company B removed A''s import';
  exception when no_data_found then null;
  end;
  -- 5d. company B's customer id in A's file is refused
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  begin
    perform public.import_opening_invoices('[{"number":"INV-X","invoice_date":"2026-08-16","customer_id":"c1739000-0000-0000-0000-0000000c0001","total":100,"balance":100}]'::jsonb, 'x.csv');
    raise exception 'FAIL 5d: another company''s customer accepted';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$
begin
  -- 5e. an opening invoice written outside the import
  begin
    insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount,
                                 document_kind, opening_balance, external_number, import_batch_id, tax_amount, tax_rate)
    values ('T-SNEAK-1', 'c1739000-0000-0000-0000-0000000000a1', 'c1739000-0000-0000-0000-0000000c0001', 'T-ABC Pvt Ltd',
            100, 100, 0, 'opening_invoice', 100, 'T-SNEAK-1', (select t.v from r1739_ids t where k = 'batch')::uuid, 0, 0);
    raise exception 'FAIL 5e: an opening invoice was inserted outside the import';
  exception when check_violation then
    if sqlerrm not like '%Import from Zoho%' then raise; end if;
  end;
  -- 5f. a credit note against an opening invoice
  begin
    insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, amount, taxable_value, tax_amount, credit_date, reason)
    values ('CN-T-1739', 'c1739000-0000-0000-0000-0000000000a1', 'INV-000245', 'c1739000-0000-0000-0000-0000000c0001', 1000, 847, 153, '2026-10-20', 'test');
    raise exception 'FAIL 5f: credit note against an imported Zoho invoice was accepted';
  exception when check_violation then
    if sqlerrm not like '%imported from Zoho Books%' then raise; end if;
  end;
  raise notice 'PASS 5: sales role, other company, direct insert and credit note all refused';
end $$;

-- ── 6. Payment reduces the balance; removal refused while it exists ──────────────────
set local role authenticated;
do $$
declare v jsonb; v_inv record; v_pay uuid; v_rv text; v_b uuid := (select t.v from r1739_ids t where k = 'batch')::uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.record_multi_invoice_payment(
    'c1739000-0000-0000-0000-0000000c0001', '2026-10-21', 'bank_transfer', null, 'T-UTR-1739-01', 15000,
    '[{"invoice_id":"INV-000245","amount":15000}]'::jsonb, false, null);
  v_pay := (v->'lines'->0->>'payment_id')::uuid;
  insert into r1739_ids values ('pay', v_pay::text);
  select * into v_inv from public.invoices where id = 'INV-000245';
  if v_inv.paid_amount <> 54000 or v_inv.status = 'paid' then
    raise exception 'FAIL 6a: after ₹15,000 the invoice is paid % / status % (want 54000, still open)', v_inv.paid_amount, v_inv.status;
  end if;
  select receipt_voucher_no into v_rv from public.payments where id = v_pay and invoice_id = 'INV-000245' and quote_id is null;
  if v_rv is null then raise exception 'FAIL 6b: the payment has no receipt voucher / is not on the invoice'; end if;
  -- over the balance is refused
  begin
    perform public.record_multi_invoice_payment(
      'c1739000-0000-0000-0000-0000000c0001', '2026-10-21', 'bank_transfer', null, 'T-UTR-1739-02', 6000,
      '[{"invoice_id":"INV-000245","amount":6000}]'::jsonb, false, null);
    raise exception 'FAIL 6c: ₹6,000 accepted on a ₹5,000 balance';
  exception when others then
    if sqlerrm not like '%only ₹5000 due%' then raise; end if;
  end;
  -- TDS: T-Bharat pays INV-000246 (₹11,800) as ₹10,620 + ₹1,180 TDS → paid, TDS receivable written
  v := public.record_multi_invoice_payment(
    'c1739000-0000-0000-0000-0000000c0002', '2026-10-21', 'bank_transfer', null, 'T-UTR-1739-04', 10620,
    '[{"invoice_id":"INV-000246","amount":10620,"tds_amount":1180,"tds_section":"194J","tds_rate_pct":10}]'::jsonb, false, null);
  insert into r1739_ids values ('pay_tds', v->'lines'->0->>'payment_id');
  if (select status::text from public.invoices where id = 'INV-000246') <> 'paid'
     or not exists (select 1 from public.tds_receivable where invoice_id = 'INV-000246' and tds_amount = 1180 and net_paid = 10620) then
    raise exception 'FAIL 6e: TDS payment on an imported invoice did not settle it / write the TDS receivable';
  end if;
  -- removal refused while a payment exists
  begin
    perform public.remove_opening_invoice_import(v_b, 'wrong file');
    raise exception 'FAIL 6d: import removed while a payment is recorded on it';
  exception when others then
    if sqlerrm not like '%cannot be removed: a payment%INV-000245%' then raise; end if;
  end;
  raise notice 'PASS 6: ₹15,000 paid → ₹5,000 due, receipt %, over-payment and removal refused', v_rv;
end $$;

-- ── 7. Paying the rest closes it; deleting a payment re-opens it; then removal works ──
do $$
declare v jsonb; v_inv record; v_b uuid := (select t.v from r1739_ids t where k = 'batch')::uuid; v_n int; v_batch record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1739000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.record_multi_invoice_payment(
    'c1739000-0000-0000-0000-0000000c0001', '2026-10-22', 'upi', null, 'T-UTR-1739-03', 5000,
    '[{"invoice_id":"INV-000245","amount":5000}]'::jsonb, false, null);
  select * into v_inv from public.invoices where id = 'INV-000245';
  if v_inv.status <> 'paid' or v_inv.paid_amount <> 59000 or v_inv.paid_date <> '2026-10-22' then
    raise exception 'FAIL 7a: fully paid invoice is % / % / %', v_inv.status, v_inv.paid_amount, v_inv.paid_date;
  end if;
  insert into r1739_ids values ('pay2', v->'lines'->0->>'payment_id');

  perform public.delete_payment((select t.v from r1739_ids t where k = 'pay2')::uuid);
  perform public.delete_payment((select t.v from r1739_ids t where k = 'pay')::uuid);
  perform public.delete_payment((select t.v from r1739_ids t where k = 'pay_tds')::uuid);  -- its TDS is reversed
  select * into v_inv from public.invoices where id = 'INV-000245';
  if v_inv.paid_amount <> 39000 or v_inv.status not in ('overdue', 'pending') or v_inv.paid_date is not null then
    raise exception 'FAIL 7b: after deleting both payments the invoice is % / % / % (want 39000 open)', v_inv.paid_amount, v_inv.status, v_inv.paid_date;
  end if;

  v := public.remove_opening_invoice_import(v_b, 'wrong file');
  if (v->>'removed')::int <> 2 then raise exception 'FAIL 7c: removed % (want 2)', v->>'removed'; end if;
  select count(*) into v_n from public.invoices where import_batch_id = v_b;
  select * into v_batch from public.invoice_import_batches where id = v_b;
  if v_n <> 0 or v_batch.removed_at is null or v_batch.removed_rows <> 2 then
    raise exception 'FAIL 7d: % invoices left / batch %', v_n, row_to_json(v_batch);
  end if;
  raise notice 'PASS 7: paid in full → paid; payments deleted → ₹20,000 due again; import removed, batch row kept';
end $$;

rollback;
