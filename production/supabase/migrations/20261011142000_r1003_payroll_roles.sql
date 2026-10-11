-- deploy-key: r1003payroll
-- deploy-peek: exists(select 1 from pg_policy where polname = 'salary_payments_select_money_roles' and polrelid = to_regclass('public.salary_payments') and pg_get_expr(polqual, polrelid) like '%accountant%' and pg_get_expr(polqual, polrelid) not like '%billing%') and exists(select 1 from pg_policy where polname = 'employee_loans_update_roles' and polrelid = to_regclass('public.employee_loans') and pg_get_expr(polqual, polrelid) like '%accountant%' and pg_get_expr(polqual, polrelid) not like '%billing%')
-- 20261011142000_r1003_payroll_roles.sql
--
-- R-1003 (P1 SECURITY, launch blocker, data-leak audit 11 Oct 2026): salary rows are for the
-- payroll roles only. Pardeep's R-718 role table: money = owner / manager / accountant /
-- billing; PAYROLL = owner / manager / accountant; sales / support / delivery none.
--
-- SUPERSEDES the 7 Oct decision "billing sees Payroll read-only" (R-254,
-- 20261007053000_billing_reads_salary_payments): billing no longer reads salaries.
--
-- ══ WHAT WAS OPEN, measured on the local DB 11 Oct ═══════════════════════════════
--   salary_payments SELECT   owner, manager, accountant, billing (20261007053000) — a billing
--                            login read every salary, net pay, TDS / PF / ESI by employee.
--   employee_loans  write    owner, manager, accountant, billing (20261011083000, R-719 — set
--                            to the roles of the Loans & Salary Advances page, which billing
--                            no longer has after this card).
--
-- ══ ROLE TABLE after this migration (every role, stated explicitly) ═══════════════
--
--   role            salary_payments read   salary_payments write   employee_loans write
--   owner           yes                    yes                     yes
--   manager         yes                    yes                     yes
--   accountant      yes                    yes                     yes
--   billing         NO  (was yes, R-254)   no                      NO  (was yes, R-719)
--   sales           no                     no                      no
--   sales_senior    no                     no                      no
--   support         no                     no                      no
--   delivery        no                     no                      no
--   partner_agent   no                     no                      no
--   service_role    unchanged — any service_role policy on these tables is NOT touched
--                   (only the two named role policies below are dropped / re-created).
--
--   salary_payments insert / update / delete stay owner / manager / accountant
--   (salary_payments_{insert,update,delete}_money_roles, 20260930175000) — untouched.
--   employee_loans / employee_loan_repayments READ stays tenant-wide on purpose: an employee's
--   own advance balance is read by My Expenses (expense claims) for every staff role.
--   employees / attendance / leave tables are unchanged: staff mark their own attendance; the
--   registers leave billing's menu and route guard in src/lib/nav.ts (same commit).
--
-- What billing loses on screen (accepted with the decision): Payroll, Salary Register,
-- Employees, Attendance, Leave, Loans & Salary Advances, ESI & PF Register leave its menu AND
-- its route guard; Payments Made shows salary pay-outs without the employee name; the
-- Expenses "unpaid salaries" hint shows nothing for billing.
--
-- Rollback: re-create the two policies with 'billing' added (see 20261007053000 and
-- 20261011083000).
-- Test: supabase/tests/r1003_payroll_roles.test.sql (rolled back).
-- Staging: the deploy script rewrites `to authenticated` / auth.role() as for R-719 (R-161).

begin;

-- ── salary_payments: read = owner / manager / accountant ────────────────────────────
drop policy if exists salary_payments_select_money_roles on public.salary_payments;

create policy salary_payments_select_money_roles on public.salary_payments
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_has_role('owner', 'manager', 'accountant')
  );

-- ── employee_loans: write = owner / manager / accountant (Loans & Salary Advances page) ─
drop policy if exists employee_loans_insert_roles on public.employee_loans;
drop policy if exists employee_loans_update_roles on public.employee_loans;
drop policy if exists employee_loans_delete_roles on public.employee_loans;

create policy employee_loans_insert_roles on public.employee_loans for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy employee_loans_update_roles on public.employee_loans for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy employee_loans_delete_roles on public.employee_loans for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));

commit;
