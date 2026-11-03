-- R-2428 — set a salary record to the amount actually paid (loss of pay), and no salary after
-- the last working day.
-- Migration: 20261103192246_r2428_salary_lop_adjust.sql
--
-- Owner's case (staging Anutech, 3 Nov): a ₹24,358 salary record; the full & final of ₹19,056
-- was paid from the bank and linked → "partially paid", ₹5,302 falsely still owed. This file
-- FAILS without the migration (adjust_salary_lop does not exist) and PASSES with it.
--
--   1. A sales login cannot adjust a salary (42501).
--   2. A reason is required.
--   3. LOP that would take the net below what the bank already paid is refused.
--   4. LOP ₹5,302 → net ₹19,056 = paid → status paid, reconciled to the F&F line, Salaries
--      expense = ₹19,056, reason kept in the notes.
--   5. A fully paid record is refused (nothing owed).
--   6. An unpaid record: LOP lowers the net and the expense; status stays unpaid.
--   7. After Start exit (last day 16 Apr), a May salary is refused (R-1896 guard still holds).
--
-- Run: docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2428_salary_lop_adjust.test.sql
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2428000-0000-0000-0000-0000000000a1', 'r2428-owner@example.test'),
  ('c2428000-0000-0000-0000-0000000000a2', 'r2428-sales@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c2428000-0000-0000-0000-0000000000f0', 'R2428 T', 'r2428@example.test', '07', 'R2428');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2428000-0000-0000-0000-0000000000a1', 'c2428000-0000-0000-0000-0000000000f0', 'r2428-owner@example.test', 'R2428 Owner', 'owner', true),
  ('c2428000-0000-0000-0000-0000000000a2', 'c2428000-0000-0000-0000-0000000000f0', 'r2428-sales@example.test', 'R2428 Sales', 'sales', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('c2428000-0000-4000-8000-0000000000b1', 'c2428000-0000-0000-0000-0000000000f0', 'HDFC', 'HDFC', 'current', 500000, '2026-04-01');

insert into public.employees (id, tenant_id, name, monthly_gross, joining_date) values
  ('c2428000-0000-4000-8000-0000000000e1', 'c2428000-0000-0000-0000-0000000000f0', 'R2428 Keshav', 24358, '2026-04-01'),
  ('c2428000-0000-4000-8000-0000000000e2', 'c2428000-0000-0000-0000-0000000000f0', 'R2428 Asha',   30000, '2025-01-01');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('c2428000-0000-4000-8000-0000000000d1', 'c2428000-0000-0000-0000-0000000000f0', 'c2428000-0000-4000-8000-0000000000b1',
   '2026-04-16', '50100508749370-TPT-FULL N FINAL SALARY-R2428 KESHAV', 19056, 0, 'csv_upload');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c2428000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

-- The two salary records, booked the Payroll way.
select public.pay_salary('c2428000-0000-4000-8000-0000000000e1', '2026-04', '2026-04-16', 24358, 0, 0, 0, null, 0, 0, 0, 0,
                         'c2428000-0000-4000-8000-0000000000b1', null);
select public.pay_salary('c2428000-0000-4000-8000-0000000000e2', '2026-04', '2026-04-30', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                         'c2428000-0000-4000-8000-0000000000b1', null);

-- The F&F line is linked to Keshav's April record → partial (₹5,302 "still owed").
reset role;
update public.bank_transactions
   set matched_to_type = 'salary',
       matched_to_id = (select id::text from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e1' and period = '2026-04')
 where id = 'c2428000-0000-4000-8000-0000000000d1';
set local role authenticated;

do $$
declare v_sal public.salary_payments;
begin
  select * into v_sal from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e1' and period = '2026-04';
  if v_sal.paid_status <> 'partial' or v_sal.paid_amount <> 19056 or v_sal.net <> 24358 then
    raise exception 'SETUP: expected partial 19056 of 24358, got % % of %', v_sal.paid_status, v_sal.paid_amount, v_sal.net;
  end if;
end $$;

-- ── 1. A sales login is refused ─────────────────────────────────────────────────────
do $$
declare v_refused boolean := false; v_id uuid;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e1' and period = '2026-04';
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2428000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    perform public.adjust_salary_lop(v_id, 5, 5302, 'left mid month');
  exception when insufficient_privilege then v_refused := true;
  end;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2428000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  if not v_refused then raise exception 'FAIL 1: a sales login could adjust a salary'; end if;
  raise notice 'PASS 1: sales refused';
end $$;

-- ── 2. Reason required ───────────────────────────────────────────────────────────────
do $$
declare v_refused boolean := false; v_msg text; v_id uuid;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e1' and period = '2026-04';
  begin
    perform public.adjust_salary_lop(v_id, 5, 5302, '  ');
  exception when others then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like 'Say why%' then raise exception 'FAIL 2: no reason accepted (msg %)', v_msg; end if;
  raise notice 'PASS 2: reason required';
end $$;

-- ── 3. Not below what the bank paid ─────────────────────────────────────────────────
do $$
declare v_refused boolean := false; v_msg text; v_id uuid;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e1' and period = '2026-04';
  begin
    perform public.adjust_salary_lop(v_id, 6, 6000, 'too much LOP');
  exception when others then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like 'The bank has already paid ₹19056%' then
    raise exception 'FAIL 3: net below paid accepted (msg %)', v_msg;
  end if;
  raise notice 'PASS 3: net cannot go below what was paid';
end $$;

-- ── 4. Owner's case: LOP ₹5,302 → paid in full ──────────────────────────────────────
do $$
declare v_sal public.salary_payments; v_exp integer; v_res jsonb;
begin
  select * into v_sal from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e1' and period = '2026-04';
  v_res := public.adjust_salary_lop(v_sal.id, 6.5, 5302, 'Left mid-April — full & final paid');
  select * into v_sal from public.salary_payments where id = v_sal.id;
  select amount into v_exp from public.expenses where id = v_sal.expense_id;
  if v_sal.net <> 19056 or v_sal.lop_amount <> 5302 or v_sal.lop_days <> 6.5 then
    raise exception 'FAIL 4a: net % lop % days %', v_sal.net, v_sal.lop_amount, v_sal.lop_days;
  end if;
  if v_sal.paid_status <> 'paid' or v_sal.reconciled_txn_id is distinct from 'c2428000-0000-4000-8000-0000000000d1'::uuid then
    raise exception 'FAIL 4b: status % txn %', v_sal.paid_status, v_sal.reconciled_txn_id;
  end if;
  if v_exp <> 19056 then raise exception 'FAIL 4c: Salaries expense % (want 19056)', v_exp; end if;
  if v_sal.notes not like '%Left mid-April — full & final paid%' then raise exception 'FAIL 4d: reason not kept (%).', v_sal.notes; end if;
  if (v_res->>'paid_status') <> 'paid' then raise exception 'FAIL 4e: result %', v_res; end if;
  raise notice 'PASS 4: net = amount paid, paid, expense follows, reason kept';
end $$;

-- ── 5. A fully paid record is refused ───────────────────────────────────────────────
do $$
declare v_refused boolean := false; v_msg text; v_id uuid;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e1' and period = '2026-04';
  begin
    perform public.adjust_salary_lop(v_id, 0, 0, 'undo the LOP');
  exception when others then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like '%already fully paid%' then raise exception 'FAIL 5: paid record changed (msg %)', v_msg; end if;
  raise notice 'PASS 5: fully paid record refused';
end $$;

-- ── 6. Unpaid record: LOP lowers net + expense, stays unpaid ────────────────────────
do $$
declare v_sal public.salary_payments; v_exp integer;
begin
  select * into v_sal from public.salary_payments where employee_id = 'c2428000-0000-4000-8000-0000000000e2' and period = '2026-04';
  perform public.adjust_salary_lop(v_sal.id, 2, 2000, 'Two days absent');
  select * into v_sal from public.salary_payments where id = v_sal.id;
  select amount into v_exp from public.expenses where id = v_sal.expense_id;
  if v_sal.net <> 28000 or v_sal.paid_status <> 'unpaid' or v_exp <> 28000 then
    raise exception 'FAIL 6: net % status % expense %', v_sal.net, v_sal.paid_status, v_exp;
  end if;
  raise notice 'PASS 6: unpaid record adjusted';
end $$;

-- ── 7. After Start exit, no salary for a later month ────────────────────────────────
do $$
declare v_refused boolean := false; v_msg text;
begin
  perform public.start_employee_exit('c2428000-0000-4000-8000-0000000000e1', '2026-04-16', 'resigned');
  begin
    perform public.pay_salary('c2428000-0000-4000-8000-0000000000e1', '2026-05', '2026-06-01', 24358, 0, 0, 0, null, 0, 0, 0, 0,
                              'c2428000-0000-4000-8000-0000000000b1', null);
  exception when others then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like '%no salary after Apr 2026%' then raise exception 'FAIL 7: May salary after exit (msg %)', v_msg; end if;
  raise notice 'PASS 7: no salary after the last working day';
end $$;

select 'PASS r2428_salary_lop_adjust' as result;

rollback;
