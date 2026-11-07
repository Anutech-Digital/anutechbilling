-- R-2570: every flow that books a bank line (or writes its own cash line) stores its OWN
-- matched_to_type + matched_to_id — never 'manual' — and bank_line_bookings() still names the
-- booking. One block per writer. Self-asserting; ROLLS BACK.
-- Red without migration 20261107165630_r2570_bank_line_own_type.sql (every writer still wrote 'manual').
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2570_bank_line_own_type.test.sql

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000025a1', 'R2570 TEST', 'r2570@example.in', '07'),
  ('aaaaaaaa-0000-0000-0000-0000000025a2', 'R2570 OTHER', 'r2570b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000025b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2570-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-0000000025b1', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'r2570-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000025c1', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'Test Current', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000025d1', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'aaaaaaaa-0000-0000-0000-0000000025c1', '2026-10-01', 'NEFT BAJAJ FINANCE LOAN', 0, 500000, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-0000000025d2', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'aaaaaaaa-0000-0000-0000-0000000025c1', '2026-10-02', 'NEFT DIRECTOR', 0, 300000, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-0000000025d3', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'aaaaaaaa-0000-0000-0000-0000000025c1', '2026-10-03', 'IMPS ASHA PAID BY MISTAKE', 0, 4000, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-0000000025d4', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'aaaaaaaa-0000-0000-0000-0000000025c1', '2026-10-04', 'RTGS FAILED', 0, 7000, 'csv_upload');
insert into public.employees (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000025e1', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'Asha');
-- A pre-R-1864 asset bought on EMI (record_emi_payment's purchases).
insert into public.emi_purchases (id, tenant_id, name, total_cost, financed, purchased_on, lender, kind, category) values
  ('aaaaaaaa-0000-0000-0000-0000000025f1', 'aaaaaaaa-0000-0000-0000-0000000025a1', 'Laptop', 120000, 100000, '2026-09-01', 'Bajaj', 'asset', 'equipment');
-- Another company's staff loan (the company gate must refuse pointing a line at it).
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000025f9', 'aaaaaaaa-0000-0000-0000-0000000025a2', 'Other', 1000, '2026-09-01', 'loan');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000025b1', 'role', 'authenticated')::text, true);

do $$
declare
  v_acct constant uuid := 'aaaaaaaa-0000-0000-0000-0000000025c1';
  t      public.bank_transactions;
  v_id   uuid;
  v_id2  uuid;
  v_bl   uuid;
  v_pay  uuid;
  n      int;
  r      record;
begin
  -- 1. book_bank_advance → bs_item + its balance-sheet row.
  perform public.book_bank_advance('aaaaaaaa-0000-0000-0000-0000000025d1', 'Bajaj Finance', 'received', null);
  select * into t from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000025d1';
  select id into v_id from public.balance_sheet_items where bank_txn_id = t.id;
  if t.matched_to_type is distinct from 'bs_item' or t.matched_to_id is distinct from v_id::text then
    raise exception 'FAIL 1: book_bank_advance wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;

  -- 2. book_bank_credit → bs_item.
  perform public.book_bank_credit('aaaaaaaa-0000-0000-0000-0000000025d2', 'director_loan', 'Loan from Pardeep', null);
  select * into t from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000025d2';
  select id into v_id from public.balance_sheet_items where bank_txn_id = t.id;
  if t.matched_to_type is distinct from 'bs_item' or t.matched_to_id is distinct from v_id::text then
    raise exception 'FAIL 2: book_bank_credit wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;

  -- 3. disburse_employee_loan → its payout line is employee_loan + the loan id.
  v_id := public.disburse_employee_loan('Asha', 15000, '2026-10-05', v_acct, 'loan', null);
  select t2.* into t from public.bank_transactions t2 join public.employee_loans e on e.bank_txn_id = t2.id where e.id = v_id;
  if t.matched_to_type is distinct from 'employee_loan' or t.matched_to_id is distinct from v_id::text then
    raise exception 'FAIL 3: disburse_employee_loan wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;

  -- 4. record_employee_loan_repayment → employee_loan + the loan id; bank_line_bookings names it.
  perform public.record_employee_loan_repayment(v_id, 5000, '2026-10-10', 'bank', v_acct, null);
  select * into t from public.bank_transactions where bank_account_id = v_acct and description = 'Loan repayment — Asha';
  if t.matched_to_type is distinct from 'employee_loan' or t.matched_to_id is distinct from v_id::text then
    raise exception 'FAIL 4: record_employee_loan_repayment wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;
  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = t.id;
  if r.source is distinct from 'employee_loan_repayment' or r.party is distinct from 'Asha' or r.amount <> 5000 then
    raise exception 'FAIL 4b: repayment line read %', row_to_json(r);
  end if;

  -- 5. edit_employee_loan: its own line is not "booked elsewhere"; it stays employee_loan.
  v_id2 := public.disburse_employee_loan('Ravi', 8000, '2026-10-06', v_acct, 'salary_advance', null);
  perform public.edit_employee_loan(v_id2, 'Ravi', 9000, '2026-10-06', v_acct, 'salary_advance', null);
  select t2.* into t from public.bank_transactions t2 join public.employee_loans e on e.bank_txn_id = t2.id where e.id = v_id2;
  if t.debit <> 9000 or t.matched_to_type is distinct from 'employee_loan' or t.matched_to_id is distinct from v_id2::text then
    raise exception 'FAIL 5: edited loan line is % / % / %', t.debit, t.matched_to_type, t.matched_to_id;
  end if;

  -- 6. delete_employee_loan: allowed, the line goes with it.
  perform public.delete_employee_loan(v_id2);
  if exists (select 1 from public.bank_transactions where id = t.id) then raise exception 'FAIL 6: deleted loan left its line'; end if;

  -- 7. settle_expense_advance → the returned cash line is employee_loan + the advance id.
  v_id2 := public.disburse_employee_loan('Meena', 6000, '2026-10-07', v_acct, 'expense_advance', null);
  perform public.settle_expense_advance(v_id2, 1000, 'Travel', 2000, v_acct, '2026-10-08', null);
  select * into t from public.bank_transactions where bank_account_id = v_acct and description = 'Advance returned — Meena';
  if t.matched_to_type is distinct from 'employee_loan' or t.matched_to_id is distinct from v_id2::text then
    raise exception 'FAIL 7: settle_expense_advance wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;
  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = t.id;
  if r.source is distinct from 'employee_advance_returned' or r.party is distinct from 'Meena' then
    raise exception 'FAIL 7b: returned-cash line read %', row_to_json(r);
  end if;

  -- 8. give_loan → loan_given + the loan id; un-reconciling its own line is refused (the loan
  --    would go and the line stay); Delete loan removes both.
  v_id := public.give_loan('Ravi Kumar', 'person', 20000, '2026-10-09', v_acct);
  select t2.* into t from public.bank_transactions t2 join public.loans_given g on g.bank_txn_id = t2.id where g.id = v_id;
  if t.matched_to_type is distinct from 'loan_given' or t.matched_to_id is distinct from v_id::text then
    raise exception 'FAIL 8: give_loan wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;
  begin
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = t.id;
    raise exception 'FAIL 8b: un-reconciling give_loan''s own line was allowed';
  exception when check_violation then null;
  end;
  if not exists (select 1 from public.loans_given where id = v_id) then raise exception 'FAIL 8c: loan gone'; end if;
  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = t.id;
  if r.source is distinct from 'loan_given' or r.party is distinct from 'Ravi Kumar' then
    raise exception 'FAIL 8d: loan given line read %', row_to_json(r);
  end if;
  perform public.delete_loan_given(v_id);
  if exists (select 1 from public.bank_transactions where id = t.id) then raise exception 'FAIL 8e: deleted loan left its line'; end if;

  -- 9. record_business_loan (no statement line) → business_loan + the loan id; un-reconcile refused.
  v_bl := public.record_business_loan('HDFC Bank', 'Working capital', 100000, 10, 12, 9000, '2026-10-11', v_acct, null);
  select t2.* into t from public.bank_transactions t2 join public.business_loans b on b.disbursal_bank_txn_id = t2.id where b.id = v_bl;
  if t.matched_to_type is distinct from 'business_loan' or t.matched_to_id is distinct from v_bl::text then
    raise exception 'FAIL 9: record_business_loan wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;
  begin
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = t.id;
    raise exception 'FAIL 9b: un-reconciling Add loan''s own line was allowed';
  exception when check_violation then null;
  end;

  -- 10. record_loan_emi → loan_repayment + the payment id; bank_line_bookings names the lender.
  perform public.record_loan_emi(v_bl, 9000, 800, '2026-10-20', v_acct, null);
  select id into v_pay from public.business_loan_payments where loan_id = v_bl;
  select * into t from public.bank_transactions where bank_account_id = v_acct and description = 'Loan EMI: HDFC Bank';
  if t.matched_to_type is distinct from 'loan_repayment' or t.matched_to_id is distinct from v_pay::text then
    raise exception 'FAIL 10: record_loan_emi wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;
  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = t.id;
  if r.source is distinct from 'business_loan_payment' or r.party is distinct from 'HDFC Bank' or r.amount <> 9000 then
    raise exception 'FAIL 10b: loan EMI line read %', row_to_json(r);
  end if;

  -- 11. record_emi_payment → emi + the payment id, the payment points at its line, Undo removes it.
  perform public.record_emi_payment('aaaaaaaa-0000-0000-0000-0000000025f1', 5000, 500, '2026-10-21', v_acct, null);
  select id into v_pay from public.emi_payments where purchase_id = 'aaaaaaaa-0000-0000-0000-0000000025f1';
  select * into t from public.bank_transactions where bank_account_id = v_acct and description = 'EMI: Laptop';
  if t.matched_to_type is distinct from 'emi' or t.matched_to_id is distinct from v_pay::text
     or (select bank_txn_id from public.emi_payments where id = v_pay) is distinct from t.id then
    raise exception 'FAIL 11: record_emi_payment wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;
  perform public.undo_emi_payment(v_pay);
  if exists (select 1 from public.bank_transactions where id = t.id) then raise exception 'FAIL 11b: Undo EMI left its line'; end if;

  -- 12. pay_statutory_dues → statutory + the payment id; bank_line_bookings names the challan.
  perform public.pay_statutory_dues(3000, 'tds', '2026-10-22', v_acct, null, 'CH123', null);
  select * into t from public.bank_transactions where bank_account_id = v_acct and description like 'Statutory dues paid (tds)%';
  if t.matched_to_type is distinct from 'statutory'
     or t.matched_to_id is distinct from (select id::text from public.statutory_dues_payments where challan_no = 'CH123') then
    raise exception 'FAIL 12: pay_statutory_dues wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;
  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = t.id;
  if r.source is distinct from 'statutory' or r.party is distinct from 'CH123' then
    raise exception 'FAIL 12b: challan line read %', row_to_json(r);
  end if;

  -- 13. Money owed back to an employee → reimbursement + 'reimbursement:<id>'.
  perform public.book_bank_txn_as_employee_advance('aaaaaaaa-0000-0000-0000-0000000025d3', 'owed_back', 'Asha', null, null, null);
  select * into t from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000025d3';
  if t.matched_to_type is distinct from 'reimbursement' or t.matched_to_id not like 'reimbursement:%' then
    raise exception 'FAIL 13: owed back wrote % / %', t.matched_to_type, t.matched_to_id;
  end if;

  -- 14. A real "Mark reconciled manually" stays 'manual' and has no booking.
  perform public.reconcile_bank_txn_manual('aaaaaaaa-0000-0000-0000-0000000025d4', 'Returned by the bank, no entry');
  select * into t from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000025d4';
  if t.matched_to_type is distinct from 'manual' then raise exception 'FAIL 14: manual reconcile wrote %', t.matched_to_type; end if;
  if exists (select 1 from public.bank_line_bookings(v_acct) b where b.txn_id = t.id) then
    raise exception 'FAIL 14b: a plain manual line must have no booking';
  end if;

  -- 15. No writer of this test left a 'manual' line behind except the real manual one.
  select count(*) into n from public.bank_transactions where bank_account_id = v_acct and matched_to_type = 'manual';
  if n <> 1 then raise exception 'FAIL 15: % manual line(s), expected 1', n; end if;

  -- 16. The new types come only from their own flows: reconcile_bank_txn refuses them.
  begin
    perform public.reconcile_bank_txn('aaaaaaaa-0000-0000-0000-0000000025d4', 'employee_loan', v_id::text, 'manual');
    raise exception 'FAIL 16: reconcile_bank_txn accepted employee_loan';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 17. The company gate (R-2472) knows the new types: a line cannot point at another company's loan.
reset role;
do $$
begin
  begin
    update public.bank_transactions
       set matched_to_type = 'employee_loan', matched_to_id = 'aaaaaaaa-0000-0000-0000-0000000025f9'
     where id = 'aaaaaaaa-0000-0000-0000-0000000025d4';
    raise exception 'FAIL 17: a line was pointed at another company''s staff loan';
  exception when insufficient_privilege then null;
  end;
  -- A reimbursement id is checked in both shapes ('reimbursement:<id>' and a bare id).
  insert into public.reimbursements (id, tenant_id, person_name, purpose, amount, incurred_on)
  values ('aaaaaaaa-0000-0000-0000-0000000025f8', 'aaaaaaaa-0000-0000-0000-0000000025a2', 'Other', 'x', 100, '2026-09-01');
  begin
    update public.bank_transactions
       set matched_to_type = 'reimbursement', matched_to_id = 'aaaaaaaa-0000-0000-0000-0000000025f8'
     where id = 'aaaaaaaa-0000-0000-0000-0000000025d4';
    raise exception 'FAIL 17b: a line was pointed at another company''s reimbursement (bare id)';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.bank_transactions
       set matched_to_type = 'reimbursement', matched_to_id = 'reimbursement:aaaaaaaa-0000-0000-0000-0000000025f8'
     where id = 'aaaaaaaa-0000-0000-0000-0000000025d4';
    raise exception 'FAIL 17c: a line was pointed at another company''s reimbursement';
  exception when insufficient_privilege then null;
  end;
end $$;

select 'r2570_bank_line_own_type: all checks passed' as result;

rollback;
