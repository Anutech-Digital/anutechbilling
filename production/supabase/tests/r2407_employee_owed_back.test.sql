-- R-2407 (Pardeep, 3 Nov 2026): money an employee paid to the company by mistake, returned later
-- with her salary. Staging 4523, 26 Oct: UPI Neelam ₹16,000 in; her salary payout then carried
-- the ₹16,000 back. Before this card the Reconcile sheet had no right place for either line.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r2407_employee_owed_back.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r2407 migration> <this test> rollback;
-- Expect "PASS r2407". Without the migration it is red ('owed_back' is not a kind; no
-- reconcile_salary_with_owed_back).
--
-- Proves (the owner's case: ₹16,000 in from Neelam, no open advance; salary ₹30,000 paid as ₹46,000):
--   1. the ₹16,000 money-in line booked as "owed back to Neelam" → a pending payable to Neelam
--      (reimbursements, no expense), line reconciled, P&L unchanged, Balance Sheet
--      reimbursements payable +₹16,000.
--   2. un-reconciling that line removes the payable; booking it again brings it back.
--   3. her ₹46,000 salary payout → salary ₹30,000 paid in full + the ₹16,000 payable settled, in
--      one line: payable back to its old figure, salary paid_amount 30,000, P&L expenses the same
--      as before the payout (no extra salary expense).
--   4. un-reconciling the payout → salary unpaid again and the ₹16,000 owed again; un-reconciling
--      the money-in line while the payable is already paid back is refused.
--   5. refusals: sales (42501), no company (28000), another company's line / salary / payable,
--      a money-out line booked as owed back, a name that is no employee, a payout whose salary
--      part is more than what is due, a payable of another employee, an already settled
--      payable, an already reconciled line. Nothing saved by a refusal.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e2407000-0000-4000-8000-0000000000' || k)::uuid, 'r2407-' || k || '@example.test'
  from unnest(array['01','02','03','05']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration) values
  ('e2407000-0000-0000-0000-0000000000f1', 'R2407 Co',    'r2407a@example.in', '07', 'Delhi', 'R street, Delhi', 'R07A', '07AAACR2407R1Z1', 'registered'),
  ('e2407000-0000-0000-0000-0000000000f2', 'R2407 Other', 'r2407b@example.in', '07', 'Delhi', 'R street, Delhi', 'R07B', '07AAACR2407R1Z2', 'registered');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2407000-0000-4000-8000-000000000001', 'e2407000-0000-0000-0000-0000000000f1', 'r2407-01@example.in', 'Owner',      'owner', true),
  ('e2407000-0000-4000-8000-000000000002', 'e2407000-0000-0000-0000-0000000000f1', 'r2407-02@example.in', 'Sales',      'sales', true),
  ('e2407000-0000-4000-8000-000000000003', 'e2407000-0000-0000-0000-0000000000f2', 'r2407-03@example.in', 'Other own',  'owner', true),
  ('e2407000-0000-4000-8000-000000000005', 'e2407000-0000-0000-0000-0000000000f1', 'r2407-05@example.in', 'Accountant', 'accountant', true);

insert into public.employees (id, tenant_id, name, is_active) values
  ('e2407000-0000-4000-8000-0000000000e1', 'e2407000-0000-0000-0000-0000000000f1', 'Neelam Sharma', true),
  ('e2407000-0000-4000-8000-0000000000e2', 'e2407000-0000-0000-0000-0000000000f1', 'Ravi Verma',    true),
  ('e2407000-0000-4000-8000-0000000000e9', 'e2407000-0000-0000-0000-0000000000f2', 'Other Person',  true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e2407000-0000-4000-8000-0000000000a1', 'e2407000-0000-0000-0000-0000000000f1', 'HDFC Current', 'HDFC', 'current', 100000, '2026-04-01'),
  ('e2407000-0000-4000-8000-0000000000b1', 'e2407000-0000-0000-0000-0000000000f2', 'Other Bank',   'SBI',  'current', 100000, '2026-04-01');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('e2407000-0000-4000-8000-0000000000d1', 'e2407000-0000-0000-0000-0000000000f1', 'e2407000-0000-4000-8000-0000000000a1', '2026-10-26', 'UPI/NEELAM SHARMA/PAID BY MISTAKE', 0, 16000, 'csv_upload'),
  ('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-0000-0000-0000000000f1', 'e2407000-0000-4000-8000-0000000000a1', '2026-11-01', 'NEFT SALARY NEELAM SHARMA OCT',        46000, 0, 'csv_upload'),
  ('e2407000-0000-4000-8000-0000000000d3', 'e2407000-0000-0000-0000-0000000000f1', 'e2407000-0000-4000-8000-0000000000a1', '2026-11-01', 'NEFT SALARY RAVI VERMA OCT',           60000, 0, 'csv_upload'),
  ('e2407000-0000-4000-8000-0000000000d9', 'e2407000-0000-0000-0000-0000000000f2', 'e2407000-0000-4000-8000-0000000000b1', '2026-10-26', 'OTHER CO',                             0, 16000, 'csv_upload');

insert into public.salary_payments (id, tenant_id, employee_id, period, gross, net, pay_date, paid_status, paid_amount) values
  ('e2407000-0000-4000-8000-0000000000c1', 'e2407000-0000-0000-0000-0000000000f1', 'e2407000-0000-4000-8000-0000000000e1', '2026-10', 30000, 30000, '2026-10-31', 'unpaid', 0),
  ('e2407000-0000-4000-8000-0000000000c2', 'e2407000-0000-0000-0000-0000000000f1', 'e2407000-0000-4000-8000-0000000000e2', '2026-10', 40000, 40000, '2026-10-31', 'unpaid', 0),
  ('e2407000-0000-4000-8000-0000000000c9', 'e2407000-0000-0000-0000-0000000000f2', 'e2407000-0000-4000-8000-0000000000e9', '2026-10', 30000, 30000, '2026-10-31', 'unpaid', 0);

create temp table r2407_res (k text primary key, v text);
grant all on r2407_res to authenticated, service_role;

create function pg_temp.r2407_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e2407000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r2407_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r2407_pnl_exp() returns bigint language sql as $$
  select coalesce(sum((g->>'amount')::bigint), 0)
    from public.report_pnl('2026-04-01', '2027-03-31') r, jsonb_array_elements(r.expense_groups) g;
$$;
create function pg_temp.r2407_payable() returns bigint language sql as $$
  select reimbursements_payable from public.report_balance_sheet('2027-03-31');
$$;
create function pg_temp.r2407_owed() returns public.reimbursements language sql as $$
  select * from public.reimbursements
   where tenant_id = 'e2407000-0000-0000-0000-0000000000f1' and person_name = 'Neelam Sharma'
   order by created_at desc limit 1;
$$;

select pg_temp.r2407_as('01');
insert into r2407_res select 'pnl0', pg_temp.r2407_pnl_exp()::text;
insert into r2407_res select 'pay0', pg_temp.r2407_payable()::text;

-- 1. ₹16,000 in from Neelam (no open advance) → owed back to Neelam
insert into r2407_res select 'owed', public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d1', 'owed_back', 'Neelam Sharma')::text;
do $$
declare v_r public.reimbursements := pg_temp.r2407_owed(); v_t public.bank_transactions;
begin
  select * into v_t from public.bank_transactions where id = 'e2407000-0000-4000-8000-0000000000d1';
  if v_r.id is null or v_r.amount <> 16000 or v_r.status <> 'pending' or v_r.expense_id is not null
     or v_r.employee_id <> 'e2407000-0000-4000-8000-0000000000e1' or v_r.incurred_on <> '2026-10-26' or coalesce(v_r.gst_paid, 0) <> 0 then
    raise exception 'FAIL 1a payable %', row_to_json(v_r); end if;
  -- R-2570: its own type now ('reimbursement'), same id shape.
  if v_t.matched_to_type <> 'reimbursement' or v_t.matched_to_id <> 'reimbursement:' || v_r.id::text then
    raise exception 'FAIL 1b line %', row_to_json(v_t); end if;
  if not exists (select 1 from public.employee_advance_bank_links where bank_txn_id = v_t.id and kind = 'owed_back'
                  and reimbursement_id = v_r.id and advance_id is null and amount = 16000) then
    raise exception 'FAIL 1c link'; end if;
  if pg_temp.r2407_pnl_exp()::text <> (select v from r2407_res where k = 'pnl0') then raise exception 'FAIL 1d owed back hit the P&L'; end if;
  if pg_temp.r2407_payable() <> (select v::bigint from r2407_res where k = 'pay0') + 16000 then
    raise exception 'FAIL 1e balance sheet payable % vs %', pg_temp.r2407_payable(), (select v from r2407_res where k = 'pay0'); end if;
  if (select v::jsonb->>'kind' from r2407_res where k = 'owed') <> 'owed_back'
     or (select (v::jsonb->>'reimbursement_id')::uuid from r2407_res where k = 'owed') <> v_r.id then
    raise exception 'FAIL 1f result %', (select v from r2407_res where k = 'owed'); end if;
end $$;

-- 2. un-reconcile removes the payable; book again
select public.reconcile_bank_txn('e2407000-0000-4000-8000-0000000000d1', null, null, null);
do $$
begin
  if exists (select 1 from public.reimbursements where tenant_id = 'e2407000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL 2a payable still there after un-reconcile'; end if;
  if exists (select 1 from public.employee_advance_bank_links where bank_txn_id = 'e2407000-0000-4000-8000-0000000000d1') then
    raise exception 'FAIL 2b link still there'; end if;
  if pg_temp.r2407_payable() <> (select v::bigint from r2407_res where k = 'pay0') then raise exception 'FAIL 2c payable figure'; end if;
end $$;
select pg_temp.r2407_as('05');   -- the accountant books it this time
select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d1', 'owed_back', '  neelam sharma ');
do $$
begin
  if (pg_temp.r2407_owed()).amount is distinct from 16000 or (pg_temp.r2407_owed()).person_name <> 'Neelam Sharma' then
    raise exception 'FAIL 2d booked again %', row_to_json(pg_temp.r2407_owed()); end if;
end $$;
select pg_temp.r2407_as('01');

-- 5a. refusals on the money-in side (nothing saved)
insert into r2407_res select 'cnt0', (select count(*)::text from public.reimbursements where tenant_id = 'e2407000-0000-0000-0000-0000000000f1');
do $$
declare v text;
begin
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d1', 'owed_back', 'Neelam Sharma')$q$);
  if v not like '%already reconciled%' then raise exception 'FAIL 5a1 reconciled line: %', v; end if;
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d2', 'owed_back', 'Neelam Sharma')$q$);
  if v not like '%money-in%' then raise exception 'FAIL 5a2 money-out line: %', v; end if;
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d9', 'owed_back', 'Other Person')$q$);
  if v not like '%not found in your company%' then raise exception 'FAIL 5a3 other company line: %', v; end if;
end $$;
-- another free money-in line to test the name / role refusals on
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('e2407000-0000-4000-8000-0000000000d4', 'e2407000-0000-0000-0000-0000000000f1', 'e2407000-0000-4000-8000-0000000000a1', '2026-10-27', 'UPI/SOMEONE', 0, 500, 'csv_upload');
do $$
declare v text;
begin
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'owed_back', 'Other Person')$q$);
  if v not like '%not an employee%' then raise exception 'FAIL 5a4 another company''s employee: %', v; end if;
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'owed_back', null)$q$);
  if v not like '%Pick the employee%' then raise exception 'FAIL 5a5 no name: %', v; end if;
  perform pg_temp.r2407_as('02');
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'owed_back', 'Ravi Verma')$q$);
  if v not like '42501%' then raise exception 'FAIL 5a6 sales: %', v; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e2407000-0000-4000-8000-0000000000ff')::text, true);
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'owed_back', 'Ravi Verma')$q$);
  if v not like '28000%' then raise exception 'FAIL 5a7 no company: %', v; end if;
  perform pg_temp.r2407_as('01');
  if (select count(*)::text from public.reimbursements where tenant_id = 'e2407000-0000-0000-0000-0000000000f1') <> (select r.v from r2407_res r where r.k = 'cnt0') then
    raise exception 'FAIL 5a8 a refusal saved a payable'; end if;
  if (select matched_to_type from public.bank_transactions where id = 'e2407000-0000-4000-8000-0000000000d4') is not null then
    raise exception 'FAIL 5a9 a refusal reconciled the line'; end if;
end $$;

-- 3. salary payout ₹46,000 = salary ₹30,000 + ₹16,000 owed back
insert into r2407_res select 'pnl1', pg_temp.r2407_pnl_exp()::text;
insert into r2407_res select 'pay1', pg_temp.r2407_payable()::text;
insert into r2407_res select 'rid', (pg_temp.r2407_owed()).id::text;

-- 5b. refusals on the payout side first (nothing saved)
do $$
declare v text; v_rid text := (select r.v from r2407_res r where r.k = 'rid');
begin
  -- Ravi's salary + Neelam's payable → another employee's payable
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d3', 'e2407000-0000-4000-8000-0000000000c2', %L)$q$, v_rid));
  if v not like '%owed to Neelam Sharma, not to Ravi Verma%' then raise exception 'FAIL 5b1 other employee: %', v; end if;
  -- salary part more than due: ₹60,000 − ₹16,000 = ₹44,000 > ₹30,000 due
  update public.bank_transactions set debit = 60000 where id = 'e2407000-0000-4000-8000-0000000000d2';
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c1', %L)$q$, v_rid));
  if v not like '%more than the ₹30000 still due%' then raise exception 'FAIL 5b2 too much: %', v; end if;
  update public.bank_transactions set debit = 46000 where id = 'e2407000-0000-4000-8000-0000000000d2';
  -- another company's salary
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c9', %L)$q$, v_rid));
  if v not like '%Salary not found in your company%' then raise exception 'FAIL 5b3 other company salary: %', v; end if;
  -- a money-in line
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d4', 'e2407000-0000-4000-8000-0000000000c1', %L)$q$, v_rid));
  if v not like '%money-out%' then raise exception 'FAIL 5b4 money-in line: %', v; end if;
  -- sales / no company
  perform pg_temp.r2407_as('02');
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c1', %L)$q$, v_rid));
  if v not like '42501%' then raise exception 'FAIL 5b5 sales: %', v; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e2407000-0000-4000-8000-0000000000ff')::text, true);
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c1', %L)$q$, v_rid));
  if v not like '28000%' then raise exception 'FAIL 5b6 no company: %', v; end if;
  -- the other company's owner cannot reach this company's line / payable
  perform pg_temp.r2407_as('03');
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c9', %L)$q$, v_rid));
  if v not like '%Bank line not found in your company%' then raise exception 'FAIL 5b7 other company owner: %', v; end if;
  perform pg_temp.r2407_as('01');
  if (select paid_amount from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 0
     or (select status from public.reimbursements where id = v_rid::uuid) <> 'pending'
     or (select matched_to_type from public.bank_transactions where id = 'e2407000-0000-4000-8000-0000000000d2') is not null then
    raise exception 'FAIL 5b8 a refusal saved something'; end if;
end $$;

select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c1',
                                              (select v::uuid from r2407_res where k = 'rid'));
do $$
declare v_s public.salary_payments; v_r public.reimbursements; v_t public.bank_transactions;
begin
  select * into v_s from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1';
  select * into v_r from public.reimbursements where id = (select v::uuid from r2407_res where k = 'rid');
  select * into v_t from public.bank_transactions where id = 'e2407000-0000-4000-8000-0000000000d2';
  if v_s.paid_amount <> 30000 or v_s.paid_status <> 'paid' or v_s.reconciled_txn_id <> v_t.id then
    raise exception 'FAIL 3a salary %', row_to_json(v_s); end if;
  if v_r.status <> 'settled' or v_r.settled_on <> '2026-11-01' then raise exception 'FAIL 3b payable %', row_to_json(v_r); end if;
  if v_t.matched_to_type <> 'split' or v_t.matched_to_id is not null then raise exception 'FAIL 3c line %', row_to_json(v_t); end if;
  if pg_temp.r2407_payable() <> (select v::bigint from r2407_res where k = 'pay0') then
    raise exception 'FAIL 3d payable not back to 0: %', pg_temp.r2407_payable(); end if;
  if pg_temp.r2407_pnl_exp()::text <> (select v from r2407_res where k = 'pnl1') then
    raise exception 'FAIL 3e P&L expenses moved: % vs %', pg_temp.r2407_pnl_exp(), (select v from r2407_res where k = 'pnl1'); end if;
  if not exists (select 1 from public.employee_advance_bank_links where bank_txn_id = v_t.id and kind = 'reimburse'
                  and reimbursement_id = v_r.id and amount = 16000) then raise exception 'FAIL 3f link'; end if;
end $$;

-- 4. un-reconciling the money-in line now is refused (already paid back)
do $$
declare v text;
begin
  v := pg_temp.r2407_err($q$select public.reconcile_bank_txn('e2407000-0000-4000-8000-0000000000d1', null, null, null)$q$);
  if v not like '%already paid back%' then raise exception 'FAIL 4a: %', v; end if;
  -- an already settled payable cannot be paid again
  v := pg_temp.r2407_err(format($q$select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d3', 'e2407000-0000-4000-8000-0000000000c1', %L)$q$,
                                (select r.v from r2407_res r where r.k = 'rid')));
  if v not like '%already paid%' then raise exception 'FAIL 4b settled payable: %', v; end if;
end $$;

-- un-reconciling the payout: salary unpaid, ₹16,000 owed again
select public.reconcile_bank_txn('e2407000-0000-4000-8000-0000000000d2', null, null, null);
do $$
begin
  if (select paid_amount from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 0
     or (select paid_status from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 'unpaid' then
    raise exception 'FAIL 4c salary not unpaid'; end if;
  if (select status from public.reimbursements where id = (select v::uuid from r2407_res where k = 'rid')) <> 'pending' then
    raise exception 'FAIL 4d payable not owed again'; end if;
  if pg_temp.r2407_payable() <> (select v::bigint from r2407_res where k = 'pay1') then raise exception 'FAIL 4e payable figure'; end if;
end $$;

-- existing R-1871 kinds still checked: a money-in line booked as reimbursement is refused
do $$
declare v text;
begin
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'nope', 'Ravi Verma')$q$);
  if v not like '%Pick what this line is%' then raise exception 'FAIL 5c bad kind: %', v; end if;
end $$;

-- 6. review fixes
-- 6a. booked by the employee's id (two people can share a name); its payable cannot be deleted on
--     the Reimbursements page — only by un-reconciling the bank line.
select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'owed_back', 'e2407000-0000-4000-8000-0000000000e2');
do $$
declare v text; v_rid uuid;
begin
  select id into v_rid from public.reimbursements where tenant_id = 'e2407000-0000-0000-0000-0000000000f1' and employee_id = 'e2407000-0000-4000-8000-0000000000e2';
  if v_rid is null or (select person_name from public.reimbursements where id = v_rid) <> 'Ravi Verma' then raise exception 'FAIL 6a1 booked by id'; end if;
  v := pg_temp.r2407_err(format('delete from public.reimbursements where id = %L', v_rid));
  if v not like '%Un-reconcile that bank line instead%' then raise exception 'FAIL 6a2 delete guard: %', v; end if;
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'owed_back', 'e2407000-0000-4000-8000-0000000000e9')$q$);
  if v not like '%already reconciled%' then raise exception 'FAIL 6a3: %', v; end if;
end $$;
select public.reconcile_bank_txn('e2407000-0000-4000-8000-0000000000d4', null, null, null);
do $$
begin
  if exists (select 1 from public.reimbursements where employee_id = 'e2407000-0000-4000-8000-0000000000e2') then
    raise exception 'FAIL 6a4 un-reconcile did not remove the payable'; end if;
end $$;
-- another company's employee id is not found
do $$
declare v text;
begin
  v := pg_temp.r2407_err($q$select public.book_bank_txn_as_employee_advance('e2407000-0000-4000-8000-0000000000d4', 'owed_back', 'e2407000-0000-4000-8000-0000000000e9')$q$);
  if v not like '%not an employee%' then raise exception 'FAIL 6a5 other company id: %', v; end if;
end $$;

-- 6b. a salary already part-paid by another line keeps that part when the salary + owed-back line
--     is un-reconciled or deleted.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('e2407000-0000-4000-8000-0000000000d6', 'e2407000-0000-0000-0000-0000000000f1', 'e2407000-0000-4000-8000-0000000000a1', '2026-10-31', 'NEFT SAL PART NEELAM', 10000, 0, 'csv_upload');
select public.reconcile_bank_txn('e2407000-0000-4000-8000-0000000000d6', 'salary', 'e2407000-0000-4000-8000-0000000000c1', 'manual');
update public.bank_transactions set debit = 36000 where id = 'e2407000-0000-4000-8000-0000000000d2';
select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c1',
                                              (select v::uuid from r2407_res where k = 'rid'));
do $$
begin
  if (select paid_amount from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 30000
     or (select paid_status from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 'paid' then
    raise exception 'FAIL 6b1 salary not paid in full'; end if;
end $$;
select public.reconcile_bank_txn('e2407000-0000-4000-8000-0000000000d2', null, null, null);
do $$
begin
  if (select paid_amount from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 10000
     or (select paid_status from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 'partial' then
    raise exception 'FAIL 6b2 earlier part payment lost: %', (select row_to_json(s) from public.salary_payments s where id = 'e2407000-0000-4000-8000-0000000000c1'); end if;
  if (select status from public.reimbursements where id = (select v::uuid from r2407_res where k = 'rid')) <> 'pending' then
    raise exception 'FAIL 6b3 payable not owed again'; end if;
end $$;
select public.reconcile_salary_with_owed_back('e2407000-0000-4000-8000-0000000000d2', 'e2407000-0000-4000-8000-0000000000c1',
                                              (select v::uuid from r2407_res where k = 'rid'));
delete from public.bank_transactions where id = 'e2407000-0000-4000-8000-0000000000d2';
do $$
begin
  if (select paid_amount from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1') <> 10000 then
    raise exception 'FAIL 6b4 deleting the line left its salary part paid: %', (select paid_amount from public.salary_payments where id = 'e2407000-0000-4000-8000-0000000000c1'); end if;
  if (select status from public.reimbursements where id = (select v::uuid from r2407_res where k = 'rid')) <> 'pending' then
    raise exception 'FAIL 6b5 payable not owed again after delete'; end if;
end $$;

select 'PASS r2407';
rollback;
