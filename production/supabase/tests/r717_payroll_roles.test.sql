\set ON_ERROR_STOP on
-- R-717 (P1 SECURITY): payroll / PIN / advance / expense-claim SECURITY DEFINER functions
-- check the caller's ROLE, not only the company. Migration 20261011050000_r717_payroll_roles.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r717_payroll_roles.test.sql
--
-- Expect "PASS r717_payroll_roles". Every check is collected first and the failures are
-- listed together at the end, so on the old bodies the run names EVERY open function
-- (proved 11 Oct 2026: sales/support/billing could pay a salary, give/top up/settle an
-- advance, approve a claim and reset a kiosk PIN).
--
--   BLOCKED  sales, support, billing, a null-caller (no public.users row) — all six functions
--   BLOCKED  accountant — set_employee_pin only
--   BLOCKED  owner of company B on company A's rows — all six (tenant match), nothing changes
--   ALLOWED  owner, manager, accountant — pay_salary, the three advance functions,
--            approve_expense_claim
--   ALLOWED  owner, manager — set_employee_pin

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e7170000-0000-4000-8000-0000000000a1', 'r717-owner@example.test'),
  ('e7170000-0000-4000-8000-0000000000a2', 'r717-manager@example.test'),
  ('e7170000-0000-4000-8000-0000000000a3', 'r717-accountant@example.test'),
  ('e7170000-0000-4000-8000-0000000000a4', 'r717-sales@example.test'),
  ('e7170000-0000-4000-8000-0000000000a5', 'r717-support@example.test'),
  ('e7170000-0000-4000-8000-0000000000a6', 'r717-billing@example.test'),
  ('e7170000-0000-4000-8000-0000000000b1', 'r717-owner-b@example.test'),
  ('e7170000-0000-4000-8000-0000000000ff', 'r717-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e7170000-0000-0000-0000-0000000000a0', 'R717 A', 'r717a@example.in', '07', 'R77A'),
  ('e7170000-0000-0000-0000-0000000000b0', 'R717 B', 'r717b@example.in', '07', 'R77B');

-- The null-caller has NO public.users row.
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e7170000-0000-4000-8000-0000000000a1', 'e7170000-0000-0000-0000-0000000000a0', 'r717-owner@example.in',      'R717 Owner',      'owner',      true),
  ('e7170000-0000-4000-8000-0000000000a2', 'e7170000-0000-0000-0000-0000000000a0', 'r717-manager@example.in',    'R717 Manager',    'manager',    true),
  ('e7170000-0000-4000-8000-0000000000a3', 'e7170000-0000-0000-0000-0000000000a0', 'r717-accountant@example.in', 'R717 Accountant', 'accountant', true),
  ('e7170000-0000-4000-8000-0000000000a4', 'e7170000-0000-0000-0000-0000000000a0', 'r717-sales@example.in',      'R717 Sales',      'sales',      true),
  ('e7170000-0000-4000-8000-0000000000a5', 'e7170000-0000-0000-0000-0000000000a0', 'r717-support@example.in',    'R717 Support',    'support',    true),
  ('e7170000-0000-4000-8000-0000000000a6', 'e7170000-0000-0000-0000-0000000000a0', 'r717-billing@example.in',    'R717 Billing',    'billing',    true),
  ('e7170000-0000-4000-8000-0000000000b1', 'e7170000-0000-0000-0000-0000000000b0', 'r717-owner-b@example.in',    'R717 Owner B',    'owner',      true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e7170000-0000-4000-8000-00000000ba01', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Bank', 'R717 Bank', 'current', 100000, '2026-04-01');

-- Employee "victim" is the target of every refused call; e1..e3 are paid by the allowed roles.
insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('e7170000-0000-4000-8000-0000000e0000', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Victim', 20000),
  ('e7170000-0000-4000-8000-0000000e0001', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Emp 1',  20000),
  ('e7170000-0000-4000-8000-0000000e0002', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Emp 2',  20000),
  ('e7170000-0000-4000-8000-0000000e0003', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Emp 3',  20000);

-- Employee advances (prepaid_advances): v = victim, 1..3 = one per allowed role.
insert into public.prepaid_advances (id, tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date) values
  ('e7170000-0000-4000-8000-0000000ad000', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Victim', 'Employee advance', 1000, 0, '2026-10-01'),
  ('e7170000-0000-4000-8000-0000000ad001', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Emp 1',  'Employee advance', 1000, 0, '2026-10-01'),
  ('e7170000-0000-4000-8000-0000000ad002', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Emp 2',  'Employee advance', 1000, 0, '2026-10-01'),
  ('e7170000-0000-4000-8000-0000000ad003', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Emp 3',  'Employee advance', 1000, 0, '2026-10-01');

-- Expense claims against an expense advance (employee_loans): one victim claim, one per allowed role.
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on, kind) values
  ('e7170000-0000-4000-8000-00000001a000', 'e7170000-0000-0000-0000-0000000000a0', 'R717 Victim', 5000, '2026-10-01', 'expense_advance');
insert into public.expense_claims (id, tenant_id, loan_id, employee_id, amount, category, spent_on, purpose) values
  ('e7170000-0000-4000-8000-0000000c1000', 'e7170000-0000-0000-0000-0000000000a0', 'e7170000-0000-4000-8000-00000001a000', 'e7170000-0000-4000-8000-0000000e0000', 100, 'Travel', '2026-10-02', 'R717 victim claim'),
  ('e7170000-0000-4000-8000-0000000c1001', 'e7170000-0000-0000-0000-0000000000a0', 'e7170000-0000-4000-8000-00000001a000', 'e7170000-0000-4000-8000-0000000e0000', 100, 'Travel', '2026-10-02', 'R717 claim 1'),
  ('e7170000-0000-4000-8000-0000000c1002', 'e7170000-0000-0000-0000-0000000000a0', 'e7170000-0000-4000-8000-00000001a000', 'e7170000-0000-4000-8000-0000000e0000', 100, 'Travel', '2026-10-02', 'R717 claim 2'),
  ('e7170000-0000-4000-8000-0000000c1003', 'e7170000-0000-0000-0000-0000000000a0', 'e7170000-0000-4000-8000-00000001a000', 'e7170000-0000-4000-8000-0000000e0000', 100, 'Travel', '2026-10-02', 'R717 claim 3');

create temp table r717_fail (n serial, label text, detail text);
grant all on r717_fail to authenticated;
grant usage on sequence r717_fail_n_seq to authenticated;

/* Runs one call as the CURRENT role/claims and records how it ended.
   want = SQLSTATE expected, 'any' (any error), or 'ok'. Failures are collected, not raised. */
create function pg_temp.r717_expect(label text, call text, want text) returns void
language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if want = 'ok' then
      insert into r717_fail(label, detail) values (label, format('expected success, got %s (%s)', v_state, v_msg));
    elsif want = 'any' or v_state = want then
      raise notice 'ok   %: refused % (%)', label, v_state, left(v_msg, 70);
    else
      insert into r717_fail(label, detail) values (label, format('expected %s, got %s (%s)', want, v_state, v_msg));
    end if;
    return;
  end;
  if want <> 'ok' then
    insert into r717_fail(label, detail) values (label, format('expected %s, call SUCCEEDED', want));
    return;
  end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r717_expect(text, text, text) to authenticated;

/* Calls of each function on the VICTIM rows (refused cases) or on row n (allowed cases). */
create function pg_temp.r717_calls(n int) returns table(fn text, call text)
language sql as $f$
  select * from (values
    ('pay_salary', format($c$select public.pay_salary('e7170000-0000-4000-8000-0000000e000%s', '2026-0%s', '2026-10-05', 20000, 0, 0, 0, null, 0, 0, 0, 0, 'e7170000-0000-4000-8000-00000000ba01')$c$, n, n + 4)),
    ('give_employee_advance', format($c$select public.give_employee_advance('R717 New %s', 500, '2026-10-05', 'cash', null, null)$c$, n)),
    ('top_up_employee_advance', format($c$select public.top_up_employee_advance('e7170000-0000-4000-8000-0000000ad00%s', 500, '2026-10-05', null)$c$, n)),
    ('settle_employee_advance', format($c$select public.settle_employee_advance('e7170000-0000-4000-8000-0000000ad00%s', '2026-10-06', null)$c$, n)),
    ('approve_expense_claim', format($c$select public.approve_expense_claim('e7170000-0000-4000-8000-0000000c100%s')$c$, n)),
    ('set_employee_pin', format($c$select public.set_employee_pin('e7170000-0000-4000-8000-0000000e000%s', '4711')$c$, n))
  ) v(fn, call)
$f$;
grant execute on function pg_temp.r717_calls(int) to authenticated;

create function pg_temp.r717_as(sub text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sub)::text, true);
end $f$;
grant execute on function pg_temp.r717_as(text) to authenticated;

-- ── 1. Refused: sales, support, billing, null-caller — all six, on the victim rows ──
set local role authenticated;
do $$
declare r record; who record;
begin
  for who in select * from (values
      ('sales',       'e7170000-0000-4000-8000-0000000000a4'),
      ('support',     'e7170000-0000-4000-8000-0000000000a5'),
      ('billing',     'e7170000-0000-4000-8000-0000000000a6'),
      ('null-caller', 'e7170000-0000-4000-8000-0000000000ff')) w(label, sub) loop
    perform pg_temp.r717_as(who.sub);
    for r in select * from pg_temp.r717_calls(0) loop
      perform pg_temp.r717_expect(who.label || ' ' || r.fn, r.call, '42501');
    end loop;
  end loop;
end $$;

-- ── 2. Accountant may not set a PIN ──────────────────────────────────────────────
select pg_temp.r717_as('e7170000-0000-4000-8000-0000000000a3');
select pg_temp.r717_expect('accountant set_employee_pin', $$select public.set_employee_pin('e7170000-0000-4000-8000-0000000e0000', '4711')$$, '42501');

-- ── 3. Other company: owner of B on company A's victim rows ──────────────────────
select pg_temp.r717_as('e7170000-0000-4000-8000-0000000000b1');
do $$
declare r record;
begin
  for r in select * from pg_temp.r717_calls(0) where fn <> 'give_employee_advance' loop
    perform pg_temp.r717_expect('other-company ' || r.fn, r.call, 'any');
  end loop;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

/* Nothing of company A's victim rows changed. */
do $$
begin
  if exists(select 1 from public.salary_payments where tenant_id = 'e7170000-0000-0000-0000-0000000000a0') then
    insert into r717_fail(label, detail) values ('untouched', 'a salary was booked by a refused caller');
  end if;
  if exists(select 1 from public.prepaid_advances where tenant_id = 'e7170000-0000-0000-0000-0000000000a0' and vendor_name like 'R717 New%') then
    insert into r717_fail(label, detail) values ('untouched', 'an advance was given by a refused caller');
  end if;
  if (select (total_amount, consumed_amount, closed_at is null) from public.prepaid_advances where id = 'e7170000-0000-4000-8000-0000000ad000')
     is distinct from (1000, 0, true) then
    insert into r717_fail(label, detail) values ('untouched', 'victim advance topped up or settled');
  end if;
  if (select status from public.expense_claims where id = 'e7170000-0000-4000-8000-0000000c1000') <> 'pending' then
    insert into r717_fail(label, detail) values ('untouched', 'victim claim approved');
  end if;
  if (select pin_hash from public.employees where id = 'e7170000-0000-4000-8000-0000000e0000') is not null then
    insert into r717_fail(label, detail) values ('untouched', 'victim kiosk PIN was set');
  end if;
end $$;

-- ── 4. Allowed: owner (1), manager (2), accountant (3) — money functions on their own rows ─
set local role authenticated;
do $$
declare r record; who record;
begin
  for who in select * from (values
      (1, 'owner',      'e7170000-0000-4000-8000-0000000000a1'),
      (2, 'manager',    'e7170000-0000-4000-8000-0000000000a2'),
      (3, 'accountant', 'e7170000-0000-4000-8000-0000000000a3')) w(n, label, sub) loop
    perform pg_temp.r717_as(who.sub);
    for r in select * from pg_temp.r717_calls(who.n) loop
      perform pg_temp.r717_expect(who.label || ' ' || r.fn, r.call,
                                  case when r.fn = 'set_employee_pin' and who.label = 'accountant' then '42501' else 'ok' end);
    end loop;
  end loop;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select count(*) from public.salary_payments where tenant_id = 'e7170000-0000-0000-0000-0000000000a0') <> 3 then
    insert into r717_fail(label, detail) values ('allowed', 'expected 3 salaries (owner/manager/accountant)');
  end if;
  if (select count(*) from public.prepaid_advances where tenant_id = 'e7170000-0000-0000-0000-0000000000a0' and vendor_name like 'R717 New%') <> 3 then
    insert into r717_fail(label, detail) values ('allowed', 'expected 3 new advances');
  end if;
  if (select count(*) from public.prepaid_advances where id in ('e7170000-0000-4000-8000-0000000ad001','e7170000-0000-4000-8000-0000000ad002','e7170000-0000-4000-8000-0000000ad003') and closed_at is not null) <> 3 then
    insert into r717_fail(label, detail) values ('allowed', 'expected 3 settled advances');
  end if;
  if (select count(*) from public.expense_claims where id in ('e7170000-0000-4000-8000-0000000c1001','e7170000-0000-4000-8000-0000000c1002','e7170000-0000-4000-8000-0000000c1003') and status = 'approved') <> 3 then
    insert into r717_fail(label, detail) values ('allowed', 'expected 3 approved claims');
  end if;
  if (select count(*) from public.employees where id in ('e7170000-0000-4000-8000-0000000e0001','e7170000-0000-4000-8000-0000000e0002') and pin_hash is not null) <> 2 then
    insert into r717_fail(label, detail) values ('allowed', 'owner/manager PIN not set');
  end if;
  if (select pin_hash from public.employees where id = 'e7170000-0000-4000-8000-0000000e0003') is not null then
    insert into r717_fail(label, detail) values ('allowed', 'accountant set a PIN');
  end if;
end $$;

-- ── Verdict ───────────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  select string_agg(format('  FAIL %s: %s', label, detail), E'\n' order by n) into v from r717_fail;
  if v is not null then
    raise exception E'r717_payroll_roles — % failure(s):\n%', (select count(*) from r717_fail), v;
  end if;
  raise notice 'PASS r717_payroll_roles';
end $$;

rollback;
