-- R-1867 (24 Oct 2026): Auto-reconcile settles a money-out bank line against a vendor's open bill
-- when it is unambiguous — through R-1866's reconcile_bank_debit_to_vendor, never reconcile_bank_txn.
-- Migration 20261024211000_r1867_auto_vendor_payment.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. bank_debit_vendor_guess picks the vendor the way the app's guessVendor does: UPI id, account
--      number, else the vendor sharing the MOST name words (Kapoor Legal Associates, not Kapoor
--      Stationers); a tie or no word → nobody; another company's vendor is never guessed.
--   B. bank_debit_vendor_auto_match lists the guessed vendor's open bills whose cash due equals the
--      debit: a COGS bill at its amount due, an expense bill at amount − TDS already on it.
--   C. auto_reconcile_bank_account:
--        - expense bill named + same amount            → paid, line 'vendor_payment', TDS untouched
--        - COGS bill named + same amount               → bill paid
--        - expense bill with TDS already on it          → paid net of that TDS (26Q row kept)
--        - UPI id in the narration                      → paid
--        - two bills of the same amount                 → left for review (ambiguous), nothing paid
--        - same amount but no vendor named              → left, bill unpaid
--        - bill dated after the bank line               → left
--        - bill held in an open payment run             → left
--        - another company's vendor named               → left
--      and the summary counts say so.
--   D. Guards: a sales login (42501), a no-company login (28000), another company's line → nothing.

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
  ('dddddddd-0000-0000-0000-000000186701','R1867 Co','r1867@example.in','07','R1867'),
  ('dddddddd-0000-0000-0000-000000186702','R1867 Other','r1867b@example.in','07','R1867B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000186701','owner1867@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186702','sales1867@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186703','nocompany1867@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000186701','dddddddd-0000-0000-0000-000000186701','owner1867@example.in','Owner 1867','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000186702','dddddddd-0000-0000-0000-000000186701','sales1867@example.in','Sales 1867','sales', now() - interval '1 day');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000186701','dddddddd-0000-0000-0000-000000186701','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000186702','dddddddd-0000-0000-0000-000000186702','Other bank','SBI');

insert into public.vendors (id, tenant_id, name, upi_id, bank_account_no) values
  ('eeeeeeee-0000-0000-0000-000000186701','dddddddd-0000-0000-0000-000000186701','Kapoor Legal Associates',null,null),
  ('eeeeeeee-0000-0000-0000-000000186702','dddddddd-0000-0000-0000-000000186701','Kapoor Stationers',null,null),
  ('eeeeeeee-0000-0000-0000-000000186703','dddddddd-0000-0000-0000-000000186701','Google Cloud India',null,null),
  ('eeeeeeee-0000-0000-0000-000000186704','dddddddd-0000-0000-0000-000000186701','Mehta Traders',null,null),
  ('eeeeeeee-0000-0000-0000-000000186705','dddddddd-0000-0000-0000-000000186701','Rao Consultants',null,null),
  ('eeeeeeee-0000-0000-0000-000000186706','dddddddd-0000-0000-0000-000000186701','Zeta Infra','zeta@okhdfc',null),
  ('eeeeeeee-0000-0000-0000-000000186707','dddddddd-0000-0000-0000-000000186701','Nair Printers',null,'50100123456789'),
  ('eeeeeeee-0000-0000-0000-000000186708','dddddddd-0000-0000-0000-000000186701','Bose Electricals',null,null),
  ('eeeeeeee-0000-0000-0000-000000186709','dddddddd-0000-0000-0000-000000186701','Iyer Logistics',null,null),
  ('eeeeeeee-0000-0000-0000-000000186710','dddddddd-0000-0000-0000-000000186702','Verma Hardware',null,null);

-- Expense bills (unpaid).
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section) values
  ('EXP-R1867-KL1','dddddddd-0000-0000-0000-000000186701','Professional Services','Kapoor Legal Associates','eeeeeeee-0000-0000-0000-000000186701','2026-09-01',47200,7200,'gst','KL-1',false,null,0,null),
  ('EXP-R1867-RC1','dddddddd-0000-0000-0000-000000186701','Professional Services','Rao Consultants','eeeeeeee-0000-0000-0000-000000186705','2026-09-03',11800,1800,'gst','RC-1',false,null,1000,'194J'),
  ('EXP-R1867-VH1','dddddddd-0000-0000-0000-000000186702','Office Supplies','Verma Hardware','eeeeeeee-0000-0000-0000-000000186710','2026-09-03',999,0,'none','VH-1',false,null,0,null);
-- COGS bills.
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, due_date, category, subtotal, igst, total, status, paid_amount) values
  ('BILL-R1867-G1','dddddddd-0000-0000-0000-000000186701','eeeeeeee-0000-0000-0000-000000186703','Google Cloud India','G-1','2026-09-05','2026-10-05','COGS-Workspace',10000,1800,11800,'unpaid',0),
  ('BILL-R1867-M1','dddddddd-0000-0000-0000-000000186701','eeeeeeee-0000-0000-0000-000000186704','Mehta Traders','M-1','2026-09-06','2026-10-06','COGS-Hardware',5000,900,5900,'unpaid',0),
  ('BILL-R1867-M2','dddddddd-0000-0000-0000-000000186701','eeeeeeee-0000-0000-0000-000000186704','Mehta Traders','M-2','2026-09-07','2026-10-07','COGS-Hardware',5000,900,5900,'unpaid',0),
  ('BILL-R1867-Z1','dddddddd-0000-0000-0000-000000186701','eeeeeeee-0000-0000-0000-000000186706','Zeta Infra','Z-1','2026-09-08','2026-10-08','COGS-Hardware',2000,360,2360,'unpaid',0),
  ('BILL-R1867-N1','dddddddd-0000-0000-0000-000000186701','eeeeeeee-0000-0000-0000-000000186707','Nair Printers','N-1','2026-09-09','2026-10-09','COGS-Hardware',3000,540,3540,'unpaid',0),
  ('BILL-R1867-B1','dddddddd-0000-0000-0000-000000186701','eeeeeeee-0000-0000-0000-000000186708','Bose Electricals','B-1','2026-10-20','2026-11-20','COGS-Hardware',1000,180,1180,'unpaid',0),
  ('BILL-R1867-I1','dddddddd-0000-0000-0000-000000186701','eeeeeeee-0000-0000-0000-000000186709','Iyer Logistics','I-1','2026-09-10','2026-10-10','COGS-Hardware',4000,720,4720,'unpaid',0);
-- Iyer's bill sits in an open payment run → pay it there, never from auto-reconcile.
insert into public.payment_runs (id, tenant_id, run_no, status, bank_account_id, created_by)
  values ('cccccccc-0000-0000-0000-000000186701','dddddddd-0000-0000-0000-000000186701','PR-R1867','draft',
          'bbbbbbbb-0000-0000-0000-000000186701','aaaaaaaa-0000-0000-0000-000000186701');
insert into public.payment_run_items (tenant_id, run_id, source, doc_id, vendor_name, amount)
  values ('dddddddd-0000-0000-0000-000000186701','cccccccc-0000-0000-0000-000000186701','vendor_bill','BILL-R1867-I1','Iyer Logistics',4720);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000186701','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-10','NEFT-KAPOOR LEGAL ASSOCIATES-KL1',47200,0,'U1','manual'),
  ('11111111-0000-0000-0000-000000186702','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-10','NEFT GOOGLE CLOUD',11800,0,'U2','manual'),
  ('11111111-0000-0000-0000-000000186703','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-11','IMPS MEHTA TRADERS',5900,0,'U3','manual'),
  ('11111111-0000-0000-0000-000000186704','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-11','UPI-RAO CONSULTANTS-FEES',10800,0,'U4','manual'),
  ('11111111-0000-0000-0000-000000186705','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-12','UPI/zeta@okhdfc/PAYMENT',2360,0,'U5','manual'),
  ('11111111-0000-0000-0000-000000186706','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-12','CHQ 004512',3540,0,'U6','manual'),
  ('11111111-0000-0000-0000-000000186707','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-12','NEFT BOSE ELECTRICALS',1180,0,'U7','manual'),
  ('11111111-0000-0000-0000-000000186708','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-12','NEFT IYER LOGISTICS',4720,0,'U8','manual'),
  ('11111111-0000-0000-0000-000000186709','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-12','NEFT VERMA HARDWARE',999,0,'U9','manual'),
  ('11111111-0000-0000-0000-000000186710','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-13','NEFT KAPOOR 1180',1180,0,'U10','manual'),
  ('11111111-0000-0000-0000-000000186711','dddddddd-0000-0000-0000-000000186701','bbbbbbbb-0000-0000-0000-000000186701','2026-10-13','IMPS 50100123456789 PRINT',3540,0,'U11','manual'),
  ('11111111-0000-0000-0000-000000186799','dddddddd-0000-0000-0000-000000186702','bbbbbbbb-0000-0000-0000-000000186702','2026-10-12','NEFT VERMA HARDWARE',999,0,'U99','manual');

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186701","role":"authenticated"}', true);

-- A. the vendor guess
do $$
begin
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186701') is distinct from 'eeeeeeee-0000-0000-0000-000000186701' then
    raise exception 'FAIL A: KAPOOR LEGAL ASSOCIATES → % (want Kapoor Legal Associates)', public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186701'); end if;
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186710') is not null then
    raise exception 'FAIL A: "KAPOOR" alone ties two vendors but guessed %', public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186710'); end if;
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186705') is distinct from 'eeeeeeee-0000-0000-0000-000000186706' then
    raise exception 'FAIL A: UPI id not used'; end if;
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186711') is distinct from 'eeeeeeee-0000-0000-0000-000000186707' then
    raise exception 'FAIL A: account number not used'; end if;
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186706') is not null then
    raise exception 'FAIL A: "CHQ 004512" guessed a vendor'; end if;
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186709') is not null then
    raise exception 'FAIL A: another company''s vendor guessed'; end if;
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186799') is not null then
    raise exception 'FAIL A: another company''s line answered'; end if;
  raise notice 'PASS A: vendor guess = UPI / account / most name words; tie, none and other company → nobody';
end $$;

-- B. candidates
do $$
declare n int; r record;
begin
  select count(*) into n from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000186703');
  if n is distinct from 2 then raise exception 'FAIL B: Mehta 5,900 has % candidates (want 2)', n; end if;
  select * into r from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000186704');
  if r.doc_id is distinct from 'EXP-R1867-RC1' or r.amount is distinct from 11800 or r.tds_amount is distinct from 1000 or r.tds_section is distinct from '194J' then
    raise exception 'FAIL B: Rao candidate % % % %', r.doc_id, r.amount, r.tds_amount, r.tds_section; end if;
  select count(*) into n from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000186707');
  if n <> 0 then raise exception 'FAIL B: a bill dated after the bank line is a candidate'; end if;
  select count(*) into n from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000186708');
  if n <> 0 then raise exception 'FAIL B: a bill in an open payment run is a candidate'; end if;
  raise notice 'PASS B: candidates = guessed vendor''s bills whose cash due equals the debit';
end $$;

-- C. auto-reconcile
do $$
declare r jsonb; t record;
begin
  r := public.auto_reconcile_bank_account('bbbbbbbb-0000-0000-0000-000000186701');
  -- paid: Kapoor Legal (expense), Google (COGS), Rao (expense net of TDS), Zeta (UPI), Nair by account (U11)
  if (r->>'reconciled')::int is distinct from 5 then raise exception 'FAIL C: reconciled % (want 5) %', r->>'reconciled', r; end if;
  if (r->>'ambiguous')::int < 1 then raise exception 'FAIL C: Mehta not ambiguous %', r; end if;

  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000186701';
  if t.matched_to_type is distinct from 'vendor_payment' or t.matched_to_id is distinct from 'eeeeeeee-0000-0000-0000-000000186701' then
    raise exception 'FAIL C: Kapoor line % %', t.matched_to_type, t.matched_to_id; end if;
  if not exists (select 1 from public.expenses where id = 'EXP-R1867-KL1' and paid and reconciled_txn_id = '11111111-0000-0000-0000-000000186701' and tds_amount = 0) then
    raise exception 'FAIL C: KL-1 not paid by the line'; end if;
  if (select status from public.vendor_bills where id = 'BILL-R1867-G1') is distinct from 'paid' then raise exception 'FAIL C: G-1 not paid'; end if;
  if not exists (select 1 from public.expenses where id = 'EXP-R1867-RC1' and paid and tds_amount = 1000 and tds_section = '194J') then
    raise exception 'FAIL C: RC-1 not paid net of its TDS'; end if;
  if (select cash from public.bank_vendor_payment_lines where expense_id = 'EXP-R1867-RC1') is distinct from 10800 then
    raise exception 'FAIL C: RC-1 cash leg'; end if;
  if (select status from public.vendor_bills where id = 'BILL-R1867-Z1') is distinct from 'paid' then raise exception 'FAIL C: Z-1 (UPI) not paid'; end if;
  if (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000186711') is distinct from 'eeeeeeee-0000-0000-0000-000000186707' then
    raise exception 'FAIL C: Nair by account not paid'; end if;

  -- left for review
  if exists (select 1 from public.vendor_bills where id in ('BILL-R1867-M1','BILL-R1867-M2','BILL-R1867-B1','BILL-R1867-I1') and status <> 'unpaid') then
    raise exception 'FAIL C: an ambiguous / later / in-run bill was paid'; end if;
  if exists (select 1 from public.bank_transactions where id in ('11111111-0000-0000-0000-000000186703','11111111-0000-0000-0000-000000186706',
              '11111111-0000-0000-0000-000000186707','11111111-0000-0000-0000-000000186708','11111111-0000-0000-0000-000000186709',
              '11111111-0000-0000-0000-000000186710') and matched_to_type is not null) then
    raise exception 'FAIL C: a line that needs review was reconciled'; end if;
  if exists (select 1 from public.expenses where id = 'EXP-R1867-VH1' and paid) then raise exception 'FAIL C: other company''s bill paid'; end if;
  -- nothing went through the old one-document path
  if exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000186701' and matched_to_type in ('expense','vendor_bill')) then
    raise exception 'FAIL C: a vendor bill was matched with reconcile_bank_txn'; end if;
  raise notice 'PASS C: auto-reconcile pays 5 sure vendor lines via R-1866; ambiguous / unnamed / later / in-run / other company left';
end $$;

-- C2. running it again changes nothing
do $$
declare r jsonb;
begin
  r := public.auto_reconcile_bank_account('bbbbbbbb-0000-0000-0000-000000186701');
  if (r->>'reconciled')::int <> 0 then raise exception 'FAIL C2: second run reconciled %', r; end if;
  raise notice 'PASS C2: second run reconciles nothing more';
end $$;

-- D. guards
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186702","role":"authenticated"}', true);
do $$
begin
  begin
    perform * from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000186703');
    raise exception 'FAIL D: sales login read vendor matches';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000186703');
    raise exception 'FAIL D: sales login guessed a vendor';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS D1: sales login refused (42501)';
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186703","role":"authenticated"}', true);
do $$
begin
  begin
    perform * from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000186703');
    raise exception 'FAIL D: no-company login read vendor matches';
  exception when invalid_authorization_specification then null;
  end;
  raise notice 'PASS D2: no-company login refused (28000)';
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186701","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000186799')) then
    raise exception 'FAIL D: another company''s line answered'; end if;
  raise notice 'PASS D3: another company''s line → nothing';
end $$;

rollback;
