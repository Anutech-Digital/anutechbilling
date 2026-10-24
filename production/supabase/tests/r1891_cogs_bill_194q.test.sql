-- R-1891 (24 Oct 2026): 194Q TDS on a COGS (goods) bill paid from a bank line.
-- Migration 20261024230000_r1891_cogs_bill_194q.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Rules (incometaxindia.gov.in "TDS on Purchase of Goods", s.194Q; CBDT Circular 13/2021):
--   buyer's business turnover last FY > ₹10 crore (asked once: tenants.tds_194q_buyer);
--   goods bought from one seller in the FY above ₹50 lakh → 0.1% of the part above ₹50 lakh
--   (5% when the seller has no PAN, s.206AA); value without GST when GST is shown separately.
--
-- Proves:
--   A. vendor_194q_open_bills: per open COGS bill the FY purchases before it, the base above
--      ₹50 lakh, the rate (0.1% / 5% without PAN), the TDS, what is already deducted and due.
--   B. TDS on a COGS bill is refused until the company says its turnover was above ₹10 crore;
--      only an owner / manager / accountant can say so (sales → 42501).
--   C. Paid net of 194Q: bill Paid at cash + TDS, the TDS on the payment line (section, base,
--      date) and in Balance Sheet "TDS payable" (dues_vendor_tds).
--   D. Wrong TDS amount, a services section on a goods bill, TDS below ₹50 lakh → refused.
--   E. Part payment takes the bill's whole TDS once; the next payment takes none.
--   F. Seller without PAN → 5%.
--   G. Un-reconcile puts the bill back (paid amount less cash AND TDS) and the TDS leaves TDS payable.
--   H. Guards: sales (42501), no company (28000), another company's vendor → nothing.

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
  ('dddddddd-0000-0000-0000-000000189101','R1891 Co','r1891@example.in','07','R1891'),
  ('dddddddd-0000-0000-0000-000000189102','R1891 Other','r1891b@example.in','07','R1891B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000189101','owner1891@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000189102','sales1891@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000189103','nocompany1891@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000189101','dddddddd-0000-0000-0000-000000189101','owner1891@example.in','Owner 1891','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000189102','dddddddd-0000-0000-0000-000000189101','sales1891@example.in','Sales 1891','sales', now() - interval '1 day');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000189101','dddddddd-0000-0000-0000-000000189101','HDFC Current','HDFC');

insert into public.vendors (id, tenant_id, name, gstin, pan, default_tds_section) values
  ('eeeeeeee-0000-0000-0000-000000189101','dddddddd-0000-0000-0000-000000189101','Ingram Micro India','07AAACI1891A1Z5','AAACI1891A','194Q'),
  ('eeeeeeee-0000-0000-0000-000000189102','dddddddd-0000-0000-0000-000000189101','No Pan Traders',null,null,'194Q'),
  ('eeeeeeee-0000-0000-0000-000000189103','dddddddd-0000-0000-0000-000000189101','Small Supplier','07AAACS1891A1Z5','AAACS1891A','194Q'),
  ('eeeeeeee-0000-0000-0000-000000189104','dddddddd-0000-0000-0000-000000189102','Other Co Vendor',null,null,null);

insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, due_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount) values
  -- Ingram, FY 2026-27: ₹40L already bought (paid elsewhere), then ₹20L and ₹5L.
  ('BILL-R1891-B1','dddddddd-0000-0000-0000-000000189101','eeeeeeee-0000-0000-0000-000000189101','Ingram Micro India','IM-1','2026-05-01','2026-05-31','COGS-Hardware',4000000,360000,360000,0,4720000,'paid',4720000),
  ('BILL-R1891-B2','dddddddd-0000-0000-0000-000000189101','eeeeeeee-0000-0000-0000-000000189101','Ingram Micro India','IM-2','2026-09-01','2026-10-01','COGS-Hardware',2000000,180000,180000,0,2360000,'unpaid',0),
  ('BILL-R1891-B3','dddddddd-0000-0000-0000-000000189101','eeeeeeee-0000-0000-0000-000000189101','Ingram Micro India','IM-3','2026-09-10','2026-10-10','COGS-Hardware',500000,45000,45000,0,590000,'unpaid',0),
  -- Ingram, last FY: does not count towards this year's ₹50 lakh.
  ('BILL-R1891-B0','dddddddd-0000-0000-0000-000000189101','eeeeeeee-0000-0000-0000-000000189101','Ingram Micro India','IM-0','2026-03-20','2026-04-20','COGS-Hardware',9000000,0,0,0,9000000,'paid',9000000),
  -- No PAN, ₹60L in one bill.
  ('BILL-R1891-B4','dddddddd-0000-0000-0000-000000189101','eeeeeeee-0000-0000-0000-000000189102','No Pan Traders','NP-1','2026-08-01','2026-09-01','COGS-Hardware',6000000,540000,540000,0,7080000,'unpaid',0),
  -- Small: ₹1L.
  ('BILL-R1891-B5','dddddddd-0000-0000-0000-000000189101','eeeeeeee-0000-0000-0000-000000189103','Small Supplier','SS-1','2026-08-01','2026-09-01','COGS-Hardware',100000,9000,9000,0,118000,'unpaid',0),
  -- Another company's bill.
  ('BILL-R1891-X1','dddddddd-0000-0000-0000-000000189102','eeeeeeee-0000-0000-0000-000000189104','Other Co Vendor','X-1','2026-08-01','2026-09-01','COGS-Hardware',6000000,0,0,0,6000000,'unpaid',0);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000189101','dddddddd-0000-0000-0000-000000189101','bbbbbbbb-0000-0000-0000-000000189101','2026-10-05','NEFT INGRAM MICRO IM-2',2359000,0,'U1','manual'),
  ('11111111-0000-0000-0000-000000189102','dddddddd-0000-0000-0000-000000189101','bbbbbbbb-0000-0000-0000-000000189101','2026-10-06','NEFT INGRAM MICRO PART',299500,0,'U2','manual'),
  ('11111111-0000-0000-0000-000000189103','dddddddd-0000-0000-0000-000000189101','bbbbbbbb-0000-0000-0000-000000189101','2026-10-07','NEFT INGRAM MICRO BAL',290000,0,'U3','manual'),
  ('11111111-0000-0000-0000-000000189104','dddddddd-0000-0000-0000-000000189101','bbbbbbbb-0000-0000-0000-000000189101','2026-10-08','NEFT NO PAN TRADERS',7030000,0,'U4','manual'),
  ('11111111-0000-0000-0000-000000189105','dddddddd-0000-0000-0000-000000189101','bbbbbbbb-0000-0000-0000-000000189101','2026-10-09','NEFT SMALL SUPPLIER',117900,0,'U5','manual');

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189101","role":"authenticated"}', true);

-- A. figures per open bill
do $$
declare r record; n int;
begin
  select * into r from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189101') q where q.doc_id = 'BILL-R1891-B2';
  if r.fy_before is distinct from 4000000 or r.base is distinct from 1000000 or r.rate_pct is distinct from 0.1
     or r.tds_total is distinct from 1000 or r.tds_due is distinct from 1000 or r.buyer is not null then
    raise exception 'FAIL A: IM-2 % % % % % %', r.fy_before, r.base, r.rate_pct, r.tds_total, r.tds_due, r.buyer; end if;
  select * into r from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189101') q where q.doc_id = 'BILL-R1891-B3';
  if r.fy_before is distinct from 6000000 or r.base is distinct from 500000 or r.tds_due is distinct from 500 then
    raise exception 'FAIL A: IM-3 % % %', r.fy_before, r.base, r.tds_due; end if;
  select count(*) into n from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189101');
  if n <> 2 then raise exception 'FAIL A: % rows (only the 2 open bills)', n; end if;
  select * into r from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189102');
  if r.rate_pct is distinct from 5 or r.no_pan is not true or r.base is distinct from 1000000 or r.tds_due is distinct from 50000 then
    raise exception 'FAIL A: no PAN % % % %', r.rate_pct, r.no_pan, r.base, r.tds_due; end if;
  select * into r from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189103');
  if r.base is distinct from 0 or r.tds_due is distinct from 0 then raise exception 'FAIL A: small % %', r.base, r.tds_due; end if;
  raise notice 'PASS A: FY purchases before, base above ₹50 lakh, 0.1%% / 5%% no PAN, TDS due';
end $$;

-- B. turnover question first
do $$
begin
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189101', 'eeeeeeee-0000-0000-0000-000000189101', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1891-B2","amount":2360000,"tds_amount":1000,"tds_section":"194Q"}]'::jsonb);
    raise exception 'FAIL B: 194Q taken without the turnover answer';
  exception when sqlstate '22023' then
    if sqlerrm not like '%10 crore%' then raise; end if;
  end;
  raise notice 'PASS B1: refused until the company answers the ₹10 crore question';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189102","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.set_tds_194q_buyer(true);
    raise exception 'FAIL B: sales login set the turnover answer';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS B2: sales cannot answer it (42501)';
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189101","role":"authenticated"}', true);
do $$
begin
  perform public.set_tds_194q_buyer(true);
  if (select tds_194q_buyer from public.tenants where id = 'dddddddd-0000-0000-0000-000000189101') is not true then
    raise exception 'FAIL B: answer not saved'; end if;
  if (select tds_194q_buyer from public.tenants where id = 'dddddddd-0000-0000-0000-000000189102') is not null then
    raise exception 'FAIL B: another company changed'; end if;
  raise notice 'PASS B3: owner answers "yes, above ₹10 crore" for this company only';
end $$;

-- C. paid net of 194Q
do $$
declare r jsonb; l record; before bigint; after bigint;
begin
  select dues_vendor_tds into before from public.report_balance_sheet('2026-10-31');
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189101', 'eeeeeeee-0000-0000-0000-000000189101', null,
         '[{"source":"vendor_bill","doc_id":"BILL-R1891-B2","amount":2360000,"tds_amount":1000,"tds_section":"194Q"}]'::jsonb);
  if (select status from public.vendor_bills where id = 'BILL-R1891-B2') is distinct from 'paid'
     or (select paid_amount from public.vendor_bills where id = 'BILL-R1891-B2') is distinct from 2360000 then
    raise exception 'FAIL C: IM-2 not paid at cash + TDS'; end if;
  select * into l from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R1891-B2';
  if l.cash is distinct from 2359000 or l.tds_amount is distinct from 1000 or l.tds_section is distinct from '194Q'
     or l.tds_base is distinct from 1000000 or l.tds_on is distinct from '2026-10-05'::date then
    raise exception 'FAIL C: line % % % % %', l.cash, l.tds_amount, l.tds_section, l.tds_base, l.tds_on; end if;
  if (r->>'tds_total')::int is distinct from 1000 or r->'paid'->0->>'tds' is distinct from '1000' then raise exception 'FAIL C: result %', r; end if;
  select dues_vendor_tds into after from public.report_balance_sheet('2026-10-31');
  if after - before is distinct from 1000 then raise exception 'FAIL C: TDS payable % → % (want +1000)', before, after; end if;
  raise notice 'PASS C: IM-2 paid ₹23,59,000 + TDS ₹1,000 (194Q on ₹10L), TDS payable +₹1,000';
end $$;

-- D. refused
do $$
begin
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189102', 'eeeeeeee-0000-0000-0000-000000189101', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1891-B3","amount":300000,"tds_amount":590,"tds_section":"194Q"}]'::jsonb);
    raise exception 'FAIL D: wrong TDS accepted';
  exception when sqlstate '22023' then
    if sqlerrm not like '%₹500%' then raise; end if;
  end;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189102', 'eeeeeeee-0000-0000-0000-000000189101', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1891-B3","amount":300000,"tds_amount":500,"tds_section":"194C"}]'::jsonb);
    raise exception 'FAIL D: 194C on a goods bill accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189105', 'eeeeeeee-0000-0000-0000-000000189103', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1891-B5","amount":118000,"tds_amount":100,"tds_section":"194Q"}]'::jsonb);
    raise exception 'FAIL D: TDS below ₹50 lakh accepted';
  exception when sqlstate '22023' then null;
  end;
  if exists (select 1 from public.bank_transactions where id in ('11111111-0000-0000-0000-000000189102','11111111-0000-0000-0000-000000189105') and matched_to_type is not null) then
    raise exception 'FAIL D: a refused payment left a reconciled line'; end if;
  raise notice 'PASS D: wrong amount, services section, below ₹50 lakh → refused, nothing written';
end $$;

-- E. part payment: the whole TDS once
do $$
declare q record;
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189102', 'eeeeeeee-0000-0000-0000-000000189101', null,
    '[{"source":"vendor_bill","doc_id":"BILL-R1891-B3","amount":300000,"tds_amount":500,"tds_section":"194Q"}]'::jsonb);
  if (select status from public.vendor_bills where id = 'BILL-R1891-B3') is distinct from 'partial'
     or (select paid_amount from public.vendor_bills where id = 'BILL-R1891-B3') is distinct from 300000 then
    raise exception 'FAIL E: IM-3 after part'; end if;
  select * into q from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189101') x where x.doc_id = 'BILL-R1891-B3';
  if q.tds_already is distinct from 500 or q.tds_due is distinct from 0 then raise exception 'FAIL E: after part % %', q.tds_already, q.tds_due; end if;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189103', 'eeeeeeee-0000-0000-0000-000000189101', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1891-B3","amount":290500,"tds_amount":500,"tds_section":"194Q"}]'::jsonb);
    raise exception 'FAIL E: TDS taken twice';
  exception when sqlstate '22023' then null;
  end;
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189103', 'eeeeeeee-0000-0000-0000-000000189101', null,
    '[{"source":"vendor_bill","doc_id":"BILL-R1891-B3","amount":290000}]'::jsonb);
  if (select status from public.vendor_bills where id = 'BILL-R1891-B3') is distinct from 'paid' then raise exception 'FAIL E: IM-3 not paid'; end if;
  raise notice 'PASS E: part payment takes the bill''s ₹500 TDS once; the balance pays ₹2,90,000 cash';
end $$;

-- F. no PAN → 5%
do $$
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000189104', 'eeeeeeee-0000-0000-0000-000000189102', null,
    '[{"source":"vendor_bill","doc_id":"BILL-R1891-B4","amount":7080000,"tds_amount":50000,"tds_section":"194Q"}]'::jsonb);
  if (select tds_amount from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R1891-B4') is distinct from 50000 then
    raise exception 'FAIL F: no-PAN TDS'; end if;
  raise notice 'PASS F: seller without PAN → 5%% (₹50,000 on ₹10L)';
end $$;

-- G. un-reconcile
do $$
declare before bigint; after bigint;
begin
  select dues_vendor_tds into before from public.report_balance_sheet('2026-10-31');
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000189101';
  if (select status from public.vendor_bills where id = 'BILL-R1891-B2') is distinct from 'unpaid'
     or (select paid_amount from public.vendor_bills where id = 'BILL-R1891-B2') is distinct from 0 then
    raise exception 'FAIL G: IM-2 % %', (select status from public.vendor_bills where id = 'BILL-R1891-B2'), (select paid_amount from public.vendor_bills where id = 'BILL-R1891-B2'); end if;
  select dues_vendor_tds into after from public.report_balance_sheet('2026-10-31');
  if before - after is distinct from 1000 then raise exception 'FAIL G: TDS payable % → %', before, after; end if;
  raise notice 'PASS G: un-reconcile → IM-2 unpaid again, TDS payable −₹1,000';
end $$;

-- H. guards
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189102","role":"authenticated"}', true);
do $$
begin
  begin
    perform * from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189101');
    raise exception 'FAIL H: sales read 194Q figures';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS H1: sales refused (42501)';
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189103","role":"authenticated"}', true);
do $$
begin
  begin
    perform * from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189101');
    raise exception 'FAIL H: no-company login read 194Q figures';
  exception when invalid_authorization_specification then null;
  end;
  begin
    perform public.set_tds_194q_buyer(true);
    raise exception 'FAIL H: no-company login set the answer';
  exception when invalid_authorization_specification then null;
  end;
  raise notice 'PASS H2: no-company login refused (28000)';
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189101","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.vendor_194q_open_bills('eeeeeeee-0000-0000-0000-000000189104')) then
    raise exception 'FAIL H: another company''s vendor answered'; end if;
  raise notice 'PASS H3: another company''s vendor → nothing';
end $$;

rollback;
