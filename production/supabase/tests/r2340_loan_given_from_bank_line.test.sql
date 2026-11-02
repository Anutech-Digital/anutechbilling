-- R-2340 (1 Nov 2026): Loan GIVEN — set up from a money-in EMI line, receipts split into principal
-- back + interest income. Migration 20261101100517_r2340_loan_given_from_bank_line (on top of R-544's
-- loans_given / loan_repayments and R-2095's other_incomes).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example: the company lent Vinod Hem Raj ₹3,50,000 at 12% a year, 24 monthly receipts of
-- ₹16,476 from 5 Oct 2026 (reducing balance: receipt 1 = ₹12,976 principal + ₹3,500 interest).
--
-- Proves:
--   A. Set-up refusals write nothing (no borrower, EMI below the month's interest, a money-in line as
--      the disbursal, a disbursal line ₹2 off, another company's line, a non-owner/accountant user).
--   B. Set up (default: lent before these books — no bank entry) + this money-in line as receipt 1,
--      one call: plan 'emi', receipt 1 = ₹12,976 principal + ₹3,500 interest; the line is matched once
--      (loan_given → the receipt); NO new bank line; Loans given asset ₹3,37,024; P&L interest received
--      ₹3,500; balanced: line ₹16,476 = asset down ₹12,976 + income ₹3,500. The same line is refused again.
--   C. Receipt 2 (₹16,476 a month later) = ₹13,106 principal + ₹3,370 interest (seq 2).
--   D. Undo = Un-reconcile: receipt 1 refused while receipt 2 is on the books; receipt 2 then 1 undo
--      cleanly — repayments, interest income gone, asset back to ₹3,50,000, lines free.
--   E. Disbursal = an imported UNMATCHED money-out line (₹3,50,000): matched once to the loan, given_on
--      = its date, no new line; un-reconciling it removes the loan (refused while a receipt exists).
--   F. The last receipt clears the loan (₹20,000 · 12% · 2: ₹10,150 then ₹10,151 → closed, asset 0);
--      a receipt more than is owed is refused.
--   G. An R-544 one-shot loan: a money-in line with the interest part given → split as given.

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
  ('dddddddd-0000-0000-0000-000000234001','R2340 Co','r2340@example.in','07','R2340'),
  ('dddddddd-0000-0000-0000-000000234002','R2340 Other','r2340b@example.in','07','R2340B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000234001','owner2340@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000234002','sales2340@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000234001','dddddddd-0000-0000-0000-000000234001','owner2340@example.in','Owner 2340','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000234002','dddddddd-0000-0000-0000-000000234001','sales2340@example.in','Sales 2340','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000234001','dddddddd-0000-0000-0000-000000234001','HDFC Current','HDFC', 500000),
  ('bbbbbbbb-0000-0000-0000-000000234002','dddddddd-0000-0000-0000-000000234002','Other bank','SBI', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000234001','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-10-05','NEFT CR VINOD HEM RAJ',0,16476,'R1','csv_upload'),
  ('22222222-0000-0000-0000-000000234002','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-11-05','NEFT CR VINOD HEM RAJ',0,16476,'R2','csv_upload'),
  ('22222222-0000-0000-0000-000000234003','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-09-01','RTGS DR VINOD HEM RAJ',350000,0,'D1','csv_upload'),
  ('22222222-0000-0000-0000-000000234004','dddddddd-0000-0000-0000-000000234002','bbbbbbbb-0000-0000-0000-000000234002','2026-09-01','RTGS DR LOAN',350000,0,'Z1','csv_upload'),
  ('22222222-0000-0000-0000-000000234005','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-09-02','RTGS DR SOMEONE',350002,0,'X1','csv_upload'),
  -- F: the ₹20,000 loan's two receipts, and one more than is owed
  ('22222222-0000-0000-0000-000000234006','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-10-10','NEFT CR RAMESH',0,10150,'F1','csv_upload'),
  ('22222222-0000-0000-0000-000000234007','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-11-10','NEFT CR RAMESH',0,10151,'F2','csv_upload'),
  ('22222222-0000-0000-0000-000000234008','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-11-10','NEFT CR RAMESH',0,10152,'F3','csv_upload'),
  -- G: an R-544 one-shot loan's repayment
  ('22222222-0000-0000-0000-000000234009','dddddddd-0000-0000-0000-000000234001','bbbbbbbb-0000-0000-0000-000000234001','2026-10-20','NEFT CR SURESH',0,25000,'G1','csv_upload');

create temp table r2340_ids (k text primary key, v uuid);
grant all on r2340_ids to public;
create temp table r2340_vals (k text primary key, v bigint);
grant all on r2340_vals to public;

-- Vinod Hem Raj, ₹3,50,000 · 12% · 24 receipts of ₹16,476 from 5 Oct 2026.
create function pg_temp.r2340_vinod(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('borrower','Vinod Hem Raj','borrower_type','person','principal',350000,'interest_rate',12,
    'emi',16476,'instalments',24,'first_due_on','2026-10-05','given_on',null,
    'disbursal_txn_id',null,'reconcile_txn_id','22222222-0000-0000-0000-000000234001') || p_extra;
$f$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000234001","role":"authenticated"}', true);

insert into r2340_vals values
  ('cash0', (select cash_and_bank from public.report_balance_sheet('2026-12-31'))),
  ('lines0', (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000234001'));

-- ── A. Refusals, nothing written ─────────────────────────────────────────────────────────
do $$
declare v_case record;
begin
  for v_case in
    select * from (values
      ('no borrower',     '{"borrower":"  "}'::jsonb,                                            'Enter the borrower%'),
      ('EMI < interest',  '{"emi":3000}'::jsonb,                                                 'The EMI ₹3000 does not cover the first month''s interest ₹3500%'),
      ('money-in as out', '{"disbursal_txn_id":"22222222-0000-0000-0000-000000234002"}'::jsonb, 'Only a money-out line can be the money lent%'),
      ('₹2 off',          '{"disbursal_txn_id":"22222222-0000-0000-0000-000000234005"}'::jsonb, 'This line is ₹350002 but the loan is ₹350000%'),
      ('other company',   '{"disbursal_txn_id":"22222222-0000-0000-0000-000000234004"}'::jsonb, 'Bank line not found in your company%'),
      ('receipt = out',   '{"reconcile_txn_id":"22222222-0000-0000-0000-000000234003"}'::jsonb, 'Only a money-in line can be a receipt%')
    ) as c(name, extra, msg)
  loop
    begin
      perform public.record_loan_given_from_bank(pg_temp.r2340_vinod(v_case.extra));
      raise exception 'FAIL A (%): accepted', v_case.name;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL A (%): wrong refusal: %', v_case.name, sqlerrm; end if;
    end;
  end loop;
  if exists (select 1 from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000234001') then
    raise exception 'FAIL A: a refused set-up left a loan behind';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000234001' and matched_to_type is not null) then
    raise exception 'FAIL A: a refused set-up matched a line';
  end if;
end $$;

-- A (role): a sales user cannot set up a loan given.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000234002","role":"authenticated"}', true);
do $$
begin
  perform public.record_loan_given_from_bank(pg_temp.r2340_vinod());
  raise exception 'FAIL A (role): sales user accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Only the owner or the accountant%' then raise exception 'FAIL A (role): wrong refusal: %', sqlerrm; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000234001","role":"authenticated"}', true);

-- ── B. Set up (lent before these books) + this line as receipt 1 ─────────────────────────
do $$
declare v_r jsonb; v_l public.loans_given; v_rep public.loan_repayments; v_line public.bank_transactions; v_bs record;
begin
  v_r := public.record_loan_given_from_bank(pg_temp.r2340_vinod());
  insert into r2340_ids values ('vinod', (v_r ->> 'loan_id')::uuid);
  select * into v_l from public.loans_given where id = (v_r ->> 'loan_id')::uuid;
  if v_l.repayment_plan <> 'emi' or v_l.emi_amount <> 16476 or v_l.instalments <> 24 or v_l.due_on <> '2026-10-05'
     or v_l.principal <> 350000 or v_l.interest_rate <> 12 or v_l.bank_txn_id is not null or v_l.paid_from_account_id is not null
     or v_l.given_on <> '2026-09-05' or v_l.status <> 'open' or v_l.borrower_name <> 'Vinod Hem Raj' then
    raise exception 'FAIL B: loan row %', row_to_json(v_l);
  end if;
  if (v_r -> 'receipt' ->> 'seq')::int is distinct from 1 or (v_r -> 'receipt' ->> 'principal')::int is distinct from 12976
     or (v_r -> 'receipt' ->> 'interest')::int is distinct from 3500 then
    raise exception 'FAIL B: receipt %', v_r;
  end if;
  select * into v_rep from public.loan_repayments where loan_id = v_l.id;
  if v_rep.amount <> 16476 or v_rep.principal_part <> 12976 or v_rep.interest_part <> 3500
     or v_rep.bank_txn_id is distinct from '22222222-0000-0000-0000-000000234001' or v_rep.repaid_on <> '2026-10-05'
     or v_rep.bank_account_id is distinct from 'bbbbbbbb-0000-0000-0000-000000234001' then
    raise exception 'FAIL B: repayment %', row_to_json(v_rep);
  end if;
  select * into v_line from public.bank_transactions where id = '22222222-0000-0000-0000-000000234001';
  if v_line.matched_to_type is distinct from 'loan_given' or v_line.matched_to_id is distinct from v_rep.id::text then
    raise exception 'FAIL B: line not matched to the receipt (% %)', v_line.matched_to_type, v_line.matched_to_id;
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = v_l.tenant_id) <> (select v from r2340_vals where k = 'lines0') then
    raise exception 'FAIL B: a new bank line was made';
  end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2340_vals where k = 'cash0') then
    raise exception 'FAIL B: cash changed';
  end if;
  if public.loans_given_asset() <> 337024 then raise exception 'FAIL B: Loans given asset % (want 337024)', public.loans_given_asset(); end if;
  if (select coalesce(sum(amount), 0) from public.report_pnl_other_income('2026-10-01', '2026-10-31') where head = 'interest') <> 3500 then
    raise exception 'FAIL B: P&L interest received is not ₹3,500';
  end if;
  -- Balanced: the line's money = principal back (asset down) + interest income.
  if v_line.credit <> (350000 - public.loans_given_asset()) + (select sum(amount) from public.other_incomes where bank_txn_id = v_line.id) then
    raise exception 'FAIL B: not balanced';
  end if;
  -- The same line cannot be a receipt again.
  begin
    perform public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000234001', v_l.id, null);
    raise exception 'FAIL B: the same line was reconciled twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line is already reconciled%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- ── C. Receipt 2 ─────────────────────────────────────────────────────────────────────────
do $$
declare v_r jsonb; v_id uuid := (select v from r2340_ids where k = 'vinod');
begin
  v_r := public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000234002', v_id, null);
  if (v_r ->> 'seq')::int <> 2 or (v_r ->> 'principal')::int <> 13106 or (v_r ->> 'interest')::int <> 3370 then
    raise exception 'FAIL C: receipt 2 %', v_r;
  end if;
  if public.loans_given_asset() <> 323918 then raise exception 'FAIL C: asset %', public.loans_given_asset(); end if;
end $$;

-- ── D. Undo: latest receipt first ────────────────────────────────────────────────────────
do $$
declare v_id uuid := (select v from r2340_ids where k = 'vinod');
begin
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234001', false);
    raise exception 'FAIL D: receipt 1 undone while receipt 2 is on the books';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%later receipt%undo%first%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
  end;
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234002', false);
  if public.loans_given_asset() <> 337024 then raise exception 'FAIL D: asset after undo 2 %', public.loans_given_asset(); end if;
  if exists (select 1 from public.other_incomes where bank_txn_id = '22222222-0000-0000-0000-000000234002') then
    raise exception 'FAIL D: interest income of receipt 2 left';
  end if;
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234001', false);
  if public.loans_given_asset() <> 350000 then raise exception 'FAIL D: asset after undo 1 %', public.loans_given_asset(); end if;
  if exists (select 1 from public.loan_repayments where loan_id = v_id) then raise exception 'FAIL D: repayments left'; end if;
  if exists (select 1 from public.other_incomes o join public.bank_transactions t on t.id = o.bank_txn_id
              where t.tenant_id = 'dddddddd-0000-0000-0000-000000234001') then
    raise exception 'FAIL D: interest income left';
  end if;
  if exists (select 1 from public.bank_transactions where id in ('22222222-0000-0000-0000-000000234001','22222222-0000-0000-0000-000000234002')
               and matched_to_type is not null) then
    raise exception 'FAIL D: a line is still matched';
  end if;
  if not exists (select 1 from public.loans_given where id = v_id and status = 'open') then raise exception 'FAIL D: loan gone or closed'; end if;
  -- clean up for E (no receipts, no bank line → delete is allowed)
  perform public.delete_loan_given(v_id);
end $$;

-- ── E. Disbursal = an imported money-out line ────────────────────────────────────────────
do $$
declare v_r jsonb; v_l public.loans_given; v_line public.bank_transactions;
begin
  v_r := public.record_loan_given_from_bank(pg_temp.r2340_vinod(jsonb_build_object(
    'disbursal_txn_id','22222222-0000-0000-0000-000000234003','account_id','bbbbbbbb-0000-0000-0000-000000234001')));
  select * into v_l from public.loans_given where id = (v_r ->> 'loan_id')::uuid;
  if v_l.bank_txn_id is distinct from '22222222-0000-0000-0000-000000234003' or v_l.given_on <> '2026-09-01'
     or v_l.paid_from_account_id is distinct from 'bbbbbbbb-0000-0000-0000-000000234001' then
    raise exception 'FAIL E: loan row %', row_to_json(v_l);
  end if;
  select * into v_line from public.bank_transactions where id = '22222222-0000-0000-0000-000000234003';
  if v_line.matched_to_type is distinct from 'loan_given' or v_line.matched_to_id is distinct from v_l.id::text then
    raise exception 'FAIL E: disbursal line not matched (% %)', v_line.matched_to_type, v_line.matched_to_id;
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = v_l.tenant_id) <> (select v from r2340_vals where k = 'lines0') then
    raise exception 'FAIL E: a new bank line was made';
  end if;
  -- refused while receipt 1 is on the books
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234003', false);
    raise exception 'FAIL E: disbursal undone while a receipt exists';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%receipt%undo those first%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234001', false);
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234003', false);
  if exists (select 1 from public.loans_given where id = v_l.id) then raise exception 'FAIL E: loan left after undo'; end if;
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000234003') is not null then
    raise exception 'FAIL E: disbursal line still matched';
  end if;
end $$;

-- ── F. The last receipt clears the loan; more than owed is refused ───────────────────────
do $$
declare v_r jsonb; v_id uuid;
begin
  v_r := public.record_loan_given_from_bank(jsonb_build_object('borrower','Ramesh','principal',20000,'interest_rate',12,
    'emi',10150,'instalments',2,'first_due_on','2026-10-10','reconcile_txn_id','22222222-0000-0000-0000-000000234006'));
  v_id := (v_r ->> 'loan_id')::uuid;
  if (v_r -> 'receipt' ->> 'principal')::int <> 9950 or (v_r -> 'receipt' ->> 'interest')::int <> 200 then
    raise exception 'FAIL F: receipt 1 %', v_r;
  end if;
  begin
    perform public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000234008', v_id, null);
    raise exception 'FAIL F: ₹10,152 accepted (only ₹10,151 is owed)';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%more than is owed%10151%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
  end;
  v_r := public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000234007', v_id, null);
  if (v_r ->> 'principal')::int <> 10050 or (v_r ->> 'interest')::int <> 101 or (v_r ->> 'closes')::boolean is not true then
    raise exception 'FAIL F: last receipt %', v_r;
  end if;
  if (select status from public.loans_given where id = v_id) <> 'closed' then raise exception 'FAIL F: loan not closed'; end if;
  if public.loans_given_asset() <> 0 then raise exception 'FAIL F: asset %', public.loans_given_asset(); end if;
  -- undoing the last receipt re-opens it
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234007', false);
  if (select status from public.loans_given where id = v_id) <> 'open' then raise exception 'FAIL F: loan not re-opened'; end if;
end $$;

-- ── G. An R-544 one-shot loan, interest part given ───────────────────────────────────────
do $$
declare v_id uuid; v_r jsonb;
begin
  v_id := public.give_loan('Suresh', 'person', 50000, '2026-09-15', 'bbbbbbbb-0000-0000-0000-000000234001', 10);
  v_r := public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000234009', v_id, 1000);
  if (v_r ->> 'principal')::int <> 24000 or (v_r ->> 'interest')::int <> 1000 then raise exception 'FAIL G: %', v_r; end if;
  if (select interest_part from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000234009') <> 1000 then
    raise exception 'FAIL G: repayment';
  end if;
end $$;

select 'R-2340 loan given from a bank line: ALL PASS' as result;

rollback;
