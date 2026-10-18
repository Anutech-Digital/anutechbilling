-- Regression test: R-1584 — the books lock covers assets, loans, EMI, reimbursements, the
-- manual Balance Sheet lines and the opening balances, and reads a payment's time in IST.
-- (migration 20261018195438_r1584_books_lock_more_tables.sql)
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1584_books_lock_more_tables.test.sql
--
-- Books locked till 30 Sep 2026, caller = the company's owner (JWT role authenticated).
--   1. A customer payment at 00:30 IST on 1 Oct (18:30-something UTC on 30 Sep) is an
--      October payment: it can be edited. One at 23:30 IST on 30 Sep cannot.
--   2. Fixed asset put to use 15 Sep: delete / cost change / back-dated new asset refused;
--      a disposal dated in October goes through; a disposal dated in September is refused.
--   3. Loan given 1 Sep: principal change and delete refused; closing it in October allowed;
--      a September repayment refused.
--   4. Employee loan, business loan, EMI purchase and their payments dated in September refused.
--   5. Reimbursement incurred 10 Sep: amount change / delete refused; settling it in October allowed.
--   6. Manual Balance Sheet line created in August: amount change / delete refused; a new line
--      today is allowed.
--   7. Opening balances as of 31 Mar 2026 can no longer be changed or removed.
--   8. The refusal says which books are locked and that the owner unlocks them (§24).
--   9. Lock removed → the same edits go through.

begin;

insert into public.tenants (id, name, email, state_code, books_locked_until) values
  ('aaaaaaaa-0000-0000-0000-000000158401', 'LOCK R1584', 'r1584@example.in', '07', '2026-09-30');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000001584a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1584-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-0000001584a1', 'aaaaaaaa-0000-0000-0000-000000158401', 'r1584-owner@example.in', 'owner');
insert into public.customers (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000001584c1', 'aaaaaaaa-0000-0000-0000-000000158401', 'R1584 Cust');
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount) values
  ('R1584-Q1', 'aaaaaaaa-0000-0000-0000-000000158401', 'R1584 Cust', 'aaaaaaaa-0000-0000-0000-0000001584c1', 18, 11800);

-- rows written by the system (no JWT → never blocked)
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at) values
  ('aaaaaaaa-0000-0000-0000-0000001584e1', 'aaaaaaaa-0000-0000-0000-000000158401', 'R1584-Q1', 'aaaaaaaa-0000-0000-0000-0000001584c1', 5000, 'upi', 'received', '2026-10-01 00:30:00+05:30'),
  ('aaaaaaaa-0000-0000-0000-0000001584e2', 'aaaaaaaa-0000-0000-0000-000000158401', 'R1584-Q1', 'aaaaaaaa-0000-0000-0000-0000001584c1', 5000, 'upi', 'received', '2026-09-30 23:30:00+05:30');
insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use) values
  ('aaaaaaaa-0000-0000-0000-0000001584f1', 'aaaaaaaa-0000-0000-0000-000000158401', 'Laptop', 'computers', 80000, '2026-09-15'),
  ('aaaaaaaa-0000-0000-0000-0000001584f2', 'aaaaaaaa-0000-0000-0000-000000158401', 'Printer', 'computers', 20000, '2026-09-15');
insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, disposed_on, disposal_value) values
  ('aaaaaaaa-0000-0000-0000-0000001584f3', 'aaaaaaaa-0000-0000-0000-000000158401', 'Old phone', 'computers', 30000, '2026-06-01', '2026-09-20', 5000);
insert into public.loans_given (id, tenant_id, borrower_name, borrower_type, principal, given_on, repayment_plan) values
  ('aaaaaaaa-0000-0000-0000-0000001584d1', 'aaaaaaaa-0000-0000-0000-000000158401', 'Ravi', 'person', 50000, '2026-09-01', 'one_shot');
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on) values
  ('aaaaaaaa-0000-0000-0000-000000158451', 'aaaaaaaa-0000-0000-0000-000000158401', 'Asha', 10000, '2026-09-05');
insert into public.business_loans (id, tenant_id, lender, principal, disbursed_on) values
  ('aaaaaaaa-0000-0000-0000-000000158461', 'aaaaaaaa-0000-0000-0000-000000158401', 'HDFC', 300000, '2026-09-05');
insert into public.emi_purchases (id, tenant_id, name, total_cost, financed, purchased_on) values
  ('aaaaaaaa-0000-0000-0000-000000158471', 'aaaaaaaa-0000-0000-0000-000000158401', 'Car', 600000, 500000, '2026-09-05');
insert into public.reimbursements (id, tenant_id, person_name, purpose, amount, incurred_on) values
  ('aaaaaaaa-0000-0000-0000-000000158481', 'aaaaaaaa-0000-0000-0000-000000158401', 'Asha', 'Cab', 900, '2026-09-10');
insert into public.balance_sheet_items (id, tenant_id, section, label, amount, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000158491', 'aaaaaaaa-0000-0000-0000-000000158401', 'asset', 'Security deposit', 25000, '2026-08-10 10:00:00+05:30');
insert into public.opening_balances (tenant_id, as_of, owner_capital, retained_earnings) values
  ('aaaaaaaa-0000-0000-0000-000000158401', '2026-03-31', 100000, 20000);

-- 3. loans given / loan repayments are written only through SECURITY DEFINER RPCs (RLS gives
--    authenticated read only). An RPC runs as the function owner with the caller's JWT —
--    the same here: database owner role, the owner's JWT claims.
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000001584a1', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  begin
    update public.loans_given set principal = 1 where id = 'aaaaaaaa-0000-0000-0000-0000001584d1';
    raise exception 'FAIL 3a: locked loan principal changed';
  exception when check_violation then null;
  end;
  begin
    delete from public.loans_given where id = 'aaaaaaaa-0000-0000-0000-0000001584d1';
    raise exception 'FAIL 3b: locked loan deleted';
  exception when check_violation then null;
  end;
  begin
    insert into public.loan_repayments (tenant_id, loan_id, repaid_on, amount, principal_part)
    values ('aaaaaaaa-0000-0000-0000-000000158401', 'aaaaaaaa-0000-0000-0000-0000001584d1', '2026-09-25', 1000, 1000);
    raise exception 'FAIL 3c: loan repayment back-dated into the lock';
  exception when check_violation then null;
  end;
  insert into public.loan_repayments (tenant_id, loan_id, repaid_on, amount, principal_part)
  values ('aaaaaaaa-0000-0000-0000-000000158401', 'aaaaaaaa-0000-0000-0000-0000001584d1', '2026-10-10', 50000, 50000);
  update public.loans_given set status = 'closed', closed_on = '2026-10-10', updated_at = now()
   where id = 'aaaaaaaa-0000-0000-0000-0000001584d1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 3d: closing a September loan in October was refused'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000001584a1', 'role', 'authenticated')::text, true);

do $$
declare
  n int;
  msg text;
begin
  -- 1. IST, not UTC
  update public.payments set notes = 'Oct payment' where id = 'aaaaaaaa-0000-0000-0000-0000001584e1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 1a: 00:30 IST 1 Oct payment not editable (RLS?)'; end if;
  begin
    update public.payments set notes = 'Sep payment' where id = 'aaaaaaaa-0000-0000-0000-0000001584e2';
    raise exception 'FAIL 1b: 23:30 IST 30 Sep payment edited inside the lock';
  exception when check_violation then null;
  end;

  -- 2. fixed assets
  begin
    delete from public.fixed_assets where id = 'aaaaaaaa-0000-0000-0000-0000001584f1';
    raise exception 'FAIL 2a: locked fixed asset deleted';
  exception when check_violation then null;
  end;
  begin
    update public.fixed_assets set cost = 1 where id = 'aaaaaaaa-0000-0000-0000-0000001584f1';
    raise exception 'FAIL 2b: locked fixed asset cost changed';
  exception when check_violation then null;
  end;
  begin
    update public.fixed_assets set put_to_use = '2026-10-02' where id = 'aaaaaaaa-0000-0000-0000-0000001584f1';
    raise exception 'FAIL 2c: locked fixed asset moved out of the period';
  exception when check_violation then null;
  end;
  begin
    insert into public.fixed_assets (tenant_id, name, block, cost, put_to_use)
    values ('aaaaaaaa-0000-0000-0000-000000158401', 'Old desk', 'furniture', 5000, '2026-09-10');
    raise exception 'FAIL 2d: fixed asset back-dated into the lock';
  exception when check_violation then null;
  end;
  begin
    update public.fixed_assets set disposed_on = '2026-09-20', disposal_value = 100 where id = 'aaaaaaaa-0000-0000-0000-0000001584f2';
    raise exception 'FAIL 2e: disposal dated inside the lock';
  exception when check_violation then null;
  end;
  update public.fixed_assets set disposed_on = '2026-10-05', disposal_value = 15000, updated_at = now()
   where id = 'aaaaaaaa-0000-0000-0000-0000001584f1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 2f: an October disposal of a September asset was refused'; end if;
  begin
    update public.fixed_assets set disposed_on = null, disposal_value = 0 where id = 'aaaaaaaa-0000-0000-0000-0000001584f1';
    -- an October disposal can be undone while October is open
  end;

  -- a disposal already booked in September cannot be re-priced or undone
  begin
    update public.fixed_assets set disposal_value = 1 where id = 'aaaaaaaa-0000-0000-0000-0000001584f3';
    raise exception 'FAIL 2g: a September disposal was re-priced inside the lock';
  exception when check_violation then null;
  end;
  begin
    update public.fixed_assets set disposed_on = null, disposal_value = 0 where id = 'aaaaaaaa-0000-0000-0000-0000001584f3';
    raise exception 'FAIL 2h: a September disposal was undone inside the lock';
  exception when check_violation then null;
  end;

  -- 3. loans given: see the block above (written only through SECURITY DEFINER RPCs)

  -- 4. employee loan, business loan, EMI
  begin
    delete from public.employee_loans where id = 'aaaaaaaa-0000-0000-0000-000000158451';
    raise exception 'FAIL 4a: locked employee loan deleted';
  exception when check_violation then null;
  end;
  begin
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method)
    values ('aaaaaaaa-0000-0000-0000-000000158401', 'aaaaaaaa-0000-0000-0000-000000158451', 1000, '2026-09-28', 'cash');
    raise exception 'FAIL 4b: employee loan repayment back-dated into the lock';
  exception when check_violation then null;
  end;
  begin
    insert into public.business_loan_payments (tenant_id, loan_id, amount, principal_part, paid_on)
    values ('aaaaaaaa-0000-0000-0000-000000158401', 'aaaaaaaa-0000-0000-0000-000000158461', 10000, 8000, '2026-09-28');
    raise exception 'FAIL 4c: business loan EMI back-dated into the lock';
  exception when check_violation then null;
  end;
  begin
    update public.business_loans set principal = 1 where id = 'aaaaaaaa-0000-0000-0000-000000158461';
    raise exception 'FAIL 4d: locked business loan changed';
  exception when check_violation then null;
  end;
  begin
    insert into public.emi_payments (tenant_id, purchase_id, amount, principal_part, paid_on)
    values ('aaaaaaaa-0000-0000-0000-000000158401', 'aaaaaaaa-0000-0000-0000-000000158471', 10000, 8000, '2026-09-28');
    raise exception 'FAIL 4e: EMI back-dated into the lock';
  exception when check_violation then null;
  end;
  begin
    update public.emi_purchases set total_cost = 1 where id = 'aaaaaaaa-0000-0000-0000-000000158471';
    raise exception 'FAIL 4f: locked EMI purchase changed';
  exception when check_violation then null;
  end;
  update public.emi_purchases set status = 'closed', updated_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000158471';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 4g: closing a September EMI purchase was refused'; end if;

  -- 5. reimbursements
  begin
    update public.reimbursements set amount = 1 where id = 'aaaaaaaa-0000-0000-0000-000000158481';
    raise exception 'FAIL 5a: locked reimbursement amount changed';
  exception when check_violation then null;
  end;
  begin
    delete from public.reimbursements where id = 'aaaaaaaa-0000-0000-0000-000000158481';
    raise exception 'FAIL 5b: locked reimbursement deleted';
  exception when check_violation then null;
  end;
  begin
    update public.reimbursements set status = 'settled', settled_on = '2026-09-29' where id = 'aaaaaaaa-0000-0000-0000-000000158481';
    raise exception 'FAIL 5c: reimbursement settled on a locked date';
  exception when check_violation then null;
  end;
  update public.reimbursements set status = 'settled', settled_on = '2026-10-03', settled_notes = 'UPI'
   where id = 'aaaaaaaa-0000-0000-0000-000000158481';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 5d: settling a September reimbursement in October was refused'; end if;

  -- 6. manual Balance Sheet lines
  begin
    update public.balance_sheet_items set amount = 1 where id = 'aaaaaaaa-0000-0000-0000-000000158491';
    raise exception 'FAIL 6a: locked Balance Sheet line changed';
  exception when check_violation then null;
  end;
  begin
    delete from public.balance_sheet_items where id = 'aaaaaaaa-0000-0000-0000-000000158491';
    raise exception 'FAIL 6b: locked Balance Sheet line deleted';
  exception when check_violation then null;
  end;
  insert into public.balance_sheet_items (tenant_id, section, label, amount)
  values ('aaaaaaaa-0000-0000-0000-000000158401', 'liability', 'New line', 500);

  -- 7. opening balances
  begin
    perform public.set_opening_balances('2026-03-31', 1, 1, null);
    raise exception 'FAIL 7a: opening balances changed behind a lock';
  exception when check_violation then null;
  end;
  begin
    perform public.set_opening_balances();
    raise exception 'FAIL 7b: opening balances removed behind a lock';
  exception when check_violation then null;
  end;

  -- 8. the message names the lock and the next step (§24)
  begin
    delete from public.fixed_assets where id = 'aaaaaaaa-0000-0000-0000-0000001584f1';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
  end;
  if msg is null or msg not like 'Books 30 Sep 2026 tak lock%' or msg not ilike '%owner%unlock%' then
    raise exception 'FAIL 8: message is not actionable: %', msg;
  end if;

  select count(*) into n from public.fixed_assets where id = 'aaaaaaaa-0000-0000-0000-0000001584f1' and cost = 80000;
  if n <> 1 then raise exception 'FAIL: the locked asset changed anyway'; end if;
  select count(*) into n from public.opening_balances where tenant_id = 'aaaaaaaa-0000-0000-0000-000000158401' and owner_capital = 100000;
  if n <> 1 then raise exception 'FAIL: the opening balances changed anyway'; end if;
end $$;

-- 9. Lock removed → allowed
reset role;
update public.tenants set books_locked_until = null where id = 'aaaaaaaa-0000-0000-0000-000000158401';
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000001584a1', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  update public.fixed_assets set cost = 81000 where id = 'aaaaaaaa-0000-0000-0000-0000001584f1';
  update public.reimbursements set amount = 950 where id = 'aaaaaaaa-0000-0000-0000-000000158481';
  update public.balance_sheet_items set amount = 26000 where id = 'aaaaaaaa-0000-0000-0000-000000158491';
  perform public.set_opening_balances('2026-03-31', 110000, 20000, null);
  select count(*) into n from public.opening_balances where tenant_id = 'aaaaaaaa-0000-0000-0000-000000158401' and owner_capital = 110000;
  if n <> 1 then raise exception 'FAIL 9: still locked after the lock was cleared'; end if;
end $$;

select 'r1584_books_lock_more_tables: all assertions passed' as result;
rollback;
