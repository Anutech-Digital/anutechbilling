-- R-2380 — merge two employee records of the same person into one.
-- Migration: 20261102162342_r2380_merge_employees.sql
--
-- Owner's case (2 Nov 2026): "Prashant" (Office Boy, kept) and "Prashant Kumar" (duplicate) —
-- the duplicate holds salary 2026-07 ₹5,000 and 2026-08 ₹14,000 that the app could not move.
-- This file FAILS without the migration (merge_employees does not exist) and PASSES with it.
--
--   1. A sales user cannot merge; an owner of ANOTHER workspace cannot merge ours.
--   2. Preview (dry run) shows the counts and changes nothing.
--   3. Owner merges Prashant Kumar into Prashant: both salaries, attendance, leave, documents,
--      advance (typed name), reimbursement (typed name), salary expense lines and the login move;
--      a day both have attendance stays on the duplicate; empty fields copied; duplicate inactive
--      "Merged into R2380 Prashant on …"; one employee.merge activity row;
--      salary and expense (P&L) totals unchanged.
--   4. Same-month salary on both → refused with the month; "keep both" → that month stays on
--      the duplicate as its own row, the rest moves; totals unchanged.
--   5. The other workspace's rows are untouched.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2380000-0000-0000-0000-0000000000a1', 'r2380-owner@example.test'),
  ('c2380000-0000-0000-0000-0000000000a2', 'r2380-mgr@example.test'),
  ('c2380000-0000-0000-0000-0000000000a3', 'r2380-sales@example.test'),
  ('c2380000-0000-0000-0000-0000000000b1', 'r2380-other-owner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2380000-0000-0000-0000-0000000000f0', 'R2380 T', 'r2380@example.test', '07', 'R2380'),
  ('c2380000-0000-0000-0000-0000000000f9', 'R2380 Other', 'r2380o@example.test', '07', 'R2380O');

insert into public.employees (id, tenant_id, name, monthly_gross, joining_date, designation, phone, pan, biometric_id, notes) values
  ('c2380000-0000-0000-0000-0000000000e1', 'c2380000-0000-0000-0000-0000000000f0', 'R2380 Prashant',       14000, '2025-01-01', 'Office Boy', null, null, null, null),
  ('c2380000-0000-0000-0000-0000000000e2', 'c2380000-0000-0000-0000-0000000000f0', 'R2380 Prashant Kumar', 14000, null, 'Duplicate of Prashant (Office Boy) — owner 2 Nov', '9811100000', 'ABCDE1234F', 'BIO-7', 'old note'),
  ('c2380000-0000-0000-0000-0000000000e3', 'c2380000-0000-0000-0000-0000000000f0', 'R2380 Asha',           20000, '2025-01-01', null, null, null, null, null),
  ('c2380000-0000-0000-0000-0000000000e4', 'c2380000-0000-0000-0000-0000000000f0', 'R2380 Asha K',         20000, '2025-01-01', null, null, null, null, null),
  ('c2380000-0000-0000-0000-0000000000e9', 'c2380000-0000-0000-0000-0000000000f9', 'R2380 Other Staff',    9000,  '2025-01-01', null, null, null, null, null);

insert into public.users (id, tenant_id, email, full_name, role, is_active, employee_id) values
  ('c2380000-0000-0000-0000-0000000000a1', 'c2380000-0000-0000-0000-0000000000f0', 'r2380-owner@example.test', 'R2380 Owner', 'owner', true, null),
  ('c2380000-0000-0000-0000-0000000000a2', 'c2380000-0000-0000-0000-0000000000f0', 'r2380-mgr@example.test', 'R2380 Mgr', 'manager', true, 'c2380000-0000-0000-0000-0000000000e2'),
  ('c2380000-0000-0000-0000-0000000000a3', 'c2380000-0000-0000-0000-0000000000f0', 'r2380-sales@example.test', 'R2380 Sales', 'sales', true, null),
  ('c2380000-0000-0000-0000-0000000000b1', 'c2380000-0000-0000-0000-0000000000f9', 'r2380-other-owner@example.test', 'R2380 Other Owner', 'owner', true, null);

-- Prashant Kumar's two salaries (owner's real amounts) with their expense lines.
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description) values
  ('EXP-R2380-07', 'c2380000-0000-0000-0000-0000000000f0', 'Salaries', 'R2380 Prashant Kumar', '2026-07-31', 5000, 0, 'payroll', 'Salary 2026-07 — R2380 Prashant Kumar'),
  ('EXP-R2380-08', 'c2380000-0000-0000-0000-0000000000f0', 'Salaries', 'R2380 Prashant Kumar', '2026-08-31', 14000, 0, 'payroll', 'Salary 2026-08 — R2380 Prashant Kumar'),
  ('EXP-R2380-A7', 'c2380000-0000-0000-0000-0000000000f0', 'Salaries', 'R2380 Asha', '2026-07-31', 20000, 0, 'payroll', 'Salary 2026-07 — R2380 Asha'),
  ('EXP-R2380-B7', 'c2380000-0000-0000-0000-0000000000f0', 'Salaries', 'R2380 Asha K', '2026-07-31', 3000, 0, 'payroll', 'Salary 2026-07 — R2380 Asha K'),
  ('EXP-R2380-B9', 'c2380000-0000-0000-0000-0000000000f0', 'Salaries', 'R2380 Asha K', '2026-09-30', 20000, 0, 'payroll', 'Salary 2026-09 — R2380 Asha K');

insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, net, incentive, expense_id) values
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e2', '2026-07', '2026-08-05', 5000, 5000, 0, 'EXP-R2380-07'),
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e2', '2026-08', '2026-09-05', 14000, 14000, 1000, 'EXP-R2380-08'),
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e3', '2026-07', '2026-08-05', 20000, 20000, 0, 'EXP-R2380-A7'),
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e4', '2026-07', '2026-08-06', 3000, 3000, 0, 'EXP-R2380-B7'),
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e4', '2026-09', '2026-10-05', 20000, 20000, 0, 'EXP-R2380-B9'),
  ('c2380000-0000-0000-0000-0000000000f9', 'c2380000-0000-0000-0000-0000000000e9', '2026-07', '2026-08-05', 9000, 9000, 0, null);

insert into public.attendance (tenant_id, employee_id, work_date) values
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e1', '2026-08-01'),
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e2', '2026-08-01'),
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e2', '2026-08-02');
insert into public.leave_entries (tenant_id, employee_id, from_date, to_date, days, type) values
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e2', '2026-08-10', '2026-08-10', 1, 'casual');
insert into public.employee_documents (tenant_id, employee_id, file_name, file_path) values
  ('c2380000-0000-0000-0000-0000000000f0', 'c2380000-0000-0000-0000-0000000000e2', 'aadhaar.pdf', 'r2380/aadhaar.pdf');
insert into public.employee_loans (tenant_id, employee_name, principal, disbursed_on, kind) values
  ('c2380000-0000-0000-0000-0000000000f0', 'R2380 Prashant Kumar', 2000, '2026-08-15', 'salary_advance'),
  ('c2380000-0000-0000-0000-0000000000f9', 'R2380 Prashant Kumar', 777, '2026-08-15', 'salary_advance');
insert into public.reimbursements (tenant_id, person_name, purpose, amount, incurred_on) values
  ('c2380000-0000-0000-0000-0000000000f0', ' r2380 prashant kumar ', 'Courier', 150, '2026-08-20');

set local role authenticated;

-- ── 1. Who may merge ─────────────────────────────────────────────────────────────────────
do $$
declare v_refused boolean := false; v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2380000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  begin
    perform public.merge_employees('c2380000-0000-0000-0000-0000000000e1', 'c2380000-0000-0000-0000-0000000000e2');
  exception when insufficient_privilege then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like 'Only an owner, manager or accountant%' then
    raise exception 'FAIL 1a: a sales user could merge (msg %)', v_msg;
  end if;

  v_refused := false; v_msg := null;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2380000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  begin
    perform public.merge_employees('c2380000-0000-0000-0000-0000000000e1', 'c2380000-0000-0000-0000-0000000000e2');
  exception when insufficient_privilege then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg <> 'Employee not in your workspace' then
    raise exception 'FAIL 1b: another workspace''s owner could merge ours (msg %)', v_msg;
  end if;
  begin
    perform public.merge_employees('c2380000-0000-0000-0000-0000000000e9', 'c2380000-0000-0000-0000-0000000000e2');
    raise exception 'FAIL 1c: mixed-workspace merge went through';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS 1: sales refused; another workspace refused';
end $$;

-- ── 2. Preview changes nothing ───────────────────────────────────────────────────────────
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2380000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  v_r := public.merge_employees('c2380000-0000-0000-0000-0000000000e1', 'c2380000-0000-0000-0000-0000000000e2', false, true);
  if (v_r->'moved'->>'salary')::int <> 2 or (v_r->'moved'->>'attendance')::int <> 1
     or (v_r->'left'->>'attendance')::int <> 1 or (v_r->'moved'->>'leave')::int <> 1
     or (v_r->'moved'->>'documents')::int <> 1 or (v_r->'moved'->>'reimbursements')::int <> 1
     or (v_r->'renamed'->>'advances')::int <> 1 or (v_r->'moved'->>'login')::int <> 1
     or jsonb_array_length(v_r->'clashes') <> 0 then
    raise exception 'FAIL 2a: preview counts wrong: %', v_r;
  end if;
  if not (v_r->'fields') ? 'phone' or not (v_r->'fields') ? 'pan' or (v_r->'fields') ? 'designation' then
    raise exception 'FAIL 2b: preview fields wrong: %', v_r->'fields';
  end if;
  if (select count(*) from public.salary_payments where employee_id = 'c2380000-0000-0000-0000-0000000000e2') <> 2
     or not (select is_active from public.employees where id = 'c2380000-0000-0000-0000-0000000000e2') then
    raise exception 'FAIL 2c: preview wrote something';
  end if;
  raise notice 'PASS 2: preview shows 2 salaries, 1 day, 1 leave, 1 doc, advance, login; writes nothing';
end $$;

-- ── 3. Owner merges Prashant Kumar into Prashant ─────────────────────────────────────────
reset role;
create temp table r2380_before on commit drop as
select (select sum(gross) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') gross,
       (select sum(net)   from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') net,
       (select sum(incentive) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') inc,
       (select sum(amount) from public.expenses where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') exp,
       (select count(*) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') n;
grant select on r2380_before to authenticated;
set local role authenticated;

do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2380000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  v_r := public.merge_employees('c2380000-0000-0000-0000-0000000000e1', 'c2380000-0000-0000-0000-0000000000e2');
  if (v_r->'moved'->>'salary')::int <> 2 then raise exception 'FAIL 3a: result %', v_r; end if;
end $$;

reset role;
do $$
declare v_k uuid := 'c2380000-0000-0000-0000-0000000000e1'; v_d uuid := 'c2380000-0000-0000-0000-0000000000e2';
        v_e public.employees; v_b record;
begin
  if (select count(*) from public.salary_payments where employee_id = v_d) <> 0
     or (select string_agg(period || ':' || net, ',' order by period) from public.salary_payments where employee_id = v_k) <> '2026-07:5000,2026-08:14000' then
    raise exception 'FAIL 3b: salaries not under the kept employee';
  end if;
  if (select string_agg(work_date::text, ',' order by work_date) from public.attendance where employee_id = v_k) <> '2026-08-01,2026-08-02'
     or (select count(*) from public.attendance where employee_id = v_d) <> 1 then
    raise exception 'FAIL 3c: attendance not moved (clash day must stay on the duplicate)';
  end if;
  if (select count(*) from public.leave_entries where employee_id = v_k) <> 1
     or (select count(*) from public.employee_documents where employee_id = v_k) <> 1 then
    raise exception 'FAIL 3d: leave / documents not moved';
  end if;
  if (select employee_name from public.employee_loans where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> 'R2380 Prashant' then
    raise exception 'FAIL 3e: advance (typed name) not re-pointed';
  end if;
  if (select employee_id from public.reimbursements where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') is distinct from v_k
     or (select person_name from public.reimbursements where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> 'R2380 Prashant' then
    raise exception 'FAIL 3f: reimbursement not re-pointed';
  end if;
  if exists (select 1 from public.expenses where id in ('EXP-R2380-07', 'EXP-R2380-08')
              and (vendor_name <> 'R2380 Prashant' or description not like '% — R2380 Prashant')) then
    raise exception 'FAIL 3g: salary expense lines still carry the duplicate''s name';
  end if;
  if (select employee_id from public.users where id = 'c2380000-0000-0000-0000-0000000000a2') is distinct from v_k then
    raise exception 'FAIL 3h: login not moved to the kept employee';
  end if;
  select * into v_e from public.employees where id = v_k;
  if v_e.phone is distinct from '9811100000' or v_e.pan is distinct from 'ABCDE1234F'
     or v_e.designation <> 'Office Boy' or v_e.biometric_id is distinct from 'BIO-7' or v_e.joining_date <> '2025-01-01' then
    raise exception 'FAIL 3i: empty fields not copied / filled fields overwritten: %', to_jsonb(v_e);
  end if;
  select * into v_e from public.employees where id = v_d;
  if v_e.is_active or v_e.notes not like 'Merged into R2380 Prashant on %' or v_e.notes not like '%old note'
     or v_e.biometric_id is not null then
    raise exception 'FAIL 3j: duplicate not marked: %', to_jsonb(v_e);
  end if;
  if (select count(*) from public.activity_log where tenant_id = 'c2380000-0000-0000-0000-0000000000f0'
        and action = 'employee.merge' and entity_id = v_k::text and label = 'Merged R2380 Prashant Kumar into R2380 Prashant') <> 1 then
    raise exception 'FAIL 3k: no employee.merge activity row';
  end if;
  select * into v_b from r2380_before;
  if (select sum(gross) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.gross
     or (select sum(net) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.net
     or (select sum(incentive) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.inc
     or (select sum(amount) from public.expenses where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.exp
     or (select count(*) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.n then
    raise exception 'FAIL 3l: salary / expense totals changed by the merge';
  end if;
  raise notice 'PASS 3: everything under Prashant; duplicate inactive "Merged into…"; logged; totals unchanged';
end $$;
set local role authenticated;

-- ── 4. Same month on both: refused, then "keep both" ────────────────────────────────────
do $$
declare v_refused boolean := false; v_msg text; v_r jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2380000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);   -- manager
  v_r := public.merge_employees('c2380000-0000-0000-0000-0000000000e3', 'c2380000-0000-0000-0000-0000000000e4', false, true);
  if jsonb_array_length(v_r->'clashes') <> 1 or v_r->'clashes'->0->>'period' <> '2026-07' then
    raise exception 'FAIL 4a: preview did not list the clash: %', v_r;
  end if;
  begin
    perform public.merge_employees('c2380000-0000-0000-0000-0000000000e3', 'c2380000-0000-0000-0000-0000000000e4');
  exception when check_violation then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like 'Both employees have a salary for Jul 2026%' then
    raise exception 'FAIL 4b: same-month clash not refused (msg %)', v_msg;
  end if;

  v_r := public.merge_employees('c2380000-0000-0000-0000-0000000000e3', 'c2380000-0000-0000-0000-0000000000e4', true);
  if (v_r->'moved'->>'salary')::int <> 1 or (v_r->'left'->>'salary')::int <> 1 then
    raise exception 'FAIL 4c: keep-both result %', v_r;
  end if;
  raise notice 'PASS 4a: clash listed in preview and refused (Jul 2026); keep both went through';
end $$;

reset role;
do $$
declare v_b record;
begin
  if (select string_agg(period || ':' || net, ',' order by period) from public.salary_payments where employee_id = 'c2380000-0000-0000-0000-0000000000e3') <> '2026-07:20000,2026-09:20000'
     or (select string_agg(period || ':' || net, ',' order by period) from public.salary_payments where employee_id = 'c2380000-0000-0000-0000-0000000000e4') <> '2026-07:3000' then
    raise exception 'FAIL 4d: keep both — Jul must stay on Asha K as its own row, Sep must move';
  end if;
  if (select vendor_name from public.expenses where id = 'EXP-R2380-B7') <> 'R2380 Asha K'
     or (select vendor_name from public.expenses where id = 'EXP-R2380-B9') <> 'R2380 Asha' then
    raise exception 'FAIL 4e: expense names follow the wrong rows';
  end if;
  select * into v_b from r2380_before;
  if (select sum(net) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.net
     or (select sum(amount) from public.expenses where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.exp
     or (select count(*) from public.salary_payments where tenant_id = 'c2380000-0000-0000-0000-0000000000f0') <> v_b.n then
    raise exception 'FAIL 4f: totals changed by keep-both merge';
  end if;

  -- ── 5. The other workspace is untouched ──
  if (select employee_name from public.employee_loans where tenant_id = 'c2380000-0000-0000-0000-0000000000f9') <> 'R2380 Prashant Kumar'
     or (select count(*) from public.salary_payments where employee_id = 'c2380000-0000-0000-0000-0000000000e9') <> 1
     or not (select is_active from public.employees where id = 'c2380000-0000-0000-0000-0000000000e9') then
    raise exception 'FAIL 5: another workspace''s rows changed';
  end if;
  raise notice 'PASS 4b/5: keep both kept two rows, totals same; other workspace untouched';
end $$;

rollback;
