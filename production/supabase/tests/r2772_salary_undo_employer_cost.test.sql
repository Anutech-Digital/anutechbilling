-- R-2772 — Undo salary removes the employer PF / ESI expense rows too; edit_salary_payment = Undo + Pay
-- in one transaction.
-- Migration: 20261114083830_r2772_salary_undo_employer_cost.sql
--
-- The bug (found while building R-2771, 14 Nov 2026): pay_salary books "Salaries", "PF — Employer"
-- and "ESI — Employer" expense rows; delete_salary_payment (Undo, and the first half of every Edit)
-- deleted only the Salaries row. Undo + Pay again booked the employer PF / ESI cost twice.
-- FAILS without the migration (case A: the link columns do not exist; with only the columns added,
-- case B: "after Undo: ESI:1/975 PF:1/1800"), PASSES with it.
--
--   A   pay Oct (gross 30,000, employer PF 1,800 + ESI 975) → 3 expense rows, both links set.
--   A2  PF / ESI off (employer 0) → only the Salaries row, links empty, Undo leaves nothing.
--   B   Undo → no salary row, NO expense row.   B2  Undo again → "Salary payment not found".
--   C   Pay again → exactly one row of each (PF 1,800, ESI 975 — not 3,600 / 1,950).
--   D   Salaries booked BEFORE the migration (no link): D1 Undo removes both employer rows;
--       D2 with an older leftover of the same amount → ONE row per kind goes, the leftover stays;
--       D3 with a leftover of another amount → the row with this salary's amount goes.
--   E   edit_salary_payment: gross 30,000 → 31,000, employer PF 1,800 → 1,860, ESI 975 → 1,008:
--       one row of each at the new amount, old salary id gone.
--   F   edit whose new booking is refused → the OLD salary and its three rows are all still there.
--   G   refusals: another month / employee; sales login; another company's owner; anon has no
--       execute; a bank-linked salary (Undo and Edit).
--   H   advance recovery: edit 5,000 → 3,000 → one repayment of 3,000, loan open again; Undo → none.
--   I   revision arrears (R-2699): edit of the paying month — its own arrears count as due again;
--       ₹1 more is refused and nothing changes.
--   J   LOP + adjust_salary_lop (R-2428), then Undo → nothing left.
--   K   books lock on the salary month → Undo and Edit refused, every row stays.
--   L   employer ESI row matched to the bank (paid_amount) → Undo refused with a plain message.
--
-- Run: node scripts/test-sql.mjs --local supabase/tests/r2772_salary_undo_employer_cost.test.sql
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2772000-0000-0000-0000-0000000000a1', 'r2772-owner@example.test'),
  ('c2772000-0000-0000-0000-0000000000a2', 'r2772-sales@example.test'),
  ('c2772000-0000-0000-0000-0000000000a3', 'r2772-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2772000-0000-0000-0000-0000000000f0', 'R2772 T', 'r2772@example.test', '07', 'R2772'),
  ('c2772000-0000-0000-0000-0000000000f1', 'R2772 Other', 'r2772o@example.test', '07', 'R2772O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2772000-0000-0000-0000-0000000000a1', 'c2772000-0000-0000-0000-0000000000f0', 'r2772-owner@example.test', 'R2772 Owner', 'owner', true),
  ('c2772000-0000-0000-0000-0000000000a2', 'c2772000-0000-0000-0000-0000000000f0', 'r2772-sales@example.test', 'R2772 Sales', 'sales', true),
  ('c2772000-0000-0000-0000-0000000000a3', 'c2772000-0000-0000-0000-0000000000f1', 'r2772-other@example.test', 'R2772 Other', 'owner', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('c2772000-0000-4000-8000-0000000000b1', 'c2772000-0000-0000-0000-0000000000f0', 'HDFC', 'HDFC', 'current', 500000, '2026-04-01');

insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, joining_date) values
  ('c2772000-0000-4000-8000-0000000000e1', 'c2772000-0000-0000-0000-0000000000f0', 'R2772 Meena', 30000, 15000, '2025-01-01'),
  ('c2772000-0000-4000-8000-0000000000e2', 'c2772000-0000-0000-0000-0000000000f0', 'R2772 Asha',  30000, 15000, '2025-01-01'),
  ('c2772000-0000-4000-8000-0000000000e3', 'c2772000-0000-0000-0000-0000000000f0', 'R2772 Ravi',  30000, 15000, '2025-01-01'),
  ('c2772000-0000-4000-8000-0000000000e4', 'c2772000-0000-0000-0000-0000000000f0', 'R2772 Kiran', 30000, 15000, '2025-01-01'),
  ('c2772000-0000-4000-8000-0000000000e5', 'c2772000-0000-0000-0000-0000000000f0', 'R2772 Lata',  30000, 15000, '2025-01-01');

insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on) values
  ('c2772000-0000-4000-8000-0000000000c1', 'c2772000-0000-0000-0000-0000000000f0', 'R2772 Kiran', 5000, '2026-09-01');

-- What the books hold for one employee (and month): "ESI:<rows>/<₹> PF:<rows>/<₹> SAL:<rows>/<₹>", '' = nothing.
create function pg_temp.r2772_rows(p_name text, p_period text default null) returns text language sql stable as $f$
  select coalesce(string_agg(c || ':' || n || '/' || t, ' ' order by c), '')
    from (select case e.category when 'Salaries' then 'SAL' when 'PF — Employer' then 'PF'
                                 when 'ESI — Employer' then 'ESI' else e.category end as c,
                 count(*) as n, sum(e.amount) as t
            from public.expenses e
           where e.tenant_id = 'c2772000-0000-0000-0000-0000000000f0' and e.vendor_name = p_name
             and (p_period is null or e.description like '% ' || p_period || ' — %')
           group by 1) x
$f$;
grant execute on function pg_temp.r2772_rows(text, text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c2772000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

-- ── A / B / C. The owner's path: pay → Undo → pay again ─────────────────────────────
do $$
declare v_id uuid; v_id2 uuid; v_sal public.salary_payments; v_rows text; v_msg text; v_n int;
begin
  v_id := public.pay_salary('c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 0, 1800, 225, 0,
                            'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000);
  select * into v_sal from public.salary_payments where id = v_id;
  v_rows := pg_temp.r2772_rows('R2772 Meena');
  if v_rows <> 'ESI:1/975 PF:1/1800 SAL:1/30000' then raise exception 'FAIL A1: after pay: %', v_rows; end if;
  if v_sal.pf_employer_expense_id is null or v_sal.esi_employer_expense_id is null then
    raise exception 'FAIL A2: employer expense links not set (% / %)', v_sal.pf_employer_expense_id, v_sal.esi_employer_expense_id;
  end if;
  select count(*) into v_n from public.expenses
   where (id = v_sal.pf_employer_expense_id and category = 'PF — Employer' and amount = 1800)
      or (id = v_sal.esi_employer_expense_id and category = 'ESI — Employer' and amount = 975);
  if v_n <> 2 then raise exception 'FAIL A3: links do not point at the PF / ESI employer rows (%)', v_n; end if;
  if v_sal.net <> 27975 or v_sal.pf_employer <> 1800 or v_sal.esi_employer <> 975 then
    raise exception 'FAIL A4: figures changed: net % pf_employer % esi_employer %', v_sal.net, v_sal.pf_employer, v_sal.esi_employer;
  end if;
  raise notice 'PASS A: pay books Salaries + PF employer + ESI employer, both linked to the salary';

  perform public.delete_salary_payment(v_id);
  v_rows := pg_temp.r2772_rows('R2772 Meena');
  select count(*) into v_n from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e1';
  if v_n <> 0 then raise exception 'FAIL B1: salary row still there'; end if;
  if v_rows <> '' then raise exception 'FAIL B: after Undo the books still hold: % (want nothing)', v_rows; end if;
  begin
    perform public.delete_salary_payment(v_id);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Salary payment not found' then raise exception 'FAIL B2: second Undo: %', v_msg; end if;
  raise notice 'PASS B: Undo removes the salary and all three expense rows; a second Undo finds nothing';

  v_id2 := public.pay_salary('c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 0, 1800, 225, 0,
                             'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000);
  v_rows := pg_temp.r2772_rows('R2772 Meena');
  if v_rows <> 'ESI:1/975 PF:1/1800 SAL:1/30000' then raise exception 'FAIL C: after Undo + Pay again: % (employer cost doubled?)', v_rows; end if;
  raise notice 'PASS C: Undo + Pay again = one row of each (PF 1,800, ESI 975)';
end $$;

-- ── A2. PF / ESI off: no employer row, no link ──────────────────────────────────────
do $$
declare v_id uuid; v_sal public.salary_payments; v_rows text;
begin
  v_id := public.pay_salary('c2772000-0000-4000-8000-0000000000e1', '2026-11', '2026-11-30', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                            'c2772000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  select * into v_sal from public.salary_payments where id = v_id;
  v_rows := pg_temp.r2772_rows('R2772 Meena', '2026-11');
  if v_rows <> 'SAL:1/30000' or v_sal.pf_employer_expense_id is not null or v_sal.esi_employer_expense_id is not null then
    raise exception 'FAIL A2a: % links % / %', v_rows, v_sal.pf_employer_expense_id, v_sal.esi_employer_expense_id;
  end if;
  perform public.delete_salary_payment(v_id);
  if pg_temp.r2772_rows('R2772 Meena', '2026-11') <> '' then raise exception 'FAIL A2b: rows left'; end if;
  if pg_temp.r2772_rows('R2772 Meena', '2026-10') <> 'ESI:1/975 PF:1/1800 SAL:1/30000' then
    raise exception 'FAIL A2c: Undo of Nov touched Oct: %', pg_temp.r2772_rows('R2772 Meena', '2026-10');
  end if;
  raise notice 'PASS A2: no employer share → no employer row, Undo touches only its own month';
end $$;

-- ── D. Salaries booked before the migration (no link) ───────────────────────────────
-- D1: plain old row. Paid on 5 Oct for September → the cost sits on 30 Sep.
select public.pay_salary('c2772000-0000-4000-8000-0000000000e3', '2026-09', '2026-10-05', 30000, 0, 0, 0, null, 0, 1800, 225, 0,
                         'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000);
reset role;
update public.salary_payments set pf_employer_expense_id = null, esi_employer_expense_id = null
 where employee_id = 'c2772000-0000-4000-8000-0000000000e3';
set local role authenticated;
do $$
declare v_id uuid; v_rows text;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e3' and period = '2026-09';
  perform public.delete_salary_payment(v_id);
  v_rows := pg_temp.r2772_rows('R2772 Ravi');
  if v_rows <> '' then raise exception 'FAIL D1: old (unlinked) salary: after Undo %', v_rows; end if;
  raise notice 'PASS D1: a salary booked before R-2772 — Undo finds and removes its employer rows';
end $$;

-- D2: an older leftover of the same amount already sits there (an Undo before the fix).
-- D3: a leftover of ANOTHER amount in August.
reset role;
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, created_at) values
  ('EXP-R2772-LEFT-P', 'c2772000-0000-0000-0000-0000000000f0', 'PF — Employer', 'R2772 Ravi', '2026-09-30', 1800, 0, 'statutory',
   'PF employer contribution 2026-09 — R2772 Ravi', '2026-10-06T10:00:00Z'),
  ('EXP-R2772-LEFT-A', 'c2772000-0000-0000-0000-0000000000f0', 'PF — Employer', 'R2772 Ravi', '2026-08-31', 1500, 0, 'statutory',
   'PF employer contribution 2026-08 — R2772 Ravi', '2026-09-06T10:00:00Z');
set local role authenticated;
select public.pay_salary('c2772000-0000-4000-8000-0000000000e3', '2026-09', '2026-10-05', 30000, 0, 0, 0, null, 0, 1800, 225, 0,
                         'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000);
select public.pay_salary('c2772000-0000-4000-8000-0000000000e3', '2026-08', '2026-08-31', 30000, 0, 0, 0, null, 0, 1800, 225, 0,
                         'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000);
reset role;
update public.salary_payments set pf_employer_expense_id = null, esi_employer_expense_id = null
 where employee_id = 'c2772000-0000-4000-8000-0000000000e3';
set local role authenticated;
do $$
declare v_id uuid; v_rows text; v_n int;
begin
  if pg_temp.r2772_rows('R2772 Ravi', '2026-09') <> 'ESI:1/975 PF:2/3600 SAL:1/30000' then
    raise exception 'FAIL D2 setup: %', pg_temp.r2772_rows('R2772 Ravi', '2026-09');
  end if;
  select id into v_id from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e3' and period = '2026-09';
  perform public.delete_salary_payment(v_id);
  v_rows := pg_temp.r2772_rows('R2772 Ravi', '2026-09');
  if v_rows <> 'PF:1/1800' then raise exception 'FAIL D2: want one PF row left (the older leftover), got %', v_rows; end if;
  select count(*) into v_n from public.expenses where id = 'EXP-R2772-LEFT-P';
  if v_n <> 1 then raise exception 'FAIL D2b: the OLDER leftover was removed instead of this salary''s row'; end if;

  select id into v_id from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e3' and period = '2026-08';
  perform public.delete_salary_payment(v_id);
  v_rows := pg_temp.r2772_rows('R2772 Ravi', '2026-08');
  if v_rows <> 'PF:1/1500' then raise exception 'FAIL D3: want only the 1,500 leftover, got %', v_rows; end if;
  raise notice 'PASS D2/D3: one row per kind, matched on the salary''s own amount; older leftovers stay for the report';
end $$;

-- ── E. edit_salary_payment: one call ────────────────────────────────────────────────
do $$
declare v_old uuid; v_new uuid; v_sal public.salary_payments; v_rows text; v_n int;
begin
  select id into v_old from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e1' and period = '2026-10';
  v_new := public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 31000, 0, 0, 0, null, 0, 1860, 233, 0,
                                      'c2772000-0000-4000-8000-0000000000b1', 'raised', 0, 1008, 1860, 15500, 0);
  select * into v_sal from public.salary_payments where id = v_new;
  select count(*) into v_n from public.salary_payments where id = v_old;
  v_rows := pg_temp.r2772_rows('R2772 Meena');
  if v_n <> 0 or v_new = v_old then raise exception 'FAIL E1: old salary row still there'; end if;
  if v_rows <> 'ESI:1/1008 PF:1/1860 SAL:1/31000' then raise exception 'FAIL E2: after edit: %', v_rows; end if;
  if v_sal.gross <> 31000 or v_sal.net <> 28907 or v_sal.pf_employer <> 1860 or v_sal.esi_employer <> 1008
     or v_sal.pf_wage <> 15500 or v_sal.notes <> 'raised' or v_sal.paid_status <> 'unpaid' then
    raise exception 'FAIL E3: gross % net % pf_emp % esi_emp % wage % notes %', v_sal.gross, v_sal.net, v_sal.pf_employer, v_sal.esi_employer, v_sal.pf_wage, v_sal.notes;
  end if;
  raise notice 'PASS E: edit = one salary, one row of each at the new amounts';
end $$;

-- ── F. edit whose new booking is refused keeps the old salary ───────────────────────
do $$
declare v_old uuid; v_msg text; v_rows text; v_n int;
begin
  select id into v_old from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e1' and period = '2026-10';
  begin
    perform public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 31000, 0, 0, 0, null, 99999, 1860, 233, 0,
                                       'c2772000-0000-4000-8000-0000000000b1', null, 0, 1008, 1860, 15500, 0);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'Deductions (%) exceed earned pay (%)' then raise exception 'FAIL F1: %', v_msg; end if;
  v_msg := null;
  begin
    perform public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 31000, 0, 0, 0, null, 0, 1860, 233, 0,
                                       'c2772000-0000-4000-8000-00000000dead', null, 0, 1008, 1860, 15500, 0);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Pay-out account not found' then raise exception 'FAIL F2: %', v_msg; end if;
  select count(*) into v_n from public.salary_payments where id = v_old and gross = 31000;
  v_rows := pg_temp.r2772_rows('R2772 Meena');
  if v_n <> 1 or v_rows <> 'ESI:1/1008 PF:1/1860 SAL:1/31000' then
    raise exception 'FAIL F3: a refused edit changed the books: salary rows % / %', v_n, v_rows;
  end if;
  raise notice 'PASS F: a refused edit leaves the old salary and its rows exactly as they were';
end $$;

-- ── G. Refusals ─────────────────────────────────────────────────────────────────────
do $$
declare v_old uuid; v_msg text; v_state text; v_rows text; v_n int;
begin
  select id into v_old from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e1' and period = '2026-10';
  -- another month / another employee
  begin
    perform public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e1', '2026-12', '2026-12-31', 31000, 0, 0, 0, null, 0, 0, 0, 0,
                                       'c2772000-0000-4000-8000-0000000000b1');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'Edit changes this month''s salary only%' then raise exception 'FAIL G1: %', v_msg; end if;
  v_msg := null;
  begin
    perform public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e2', '2026-10', '2026-10-31', 31000, 0, 0, 0, null, 0, 0, 0, 0,
                                       'c2772000-0000-4000-8000-0000000000b1');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'Edit changes this month''s salary only%' then raise exception 'FAIL G2: %', v_msg; end if;

  -- sales login of the same company
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2772000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  v_msg := null; v_state := null;
  begin
    perform public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 1, 0, 0, 0, null, 0, 0, 0, 0,
                                       'c2772000-0000-4000-8000-0000000000b1');
  exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
  if v_state is distinct from '42501' then raise exception 'FAIL G3: sales edit: % (%)', v_msg, v_state; end if;
  v_msg := null; v_state := null;
  begin
    perform public.delete_salary_payment(v_old);
  exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
  if v_state is distinct from '42501' then raise exception 'FAIL G4: sales undo: % (%)', v_msg, v_state; end if;

  -- another company's owner
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2772000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  v_msg := null;
  begin
    perform public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 1, 0, 0, 0, null, 0, 0, 0, 0,
                                       'c2772000-0000-4000-8000-0000000000b1');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then raise exception 'FAIL G5: another company''s owner edited the salary'; end if;
  v_msg := null;
  begin
    perform public.delete_salary_payment(v_old);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then raise exception 'FAIL G6: another company''s owner undid the salary'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c2772000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.salary_payments where id = v_old and gross = 31000;
  v_rows := pg_temp.r2772_rows('R2772 Meena');
  if v_n <> 1 or v_rows <> 'ESI:1/1008 PF:1/1860 SAL:1/31000' then raise exception 'FAIL G7: a refused call changed the books: % / %', v_n, v_rows; end if;

  if has_function_privilege('anon', 'public.edit_salary_payment(uuid,uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer,integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.edit_salary_payment(uuid,uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer,integer)', 'execute')
     or has_function_privilege('anon', 'public.delete_salary_payment(uuid)', 'execute')
     or has_function_privilege('anon', 'public.pay_salary(uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer)', 'execute') then
    raise exception 'FAIL G8: grants wrong (anon must not, authenticated must execute edit_salary_payment)';
  end if;
  raise notice 'PASS G: other month / employee, sales, another company, anon — all refused, nothing changed';
end $$;

-- bank-linked salary: Undo and Edit refused as before
reset role;
update public.salary_payments set paid_amount = 1000, paid_status = 'partial'
 where employee_id = 'c2772000-0000-4000-8000-0000000000e1' and period = '2026-10';
set local role authenticated;
do $$
declare v_old uuid; v_msg text; v_rows text;
begin
  select id into v_old from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e1' and period = '2026-10';
  begin
    perform public.edit_salary_payment(v_old, 'c2772000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 32000, 0, 0, 0, null, 0, 0, 0, 0,
                                       'c2772000-0000-4000-8000-0000000000b1');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'This salary has 1000 reconciled against it%' then raise exception 'FAIL G9: bank-linked edit: %', v_msg; end if;
  v_msg := null;
  begin
    perform public.delete_salary_payment(v_old);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'This salary has 1000 reconciled against it%' then raise exception 'FAIL G10: bank-linked undo: %', v_msg; end if;
  v_rows := pg_temp.r2772_rows('R2772 Meena');
  if v_rows <> 'ESI:1/1008 PF:1/1860 SAL:1/31000' then raise exception 'FAIL G11: %', v_rows; end if;
  raise notice 'PASS G9-11: a bank-linked salary can be neither undone nor edited';
end $$;

-- ── H. Advance recovery follows the edit ────────────────────────────────────────────
do $$
declare v_id uuid; v_id2 uuid; v_n int; v_sum int; v_status text;
begin
  v_id := public.pay_salary('c2772000-0000-4000-8000-0000000000e4', '2026-10', '2026-10-31', 30000, 0, 0, 5000, 'c2772000-0000-4000-8000-0000000000c1', 0, 1800, 225, 0,
                            'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000);
  select status into v_status from public.employee_loans where id = 'c2772000-0000-4000-8000-0000000000c1';
  if v_status <> 'closed' then raise exception 'FAIL H0: loan % after full recovery', v_status; end if;
  v_id2 := public.edit_salary_payment(v_id, 'c2772000-0000-4000-8000-0000000000e4', '2026-10', '2026-10-31', 30000, 0, 0, 3000, 'c2772000-0000-4000-8000-0000000000c1', 0, 1800, 225, 0,
                                      'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000, 0);
  select count(*), coalesce(sum(amount), 0) into v_n, v_sum from public.employee_loan_repayments where loan_id = 'c2772000-0000-4000-8000-0000000000c1';
  select status into v_status from public.employee_loans where id = 'c2772000-0000-4000-8000-0000000000c1';
  if v_n <> 1 or v_sum <> 3000 or v_status <> 'active' then raise exception 'FAIL H1: repayments % / ₹% loan %', v_n, v_sum, v_status; end if;
  if (select net from public.salary_payments where id = v_id2) <> 24975 then raise exception 'FAIL H2: net'; end if;
  if pg_temp.r2772_rows('R2772 Kiran') <> 'ESI:1/975 PF:1/1800 SAL:1/30000' then raise exception 'FAIL H3: %', pg_temp.r2772_rows('R2772 Kiran'); end if;
  perform public.delete_salary_payment(v_id2);
  select count(*) into v_n from public.employee_loan_repayments where loan_id = 'c2772000-0000-4000-8000-0000000000c1';
  if v_n <> 0 or pg_temp.r2772_rows('R2772 Kiran') <> '' then raise exception 'FAIL H4: after Undo repayments % rows %', v_n, pg_temp.r2772_rows('R2772 Kiran'); end if;
  raise notice 'PASS H: advance recovery 5,000 → 3,000 by edit = one repayment of 3,000; Undo = none';
end $$;

-- ── I. Revision arrears (R-2699) ride through an edit ───────────────────────────────
select public.pay_salary('c2772000-0000-4000-8000-0000000000e2', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                         'c2772000-0000-4000-8000-0000000000b1', null);
reset role;
update public.salary_payments set created_at = '2026-11-01T10:00:00Z' where employee_id = 'c2772000-0000-4000-8000-0000000000e2';
set local role authenticated;
do $$
declare v_id uuid; v_id2 uuid; v_msg text; v_sal public.salary_payments; v_rows text;
begin
  perform public.revise_employee_salary('c2772000-0000-4000-8000-0000000000e2', '2026-10-01', 36000, 18000, 0, null, 'raise');
  v_id := public.pay_salary_with_arrears('c2772000-0000-4000-8000-0000000000e2', '2026-11', '2026-11-30', 36000, 0, 0, 0, null, 0, 1800, 0, 0,
                                         'c2772000-0000-4000-8000-0000000000b1', null, 0, 0, 1800, 15000, 6000);
  -- one rupee more than is due (its own 6,000 counts as due again inside the edit)
  begin
    perform public.edit_salary_payment(v_id, 'c2772000-0000-4000-8000-0000000000e2', '2026-11', '2026-11-30', 36000, 0, 0, 0, null, 0, 1800, 0, 0,
                                       'c2772000-0000-4000-8000-0000000000b1', null, 0, 0, 1800, 15000, 6001);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'Arrears ₹6001 is more than the ₹6000 still due for this employee.' then raise exception 'FAIL I1: %', v_msg; end if;
  select * into v_sal from public.salary_payments where id = v_id;
  if v_sal.arrears is distinct from 6000 then raise exception 'FAIL I2: refused edit changed the salary (arrears %)', v_sal.arrears; end if;

  v_id2 := public.edit_salary_payment(v_id, 'c2772000-0000-4000-8000-0000000000e2', '2026-11', '2026-11-30', 36000, 0, 0, 0, null, 500, 1800, 0, 0,
                                      'c2772000-0000-4000-8000-0000000000b1', null, 1000, 0, 1800, 15000, 6000);
  select * into v_sal from public.salary_payments where id = v_id2;
  v_rows := pg_temp.r2772_rows('R2772 Asha', '2026-11');
  if v_sal.arrears <> 6000 or v_sal.incentive <> 7000 or v_sal.tds <> 500 or v_sal.net <> 40700 then
    raise exception 'FAIL I3: arrears % incentive % tds % net %', v_sal.arrears, v_sal.incentive, v_sal.tds, v_sal.net;
  end if;
  if v_rows <> 'PF:1/1800 SAL:1/43000' then raise exception 'FAIL I4: %', v_rows; end if;
  raise notice 'PASS I: arrears 6,000 stay through the edit; 6,001 refused with nothing changed';
end $$;

-- ── J. LOP, adjust_salary_lop, then Undo ────────────────────────────────────────────
do $$
declare v_id uuid;
begin
  v_id := public.pay_salary('c2772000-0000-4000-8000-0000000000e4', '2026-11', '2026-11-30', 30000, 2, 2000, 0, null, 0, 1680, 210, 0,
                            'c2772000-0000-4000-8000-0000000000b1', null, 0, 910, 1680, 14000);
  perform public.adjust_salary_lop(v_id, 3, 3000, 'one more day absent');
  if pg_temp.r2772_rows('R2772 Kiran') <> 'ESI:1/910 PF:1/1680 SAL:1/27000' then raise exception 'FAIL J1: %', pg_temp.r2772_rows('R2772 Kiran'); end if;
  perform public.delete_salary_payment(v_id);
  if pg_temp.r2772_rows('R2772 Kiran') <> '' then raise exception 'FAIL J2: after Undo %', pg_temp.r2772_rows('R2772 Kiran'); end if;
  raise notice 'PASS J: a salary whose LOP was adjusted is undone completely';
end $$;

-- ── K. Books lock ───────────────────────────────────────────────────────────────────
select public.pay_salary('c2772000-0000-4000-8000-0000000000e5', '2026-07', '2026-07-31', 30000, 0, 0, 0, null, 0, 1800, 225, 0,
                         'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000);
reset role;
update public.tenants set books_locked_until = '2026-07-31' where id = 'c2772000-0000-0000-0000-0000000000f0';
set local role authenticated;
do $$
declare v_id uuid; v_msg text; v_n int;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e5' and period = '2026-07';
  begin
    perform public.delete_salary_payment(v_id);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then raise exception 'FAIL K1: Undo in a locked month went through'; end if;
  v_msg := null;
  begin
    perform public.edit_salary_payment(v_id, 'c2772000-0000-4000-8000-0000000000e5', '2026-07', '2026-07-31', 31000, 0, 0, 0, null, 0, 1800, 225, 0,
                                       'c2772000-0000-4000-8000-0000000000b1', null, 0, 975, 1800, 15000, 0);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then raise exception 'FAIL K2: Edit in a locked month went through'; end if;
  select count(*) into v_n from public.salary_payments where id = v_id and gross = 30000;
  if v_n <> 1 or pg_temp.r2772_rows('R2772 Lata') <> 'ESI:1/975 PF:1/1800 SAL:1/30000' then
    raise exception 'FAIL K3: locked month changed: % / %', v_n, pg_temp.r2772_rows('R2772 Lata');
  end if;
  raise notice 'PASS K: books lock refuses Undo and Edit; every row stays';
end $$;
reset role;
update public.tenants set books_locked_until = null where id = 'c2772000-0000-0000-0000-0000000000f0';

-- ── L. Employer ESI row matched to the bank ─────────────────────────────────────────
update public.expenses set paid_amount = 975
 where tenant_id = 'c2772000-0000-0000-0000-0000000000f0' and vendor_name = 'R2772 Lata' and category = 'ESI — Employer';
set local role authenticated;
do $$
declare v_id uuid; v_msg text; v_n int;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e5' and period = '2026-07';
  begin
    perform public.delete_salary_payment(v_id);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'The employer ESI cost of this salary is matched to a bank line — un-reconcile that bank line first, then undo.' then
    raise exception 'FAIL L1: %', v_msg;
  end if;
  select count(*) into v_n from public.salary_payments where id = v_id;
  if v_n <> 1 or pg_temp.r2772_rows('R2772 Lata') <> 'ESI:1/975 PF:1/1800 SAL:1/30000' then
    raise exception 'FAIL L2: refused Undo changed the books: % / %', v_n, pg_temp.r2772_rows('R2772 Lata');
  end if;
  raise notice 'PASS L: an employer row matched to the bank refuses the Undo, nothing changes';
end $$;
reset role;
update public.expenses set paid_amount = 0
 where tenant_id = 'c2772000-0000-0000-0000-0000000000f0' and vendor_name = 'R2772 Lata' and category = 'ESI — Employer';
set local role authenticated;
do $$
declare v_id uuid;
begin
  select id into v_id from public.salary_payments where employee_id = 'c2772000-0000-4000-8000-0000000000e5' and period = '2026-07';
  perform public.delete_salary_payment(v_id);
  if pg_temp.r2772_rows('R2772 Lata') <> '' then raise exception 'FAIL L3: %', pg_temp.r2772_rows('R2772 Lata'); end if;
  raise notice 'PASS r2772_salary_undo_employer_cost';
end $$;

rollback;
