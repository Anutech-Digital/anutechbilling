-- R-2699 — salary revision / increment with an effective-from month, history, arrears.
-- Migration: 20261112182538_r2699_salary_revisions.sql
--
-- Owner's case (Excel owner, 12 Nov): ₹30,000 → ₹36,000 from Dec 2026 — Nov at the old salary,
-- Dec at the new one, history kept. A revision dated into already-paid months never changes
-- those months; it gives arrears paid once, with the next salary, in the paying month.
-- FAILS without the migration (revise_employee_salary does not exist), PASSES with it.
--
--   1. Sales login: cannot revise, cannot read revisions or arrears.
--   2. Owner path: revise Keshav 30k → 36k from Dec; employees row = 36k; in force Nov 30k, Dec 36k.
--   3. Refusals: same salary; on/before the latest revision; before the joining month;
--      Basic + DA above gross; zero gross.
--   4. Backdated: Asha paid Oct (full 30k) + Nov (LOP 15k); revised to 36k from Oct →
--      booked rows unchanged; arrears Oct 6,000 + Nov 3,000 = 9,000.
--   5. Dec salary with arrears 9,001 refused; with 9,000 → incentive 9,000, arrears 9,000,
--      net 45,000, Salaries expense 45,000 dated Dec; any more arrears refused; a backlog month
--      before the raise (Sep) cannot carry them.
--   6. Pay cut into a paid month refused. 6b. Gross edited after booking → arrears still from the
--      salary stored at booking (salary_payments.salary_in_force).
--   6c. Legacy rows (no stored salary): never more arrears than was underpaid. 6d. Exit month. 6e. Direct
--      edits of gross / arrears columns refused.
--   7. Undo: Asha's revision refused (Dec booked on it); Keshav's undone → back to 30k.
--   8. Another company's owner: cannot revise Keshav, cannot read his arrears.
--
-- Run: node scripts/test-sql.mjs --local supabase/tests/r2699_salary_revision.test.sql
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2699000-0000-0000-0000-0000000000a1', 'r2699-owner@example.test'),
  ('c2699000-0000-0000-0000-0000000000a2', 'r2699-sales@example.test'),
  ('c2699000-0000-0000-0000-0000000000a3', 'r2699-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2699000-0000-0000-0000-0000000000f0', 'R2699 T', 'r2699@example.test', '07', 'R2699'),
  ('c2699000-0000-0000-0000-0000000000f1', 'R2699 Other', 'r2699o@example.test', '07', 'R2699O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2699000-0000-0000-0000-0000000000a1', 'c2699000-0000-0000-0000-0000000000f0', 'r2699-owner@example.test', 'R2699 Owner', 'owner', true),
  ('c2699000-0000-0000-0000-0000000000a2', 'c2699000-0000-0000-0000-0000000000f0', 'r2699-sales@example.test', 'R2699 Sales', 'sales', true),
  ('c2699000-0000-0000-0000-0000000000a3', 'c2699000-0000-0000-0000-0000000000f1', 'r2699-other@example.test', 'R2699 Other', 'owner', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('c2699000-0000-4000-8000-0000000000b1', 'c2699000-0000-0000-0000-0000000000f0', 'HDFC', 'HDFC', 'current', 500000, '2026-04-01');

insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, joining_date) values
  ('c2699000-0000-4000-8000-0000000000e1', 'c2699000-0000-0000-0000-0000000000f0', 'R2699 Keshav', 30000, 15000, '2026-04-01'),
  ('c2699000-0000-4000-8000-0000000000e2', 'c2699000-0000-0000-0000-0000000000f0', 'R2699 Asha',   30000, 15000, '2025-01-01'),
  ('c2699000-0000-4000-8000-0000000000e3', 'c2699000-0000-0000-0000-0000000000f0', 'R2699 Ravi',   30000, null,  '2025-01-01');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c2699000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

-- Asha: Oct full month, Nov with ₹15,000 LOP — booked at ₹30,000 BEFORE any revision.
select public.pay_salary('c2699000-0000-4000-8000-0000000000e2', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                         'c2699000-0000-4000-8000-0000000000b1', null);
select public.pay_salary('c2699000-0000-4000-8000-0000000000e2', '2026-11', '2026-11-30', 30000, 15, 15000, 0, null, 0, 0, 0, 0,
                         'c2699000-0000-4000-8000-0000000000b1', null);
-- Ravi: Oct paid at ₹30,000.
select public.pay_salary('c2699000-0000-4000-8000-0000000000e3', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                         'c2699000-0000-4000-8000-0000000000b1', null);
-- One transaction has one now(): place the bookings in the past (as real requests would be).
reset role;
update public.salary_payments set created_at = '2026-11-01T10:00:00Z'
 where employee_id in ('c2699000-0000-4000-8000-0000000000e2', 'c2699000-0000-4000-8000-0000000000e3');
set local role authenticated;

-- ── 1. Sales login is refused ───────────────────────────────────────────────────────
do $$
declare v_refused boolean := false; v_refused2 boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2699000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e1', '2026-12-01', 36000, 18000, 0, null, null);
  exception when insufficient_privilege then v_refused := true;
  end;
  begin
    perform * from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e2');
  exception when insufficient_privilege then v_refused2 := true;
  end;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2699000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  if not v_refused then raise exception 'FAIL 1a: a sales login could revise a salary'; end if;
  if not v_refused2 then raise exception 'FAIL 1b: a sales login could read arrears'; end if;
  raise notice 'PASS 1: sales refused';
end $$;

-- ── 2. Owner path: Keshav 30k → 36k from Dec 2026 ───────────────────────────────────
do $$
declare v_id uuid; v_emp record; v_rev public.employee_salary_revisions; v_n int;
begin
  v_id := public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e1', '2026-12-15', 36000, 18000, 0, 470000, 'Annual increment');
  select monthly_gross, basic_monthly into v_emp from public.employees where id = 'c2699000-0000-4000-8000-0000000000e1';
  select * into v_rev from public.employee_salary_revisions where id = v_id;
  if v_emp.monthly_gross <> 36000 or v_emp.basic_monthly <> 18000 then
    raise exception 'FAIL 2a: employee row % / %', v_emp.monthly_gross, v_emp.basic_monthly;
  end if;
  if v_rev.effective_from <> '2026-12-01' or v_rev.prev_monthly_gross <> 30000 or v_rev.prev_basic_monthly <> 15000
     or v_rev.annual_ctc <> 470000 or v_rev.note <> 'Annual increment' or v_rev.created_by <> 'c2699000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL 2b: revision row % % % % % %', v_rev.effective_from, v_rev.prev_monthly_gross, v_rev.prev_basic_monthly, v_rev.annual_ctc, v_rev.note, v_rev.created_by;
  end if;
  select count(*) into v_n from public.employee_salary_revisions where employee_id = 'c2699000-0000-4000-8000-0000000000e1';
  if v_n <> 1 then raise exception 'FAIL 2c: owner reads % revisions', v_n; end if;
  raise notice 'PASS 2: revision saved with the salary it replaced; employee row = going forward';
end $$;

reset role;
do $$
begin
  if public._salary_in_force_gross('c2699000-0000-4000-8000-0000000000e1', '2026-11') <> 30000 then
    raise exception 'FAIL 2d: Nov in force % (want 30000)', public._salary_in_force_gross('c2699000-0000-4000-8000-0000000000e1', '2026-11');
  end if;
  if public._salary_in_force_gross('c2699000-0000-4000-8000-0000000000e1', '2026-12') <> 36000
     or public._salary_in_force_gross('c2699000-0000-4000-8000-0000000000e1', '2027-03') <> 36000 then
    raise exception 'FAIL 2e: Dec/Mar in force not 36000';
  end if;
  raise notice 'PASS 2f: Nov 30,000 · Dec 36,000 (same rule as salaryInForce)';
end $$;
set local role authenticated;

-- ── 3. Refusals ─────────────────────────────────────────────────────────────────────
do $$
declare v_msg text;
begin
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e1', '2027-01-01', 36000, 18000, 0, null, null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'The new salary is the same as the current one.' then raise exception 'FAIL 3a: %', v_msg; end if;
  v_msg := null;
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e1', '2026-12-01', 40000, 18000, 0, null, null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like 'A salary revision from Dec 2026 already exists%' then raise exception 'FAIL 3b: %', v_msg; end if;
  v_msg := null;
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e3', '2024-12-01', 40000, null, 0, null, null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like 'The new salary can''t start before Jan 2025%' then raise exception 'FAIL 3c: %', v_msg; end if;
  v_msg := null;
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e3', '2027-01-01', 40000, 35000, 6000, null, null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Basic + DA can''t be more than the monthly gross.' then raise exception 'FAIL 3d: %', v_msg; end if;
  v_msg := null;
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e3', '2027-01-01', 0, null, 0, null, null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like 'Enter the new monthly gross salary%' then raise exception 'FAIL 3e: %', v_msg; end if;
  raise notice 'PASS 3: same / overlapping / before joining / Basic+DA / zero refused';
end $$;

-- ── 4. Backdated into paid months: arrears, booked rows untouched ───────────────────
do $$
declare v_id uuid; v_net_before int; v_net_after int; v_oct int; v_nov int; v_total int;
begin
  select sum(net) into v_net_before from public.salary_payments where employee_id = 'c2699000-0000-4000-8000-0000000000e2';
  v_id := public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e2', '2026-10-01', 36000, 18000, 0, null, 'Backdated increment');
  -- The revision was saved after those bookings (one transaction has one now()).
  reset role;
  update public.employee_salary_revisions set created_at = '2026-11-05T10:00:00Z' where id = v_id;
  set local role authenticated;
  select sum(net) into v_net_after from public.salary_payments where employee_id = 'c2699000-0000-4000-8000-0000000000e2';
  if v_net_after <> v_net_before then raise exception 'FAIL 4a: booked salary changed % → %', v_net_before, v_net_after; end if;
  select arrears into v_oct from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e2') where period = '2026-10';
  select arrears into v_nov from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e2') where period = '2026-11';
  select sum(arrears) into v_total from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e2');
  if v_oct <> 6000 or v_nov <> 3000 or v_total <> 9000 then
    raise exception 'FAIL 4b: arrears Oct % Nov % total % (want 6000 / 3000 / 9000)', v_oct, v_nov, v_total;
  end if;
  raise notice 'PASS 4: booked months unchanged; arrears Oct 6,000 + Nov 3,000';
end $$;

-- ── 5. Arrears paid once, with the Dec salary ───────────────────────────────────────
do $$
declare v_msg text; v_id uuid; v_sal public.salary_payments; v_exp public.expenses; v_total int;
begin
  begin
    perform public.pay_salary_with_arrears('c2699000-0000-4000-8000-0000000000e2', '2026-12', '2026-12-31', 36000, 0, 0, 0, null, 0, 0, 0, 0,
                                           'c2699000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null, 9001);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Arrears ₹9001 is more than the ₹9000 still due for this employee.' then raise exception 'FAIL 5a: %', v_msg; end if;
  -- A backlog month before the raise (Sep) cannot carry the arrears.
  v_msg := null;
  begin
    perform public.pay_salary_with_arrears('c2699000-0000-4000-8000-0000000000e2', '2026-09', '2026-12-31', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                                           'c2699000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null, 9000);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Arrears can be paid with a salary for a month after Nov 2026 — pay this month without them.' then raise exception 'FAIL 5a2: %', v_msg; end if;

  v_id := public.pay_salary_with_arrears('c2699000-0000-4000-8000-0000000000e2', '2026-12', '2027-01-02', 36000, 0, 0, 0, null, 0, 0, 0, 0,
                                         'c2699000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null, 9000);
  select * into v_sal from public.salary_payments where id = v_id;
  select * into v_exp from public.expenses where id = v_sal.expense_id;
  if v_sal.arrears <> 9000 or v_sal.incentive <> 9000 or v_sal.net <> 45000 or v_sal.gross <> 36000 then
    raise exception 'FAIL 5b: arrears % incentive % net % gross %', v_sal.arrears, v_sal.incentive, v_sal.net, v_sal.gross;
  end if;
  if v_exp.amount <> 45000 or v_exp.expense_date <> '2026-12-31' or v_exp.description not like '%arrears ₹9000%' then
    raise exception 'FAIL 5c: expense % on % (%)', v_exp.amount, v_exp.expense_date, v_exp.description;
  end if;
  if v_sal.salary_in_force <> 36000 then raise exception 'FAIL 5f: Dec salary_in_force % (want 36000)', v_sal.salary_in_force; end if;
  if (select salary_in_force from public.salary_payments where employee_id = 'c2699000-0000-4000-8000-0000000000e2' and period = '2026-10') <> 30000 then
    raise exception 'FAIL 5g: Oct salary_in_force not 30000';
  end if;
  select sum(arrears) into v_total from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e2');
  if v_total <> 9000 then raise exception 'FAIL 5d: Dec (booked at the new salary) added arrears: total %', v_total; end if;
  v_msg := null;
  begin
    perform public.pay_salary_with_arrears('c2699000-0000-4000-8000-0000000000e2', '2027-01', '2027-01-31', 36000, 0, 0, 0, null, 0, 0, 0, 0,
                                           'c2699000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null, 1);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Arrears ₹1 is more than the ₹0 still due for this employee.' then raise exception 'FAIL 5e: %', v_msg; end if;
  raise notice 'PASS 5: arrears 9,000 paid once with Dec (expense in Dec); no second time';
end $$;

-- ── 6. Pay cut into a paid month ────────────────────────────────────────────────────
do $$
declare v_msg text;
begin
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e3', '2026-10-01', 25000, null, 0, null, null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like 'A lower salary can''t start in a month that is already paid (Oct 2026)%' then raise exception 'FAIL 6: %', v_msg; end if;
  raise notice 'PASS 6: pay cut into a paid month refused';
end $$;

-- ── 6b. Gross edited directly after a booking, then a backdated revision ────────────
-- Ravi's Oct was booked at 30,000; the gross is then edited to 33,000 (Employees → Edit); a
-- revision to 36,000 from Oct must still owe 6,000 for Oct (the stored salary at booking).
reset role;
update public.employees set monthly_gross = 33000 where id = 'c2699000-0000-4000-8000-0000000000e3';
set local role authenticated;
do $$
declare v_oct int;
begin
  perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e3', '2026-10-01', 36000, null, 0, null, null);
  select arrears into v_oct from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e3') where period = '2026-10';
  if v_oct <> 6000 then raise exception 'FAIL 6b: Oct arrears % (want 6000 — stored salary at booking, not the edited 33,000)', v_oct; end if;
  raise notice 'PASS 6b: arrears from the salary stored at booking';
end $$;

-- ── 6c. Legacy rows (booked before this migration: salary_in_force null) ─────────────
-- Meera: Sep paid 40,000; gross later edited DOWN to 30,000; revise to 36,000 from Sep → no
-- arrears (she was already paid more). Kabir: Sep paid 30,000; gross edited UP to 33,000; revise
-- to 36,000 from Sep → arrears on 33,000 → 36,000 only (never more than the real 6,000).
reset role;
insert into public.employees (id, tenant_id, name, monthly_gross, joining_date) values
  ('c2699000-0000-4000-8000-0000000000e4', 'c2699000-0000-0000-0000-0000000000f0', 'R2699 Meera', 40000, '2025-01-01'),
  ('c2699000-0000-4000-8000-0000000000e5', 'c2699000-0000-0000-0000-0000000000f0', 'R2699 Kabir', 30000, '2025-01-01');
set local role authenticated;
select public.pay_salary('c2699000-0000-4000-8000-0000000000e4', '2026-09', '2026-09-30', 40000, 0, 0, 0, null, 0, 0, 0, 0,
                         'c2699000-0000-4000-8000-0000000000b1', null);
select public.pay_salary('c2699000-0000-4000-8000-0000000000e5', '2026-09', '2026-09-30', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                         'c2699000-0000-4000-8000-0000000000b1', null);
reset role;
select set_config('app.r2699_salary_arrears', 'on', true);
update public.salary_payments set salary_in_force = null, created_at = '2026-09-30T10:00:00Z'
 where employee_id in ('c2699000-0000-4000-8000-0000000000e4', 'c2699000-0000-4000-8000-0000000000e5');
select set_config('app.r2699_salary_arrears', '', true);
update public.employees set monthly_gross = 30000 where id = 'c2699000-0000-4000-8000-0000000000e4';
update public.employees set monthly_gross = 33000 where id = 'c2699000-0000-4000-8000-0000000000e5';
set local role authenticated;
do $$
declare v_meera int; v_kabir int;
begin
  perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e4', '2026-09-01', 36000, null, 0, null, null);
  perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e5', '2026-09-01', 36000, null, 0, null, null);
  select coalesce(sum(arrears), 0) into v_meera from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e4');
  select coalesce(sum(arrears), 0) into v_kabir from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e5');
  if v_meera <> 0 then raise exception 'FAIL 6c-a: legacy month paid 40,000 now owes arrears % (want 0)', v_meera; end if;
  if v_kabir <> 2727 then raise exception 'FAIL 6c-b: legacy month arrears % (want 2727 = 30,000 x 36/33 - 30,000)', v_kabir; end if;
  raise notice 'PASS 6c: legacy rows never owe more than was underpaid';
end $$;

-- ── 6d. After Start exit, no revision after the last month ──────────────────────────
do $$
declare v_msg text;
begin
  perform public.start_employee_exit('c2699000-0000-4000-8000-0000000000e4', '2026-10-15', 'resigned');
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e4', '2026-11-01', 40000, null, 0, null, null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like 'The new salary can''t start after Oct 2026 — that is R2699 Meera''s last month.' then raise exception 'FAIL 6d: %', v_msg; end if;
  raise notice 'PASS 6d: no revision after the exit month';
end $$;

-- ── 6e. No change outside the RPCs ────────────────────────────────────────────────
-- Owner edits Asha's gross directly (she has a revision) → refused; owner edits arrears /
-- salary_in_force on a booked salary through the table → refused.
do $$
declare v_msg text; v_msg2 text; v_msg3 text;
begin
  begin update public.employees set monthly_gross = 50000 where id = 'c2699000-0000-4000-8000-0000000000e2';
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'R2699 Asha''s salary is set by salary revisions — change it with Revise salary in the employee profile.' then
    raise exception 'FAIL 6e-a: %', v_msg;
  end if;
  begin update public.salary_payments set arrears = 0 where employee_id = 'c2699000-0000-4000-8000-0000000000e2' and period = '2026-12';
  exception when others then v_msg2 := sqlerrm; end;
  begin update public.salary_payments set salary_in_force = 20000 where employee_id = 'c2699000-0000-4000-8000-0000000000e2' and period = '2026-10';
  exception when others then v_msg3 := sqlerrm; end;
  if v_msg2 is distinct from 'Salary revision arrears on a booked salary can''t be edited — undo that salary and pay it again.'
     or v_msg3 is distinct from v_msg2 then
    raise exception 'FAIL 6e-b: % / %', v_msg2, v_msg3;
  end if;
  -- Other fields still save (name / phone) with the same salary.
  update public.employees set phone = '9999999999', monthly_gross = monthly_gross where id = 'c2699000-0000-4000-8000-0000000000e2';
  raise notice 'PASS 6e: salary and arrears columns change only through the RPCs';
end $$;

-- ── 7. Undo ─────────────────────────────────────────────────────────────────────────
do $$
declare v_msg text; v_rev uuid; v_emp record;
begin
  select id into v_rev from public.employee_salary_revisions where employee_id = 'c2699000-0000-4000-8000-0000000000e2';
  begin perform public.undo_salary_revision(v_rev);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Salary for Dec 2026 is already booked on this revision — undo that salary first.' then raise exception 'FAIL 7a: %', v_msg; end if;
  select id into v_rev from public.employee_salary_revisions where employee_id = 'c2699000-0000-4000-8000-0000000000e1';
  perform public.undo_salary_revision(v_rev);
  select monthly_gross, basic_monthly into v_emp from public.employees where id = 'c2699000-0000-4000-8000-0000000000e1';
  if v_emp.monthly_gross <> 30000 or v_emp.basic_monthly <> 15000 then raise exception 'FAIL 7b: not restored % %', v_emp.monthly_gross, v_emp.basic_monthly; end if;
  if exists (select 1 from public.employee_salary_revisions where id = v_rev) then raise exception 'FAIL 7c: revision still there'; end if;
  raise notice 'PASS 7: undo refused once booked on it; latest unbooked revision undone';
end $$;

-- ── 8. Another company ─────────────────────────────────────────────────────────────
do $$
declare v_msg text; v_msg2 text; v_n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2699000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  begin perform public.revise_employee_salary('c2699000-0000-4000-8000-0000000000e1', '2027-02-01', 50000, null, 0, null, null);
  exception when others then v_msg := sqlerrm; end;
  begin perform * from public.employee_salary_arrears('c2699000-0000-4000-8000-0000000000e2');
  exception when others then v_msg2 := sqlerrm; end;
  select count(*) into v_n from public.employee_salary_revisions;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2699000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  if v_msg is distinct from 'Employee not found in your company — refresh the page.' then raise exception 'FAIL 8a: %', v_msg; end if;
  if v_msg2 is distinct from 'Employee not found in your company — refresh the page.' then raise exception 'FAIL 8b: %', v_msg2; end if;
  if v_n <> 0 then raise exception 'FAIL 8c: other company reads % revisions', v_n; end if;
  raise notice 'PASS 8: other company refused';
end $$;

select 'PASS r2699_salary_revision' as result;

rollback;
