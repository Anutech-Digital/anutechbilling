-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_payments' and column_name = 'pf_employer_expense_id') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_salary_payment(uuid)') and prosrc like '%employer % cost of this salary%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_salary(uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer)') and prosrc like '%esi_employer_expense_id%') and to_regprocedure('public.edit_salary_payment(uuid,uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer,integer)') is not null
-- deploy-key: r2772salaryundoemployercost
-- 20261114083830_r2772_salary_undo_employer_cost.sql
--
-- R-2772 (p0 money, 14 Nov 2026 — found while building R-2771, Excel owner's report cd1b654a).
--
-- THE BUG. pay_salary books up to three expense rows for one salary: "Salaries" (linked,
-- salary_payments.expense_id), "PF — Employer" and "ESI — Employer" (NOT linked to anything).
-- delete_salary_payment (the payroll "Undo salary", and the first half of every "Edit salary")
-- deleted only the linked Salaries row. So after an Undo the month still carried the employer
-- PF / ESI cost with no salary, and Undo + Pay again — or any Edit — booked that cost TWICE
-- (P&L expense overstated; the PF / ESI payable on the Balance Sheet comes from salary_payments,
-- so it was right and the two no longer agreed). Reproduced on the local DB 14 Nov: gross 20,000,
-- employer PF 1,800 + ESI 618 -> Undo leaves 2,418 -> pay again shows 3,600 + 1,236.
--
-- THE FIX.
--   1. salary_payments.pf_employer_expense_id / esi_employer_expense_id — the real link.
--      pay_salary fills them (its ONLY change: the two ids in its insert; the maths is untouched,
--      body = 20261011070000_r717, the newest definition).
--   2. delete_salary_payment also deletes the employer rows of THAT salary:
--        - linked rows by id;
--        - a salary booked before this migration (no link): the row of the same company with the
--          same category, payment_method 'statutory', amount = the salary row's employer figure,
--          the salary-month expense date, the description pay_salary wrote for that month and the
--          name on that salary's own Salaries expense — and not linked to any salary. ONE row per
--          kind, the newest. An older leftover of an earlier Undo therefore stays (it is listed by
--          scripts/ops/r2772-salary-employer-cost-doubled-report.sql — repairing booked data is
--          the owner's decision, never this function's).
--      An employer row that is itself matched to a bank line / part-paid refuses the Undo with a
--      plain message (as a bank-linked salary already does). Books lock, bank-match and the
--      other expense delete guards keep working through the existing triggers on expenses.
--      The salary row is now locked (for update) while it is undone.
--   3. edit_salary_payment(p_salary_id, <the pay_salary_with_arrears inputs>) — Undo + Pay in ONE
--      transaction (production/CLAUDE.md §17b): if the new booking is refused, the old salary and
--      all its rows are still there. Same employee and month only. SECURITY INVOKER — it only
--      calls the two gated RPCs (role + company checks live there) and reads the row through RLS.
--
-- No data is changed: the new columns start empty; old rows are matched when they are undone.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r2772_salary_undo_employer_cost.test.sql (rolled back).

begin;

alter table public.salary_payments
  add column if not exists pf_employer_expense_id  text references public.expenses(id) on delete set null,
  add column if not exists esi_employer_expense_id text references public.expenses(id) on delete set null;

comment on column public.salary_payments.pf_employer_expense_id is
  'R-2772: the "PF — Employer" expense row pay_salary booked for this salary (null: none, or booked before R-2772).';
comment on column public.salary_payments.esi_employer_expense_id is
  'R-2772: the "ESI — Employer" expense row pay_salary booked for this salary (null: none, or booked before R-2772).';

create index if not exists salary_payments_pf_employer_expense_idx
  on public.salary_payments (pf_employer_expense_id) where pf_employer_expense_id is not null;
create index if not exists salary_payments_esi_employer_expense_idx
  on public.salary_payments (esi_employer_expense_id) where esi_employer_expense_id is not null;

-- ── 1. pay_salary: body of 20261011070000_r717 + the two employer expense ids on the salary row ──
create or replace function public.pay_salary(p_employee_id uuid, p_period text, p_pay_date date, p_gross integer, p_lop_days numeric, p_lop_amount integer, p_advance_recovered integer, p_advance_loan_id uuid, p_tds integer, p_pf integer, p_esi integer, p_other integer, p_bank_account_id uuid, p_notes text DEFAULT NULL::text, p_incentive integer DEFAULT 0, p_esi_employer integer DEFAULT 0, p_pf_employer integer DEFAULT 0, p_pf_wage integer DEFAULT NULL)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp public.employees;
  v_gross integer := greatest(coalesce(p_gross,0),0);
  v_lop_amt integer := greatest(coalesce(p_lop_amount,0),0);
  v_inc integer := greatest(coalesce(p_incentive,0),0);
  v_adv integer := greatest(coalesce(p_advance_recovered,0),0);
  v_tds integer := greatest(coalesce(p_tds,0),0);
  v_pf integer := greatest(coalesce(p_pf,0),0);
  v_esi integer := greatest(coalesce(p_esi,0),0);
  v_esi_emp integer := greatest(coalesce(p_esi_employer,0),0);
  v_pf_emp integer := greatest(coalesce(p_pf_employer,0),0);
  v_other integer := greatest(coalesce(p_other,0),0);
  v_earned integer; v_net integer; v_exp_id text; v_esi_exp_id text; v_pf_exp_id text; v_pay_id uuid;
  v_loan public.employee_loans; v_paid integer; v_outstd integer;
  v_exp_date date;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can pay a salary' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_period is null or p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Salary period must be YYYY-MM'; end if;
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;
  v_earned := greatest(v_gross - v_lop_amt, 0) + v_inc;
  v_net := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;
  if v_net < 0 then raise exception 'Deductions (%) exceed earned pay (%)', v_adv+v_tds+v_pf+v_esi+v_other, v_earned; end if;
  if v_adv > 0 then
    if p_advance_loan_id is null then raise exception 'Pick which advance/loan the recovery reduces'; end if;
    select * into v_loan from public.employee_loans where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount),0) into v_paid from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd; end if;
  end if;

  -- Accrual: the cost sits in the salary month, whatever day it was paid.
  v_exp_date := public.salary_expense_date(p_period, p_pay_date);

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, 'Salaries', v_emp.name, v_exp_date, v_earned, 0, 'payroll',
          'Salary ' || p_period || ' — ' || v_emp.name || case when v_inc > 0 then ' (incl. incentive)' else '' end);

  if v_esi_emp > 0 then
    v_esi_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'E';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_esi_exp_id, v_tenant, 'ESI — Employer', v_emp.name, v_exp_date, v_esi_emp, 0, 'statutory',
            'ESI employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  if v_pf_emp > 0 then
    v_pf_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'P';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_pf_exp_id, v_tenant, 'PF — Employer', v_emp.name, v_exp_date, v_pf_emp, 0, 'statutory',
            'PF employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  -- R-2772: the salary row keeps the ids of its employer PF / ESI expense rows, so Undo can remove them.
  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount, incentive, advance_recovered,
     tds, pf, esi, esi_employer, pf_employer, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status, pf_wage,
     pf_employer_expense_id, esi_employer_expense_id)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days,0), v_lop_amt, v_inc, v_adv,
     v_tds, v_pf, v_esi, v_esi_emp, v_pf_emp, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end, nullif(trim(coalesce(p_notes,'')),''), 'unpaid',
     case when p_pf_wage is null then null else greatest(p_pf_wage, 0) end,
     v_pf_exp_id, v_esi_exp_id)
  returning id into v_pay_id;

  if v_adv > 0 then
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now() where id = p_advance_loan_id;
  end if;
  return v_pay_id;
end; $function$;

revoke all on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer) from public, anon;
grant execute on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer) to authenticated, service_role;

-- ── 2. delete_salary_payment: body of 20261012025800_r885 + the employer PF / ESI rows ──────────
create or replace function public.delete_salary_payment(p_salary_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sp     public.salary_payments;
  v_name   text;
  v_date   date;
  v_pf_id  text;
  v_esi_id text;
  v_e      record;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can undo a salary payment' using errcode = '42501';
  end if;
  -- R-2772: hold the row while it is undone (a bank match or a second Undo waits for this one).
  select * into v_sp from public.salary_payments where id = p_salary_id for update;
  if not found then raise exception 'Salary payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_sp.tenant_id is distinct from v_tenant) then
    raise exception 'Salary payment not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sp.paid_amount > 0 then
    raise exception 'This salary has % reconciled against it — un-reconcile that bank line first, then undo.', v_sp.paid_amount
      using errcode = 'invalid_parameter_value';
  end if;

  /* R-2772: the employer PF / ESI expense rows pay_salary booked for THIS salary.
     Linked (booked since R-2772) → by id. Not linked (booked before) → the one row of this company
     that pay_salary would have written for this salary: same category, 'statutory', the salary
     row's employer figure, the salary-month date, pay_salary's description for the month and the
     name on this salary's own Salaries expense; never a row another salary is linked to. */
  v_pf_id  := v_sp.pf_employer_expense_id;
  v_esi_id := v_sp.esi_employer_expense_id;
  if (v_pf_id is null and v_sp.pf_employer > 0) or (v_esi_id is null and v_sp.esi_employer > 0) then
    select e.vendor_name into v_name from public.expenses e
     where e.id = v_sp.expense_id and e.tenant_id = v_sp.tenant_id;
    if v_name is null then
      select emp.name into v_name from public.employees emp where emp.id = v_sp.employee_id;
    end if;
    v_date := public.salary_expense_date(v_sp.period, v_sp.pay_date);
    if v_pf_id is null and v_sp.pf_employer > 0 then
      select e.id into v_pf_id from public.expenses e
       where e.tenant_id = v_sp.tenant_id and e.category = 'PF — Employer' and e.payment_method = 'statutory'
         and e.amount = v_sp.pf_employer and e.expense_date = v_date and e.vendor_name = v_name
         and e.description = 'PF employer contribution ' || v_sp.period || ' — ' || v_name
         and not exists (select 1 from public.salary_payments s where s.pf_employer_expense_id = e.id)
       order by e.created_at desc, e.id desc limit 1;
    end if;
    if v_esi_id is null and v_sp.esi_employer > 0 then
      select e.id into v_esi_id from public.expenses e
       where e.tenant_id = v_sp.tenant_id and e.category = 'ESI — Employer' and e.payment_method = 'statutory'
         and e.amount = v_sp.esi_employer and e.expense_date = v_date and e.vendor_name = v_name
         and e.description = 'ESI employer contribution ' || v_sp.period || ' — ' || v_name
         and not exists (select 1 from public.salary_payments s where s.esi_employer_expense_id = e.id)
       order by e.created_at desc, e.id desc limit 1;
    end if;
  end if;

  -- An employer row that is itself paid / matched to a bank line: say so, undo nothing.
  for v_e in
    select e.id, e.category from public.expenses e
     where e.tenant_id = v_sp.tenant_id and e.id in (v_pf_id, v_esi_id)
       and (e.reconciled_txn_id is not null or coalesce(e.paid_amount, 0) > 0
            or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id)
            or exists (select 1 from public.bank_transactions t
                        where t.tenant_id = e.tenant_id and t.matched_to_type = 'expense' and t.matched_to_id = e.id))
  loop
    raise exception 'The employer % cost of this salary is matched to a bank line — un-reconcile that bank line first, then undo.',
      case when v_e.category like 'PF%' then 'PF' else 'ESI' end
      using errcode = 'invalid_parameter_value';
  end loop;

  if v_sp.advance_recovered > 0 and v_sp.advance_loan_id is not null then
    delete from public.employee_loan_repayments
     where tenant_id = v_sp.tenant_id and loan_id = v_sp.advance_loan_id
       and method = 'salary_deduction' and amount = v_sp.advance_recovered
       and repaid_on = v_sp.pay_date and notes = 'Recovered from salary ' || v_sp.period;
    update public.employee_loans set status = 'active', updated_at = now()
     where id = v_sp.advance_loan_id;
  end if;

  delete from public.salary_payments where id = p_salary_id;

  if v_sp.expense_id is not null then
    delete from public.expenses where id = v_sp.expense_id and tenant_id = v_sp.tenant_id;
  end if;
  if v_pf_id is not null then
    delete from public.expenses where id = v_pf_id and tenant_id = v_sp.tenant_id and category = 'PF — Employer';
  end if;
  if v_esi_id is not null then
    delete from public.expenses where id = v_esi_id and tenant_id = v_sp.tenant_id and category = 'ESI — Employer';
  end if;
end;
$function$;

revoke all on function public.delete_salary_payment(uuid) from public, anon;
grant execute on function public.delete_salary_payment(uuid) to authenticated, service_role;

-- ── 3. edit_salary_payment: Undo + Pay in one transaction ───────────────────────────────────────
create or replace function public.edit_salary_payment(p_salary_id uuid, p_employee_id uuid, p_period text, p_pay_date date, p_gross integer, p_lop_days numeric, p_lop_amount integer, p_advance_recovered integer, p_advance_loan_id uuid, p_tds integer, p_pf integer, p_esi integer, p_other integer, p_bank_account_id uuid, p_notes text DEFAULT NULL::text, p_incentive integer DEFAULT 0, p_esi_employer integer DEFAULT 0, p_pf_employer integer DEFAULT 0, p_pf_wage integer DEFAULT NULL, p_arrears integer DEFAULT 0)
 returns uuid
 language plpgsql
 security invoker
 set search_path to 'public'
as $function$
declare
  v_emp    uuid;
  v_period text;
begin
  /* R-2772: one call = one transaction. Both halves are the existing RPCs (their role and company
     checks, bank-link refusal, arrears limit, books lock all apply); if the new booking raises,
     the Undo is rolled back with it — the month never ends up without its salary. */
  select s.employee_id, s.period into v_emp, v_period
    from public.salary_payments s where s.id = p_salary_id;
  if not found then
    -- Not there, or not readable by this login (RLS: owner / manager / accountant of the company).
    if coalesce(auth.role(), '') in ('anon', 'authenticated')
       and not public.current_user_has_role('owner', 'manager', 'accountant') then
      raise exception 'Only an owner, manager or accountant can edit a salary' using errcode = '42501';
    end if;
    raise exception 'Salary payment not found';
  end if;
  if v_emp is distinct from p_employee_id or v_period is distinct from p_period then
    raise exception 'Edit changes this month''s salary only — to move it to another month or employee, undo it and pay again.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform public.delete_salary_payment(p_salary_id);
  return public.pay_salary_with_arrears(p_employee_id, p_period, p_pay_date, p_gross, p_lop_days, p_lop_amount,
                                        p_advance_recovered, p_advance_loan_id, p_tds, p_pf, p_esi, p_other,
                                        p_bank_account_id, p_notes, p_incentive, p_esi_employer, p_pf_employer,
                                        p_pf_wage, p_arrears);
end;
$function$;

revoke all on function public.edit_salary_payment(uuid, uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.edit_salary_payment(uuid, uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer, integer) to authenticated, service_role;

commit;
