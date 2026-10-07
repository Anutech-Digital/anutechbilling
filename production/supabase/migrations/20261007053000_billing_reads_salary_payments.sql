-- deploy-key: salarybill
-- deploy-peek: exists(select 1 from pg_policies where schemaname='public' and tablename='salary_payments' and policyname='salary_payments_select_money_roles' and qual like '%billing%')
-- R-254 (7 Oct 2026): billing may READ salary_payments, so the Payroll screen shows the real
-- Paid / Partial / Awaiting-reconcile status instead of an empty column.
--
-- BUG: role hardening (20260930175000) limited the salary_payments SELECT policy to
-- owner / manager / accountant. Billing still had Payroll in the menu (PAYROLL_ROLES in
-- src/lib/nav.ts), so for billing every employee looked unpaid ("Pay salary" on every row,
-- "everyone pending") — someone could pay a salary twice outside the app.
--
-- DECISION (Pardeep, 7 Oct): billing SEES Payroll, read-only. The UI hides every write
-- button for billing (canWriteMoney / MONEY_WRITE_ROLES in src/lib/nav.ts).
--
-- WHAT CHANGES: only the SELECT policy on salary_payments gains 'billing'.
-- WHAT DOES NOT: insert / update / delete stay owner / manager / accountant
-- (salary_payments_{insert,update,delete}_money_roles from 20260930175000 are untouched).
-- Other tables are untouched: employees, bank_accounts and bank_transactions were never
-- read-restricted, only write-restricted.
--
-- Side effect worth knowing: with this applied, billing's Balance Sheet salary lines would
-- be real too. ROUTE_DENY in src/lib/nav.ts still hides the Balance Sheet from billing —
-- lifting that is a separate product call, not part of R-254.
--
-- Rollback: re-run the CREATE POLICY below without 'billing'.

begin;

drop policy if exists salary_payments_select_money_roles on public.salary_payments;

create policy salary_payments_select_money_roles on public.salary_payments
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_has_role('owner', 'manager', 'accountant', 'billing')
  );

commit;
