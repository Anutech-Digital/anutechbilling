-- R-1839 (Pardeep, 24 Oct 2026): a bank debit to an employee can be an INCENTIVE / bonus.
-- book_bank_txn_as_incentive books it through payroll — salary for TDS / payslip / Form 16,
-- a Salaries expense on the P&L — never drawings, never a plain expense.
--
-- Self-asserting, ONE transaction, rolled back:
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1839_incentive_from_bank.test.sql
-- Before the migration is applied: begin; <r1839 migration without begin/commit> <this test without begin/rollback> rollback;
--
-- Proves:
--   1. (a) Ravi has a September salary (gross 30,000, paid): a ₹5,000 line with ₹500 TDS adds
--      incentive 5,500, TDS 500, net +5,000 to THAT record; the month's Salaries expense is
--      35,500; the line is linked (paid in full again).
--   2. (b) Sita has no October salary: a ₹8,000 line makes a one-off payroll record (gross 0,
--      incentive 8,000, net 8,000, paid) with its Salaries expense.
--   3. the register (salary_payments) incentive total = 13,500; report_pnl Salaries for Sep–Oct
--      went up by exactly 13,500 (5,500 + 8,000).
--   4. sales refused (42501); a money-in line refused; another company's employee refused;
--      a line already reconciled refused.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1839100-0000-4000-8000-0000000000' || k)::uuid, 'r1839i-' || k || '@example.test'
  from unnest(array['01','02','03']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1839100-0000-0000-0000-0000000000f1', 'R1839I Co',  'r1839i@example.in',  '07', 'Delhi', 'R street, Delhi', 'R39I', '07AAACR1839R1Z4', 'registered', 'proprietor'),
  ('e1839100-0000-0000-0000-0000000000f2', 'R1839I Two', 'r1839i2@example.in', '07', 'Delhi', 'R street, Delhi', 'R39J', '07AAACR1839R1Z5', 'registered', 'proprietor');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1839100-0000-4000-8000-000000000001', 'e1839100-0000-0000-0000-0000000000f1', 'r1839i-01@example.in', 'Owner', 'owner', true),
  ('e1839100-0000-4000-8000-000000000002', 'e1839100-0000-0000-0000-0000000000f1', 'r1839i-02@example.in', 'Sales', 'sales', true),
  ('e1839100-0000-4000-8000-000000000003', 'e1839100-0000-0000-0000-0000000000f2', 'r1839i-03@example.in', 'Other', 'owner', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e1839100-0000-4000-8000-0000000000a1', 'e1839100-0000-0000-0000-0000000000f1', 'HDFC', 'HDFC', 'current', 500000, '2026-04-01');

insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('e1839100-0000-4000-8000-0000000000e1', 'e1839100-0000-0000-0000-0000000000f1', 'Ravi Kumar', 30000),
  ('e1839100-0000-4000-8000-0000000000e2', 'e1839100-0000-0000-0000-0000000000f1', 'Sita Devi',  25000),
  ('e1839100-0000-4000-8000-0000000000e9', 'e1839100-0000-0000-0000-0000000000f2', 'Other Emp',  20000);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('e1839100-0000-4000-8000-0000000000d0', 'e1839100-0000-0000-0000-0000000000f1', 'e1839100-0000-4000-8000-0000000000a1', '2026-10-01', 'SALARY SEP RAVI',      30000, 0, 'csv_upload'),
  ('e1839100-0000-4000-8000-0000000000d1', 'e1839100-0000-0000-0000-0000000000f1', 'e1839100-0000-4000-8000-0000000000a1', '2026-10-05', 'INCENTIVE RAVI',        5000, 0, 'csv_upload'),
  ('e1839100-0000-4000-8000-0000000000d2', 'e1839100-0000-0000-0000-0000000000f1', 'e1839100-0000-4000-8000-0000000000a1', '2026-10-20', 'BONUS SITA',            8000, 0, 'csv_upload'),
  ('e1839100-0000-4000-8000-0000000000d3', 'e1839100-0000-0000-0000-0000000000f1', 'e1839100-0000-4000-8000-0000000000a1', '2026-10-21', 'NEFT IN',               0, 9000, 'csv_upload'),
  ('e1839100-0000-4000-8000-0000000000d4', 'e1839100-0000-0000-0000-0000000000f1', 'e1839100-0000-4000-8000-0000000000a1', '2026-10-22', 'IMPS OUT',              700, 0, 'csv_upload');

create temp table r1839i_res (k text primary key, v text);
grant all on r1839i_res to authenticated, service_role;
create function pg_temp.r1839i_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1839100-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1839i_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql; return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1839i_salaries() returns bigint language sql as $$
  select coalesce(sum((g->>'amount')::bigint), 0)
    from public.report_pnl('2026-09-01', '2026-10-31') r, jsonb_array_elements(r.unassigned_by_category) g
   where g->>'category' = 'Salaries';
$$;

-- Ravi's September salary, booked and paid the normal way (Payroll + reconcile).
select pg_temp.r1839i_as('01');
insert into r1839i_res select 'sal', public.pay_salary('e1839100-0000-4000-8000-0000000000e1', '2026-09', '2026-10-01', 30000, 0, 0, 0, null, 0, 0, 0, 0,
  'e1839100-0000-4000-8000-0000000000a1', null, 0, 0, 0, null)::text;
select public.reconcile_bank_txn('e1839100-0000-4000-8000-0000000000d0', 'salary', (select v from r1839i_res where k = 'sal'), 'manual');
insert into r1839i_res select 'pnl_before', pg_temp.r1839i_salaries()::text;

-- 4. refusals first (nothing may change)
select pg_temp.r1839i_as('02');
insert into r1839i_res select 'sales', pg_temp.r1839i_err($q$select public.book_bank_txn_as_incentive('e1839100-0000-4000-8000-0000000000d1', 'e1839100-0000-4000-8000-0000000000e1', '2026-09', 500)$q$);
select pg_temp.r1839i_as('01');
insert into r1839i_res select 'credit', pg_temp.r1839i_err($q$select public.book_bank_txn_as_incentive('e1839100-0000-4000-8000-0000000000d3', 'e1839100-0000-4000-8000-0000000000e1', '2026-09')$q$);
insert into r1839i_res select 'otheremp', pg_temp.r1839i_err($q$select public.book_bank_txn_as_incentive('e1839100-0000-4000-8000-0000000000d4', 'e1839100-0000-4000-8000-0000000000e9', '2026-10')$q$);
insert into r1839i_res select 'matched', pg_temp.r1839i_err($q$select public.book_bank_txn_as_incentive('e1839100-0000-4000-8000-0000000000d0', 'e1839100-0000-4000-8000-0000000000e1', '2026-09')$q$);
insert into r1839i_res select 'badmonth', pg_temp.r1839i_err($q$select public.book_bank_txn_as_incentive('e1839100-0000-4000-8000-0000000000d4', 'e1839100-0000-4000-8000-0000000000e1', 'Sept')$q$);
do $$ begin
  if (select v from r1839i_res where k = 'sales')    not like '42501:%' then raise exception 'FAIL 4a sales: %', (select v from r1839i_res where k = 'sales'); end if;
  if (select v from r1839i_res where k = 'credit')   not like '%money-out%' then raise exception 'FAIL 4b credit: %', (select v from r1839i_res where k = 'credit'); end if;
  if (select v from r1839i_res where k = 'otheremp') not like '%not in your company%' then raise exception 'FAIL 4c other employee: %', (select v from r1839i_res where k = 'otheremp'); end if;
  if (select v from r1839i_res where k = 'matched')  not like '%already reconciled%' then raise exception 'FAIL 4d matched: %', (select v from r1839i_res where k = 'matched'); end if;
  if (select v from r1839i_res where k = 'badmonth') not like '%month%' then raise exception 'FAIL 4e month: %', (select v from r1839i_res where k = 'badmonth'); end if;
  if (select incentive from public.salary_payments where id = (select v::uuid from r1839i_res where k = 'sal')) <> 0 then raise exception 'FAIL 4f a refusal changed the salary'; end if;
end $$;

-- 1. (a) Ravi: ₹5,000 paid, ₹500 TDS → added to September
insert into r1839i_res select 'a', public.book_bank_txn_as_incentive('e1839100-0000-4000-8000-0000000000d1', 'e1839100-0000-4000-8000-0000000000e1', '2026-09', 500)::text;
do $$
declare v_sp public.salary_payments;
begin
  select * into v_sp from public.salary_payments where id = (select v::uuid from r1839i_res where k = 'sal');
  if v_sp.incentive <> 5500 or v_sp.tds <> 500 or v_sp.net <> 35000 or v_sp.gross <> 30000 then raise exception 'FAIL 1a salary %', row_to_json(v_sp); end if;
  if v_sp.paid_amount <> 35000 or v_sp.paid_status <> 'paid' then raise exception 'FAIL 1b paid % %', v_sp.paid_amount, v_sp.paid_status; end if;
  if (select amount from public.expenses where id = v_sp.expense_id) <> 35500 then raise exception 'FAIL 1c Salaries expense %', (select amount from public.expenses where id = v_sp.expense_id); end if;
  if (select category from public.expenses where id = v_sp.expense_id) <> 'Salaries' then raise exception 'FAIL 1d category'; end if;
  if (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = 'e1839100-0000-4000-8000-0000000000d1') <> 'salary:' || v_sp.id then raise exception 'FAIL 1e line not linked'; end if;
  if ((select v from r1839i_res where k = 'a')::jsonb)->>'mode' <> 'added_to_month' then raise exception 'FAIL 1f mode'; end if;
  if (select count(*) from public.salary_payments where employee_id = 'e1839100-0000-4000-8000-0000000000e1') <> 1 then raise exception 'FAIL 1g second record'; end if;
end $$;

-- 2. (b) Sita: no October salary → one-off payroll record
insert into r1839i_res select 'b', public.book_bank_txn_as_incentive('e1839100-0000-4000-8000-0000000000d2', 'e1839100-0000-4000-8000-0000000000e2', '2026-10', 0)::text;
do $$
declare v_sp public.salary_payments;
begin
  select * into v_sp from public.salary_payments where id = (((select v from r1839i_res where k = 'b')::jsonb)->>'salary_id')::uuid;
  if v_sp.employee_id <> 'e1839100-0000-4000-8000-0000000000e2' or v_sp.period <> '2026-10' or v_sp.gross <> 0 or v_sp.incentive <> 8000 or v_sp.net <> 8000 then
    raise exception 'FAIL 2a one-off %', row_to_json(v_sp);
  end if;
  if v_sp.paid_status <> 'paid' then raise exception 'FAIL 2b status %', v_sp.paid_status; end if;
  if (select category || amount from public.expenses where id = v_sp.expense_id) <> 'Salaries8000' then raise exception 'FAIL 2c expense'; end if;
  if ((select v from r1839i_res where k = 'b')::jsonb)->>'mode' <> 'one_off' then raise exception 'FAIL 2d mode'; end if;
end $$;

-- 3. register total + P&L
do $$ begin
  if (select sum(incentive) from public.salary_payments where tenant_id = 'e1839100-0000-0000-0000-0000000000f1') <> 13500 then raise exception 'FAIL 3a register incentive total'; end if;
  if pg_temp.r1839i_salaries() - (select v::bigint from r1839i_res where k = 'pnl_before') <> 13500 then
    raise exception 'FAIL 3b P&L Salaries moved by % (want 13500)', pg_temp.r1839i_salaries() - (select v::bigint from r1839i_res where k = 'pnl_before');
  end if;
  if exists (select 1 from public.owner_equity_movements where tenant_id = 'e1839100-0000-0000-0000-0000000000f1') then raise exception 'FAIL 3c booked as drawings'; end if;
end $$;

select 'PASS r1839 incentive' as result;

rollback;
