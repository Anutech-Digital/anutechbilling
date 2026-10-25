-- R-1866 (24 Oct 2026): a money-out bank line pays a vendor — its open bills (several, part,
-- net of TDS), a new bill recorded on the spot, an advance, a bank charge — in ONE transaction.
-- Migration 20261024160000_r1866_bank_debit_vendor.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. bank_debit_vendor_open_items lists the vendor's COGS bills and unpaid expense bills
--      (oldest first, amount due, TDS base) and nothing of another vendor / company.
--   B. Full payment of one COGS bill → bill paid, line 'vendor_payment', no second bank line.
--   C. Two expense bills in one payment net of 194J TDS (10%) → both paid, TDS 5,000 + 1,000 on
--      the rows (26Q / TDS payable source), expenses payable for the vendor = 0, vendor learns 194J.
--   D. Part payment of a COGS bill → partial, ₹13,600 still due; Balance Sheet payables say so.
--   E. New expense bill on the spot with GST input + 194J TDS → recorded AND paid: bill_type gst,
--      CGST/SGST split (same state), TDS on the row, cash = total − TDS.
--   F. New COGS bill on the spot, vendor in another state → IGST, tax invoice, paid.
--   G. Advance to a vendor added on the spot (name + PAN) → prepaid asset; a later bill adjusts
--      it through the existing consume_prepaid_fifo; un-reconcile of the used advance is refused.
--   H. Bank charge on the same line → its own Bank Charges expense; the rest of COGS bill paid.
--   I. Parts not adding up to the debit, TDS on a COGS bill, part payment of an expense bill,
--      another vendor's bill → refused, nothing written.
--   J. Un-reconcile puts everything back: expense bills unpaid with their old TDS, a new bill
--      deleted, a COGS bill's paid amount reduced — and the line can be paid again.
--   K. Guards: another company's vendor / line, a sales login (42501), a no-company login (28000).

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
  ('dddddddd-0000-0000-0000-000000186601','R1866 Co','r1866@example.in','07','R1866'),
  ('dddddddd-0000-0000-0000-000000186602','R1866 Other','r1866b@example.in','07','R1866B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000186601','owner1866@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186602','sales1866@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186603','nocompany1866@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000186601','dddddddd-0000-0000-0000-000000186601','owner1866@example.in','Owner 1866','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000186602','dddddddd-0000-0000-0000-000000186601','sales1866@example.in','Sales 1866','sales', now() - interval '1 day');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000186601','dddddddd-0000-0000-0000-000000186601','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000186602','dddddddd-0000-0000-0000-000000186602','Other bank','SBI');

insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000186601','dddddddd-0000-0000-0000-000000186601','Sharma Associates','07AAKFS1866A1Z5','AAKFS1866A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000186602','dddddddd-0000-0000-0000-000000186601','Google Cloud India','29AACCG1866B1Z9',null,'COGS-Workspace'),
  ('eeeeeeee-0000-0000-0000-000000186603','dddddddd-0000-0000-0000-000000186602','Other Co Vendor',null,null,null);

-- Sharma: two unpaid expense bills (professional fees, GST on top).
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1866-E1','dddddddd-0000-0000-0000-000000186601','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000186601','2026-09-01',59000,9000,'gst','PS-101',false,null),
  ('EXP-R1866-E2','dddddddd-0000-0000-0000-000000186601','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000186601','2026-09-15',11800,1800,'gst','PS-102',false,null),
  ('EXP-R1866-OT','dddddddd-0000-0000-0000-000000186601','Office Rent','Somebody Else',null,'2026-09-15',20000,0,'none','R-9',false,null),
  ('EXP-R1866-XC','dddddddd-0000-0000-0000-000000186602','Office Rent','Other Co Vendor','eeeeeeee-0000-0000-0000-000000186603','2026-09-15',500,0,'none','X-1',false,null);
-- Google: two COGS bills.
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, subtotal, igst, total, status, paid_amount) values
  ('BILL-R1866-B1','dddddddd-0000-0000-0000-000000186601','eeeeeeee-0000-0000-0000-000000186602','Google Cloud India','29AACCG1866B1Z9','G-1','2026-09-05','2026-10-05','COGS-Workspace',10000,1800,11800,'unpaid',0),
  ('BILL-R1866-B2','dddddddd-0000-0000-0000-000000186601','eeeeeeee-0000-0000-0000-000000186602','Google Cloud India','29AACCG1866B1Z9','G-2','2026-09-20','2026-10-20','COGS-Workspace',20000,3600,23600,'unpaid',0);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000186601','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-10','NEFT GOOGLE CLOUD INDIA G-1',11800,0,'U1','manual'),
  ('11111111-0000-0000-0000-000000186602','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-11','IMPS SHARMA ASSOCIATES',64800,0,'U2','manual'),
  ('11111111-0000-0000-0000-000000186603','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-12','NEFT GOOGLE PART',10000,0,'U3','manual'),
  ('11111111-0000-0000-0000-000000186604','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-13','UPI SHARMA ASSOC AUDIT',21600,0,'U4','manual'),
  ('11111111-0000-0000-0000-000000186605','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-14','CARD META ADS',15000,0,'U5','manual'),
  ('11111111-0000-0000-0000-000000186606','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-15','NEFT GOOGLE G-2 BAL',13625,0,'U6','manual'),
  ('11111111-0000-0000-0000-000000186607','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-16','NEFT GOOGLE NEW',5900,0,'U7','manual'),
  ('11111111-0000-0000-0000-000000186608','dddddddd-0000-0000-0000-000000186601','bbbbbbbb-0000-0000-0000-000000186601','2026-10-16','MISC',9999,0,'U8','manual'),
  ('11111111-0000-0000-0000-000000186609','dddddddd-0000-0000-0000-000000186602','bbbbbbbb-0000-0000-0000-000000186602','2026-10-16','OTHER CO',500,0,'U9','manual');

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186601","role":"authenticated"}', true);

-- A. open items
do $$
declare n int; r record;
begin
  select count(*) into n from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000186601');
  if n is distinct from 2 then raise exception 'FAIL A: Sharma has % open items (want 2)', n; end if;
  select * into r from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000186601') limit 1;
  if r.doc_id is distinct from 'EXP-R1866-E1' or r.amount_due is distinct from 59000 or r.tds_base is distinct from 50000
     or not r.can_part or r.source is distinct from 'expense' then   -- R-1915: expense bills can be part-paid
    raise exception 'FAIL A: first Sharma row % % % % %', r.doc_id, r.amount_due, r.tds_base, r.can_part, r.source; end if;
  select * into r from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000186602') o where o.doc_id = 'BILL-R1866-B2';
  if r.amount_due is distinct from 23600 or r.tds_base is distinct from 20000 or not r.can_part or r.gst is distinct from 3600 then
    raise exception 'FAIL A: Google B2 row % % % %', r.amount_due, r.tds_base, r.can_part, r.gst; end if;
  if exists (select 1 from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000186603')) then
    raise exception 'FAIL A: another company''s vendor listed'; end if;
  raise notice 'PASS A: open items = expense bills + COGS bills, oldest first, due + TDS base right';
end $$;

-- B. Full payment of one COGS bill
do $$
declare r jsonb; t record;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186601', 'eeeeeeee-0000-0000-0000-000000186602',
         null, '[{"source":"vendor_bill","doc_id":"BILL-R1866-B1","amount":11800}]'::jsonb);
  if (select status from public.vendor_bills where id = 'BILL-R1866-B1') is distinct from 'paid'
     or (select paid_amount from public.vendor_bills where id = 'BILL-R1866-B1') is distinct from 11800 then
    raise exception 'FAIL B: bill not paid'; end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000186601';
  if t.matched_to_type is distinct from 'vendor_payment' or t.matched_to_id is distinct from 'eeeeeeee-0000-0000-0000-000000186602' then
    raise exception 'FAIL B: line % %', t.matched_to_type, t.matched_to_id; end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000186601') is distinct from 8 then
    raise exception 'FAIL B: a second bank line appeared'; end if;
  if r->'paid'->0->>'status' is distinct from 'paid' then raise exception 'FAIL B: result %', r; end if;
  raise notice 'PASS B: full payment → G-1 paid, line reconciled, no extra bank line';
end $$;

-- C. Two expense bills, one payment, net of 194J TDS
do $$
declare r jsonb; bs record;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186602', 'eeeeeeee-0000-0000-0000-000000186601', null,
         '[{"source":"expense","doc_id":"EXP-R1866-E1","amount":59000,"tds_amount":5000,"tds_section":"194J"},
           {"source":"expense","doc_id":"EXP-R1866-E2","amount":11800,"tds_amount":1000,"tds_section":"194J"}]'::jsonb);
  if exists (select 1 from public.expenses where id in ('EXP-R1866-E1','EXP-R1866-E2')
              and (not paid or reconciled_txn_id is distinct from '11111111-0000-0000-0000-000000186602' or paid_date <> '2026-10-11'
                   or bank_account_id is distinct from 'bbbbbbbb-0000-0000-0000-000000186601' or tds_section is distinct from '194J')) then
    raise exception 'FAIL C: expense bills not paid / linked'; end if;
  if (select sum(tds_amount) from public.expenses where id in ('EXP-R1866-E1','EXP-R1866-E2')) is distinct from 6000 then
    raise exception 'FAIL C: TDS on the bills %', (select sum(tds_amount) from public.expenses where id in ('EXP-R1866-E1','EXP-R1866-E2')); end if;
  if (r->>'tds_total')::int is distinct from 6000 or r->>'tds_section' is distinct from '194J' then raise exception 'FAIL C: result %', r; end if;
  if (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000186601') is distinct from '194J' then
    raise exception 'FAIL C: vendor did not learn 194J'; end if;
  select * into bs from public.report_balance_sheet('2026-10-31');
  if bs.dues_vendor_tds is distinct from 6000 then raise exception 'FAIL C: TDS payable % (want 6000)', bs.dues_vendor_tds; end if;
  -- only the other vendor's unpaid rent (20,000) is still payable
  if bs.expenses_payable is distinct from 20000 then raise exception 'FAIL C: expenses payable % (want 20000)', bs.expenses_payable; end if;
  if bs.expenses_paid_unbanked is distinct from 0 then raise exception 'FAIL C: paid-unbanked %', bs.expenses_paid_unbanked; end if;
  raise notice 'PASS C: PS-101 + PS-102 paid by one ₹64,800 line, TDS ₹6,000 (194J) payable, vendor payable 0';
end $$;

-- D. Part payment of a COGS bill
do $$
declare r jsonb; bs record;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186603', 'eeeeeeee-0000-0000-0000-000000186602', null,
         '[{"source":"vendor_bill","doc_id":"BILL-R1866-B2","amount":10000}]'::jsonb);
  if (select status from public.vendor_bills where id = 'BILL-R1866-B2') is distinct from 'partial'
     or (r->'paid'->0->>'still_due')::int is distinct from 13600 then raise exception 'FAIL D: % %', (select status from public.vendor_bills where id = 'BILL-R1866-B2'), r; end if;
  select * into bs from public.report_balance_sheet('2026-10-31');
  if bs.payables is distinct from 13600 then raise exception 'FAIL D: payables % (want 13600)', bs.payables; end if;
  raise notice 'PASS D: part payment → G-2 partial, ₹13,600 still due on the Balance Sheet';
end $$;

-- E. New expense bill on the spot, GST input + 194J
do $$
declare r jsonb; e record;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186604', 'eeeeeeee-0000-0000-0000-000000186601', null, '[]'::jsonb,
         '{"kind":"expense","bill_no":"PS-130","bill_date":"2026-10-12","category":"Professional Services","taxable":20000,"gst":3600,"itc":true,"tds_amount":2000,"tds_section":"194J"}'::jsonb);
  select * into e from public.expenses where id = r->'new_bill'->>'doc_id';
  if not found then raise exception 'FAIL E: no expense created: %', r; end if;
  if e.amount <> 23600 or e.gst_paid <> 3600 or e.bill_type <> 'gst' or e.cgst <> 1800 or e.sgst <> 1800 or coalesce(e.igst, 0) <> 0
     or e.tds_amount <> 2000 or e.tds_section <> '194J' or not e.paid or e.reconciled_txn_id is distinct from '11111111-0000-0000-0000-000000186604'
     or e.vendor_id is distinct from 'eeeeeeee-0000-0000-0000-000000186601' or e.bill_no <> 'PS-130' or e.expense_date <> '2026-10-12' then
    raise exception 'FAIL E: expense row %', row_to_json(e); end if;
  if (r->'new_bill'->>'cash')::int <> 21600 then raise exception 'FAIL E: cash %', r; end if;
  raise notice 'PASS E: new expense bill PS-130 recorded + paid, CGST/SGST 1,800 each, TDS 2,000, bank 21,600';
end $$;

-- F. New COGS bill on the spot, vendor in another state
do $$
declare r jsonb; b record;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186607', 'eeeeeeee-0000-0000-0000-000000186602', null, '[]'::jsonb,
         '{"kind":"cogs","bill_no":"G-3","bill_date":"2026-10-16","category":"COGS-Workspace","taxable":5000,"gst":900,"itc":true}'::jsonb);
  select * into b from public.vendor_bills where id = r->'new_bill'->>'doc_id';
  if not found or b.total <> 5900 or b.subtotal <> 5000 or b.igst <> 900 or b.cgst <> 0 or b.status <> 'paid' or b.paid_amount <> 5900
     or b.document_type <> 'tax_invoice' or b.vendor_id is distinct from 'eeeeeeee-0000-0000-0000-000000186602' then
    raise exception 'FAIL F: bill %', row_to_json(b); end if;
  raise notice 'PASS F: new COGS bill G-3 (IGST 900, tax invoice) recorded + paid';
end $$;

-- G. Advance to a vendor added on the spot; a later bill adjusts it
do $$
declare r jsonb; v record; a record; left_ integer; ok boolean := false;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186605', null,
         '{"name":"Meta Ads India","pan":"AAGCM1866C"}'::jsonb, '[]'::jsonb, null, 15000, 'Advertising');
  select * into v from public.vendors where id = (r->>'vendor_id')::uuid;
  if v.name <> 'Meta Ads India' or v.pan <> 'AAGCM1866C' or v.tenant_id <> 'dddddddd-0000-0000-0000-000000186601' then raise exception 'FAIL G: vendor %', row_to_json(v); end if;
  select * into a from public.prepaid_advances where id = (r->'advance'->>'id')::uuid;
  if a.total_amount <> 15000 or a.category <> 'Advertising' or a.vendor_id is distinct from v.id or a.paid_date <> '2026-10-14' then
    raise exception 'FAIL G: advance %', row_to_json(a); end if;
  -- Same name again → the same vendor, not a duplicate.
  if (select count(*) from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000186601' and upper(name) = 'META ADS INDIA') <> 1 then
    raise exception 'FAIL G: duplicate vendor'; end if;
  -- The later bill adjusts against it (existing Prepaid → Book invoice).
  left_ := public.consume_prepaid_fifo('Meta Ads India', 11800, 1800, '2026-10-20', null, null, v.id, 'META-77');
  if left_ <> 3200 then raise exception 'FAIL G: advance left % (want 3200)', left_; end if;
  -- A used advance cannot be un-reconciled from under its bill.
  begin perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000186605', null, null, 'manual');
  exception when check_violation then ok := sqlerrm like '%already used%'; end;
  if not ok then raise exception 'FAIL G: un-reconcile of a used advance was not refused'; end if;
  raise notice 'PASS G: ₹15,000 advance to new vendor Meta Ads, bill META-77 adjusted (₹3,200 left), un-reconcile refused';
end $$;

-- H. Rest of G-2 + bank charge on the same line
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186606', 'eeeeeeee-0000-0000-0000-000000186602', null,
         '[{"source":"vendor_bill","doc_id":"BILL-R1866-B2","amount":13600}]'::jsonb, null, 0, null, 25);
  if (select status from public.vendor_bills where id = 'BILL-R1866-B2') <> 'paid' then raise exception 'FAIL H: G-2 not paid'; end if;
  if not exists (select 1 from public.expenses where id = r->'bank_charge'->>'expense_id' and category = 'Bank Charges' and amount = 25
                  and paid and reconciled_txn_id = '11111111-0000-0000-0000-000000186606') then
    raise exception 'FAIL H: bank charge %', r; end if;
  if (select payables from public.report_balance_sheet('2026-10-31')) <> 0 then raise exception 'FAIL H: Google still payable'; end if;
  raise notice 'PASS H: G-2 paid + ₹25 bank charge as its own expense; payables 0';
end $$;

-- I. Refusals — nothing written
do $$
declare ok boolean;
begin
  ok := false;
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186608', 'eeeeeeee-0000-0000-0000-000000186601', null, '[]'::jsonb, null, 5000);
  exception when invalid_parameter_value then ok := sqlerrm like '%add up to ₹5000 but the bank line is ₹9999%'; end;
  if not ok then raise exception 'FAIL I: mismatch not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186608', 'eeeeeeee-0000-0000-0000-000000186602', null, '[]'::jsonb,
         '{"kind":"cogs","category":"COGS-Other","taxable":9999,"gst":0,"tds_amount":10,"tds_section":"194Q","pay":9989}'::jsonb);
  exception when invalid_parameter_value then ok := sqlerrm like '%TDS on a COGS bill%'; end;
  if not ok then raise exception 'FAIL I: TDS on a COGS bill not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186608', null, '{"name":"Somebody Else"}'::jsonb,
         '[{"source":"expense","doc_id":"EXP-R1866-OT","amount":25000}]'::jsonb);
  -- R-1915: a part is allowed now; more than the bill still owes is refused.
  exception when invalid_parameter_value then ok := sqlerrm like '%more than the ₹20000 still to pay%'; end;
  if not ok then raise exception 'FAIL I: paying more than an expense bill owes not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186608', 'eeeeeeee-0000-0000-0000-000000186601', null,
         '[{"source":"expense","doc_id":"EXP-R1866-OT","amount":20000}]'::jsonb);
  exception when invalid_parameter_value then ok := sqlerrm like '%not Sharma Associates%'; end;
  if not ok then raise exception 'FAIL I: another vendor''s bill not refused'; end if;

  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186608') is not null
     or exists (select 1 from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000186608')
     or exists (select 1 from public.vendors where name = 'Somebody Else') then
    raise exception 'FAIL I: something was written'; end if;
  raise notice 'PASS I: mismatch / COGS TDS / expense over-payment / wrong vendor refused, nothing written';
end $$;

-- J. Un-reconcile puts everything back
do $$
begin
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000186602', null, null, 'manual');
  if exists (select 1 from public.expenses where id in ('EXP-R1866-E1','EXP-R1866-E2')
              and (paid or reconciled_txn_id is not null or tds_amount <> 0 or tds_section is not null or paid_date is not null)) then
    raise exception 'FAIL J: expense bills not put back'; end if;
  if exists (select 1 from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000186602') then
    raise exception 'FAIL J: allocation rows left'; end if;
  -- …and the same line pays them again.
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186602', 'eeeeeeee-0000-0000-0000-000000186601', null,
         '[{"source":"expense","doc_id":"EXP-R1866-E1","amount":59000,"tds_amount":5000,"tds_section":"194J"},
           {"source":"expense","doc_id":"EXP-R1866-E2","amount":11800,"tds_amount":1000,"tds_section":"194J"}]'::jsonb);

  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000186604', null, null, 'manual');
  if exists (select 1 from public.expenses where bill_no = 'PS-130' and tenant_id = 'dddddddd-0000-0000-0000-000000186601') then
    raise exception 'FAIL J: the on-the-spot bill was not removed'; end if;

  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000186606', null, null, 'manual');
  if (select paid_amount from public.vendor_bills where id = 'BILL-R1866-B2') <> 10000
     or (select status from public.vendor_bills where id = 'BILL-R1866-B2') <> 'partial' then
    raise exception 'FAIL J: G-2 paid amount not reduced'; end if;
  if exists (select 1 from public.expenses where category = 'Bank Charges' and tenant_id = 'dddddddd-0000-0000-0000-000000186601') then
    raise exception 'FAIL J: bank charge not removed'; end if;

  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000186607', null, null, 'manual');
  if exists (select 1 from public.vendor_bills where bill_no = 'G-3' and tenant_id = 'dddddddd-0000-0000-0000-000000186601') then
    raise exception 'FAIL J: on-the-spot COGS bill not removed'; end if;

  -- A paid bill cannot be deleted from under its vendor-payment line.
  begin
    perform public.delete_expense('EXP-R1866-E1');
    raise exception 'FAIL J: paid expense bill deleted';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS J: un-reconcile restores bills (TDS back to 0), removes on-the-spot bills + charge; re-pay works; delete blocked';
end $$;

-- K. Guards (owner): another company's vendor and line
do $$
declare ok boolean;
begin
  ok := false;
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186608', 'eeeeeeee-0000-0000-0000-000000186603', null, '[]'::jsonb, null, 9999);
  exception when insufficient_privilege then ok := sqlerrm like '%Vendor not found in your company%'; end;
  if not ok then raise exception 'FAIL K: another company''s vendor not refused'; end if;
  ok := false;
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186609', 'eeeeeeee-0000-0000-0000-000000186601', null, '[]'::jsonb, null, 500);
  exception when insufficient_privilege then ok := sqlerrm like '%not in your company%'; end;
  if not ok then raise exception 'FAIL K: another company''s line not refused'; end if;
  raise notice 'PASS K(owner): other company''s vendor / line refused';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186602","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186608', 'eeeeeeee-0000-0000-0000-000000186601', null, '[]'::jsonb, null, 9999);
  exception when insufficient_privilege then ok := sqlerrm like '%pay a vendor from the bank%'; end;
  if not ok then raise exception 'FAIL K: sales role not refused'; end if;
  ok := false;
  begin perform public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000186601');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL K: sales role read open items'; end if;
  raise notice 'PASS K(sales): refused with 42501';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186603","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000186609', 'eeeeeeee-0000-0000-0000-000000186603', null, '[]'::jsonb, null, 500);
  exception when sqlstate '28000' then ok := true; end;
  if not ok then raise exception 'FAIL K: no-company login not refused'; end if;
  ok := false;
  begin perform public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000186603');
  exception when sqlstate '28000' then ok := true; end;
  if not ok then raise exception 'FAIL K: no-company login read open items'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186609') is not null then
    raise exception 'FAIL K: other company''s line changed'; end if;
  raise notice 'PASS K(no company): refused with 28000, nothing written';
end $$;

rollback;
