-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_bank_account(uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_business_loan(uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_customer(uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_employee_loan(uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_expense_claim(uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_salary_payment(uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.disburse_employee_loan(text,integer,date,uuid,text,text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.edit_employee_loan(uuid,text,integer,date,uuid,text,text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.edit_expense_claim(uuid,integer,text,text,date)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.generate_invoice(text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_statutory_dues(integer,text,date,uuid,text,text,text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_expenses_to_bank_txn(uuid,text[])') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_salaries_to_bank_txn(uuid,uuid[])') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_business_loan(text,text,integer,numeric,integer,integer,date,uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_emi_payment(uuid,integer,integer,date,uuid,text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_emi_purchase(text,text,integer,integer,integer,integer,date,uuid,text,text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_employee_loan_repayment(uuid,integer,date,text,uuid,text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_loan_emi(uuid,integer,integer,date,uuid,text)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_project_payment(uuid,integer,text,text,date,uuid)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_project_receipt_with_tds(uuid,integer,integer,text,numeric,integer,date,uuid,text,boolean)') and prosrc like '%R-885%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reject_expense_claim(uuid,text)') and prosrc like '%R-885%')
-- deploy-key: r885moneyroles
-- 20261012025800_r885_money_roles_more.sql
--
-- R-885 (R-718b, P1 SECURITY, launch audit 11 Oct 2026): the remaining money SECURITY DEFINER
-- functions check the caller's ROLE, not just the company.
--
-- ══ WHAT WAS OPEN, measured on the local DB 11 Oct ═══════════════════════════════
--
--   Every function below checked only the tenant (or nothing beyond "row is in my company").
--   A definer skips RLS, so any member of the company — sales, support, delivery — could
--   delete a customer or a bank account, issue a GST invoice, give themselves a staff loan,
--   pay "statutory dues" out of the bank, record a business loan / EMI, match bank lines,
--   reject or edit expense claims, undo salaries.
--   (supabase/tests/r885_money_roles_more.test.sql: 150 failures on the old bodies — sales
--   deleted a customer and a bank account and issued an invoice, all for real.)
--   R-718 (20261011120000) already gated unreconcile_bank_receipt and book_bank_txn_as_*;
--   R-717 (20261011070000) pay_salary / advances / approve_expense_claim — not redone here.
--
-- ══ WHAT CHANGES (guards only — bodies are the newest definitions, money maths untouched) ═
--
--   Pardeep's role table (R-718, 11 Oct 2026), per function:
--   (rec) owner, manager, accountant, billing — record / issue / raise / reconcile:
--         generate_invoice, raise_subscription_billing, record_project_payment,
--         record_project_receipt_with_tds, reconcile_expenses_to_bank_txn,
--         record_business_loan, record_loan_emi, record_emi_purchase, record_emi_payment
--   (pay) owner, manager, accountant — salary / loan / expense claim / statutory (R-717 rule;
--         billing is not on payroll since R-1003):
--         disburse_employee_loan, edit_employee_loan, record_employee_loan_repayment,
--         pay_statutory_dues, reconcile_salaries_to_bank_txn, reject_expense_claim,
--         edit_expense_claim, delete_salary_payment (*)
--   (del) owner, accountant — deletes:
--         delete_customer, delete_bank_account, delete_employee_loan, delete_expense_claim,
--         delete_business_loan
--   sales, sales_senior, support, delivery, partner_agent, a no-company login: none.
--   (*) delete_salary_payment is the payroll "Undo" AND the first half of "Edit salary"
--       (undo + pay again; it refuses once the salary is reconciled), so it follows pay_salary
--       (owner / manager / accountant) — under the delete rule a manager could pay a salary but
--       not correct it.
--
--   Trust rule as R-454 / R-714 / R-717 / R-718: service_role or a direct DB session with no
--   request role is trusted. Callers checked 12 Oct:
--     generate_invoice      browser (Invoices queue, quote page, record-payment dialog, quote
--                           builder invoice mode, Subscriptions after a payment) — all money
--                           roles; the Razorpay webhook / online checkout (admin client =
--                           service_role). Inside SQL: record_payment, create_direct_invoice
--                           (both R-718-gated to the same roles), raise_subscription_billing
--                           (gated here) and activate_quote_on_credit.
--     raise_subscription_billing  billing cron, raise-instalments route, online checkout,
--                           seat increase — all createAdminClient / createAdminClientFor
--                           (service_role, unaffected). Inside SQL: activate_quote_on_credit.
--     activate_quote_on_credit ("Activate now, pay later") is open to any active member of the
--       company by design (over-limit and annual plans = owner only; credit_annual_block test:
--       "monthly-only quote activates for sales") and calls generate_invoice /
--       raise_subscription_billing with the SAME caller. Those two therefore let a call through
--       when PG_CONTEXT (the real PL/pgSQL call stack — not settable from a browser, and only
--       the migration owner can create functions) shows public.activate_quote_on_credit as the
--       caller; a pg_temp function of the same name does not match (test proves it).
--     record_project_payment  also called by record_project_receipt_with_tds — same role group.
--     Everything else: the signed-in browser client only (lib/queries/*).
--   generate_invoice / raise_subscription_billing keep R-454's no-company refusal (28000) first;
--   the role gate sits right after it (r714 / tenant_guard_fail_closed tests unchanged).
--   Refusal: SQLSTATE 42501 "Only an owner, manager, accountant or billing user can …" /
--   "Only an owner, manager or accountant can …" / "Only an owner or accountant user can …".
--   Tenant match is unchanged in every body.
--
-- Source of the bodies: pg_get_functiondef on the local DB at manager-pardeep 1f41bf61
-- (generate_invoice / raise_subscription_billing = 20261010190000_tenant_guard_fail_closed;
-- delete_customer = 20260926130000; pay_statutory_dues = 20260927130000;
-- record_project_receipt_with_tds = 20260926100000; the rest baseline.sql — no later migration
-- redefines any of them, re-checked 12 Oct). Signatures unchanged → grants and comments kept.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r885_money_roles_more.test.sql (rolled back).

begin;

CREATE OR REPLACE FUNCTION public.delete_bank_account(p_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — delete group: owner, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a bank account' using errcode = '42501';
  end if;
  perform 1 from public.bank_accounts
    where id = p_account_id and tenant_id = v_tenant;
  if not found then
    raise exception 'Bank account not found';
  end if;

  delete from public.bank_accounts
    where id = p_account_id and tenant_id = v_tenant;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_business_loan(p_loan_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_l      public.business_loans;
  v_pays   integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — delete group: owner, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a business loan' using errcode = '42501';
  end if;
  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select count(*) into v_pays from public.business_loan_payments where loan_id = p_loan_id;
  if v_pays > 0 then
    raise exception 'This loan has % EMI payment(s) recorded — delete those first', v_pays;
  end if;

  if v_l.deposit_account_id is not null then
    delete from public.bank_transactions
     where tenant_id = v_tenant
       and bank_account_id = v_l.deposit_account_id
       and txn_date = v_l.disbursed_on
       and credit = v_l.principal
       and description = 'Loan received: ' || v_l.lender;
  end if;

  delete from public.business_loans where id = p_loan_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_customer(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant      uuid;
  v_caller      uuid;
  v_is_service  boolean;
  v_subs        integer;
  v_pays        integer;
  v_invs        integer;
  v_quotes      integer;
  v_projs       integer;
  v_credits     integer;
  v_debits      integer;
  v_tds         integer;
  v_name        text;
  v_parts       text[] := array[]::text[];
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — delete group: owner, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a customer' using errcode = '42501';
  end if;
  v_is_service := auth.role() = 'service_role';

  select tenant_id, name into v_tenant, v_name
    from public.customers where id = p_customer_id;
  if not found then
    raise exception 'customer % not found', p_customer_id;
  end if;

  if not v_is_service then
    v_caller := public.current_tenant_id();
    if v_caller is null or v_caller <> v_tenant then
      raise exception 'customer % does not belong to your tenant', p_customer_id;
    end if;
  end if;

  select count(*) into v_subs    from public.subscriptions  where customer_id = p_customer_id;
  select count(*) into v_pays    from public.payments       where customer_id = p_customer_id;
  select count(*) into v_invs    from public.invoices       where customer_id = p_customer_id;
  select count(*) into v_quotes  from public.quotes         where customer_id = p_customer_id;
  select count(*) into v_projs   from public.project_sales  where customer_id = p_customer_id;
  -- R-007: these three are legal records too, and nothing counted them. A customer
  -- holding only a credit note was deletable through the front door.
  select count(*) into v_credits from public.credit_notes   where customer_id = p_customer_id;
  select count(*) into v_debits  from public.debit_notes    where customer_id = p_customer_id;
  select count(*) into v_tds     from public.tds_receivable where customer_id = p_customer_id;

  if v_subs    > 0 then v_parts := v_parts || format('%s subscription(s)', v_subs);   end if;
  if v_pays    > 0 then v_parts := v_parts || format('%s payment(s)',      v_pays);    end if;
  if v_invs    > 0 then v_parts := v_parts || format('%s invoice(s)',      v_invs);    end if;
  if v_quotes  > 0 then v_parts := v_parts || format('%s quote(s)',        v_quotes);  end if;
  if v_projs   > 0 then v_parts := v_parts || format('%s project(s)',      v_projs);   end if;
  if v_credits > 0 then v_parts := v_parts || format('%s credit note(s)',  v_credits); end if;
  if v_debits  > 0 then v_parts := v_parts || format('%s debit note(s)',   v_debits);  end if;
  if v_tds     > 0 then v_parts := v_parts || format('%s TDS entry(s)',    v_tds);     end if;

  if array_length(v_parts, 1) is not null then
    raise exception
      'Cannot delete customer "%": has %. Those are financial records and must keep their customer. Archive the customer instead (Customers -> the customer -> Archive), which hides it everywhere without touching the books.',
      v_name, array_to_string(v_parts, ', ');
  end if;

  delete from public.customers where id = p_customer_id and tenant_id = v_tenant;

  return jsonb_build_object('deleted', true, 'customer_id', p_customer_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_employee_loan(p_loan_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   public.employee_loans;
  v_paid   integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — delete group: owner, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete an employee loan' using errcode = '42501';
  end if;
  select * into v_loan from public.employee_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before deleting.';
  end if;

  if v_loan.bank_account_id is not null then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, v_loan.bank_account_id, (now() at time zone 'Asia/Kolkata')::date,
       'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
  end if;

  delete from public.employee_loans where id = p_loan_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_expense_claim(p_claim_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid := public.current_tenant_id(); v_status text;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — delete group: owner, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete an expense claim' using errcode = '42501';
  end if;
  select status into v_status from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_status <> 'pending' then raise exception 'Only pending claims can be deleted'; end if;
  delete from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
end; $function$
;

CREATE OR REPLACE FUNCTION public.delete_salary_payment(p_salary_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sp     public.salary_payments;
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
  select * into v_sp from public.salary_payments where id = p_salary_id;
  if not found then raise exception 'Salary payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_sp.tenant_id is distinct from v_tenant) then
    raise exception 'Salary payment not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sp.paid_amount > 0 then
    raise exception 'This salary has % reconciled against it — un-reconcile that bank line first, then undo.', v_sp.paid_amount
      using errcode = 'invalid_parameter_value';
  end if;

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
end;
$function$
;

CREATE OR REPLACE FUNCTION public.disburse_employee_loan(p_employee_name text, p_principal integer, p_disbursed_on date, p_bank_account_id uuid, p_kind text DEFAULT 'loan'::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   uuid;
  v_acct   text;
  v_kind   text := coalesce(nullif(trim(p_kind), ''), 'loan');
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can give an employee loan or advance' using errcode = '42501';
  end if;
  if p_principal is null or p_principal <= 0 then
    raise exception 'Amount must be positive';
  end if;
  if trim(coalesce(p_employee_name, '')) = '' then
    raise exception 'Employee name is required';
  end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then
    raise exception 'Invalid kind';
  end if;

  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  insert into public.employee_loans
    (tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, created_by)
  values
    (v_tenant, trim(p_employee_name), p_principal, p_disbursed_on, p_bank_account_id, v_kind,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_loan;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_disbursed_on,
     case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || trim(p_employee_name),
     p_principal, 0, 'manual', 'manual', 'manual');

  return v_loan;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.edit_employee_loan(p_loan_id uuid, p_employee_name text, p_principal integer, p_disbursed_on date, p_bank_account_id uuid, p_kind text, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   public.employee_loans;
  v_paid   integer;
  v_kind   text := coalesce(nullif(trim(p_kind), ''), 'loan');
  v_name   text := trim(coalesce(p_employee_name, ''));
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change an employee loan' using errcode = '42501';
  end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Amount must be positive'; end if;
  if v_name = '' then raise exception 'Employee name is required'; end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then raise exception 'Invalid kind'; end if;

  select * into v_loan from public.employee_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before editing.';
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  if p_principal <> v_loan.principal or p_bank_account_id is distinct from v_loan.bank_account_id then
    if v_loan.bank_account_id is not null then
      insert into public.bank_transactions
        (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
      values
        (v_tenant, v_loan.bank_account_id, (now() at time zone 'Asia/Kolkata')::date,
         'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
    end if;
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_disbursed_on,
       case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || v_name || ' (edited)',
       p_principal, 0, 'manual', 'manual', 'manual');
  end if;

  update public.employee_loans
     set employee_name   = v_name,
         principal       = p_principal,
         disbursed_on    = p_disbursed_on,
         bank_account_id = p_bank_account_id,
         kind            = v_kind,
         notes           = nullif(trim(coalesce(p_notes, '')), ''),
         updated_at      = now()
   where id = p_loan_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.edit_expense_claim(p_claim_id uuid, p_amount integer, p_category text, p_purpose text, p_spent_on date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_claim public.expense_claims; v_loan public.employee_loans;
  v_paid integer; v_pending integer; v_available integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change an expense claim' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if trim(coalesce(p_category, '')) = '' then raise exception 'Please choose a category'; end if;
  select * into v_claim from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'Only pending claims can be edited'; end if;
  select * into v_loan from public.employee_loans where id = v_claim.loan_id and tenant_id = v_tenant;
  if not found then raise exception 'The advance for this claim no longer exists'; end if;
  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending from public.expense_claims where loan_id = v_loan.id and status = 'pending' and id <> p_claim_id;
  v_available := v_loan.principal - v_paid - v_pending;
  if p_amount > v_available then raise exception 'Amount (%) is more than what is still claimable (%)', p_amount, v_available; end if;
  update public.expense_claims set amount = p_amount, category = trim(p_category),
     purpose = nullif(trim(coalesce(p_purpose, '')), ''), spent_on = coalesce(p_spent_on, spent_on)
   where id = p_claim_id and tenant_id = v_tenant;
end; $function$
;

CREATE OR REPLACE FUNCTION public.generate_invoice(p_quote_id text)
 RETURNS TABLE(invoice_id text, net_payable integer, total_advances integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote     record;
  v_adv       jsonb;
  v_total     integer;
  v_first     timestamptz;
  v_id        text;
  v_gross     integer;
  v_net       integer;
  v_status    invoice_status;
  v_today     date := public.ist_today();
  v_taxable   integer;
  v_tax       integer;
  v_rate      integer;
  v_cust_st   text;
  v_sell_st   text;
  v_cust_country text;
  v_is_export boolean;
  v_inter     boolean;
  v_cust_gstin text;
  v_caller    uuid;
  v_trusted   boolean;
begin
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the quote''s company can issue its invoice'
      using errcode = '28000';
  end if;
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  /* activate_quote_on_credit ("Activate now, pay later") calls this with the SAME caller and
     has its own rules (any active member of the company; over-limit / annual = owner), so a
     call nested inside it is left to that function's guard. PG_CONTEXT is the real call stack —
     a browser cannot fake it, and nobody but the migration owner can create functions. */
  declare
    v_r885_ctx text;
  begin
    get diagnostics v_r885_ctx = pg_context;
    if not (coalesce(auth.role(), '') = 'service_role'
            or (auth.role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing')
       and v_r885_ctx !~ 'function (public\.)?activate_quote_on_credit\(' then
      raise exception 'Only an owner, manager, accountant or billing user can issue an invoice' using errcode = '42501';
    end if;
  end;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.amount,
         q.payment_method, q.payment_reference, q.invoice_id,
         q.subtotal, q.discount_pct, q.tax_rate, q.payment_terms_days
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;

  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if v_caller is not null
     and v_quote.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.invoice_id is not null then
    raise exception 'Invoice % already exists for quote %', v_quote.invoice_id, p_quote_id
      using errcode = 'unique_violation';
  end if;

  v_gross := coalesce(v_quote.amount, 0);
  if v_gross <= 0 then
    raise exception 'Quote % has no amount — cannot generate a zero-value tax invoice', p_quote_id
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_quote.tax_rate, 18);
  if v_quote.subtotal is not null then
    v_taxable := v_quote.subtotal - round(v_quote.subtotal * coalesce(v_quote.discount_pct, 0) / 100.0);
  else
    v_taxable := round(v_gross * 100.0 / (100 + v_rate));
  end if;
  v_tax := v_gross - v_taxable;

  select c.state_code, c.country, c.gstin into v_cust_st, v_cust_country, v_cust_gstin
    from public.customers c where c.id = v_quote.customer_id;

  /* R-373 (7 Oct 2026): a GSTIN's first two digits ARE the GST state code. A customer
     with a GSTIN but no state_code was refused below, although invoice_party_snapshot
     (R-043) already takes the place of supply from the same GSTIN prefix. Fall back to
     it only when state_code is blank and the GSTIN starts with two digits. */
  if nullif(btrim(coalesce(v_cust_st, '')), '') is null
     and btrim(coalesce(v_cust_gstin, '')) ~ '^[0-9]{2}' then
    v_cust_st := substring(btrim(v_cust_gstin) from 1 for 2);
  end if;
  select t.state_code into v_sell_st from public.tenants t where t.id = v_quote.tenant_id;

  /* ── R-041 (Pardeep, 30 Sep 2026): an unknown place of supply used to mean CGST+SGST ──
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state_code on either side resolved to FALSE = intra-state = CGST+SGST. That
     is a missing fact turned into a confident tax head (AGENTS.md §2), and it is the
     expensive direction: an inter-state supply billed as CGST+SGST is tax paid to the wrong
     government, which GSTR-1 will not reconcile and which the customer cannot claim.
     23 of this tenant's customers have no state_code.

     EXPORT is the one case where no state is correct rather than missing: a recipient
     outside India has no Indian place of supply, and the supply is zero-rated under IGST
     Section 16 (LUT or with payment of tax). Those quotes already carry tax_rate 0, set by
     the same `isExportSupply` the app uses, so there is no split to get wrong.

     Everything else stops. §24: the message names the screen that fixes it. */
  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply; the zero rate on the quote governs
  elsif v_cust_st is null or btrim(v_cust_st) = '' then
    raise exception
      'Cannot issue this invoice: % has no state on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit), then issue the invoice.',
      v_quote.customer_name, v_quote.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null or btrim(v_sell_st) = '' then
    raise exception
      'Cannot issue this invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company, then issue the invoice.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);
  end if;

  select a.advances, coalesce(a.total_paid, 0), a.first_at
    into v_adv, v_total, v_first
    from public.compute_advance_adjustment(p_quote_id) a;
  v_adv   := coalesce(v_adv, '[]'::jsonb);
  v_total := coalesce(v_total, 0);

  v_net    := greatest(0, v_gross - v_total);
  v_status := case when v_net = 0 then 'paid' else 'pending' end::invoice_status;

  v_id := public.next_document_number('invoice', v_quote.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate invoice number for quote %', p_quote_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date, razorpay_id,
    adjusted_advances, net_payable, first_advance_at, quote_id,
    taxable_value, tax_amount, tax_rate, inter_state
  ) values (
    v_id, v_quote.tenant_id, v_quote.customer_id, v_quote.customer_name, v_gross, v_status,
    -- THE ONE CHANGE: the fallback was 0, which made every termless invoice due on issue.
    v_today, v_today + coalesce(v_quote.payment_terms_days, 30), case when v_status = 'paid' then v_today else null end,
    case when v_quote.payment_method = 'razorpay' then v_quote.payment_reference else null end,
    v_adv, v_net, v_first, v_quote.id,
    v_taxable, v_tax, v_rate, v_inter
  );

  update public.quotes
     set payment_status = 'invoiced'::payment_status,
         invoice_id     = v_id
   where id = p_quote_id;

  return query select v_id, v_net, v_total;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.pay_statutory_dues(p_amount integer, p_kind text, p_paid_on date, p_bank_account_id uuid, p_notes text DEFAULT NULL::text, p_challan_no text DEFAULT NULL::text, p_period text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_acct   text;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can pay statutory dues' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;
  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Account not found'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes, challan_no, period)
  values (v_tenant, coalesce(nullif(p_kind, ''), 'mixed'), p_amount, p_paid_on, p_bank_account_id,
          nullif(trim(coalesce(p_notes, '')), ''),
          nullif(trim(coalesce(p_challan_no,'')),''), nullif(trim(coalesce(p_period,'')),''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on,
     'Statutory dues paid (' || coalesce(nullif(p_kind, ''), 'mixed') || ')'
       || case when nullif(trim(coalesce(p_challan_no,'')),'') is not null then ' · challan ' || trim(p_challan_no) else '' end,
     p_amount, 0, 'manual', 'manual', 'manual');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.raise_subscription_billing(p_billing_id uuid)
 RETURNS TABLE(invoice_id text, gross integer, already_raised boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b        record;
  v_sub      record;
  v_id       text;
  v_gross    integer;
  v_tax      integer;
  v_rate     integer;
  v_cust_st  text;
  v_sell_st  text;
  v_cust_gstin   text;
  v_sell_gstin   text;
  v_cust_country text;
  v_is_export    boolean;
  v_inter    boolean;
  v_lines    jsonb;
  v_terms    integer := 30;
  v_today    date := public.ist_today();
  v_existing integer;
  v_received integer := 0;
  v_applied  integer := 0;
  v_credit   integer := 0;
  v_status   invoice_status;
  v_caller   uuid;
  v_trusted  boolean;
begin
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can raise its invoice'
      using errcode = '28000';
  end if;
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  /* activate_quote_on_credit ("Activate now, pay later") calls this with the SAME caller and
     has its own rules (any active member of the company; over-limit / annual = owner), so a
     call nested inside it is left to that function's guard. PG_CONTEXT is the real call stack —
     a browser cannot fake it, and nobody but the migration owner can create functions. */
  declare
    v_r885_ctx text;
  begin
    get diagnostics v_r885_ctx = pg_context;
    if not (coalesce(auth.role(), '') = 'service_role'
            or (auth.role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing')
       and v_r885_ctx !~ 'function (public\.)?activate_quote_on_credit\(' then
      raise exception 'Only an owner, manager, accountant or billing user can raise an instalment invoice' using errcode = '42501';
    end if;
  end;

  select b.* into v_b
    from public.subscription_billings b
   where b.id = p_billing_id
   for update;

  if not found then
    raise exception 'Billing instalment % not found', p_billing_id
      using errcode = 'no_data_found';
  end if;

  if v_caller is not null
     and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing instalment % is not in the caller''s tenant', p_billing_id
      using errcode = 'insufficient_privilege';
  end if;

  /* Already billed. Ordinary answer, not an error — the cron retries. */
  if v_b.invoice_id is not null then
    select i.amount into v_existing from public.invoices i where i.id = v_b.invoice_id;
    return query select v_b.invoice_id, coalesce(v_existing, 0), true;
    return;
  end if;

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id
    into v_sub
    from public.subscriptions s
   where s.id = v_b.subscription_id;

  if not found then
    raise exception 'Subscription % behind instalment % no longer exists',
      v_b.subscription_id, p_billing_id using errcode = 'no_data_found';
  end if;

  /* ── R-372: place of supply, same rules as generate_invoice (R-041) ──────────────
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state on either side resolved to FALSE = intra-state = CGST+SGST: a missing
     fact turned into a confident tax head (AGENTS.md §2) on every instalment invoice.

     State = the entered state_code, else the first two digits of the GSTIN (a registered
     party has already told us their state) — the same fallback invoice_party_snapshot
     uses to freeze pos_state_code, so the head and the printed place of supply agree.

     EXPORT (country set and not India) is the one case where no Indian state is correct:
     zero-rated under IGST Section 16, so no tax and no CGST/SGST/IGST split.

     Anything else still unknown REFUSES. The billing cron reports it per subscription and
     the instalment stays unbilled until the state is set. */
  select c.state_code, c.gstin, c.country into v_cust_st, v_cust_gstin, v_cust_country
    from public.customers c where c.id = v_sub.customer_id;
  select t.state_code, t.gstin into v_sell_st, v_sell_gstin
    from public.tenants t where t.id = v_b.tenant_id;

  v_cust_st := case
    when nullif(btrim(coalesce(v_cust_st, '')), '') is not null then lpad(btrim(v_cust_st), 2, '0')
    when btrim(coalesce(v_cust_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_cust_gstin) from 1 for 2)
    else null
  end;
  v_sell_st := case
    when nullif(btrim(coalesce(v_sell_st, '')), '') is not null then lpad(btrim(v_sell_st), 2, '0')
    when btrim(coalesce(v_sell_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_sell_gstin) from 1 for 2)
    else null
  end;

  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india', 'bharat');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply
    v_rate  := 0;       -- zero-rated export (IGST s16)
  elsif v_cust_st is null then
    raise exception
      'Cannot issue the instalment invoice: % has no state (or GSTIN) on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit); the next billing run will issue it.',
      v_sub.customer_name, v_sub.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null then
    raise exception
      'Cannot issue the instalment invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company; the next billing run will issue it.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);   -- both lpad-ed to 2 digits above
    v_rate  := v_b.tax_rate;
  end if;

  v_tax   := round(v_b.taxable_amount * v_rate / 100.0);
  v_gross := v_b.taxable_amount + v_tax;

  -- ── What has already been paid towards this subscription ──────────────────
  if v_sub.quote_id is not null then
    select coalesce(sum(p.amount), 0) into v_received
      from public.payments p
     where p.quote_id = v_sub.quote_id
       and p.status   = 'received';
  end if;

  select coalesce(sum(i.paid_amount), 0) into v_applied
    from public.subscription_billings b
    join public.invoices i on i.id = b.invoice_id
   where b.subscription_id = v_b.subscription_id;

  v_credit := least(greatest(0, v_received - v_applied), v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  /* R-372: the fallback was 0, which made every termless instalment due on issue.
     30 matches generate_invoice. */
  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 30) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 30);

  /* ONE line, qty 1, rate = the whole instalment. Not qty = seats with a per-seat
     rate: an instalment of ₹2,000 over 3 seats is ₹666.67 each, and a tax invoice
     whose qty × rate does not equal its amount is wrong on its face. The seat count
     and service period go in the description, where CGST Rule 46 wants them. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'instalment-' || v_b.period_index::text,
    'name',        v_sub.plan,
    'description', coalesce(v_sub.seats, 0)::text || ' seats · '
                   || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                   || to_char(v_b.period_end,   'DD Mon YYYY'),
    'qty',         1,
    'rate',        v_b.taxable_amount,
    'cost',        0
  ));

  v_id := public.next_document_number('invoice', v_b.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate an invoice number for instalment %', p_billing_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date,
    /* quote_id STAYS NULL — build-props.ts:69-71 prefers the quote for every amount
       it prints, so linking a ₹2,360 instalment to its ₹28,320 quote would print
       ₹28,320 on it. The link lives on subscription_billings. */
    quote_id,
    net_payable, paid_amount, taxable_value, tax_amount, tax_rate, inter_state,
    line_items
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_gross, v_status,
    v_today, v_today + v_terms,
    case when v_status = 'paid' then v_today else null end,
    null,
    greatest(0, v_gross - v_credit), v_credit,
    v_b.taxable_amount, v_tax, v_rate, v_inter,
    v_lines
  );

  update public.subscription_billings
     set invoice_id = v_id, updated_at = now()
   where id = p_billing_id;

  return query select v_id, v_gross, false;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reconcile_expenses_to_bank_txn(p_bank_txn_id uuid, p_expense_ids text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_sum    integer;
  v_cnt    integer;
  v_want   integer := coalesce(array_length(p_expense_ids, 1), 0);
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match expenses to a bank line' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_txn.tenant_id is distinct from v_tenant) then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_txn.debit <= 0 then
    raise exception 'Only a money-out (debit) line can be matched to expenses' using errcode = 'invalid_parameter_value';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled — un-reconcile it first' using errcode = 'invalid_parameter_value';
  end if;
  if v_want < 1 then raise exception 'Pick at least one expense to match'; end if;

  select coalesce(sum(amount), 0), count(*) into v_sum, v_cnt
  from public.expenses
  where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id and reconciled_txn_id is null;

  if v_cnt <> v_want then
    raise exception 'Some selected expenses are missing or already reconciled — refresh and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sum <> v_txn.debit then
    raise exception 'Selected expenses total % but this bank line is % — they must add up exactly', v_sum, v_txn.debit
      using errcode = 'invalid_parameter_value';
  end if;

  update public.expenses set reconciled_txn_id = p_bank_txn_id
   where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id;

  update public.salary_payments sp
     set paid_status = 'paid', paid_amount = sp.net, reconciled_txn_id = p_bank_txn_id
   where sp.tenant_id = v_txn.tenant_id and sp.expense_id = any (p_expense_ids) and sp.paid_status <> 'paid';

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual'
   where id = p_bank_txn_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reconcile_salaries_to_bank_txn(p_bank_txn_id uuid, p_salary_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_sum    integer;
  v_cnt    integer;
  v_want   integer := coalesce(array_length(p_salary_ids, 1), 0);
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can match salaries to a bank line' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_txn.tenant_id is distinct from v_tenant) then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_txn.debit <= 0 then
    raise exception 'Only a money-out (debit) line can be matched to salaries' using errcode = 'invalid_parameter_value';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled — un-reconcile it first' using errcode = 'invalid_parameter_value';
  end if;
  if v_want < 1 then raise exception 'Pick at least one salary to match'; end if;

  select coalesce(sum(net), 0), count(*) into v_sum, v_cnt
  from public.salary_payments
  where id = any (p_salary_ids) and tenant_id = v_txn.tenant_id
    and paid_status = 'unpaid' and reconciled_txn_id is null;

  if v_cnt <> v_want then
    raise exception 'Some selected salaries are missing or already paid — refresh and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sum <> v_txn.debit then
    raise exception 'Selected salaries total % but this bank line is % — they must add up exactly', v_sum, v_txn.debit
      using errcode = 'invalid_parameter_value';
  end if;

  update public.salary_payments
     set paid_status = 'paid', reconciled_txn_id = p_bank_txn_id
   where id = any (p_salary_ids) and tenant_id = v_txn.tenant_id;

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual'
   where id = p_bank_txn_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_business_loan(p_lender text, p_purpose text, p_principal integer, p_interest_rate numeric, p_tenure_months integer, p_emi_amount integer, p_disbursed_on date, p_deposit_account uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a business loan' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Loan amount must be positive'; end if;
  if trim(coalesce(p_lender, '')) = '' then raise exception 'Lender is required'; end if;
  if p_deposit_account is null then raise exception 'Pick the account the money was received into'; end if;
  perform 1 from public.bank_accounts where id = p_deposit_account and tenant_id = v_tenant;
  if not found then raise exception 'Deposit account not found'; end if;

  insert into public.business_loans
    (tenant_id, lender, purpose, principal, interest_rate, tenure_months, emi_amount, disbursed_on, deposit_account_id, status, created_by)
  values
    (v_tenant, trim(p_lender), nullif(trim(coalesce(p_purpose,'')),''), p_principal,
     p_interest_rate, nullif(greatest(coalesce(p_tenure_months,0),0),0), nullif(greatest(coalesce(p_emi_amount,0),0),0),
     p_disbursed_on, p_deposit_account, 'active', auth.uid())
  returning id into v_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_deposit_account, p_disbursed_on, 'Loan received: ' || trim(p_lender), 0, p_principal, 'manual', 'manual', 'manual');

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_emi_payment(p_purchase_id uuid, p_amount integer, p_interest integer, p_paid_on date, p_bank_account_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_p        public.emi_purchases;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record an EMI payment' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'EMI amount must be positive'; end if;
  v_prin := p_amount - v_int;
  if v_prin < 0 then raise exception 'Interest cannot exceed the EMI amount'; end if;

  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant;
  if not found then raise exception 'Purchase not found'; end if;

  select coalesce(sum(principal_part), 0) into v_paidprin from public.emi_payments where purchase_id = p_purchase_id;
  v_outstd := v_p.financed - v_paidprin;
  if v_prin > v_outstd then raise exception 'Principal part (%) exceeds outstanding loan (%)', v_prin, v_outstd; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  if v_int > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_exp_id, v_tenant, 'Interest', coalesce(v_p.lender, v_p.name), p_paid_on, v_int, 0, 'emi', 'EMI interest - ' || v_p.name);
  end if;

  insert into public.emi_payments
    (tenant_id, purchase_id, amount, principal_part, interest_part, paid_on, bank_account_id, expense_id, notes)
  values
    (v_tenant, p_purchase_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'EMI: ' || v_p.name, p_amount, 0, 'manual', 'manual', 'manual');

  update public.emi_purchases
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_purchase_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_emi_purchase(p_name text, p_category text, p_total_cost integer, p_down_payment integer, p_emi_count integer, p_emi_amount integer, p_purchased_on date, p_down_account uuid, p_lender text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_down   integer := greatest(coalesce(p_down_payment, 0), 0);
  v_cat    text := coalesce(nullif(trim(p_category), ''), 'other');
  v_fin    integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record an EMI purchase' using errcode = '42501';
  end if;
  if p_total_cost is null or p_total_cost <= 0 then raise exception 'Total cost must be positive'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Name is required'; end if;
  if v_down > p_total_cost then raise exception 'Down payment cannot exceed total cost'; end if;
  v_fin := p_total_cost - v_down;

  if v_down > 0 then
    if p_down_account is null then raise exception 'Pick the account the down payment came from'; end if;
    perform 1 from public.bank_accounts where id = p_down_account and tenant_id = v_tenant;
    if not found then raise exception 'Down-payment account not found'; end if;
  end if;

  insert into public.emi_purchases
    (tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on, down_account_id, lender, notes, status, created_by)
  values
    (v_tenant, trim(p_name), v_cat, p_total_cost, v_down, v_fin,
     greatest(coalesce(p_emi_count,0),0), greatest(coalesce(p_emi_amount,0),0), p_purchased_on, p_down_account,
     nullif(trim(coalesce(p_lender,'')),''), nullif(trim(coalesce(p_notes,'')),''),
     case when v_fin <= 0 then 'closed' else 'active' end, auth.uid())
  returning id into v_id;

  if v_down > 0 then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_down_account, p_purchased_on, 'Purchase: ' || trim(p_name) || ' (down payment)', v_down, 0, 'manual', 'manual', 'manual');
  end if;

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_employee_loan_repayment(p_loan_id uuid, p_amount integer, p_repaid_on date, p_method text, p_bank_account_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can record an employee loan repayment' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Repayment amount must be positive';
  end if;
  if p_method not in ('cash', 'bank', 'salary_deduction') then
    raise exception 'Invalid repayment method';
  end if;

  select * into v_loan from public.employee_loans
    where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = p_loan_id;
  v_outstanding := v_loan.principal - v_paid;

  if p_amount > v_outstanding then
    raise exception 'Repayment (%) exceeds outstanding (%)', p_amount, v_outstanding;
  end if;

  if p_method in ('cash', 'bank') then
    if p_bank_account_id is null then
      raise exception 'A receiving account is required for a % repayment', p_method;
    end if;
    perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
    if not found then raise exception 'Receiving account not found'; end if;
  end if;

  insert into public.employee_loan_repayments
    (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
  values
    (v_tenant, p_loan_id, p_amount, p_repaid_on, p_method,
     case when p_method = 'salary_deduction' then null else p_bank_account_id end,
     nullif(trim(coalesce(p_notes, '')), ''));

  if p_method in ('cash', 'bank') then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_repaid_on,
       'Loan repayment — ' || v_loan.employee_name, 0, p_amount, 'manual', 'manual', 'manual');
  end if;

  update public.employee_loans
     set status     = case when v_outstanding - p_amount <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = p_loan_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_loan_emi(p_loan_id uuid, p_amount integer, p_interest integer, p_paid_on date, p_bank_account_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_l        public.business_loans;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a loan EMI' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'EMI amount must be positive'; end if;
  v_prin := p_amount - v_int;
  if v_prin < 0 then raise exception 'Interest cannot exceed the EMI amount'; end if;

  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(principal_part), 0) into v_paidprin from public.business_loan_payments where loan_id = p_loan_id;
  v_outstd := v_l.principal - v_paidprin;
  if v_prin > v_outstd then raise exception 'Principal part (%) exceeds outstanding loan (%)', v_prin, v_outstd; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  if v_int > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_exp_id, v_tenant, 'Interest', v_l.lender, p_paid_on, v_int, 0, 'emi', 'Loan interest — ' || v_l.lender);
  end if;

  insert into public.business_loan_payments
    (tenant_id, loan_id, amount, principal_part, interest_part, paid_on, bank_account_id, expense_id, notes)
  values
    (v_tenant, p_loan_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'Loan EMI: ' || v_l.lender, p_amount, 0, 'manual', 'manual', 'manual');

  update public.business_loans
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_loan_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_project_payment(p_milestone_id uuid, p_amount integer, p_method text, p_reference text, p_received_at date, p_bank_txn_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_pay_id   uuid;
  v_paid     integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a project payment' using errcode = '42501';
  end if;
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_ms.tenant_id is distinct from v_tenant) then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be > 0'; end if;

  insert into public.project_payments
    (tenant_id, project_id, milestone_id, amount, method, reference, received_at, bank_txn_id)
  values
    (v_ms.tenant_id, v_ms.project_id, p_milestone_id, p_amount,
     nullif(trim(coalesce(p_method,'')),''), nullif(trim(coalesce(p_reference,'')),''),
     coalesce(p_received_at, current_date), p_bank_txn_id)
  returning id into v_pay_id;

  select coalesce(sum(amount), 0) into v_paid
    from public.project_payments where milestone_id = p_milestone_id;
  if v_paid >= v_ms.total_amount then
    update public.project_milestones set status = 'paid' where id = p_milestone_id;
    if v_ms.invoice_id is not null then
      update public.invoices set status = 'paid'::invoice_status, paid_date = coalesce(p_received_at, current_date)
       where id = v_ms.invoice_id;
    end if;
  end if;

  if p_bank_txn_id is not null then
    update public.bank_transactions
       set matched_to_type = 'project', matched_to_id = v_pay_id::text,
           matched_at = now(), match_confidence = 'manual'
     where id = p_bank_txn_id and tenant_id = v_ms.tenant_id;
  end if;

  return v_pay_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_project_receipt_with_tds(p_milestone_id uuid, p_net integer, p_tds integer, p_section text, p_rate_pct numeric, p_tds_base integer, p_received_at date, p_bank_txn_id uuid, p_reference text, p_raise_invoice boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_ms      public.project_milestones;
  v_proj    public.project_sales;
  v_net_id  uuid;
  v_tds_id  uuid;
  v_invoice text;
  v_tds_row text;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a project payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_net, 0) <= 0 or coalesce(p_tds, 0) <= 0 or coalesce(p_tds_base, 0) <= 0 then
    raise exception 'Net, TDS and the TDS base must all be more than zero';
  end if;
  select * into v_proj from public.project_sales where id = v_ms.project_id;

  -- 1 + 2. both parts of the settlement, through the one project-payment path
  v_net_id := public.record_project_payment(p_milestone_id, p_net, 'bank_transfer', p_reference, p_received_at, p_bank_txn_id);
  v_tds_id := public.record_project_payment(p_milestone_id, p_tds, 'tds',
                format('TDS %s @ %s%% on ₹%s', coalesce(p_section, '194J'), p_rate_pct, p_tds_base), p_received_at, null);

  -- 3. invoice, after both, so a fully settled milestone's invoice is born paid
  select invoice_id into v_invoice from public.project_milestones where id = p_milestone_id;
  if p_raise_invoice and v_invoice is null then
    v_invoice := public.raise_project_milestone_invoice(p_milestone_id);
  end if;

  -- 4. the credit to claim
  v_tds_row := 'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  insert into public.tds_receivable (
    id, tenant_id, invoice_id, payment_id, customer_id, customer_name, section, rate_pct,
    gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status, notes
  ) values (
    v_tds_row, v_tenant, v_invoice, null, v_proj.customer_id, coalesce(v_proj.customer_name, ''),
    coalesce(p_section, '194J'), p_rate_pct, p_tds_base, p_tds, p_net,
    public.indian_fiscal_year(coalesce(p_received_at, current_date)), coalesce(p_received_at, current_date),
    'pending_cert',
    format('Project %s · milestone "%s" · project payments %s (bank) + %s (TDS)', v_proj.title, v_ms.label, v_net_id, v_tds_id)
  );

  return jsonb_build_object('net_payment', v_net_id, 'tds_payment', v_tds_id, 'invoice_id', v_invoice, 'tds_receivable', v_tds_row);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_expense_claim(p_claim_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can reject an expense claim' using errcode = '42501';
  end if;
  select status into v_status from public.expense_claims
    where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_status <> 'pending' then raise exception 'This claim is already %', v_status; end if;

  update public.expense_claims
     set status = 'rejected', reject_reason = nullif(trim(coalesce(p_reason, '')), ''), reviewed_at = now()
   where id = p_claim_id and tenant_id = v_tenant;
end;
$function$
;

commit;
