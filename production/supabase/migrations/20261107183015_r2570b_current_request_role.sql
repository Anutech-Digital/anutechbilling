-- deploy-peek: exists(select 1 from pg_proc where proname = 'disburse_employee_loan' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'edit_employee_loan' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'delete_employee_loan' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'record_employee_loan_repayment' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'record_business_loan' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'record_loan_emi' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'record_emi_payment' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'pay_statutory_dues' and prosrc like '%R-2570b%') and exists(select 1 from pg_proc where proname = 'book_bank_txn_as_employee_advance' and prosrc like '%R-2570b%')
-- deploy-key: r2570bcurrentrequestrole
--
-- R-2570b (8 Nov 2026) — fixes the red CI of R-2570 (src/lib/security/cloudsql-auth-shim-scan.test.ts,
-- "no migration after R-2487 adds a raw trusted-server list"). 20261107165630_r2570_bank_line_own_type.sql
-- (already pushed — never edited) copied nine function bodies that still read the request role with the
-- raw auth call. This file redefines exactly those nine with R-2570's bodies, the only change being
-- public.current_request_role() in place of that call (what R-2487 asks for, and byte-for-byte what the
-- staging deploy script's rewrite already turns R-2570 into there). Same signatures, so grants stay.
-- Behaviour is identical: current_request_role() answers the auth role for every login except the
-- Cloud SQL gateway logins (app_runtime / app_jobs / app_service / app_anon), which it maps — on local
-- Supabase, CI and staging nothing changes; on live it no longer depends on the R-2487 auth shims.
-- The scan test lists 20261107165630 as forward-fixed by this file and checks every raw body there is
-- redefined here without the raw list.

CREATE OR REPLACE FUNCTION public.disburse_employee_loan(p_employee_name text, p_principal integer, p_disbursed_on date, p_bank_account_id uuid, p_kind text DEFAULT 'loan'::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: the payout line is matched to its loan (employee_loan + loan id), not 'manual' */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(public.current_request_role(), '') = 'service_role'
                       or (public.current_request_role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_loan    uuid;
  v_txn     uuid;
  v_kind    text := coalesce(nullif(trim(p_kind), ''), 'loan');
begin
  /* R-1873: the cash line's id is stored on the loan (bank_txn_id). R-885 role gate kept. */
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can give an employee loan or advance' using errcode = '42501';
  end if;
  if v_tenant is null then
    raise exception 'No company selected — sign in again, then give the loan.' using errcode = '28000';
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

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found — pick a bank or cash account of this company.'; end if;

  v_loan := gen_random_uuid();
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_disbursed_on,
     case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || trim(p_employee_name),
     p_principal, 0, 'manual', 'employee_loan', v_loan::text, 'manual')
  returning id into v_txn;

  insert into public.employee_loans
    (id, tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, created_by, bank_txn_id)
  values
    (v_loan, v_tenant, trim(p_employee_name), p_principal, p_disbursed_on, p_bank_account_id, v_kind,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid(), v_txn)
  returning id into v_loan;

  return v_loan;
end;
$function$;

CREATE OR REPLACE FUNCTION public.edit_employee_loan(p_loan_id uuid, p_employee_name text, p_principal integer, p_disbursed_on date, p_bank_account_id uuid, p_kind text, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: the loan's own line is 'employee_loan' + loan id (old lines: 'manual'); an edit names it so */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(public.current_request_role(), '') = 'service_role'
                       or (public.current_request_role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_loan    public.employee_loans;
  v_line    public.bank_transactions;
  v_txn     uuid;
  v_paid    integer;
  v_kind    text := coalesce(nullif(trim(p_kind), ''), 'loan');
  v_name    text := trim(coalesce(p_employee_name, ''));
  v_desc    text;
  v_money   boolean;
begin
  /* R-1873: the linked cash line is changed in place (amount, account, date, name) — no
     reverse-and-repost pair. R-885 role gate kept; §17c fail-closed. */
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change an employee loan' using errcode = '42501';
  end if;
  if v_tenant is null and not v_trusted then
    raise exception 'No company selected — sign in again, then change the loan.' using errcode = '28000';
  end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Amount must be positive'; end if;
  if v_name = '' then raise exception 'Employee name is required'; end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then raise exception 'Invalid kind'; end if;

  select * into v_loan from public.employee_loans
   where id = p_loan_id and (tenant_id = v_tenant or (v_tenant is null and v_trusted))
   for update;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before editing.';
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_loan.tenant_id;
  if not found then raise exception 'Source account not found — pick a bank or cash account of this company.'; end if;

  v_desc  := case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || v_name;
  v_money := p_principal <> v_loan.principal
             or p_bank_account_id is distinct from v_loan.bank_account_id
             or p_disbursed_on <> v_loan.disbursed_on;

  if v_loan.bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = v_loan.bank_txn_id for update;
  elsif v_loan.bank_account_id is not null then
    select * into v_line from public.bank_transactions
     where id = public.employee_loan_legacy_line(p_loan_id) for update;
  end if;

  if v_money and v_line.id is not null
     and (v_line.matched_to_type is not null
          and not (v_line.matched_to_type = 'manual' and v_line.matched_to_id is null)
          and not (v_line.matched_to_type = 'employee_loan' and v_line.matched_to_id = p_loan_id::text)) then
    raise exception 'This loan''s cash line is now booked as "%" on the Banking page, so its amount, account or date cannot change here.', v_line.matched_to_type
      using hint = '/accounting/banking/' || v_line.bank_account_id || '?focus=' || v_line.id,
            detail = 'Open the line in Banking, un-reconcile it, then edit the loan again.';
  end if;

  if v_line.id is null and v_money then
    -- No line to change (a loan from before R-1873 whose line cannot be found): the old way —
    -- put the old amount back, then pay out the new one. The new line is linked.
    if v_loan.bank_account_id is not null then
      insert into public.bank_transactions
        (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
      values
        (v_loan.tenant_id, v_loan.bank_account_id, public.ist_today(),
         'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
    end if;
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
    values
      (v_loan.tenant_id, p_bank_account_id, p_disbursed_on, v_desc, p_principal, 0, 'manual', 'employee_loan', p_loan_id::text, 'manual')
    returning id into v_txn;
  else
    v_txn := v_line.id;
  end if;

  -- The loan first, then its line: the line guard checks the line against the loan.
  update public.employee_loans
     set employee_name   = v_name,
         principal       = p_principal,
         disbursed_on    = p_disbursed_on,
         bank_account_id = p_bank_account_id,
         kind            = v_kind,
         notes           = nullif(trim(coalesce(p_notes, '')), ''),
         bank_txn_id     = v_txn,
         updated_at      = now()
   where id = p_loan_id;

  if v_line.id is not null then
    update public.bank_transactions
       set bank_account_id = p_bank_account_id,
           txn_date        = p_disbursed_on,
           debit           = p_principal,
           description     = case when v_line.matched_to_type in ('manual', 'employee_loan') then v_desc else description end,
           matched_to_type = case when v_line.matched_to_type = 'manual' and v_line.matched_to_id is null then 'employee_loan' else matched_to_type end,
           matched_to_id   = case when v_line.matched_to_type = 'manual' and v_line.matched_to_id is null then p_loan_id::text else matched_to_id end,
           updated_at      = now()
     where id = v_line.id;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_employee_loan(p_loan_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: the loan's own line is 'employee_loan' + loan id (old lines: 'manual') — not 'booked elsewhere' */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(public.current_request_role(), '') = 'service_role'
                       or (public.current_request_role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_loan    public.employee_loans;
  v_line    public.bank_transactions;
  v_acct    text;
  v_paid    integer;
begin
  /* R-1873: deletes the loan AND its cash line together (no "Correction" credit), so Payments
     Made, the account balance, the loans register and the Balance Sheet all lose it at once.
     R-885 role gate (delete group: owner, accountant) kept; §17c fail-closed. */
  if not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete an employee loan' using errcode = '42501';
  end if;
  if v_tenant is null and not v_trusted then
    raise exception 'No company selected — sign in again, then delete the loan.' using errcode = '28000';
  end if;

  select * into v_loan from public.employee_loans
   where id = p_loan_id and (tenant_id = v_tenant or (v_tenant is null and v_trusted))
   for update;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before deleting.';
  end if;

  if v_loan.bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = v_loan.bank_txn_id for update;
  elsif v_loan.bank_account_id is not null then
    select * into v_line from public.bank_transactions
     where id = public.employee_loan_legacy_line(p_loan_id) for update;
  end if;

  if v_line.id is not null
     and (v_line.matched_to_type is not null
          and not (v_line.matched_to_type = 'manual' and v_line.matched_to_id is null)
          and not (v_line.matched_to_type = 'employee_loan' and v_line.matched_to_id = p_loan_id::text)) then
    select name into v_acct from public.bank_accounts where id = v_line.bank_account_id;
    raise exception 'This loan''s cash line (% · % · ₹%) is now booked as "%" on the Banking page, so deleting the loan would change that booking too.',
      coalesce(v_acct, 'account'), to_char(v_line.txn_date, 'DD Mon YYYY'), v_line.debit, v_line.matched_to_type
      using hint = '/accounting/banking/' || v_line.bank_account_id || '?focus=' || v_line.id,
            detail = 'Open the line in Banking, un-reconcile it, then delete the loan again.';
  end if;

  delete from public.employee_loans where id = p_loan_id;

  if v_line.id is not null then
    delete from public.bank_transactions where id = v_line.id;
  elsif v_loan.bank_account_id is not null then
    -- A loan from before R-1873 whose line can no longer be found: keep the old correction
    -- credit so the account balance still comes back right.
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_loan.tenant_id, v_loan.bank_account_id, public.ist_today(),
       'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_employee_loan_repayment(p_loan_id uuid, p_amount integer, p_repaid_on date, p_method text, p_bank_account_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: the repayment line is matched to its loan (employee_loan + loan id), not 'manual' */
declare
  v_tenant      uuid := public.current_tenant_id();
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
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
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_repaid_on,
       'Loan repayment — ' || v_loan.employee_name, 0, p_amount, 'manual', 'employee_loan', p_loan_id::text, 'manual');
  end if;

  update public.employee_loans
     set status     = case when v_outstanding - p_amount <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = p_loan_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_business_loan(p_lender text, p_purpose text, p_principal integer, p_interest_rate numeric, p_tenure_months integer, p_emi_amount integer, p_disbursed_on date, p_deposit_account uuid, p_bank_txn_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: its own money-in line is matched to the loan (business_loan + loan id), not 'manual' */
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_on     date := p_disbursed_on;
  v_line   public.bank_transactions;
  v_txn    uuid;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. R-2377: + the imported money-in line. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
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

  -- R-2377: the loan money is a line already on the statement.
  if p_bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = p_bank_txn_id for update;
    if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
    if v_line.bank_account_id is distinct from p_deposit_account then
      raise exception 'That bank line is not on the account the loan money came into';
    end if;
    if coalesce(v_line.credit, 0) <= 0 or coalesce(v_line.debit, 0) <> 0 then
      raise exception 'Only a money-in line can be the loan money';
    end if;
    if v_line.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
    if abs(v_line.credit - p_principal) > 1 then
      raise exception 'This line is ₹% but the loan is ₹% — pick the line for the loan amount', v_line.credit, p_principal;
    end if;
    v_on := v_line.txn_date;
  end if;
  if v_on is null then raise exception 'Enter the date the loan money came in'; end if;

  insert into public.business_loans
    (tenant_id, lender, purpose, principal, interest_rate, tenure_months, emi_amount, disbursed_on, deposit_account_id, status, created_by)
  values
    (v_tenant, trim(p_lender), nullif(trim(coalesce(p_purpose,'')),''), p_principal,
     p_interest_rate, nullif(greatest(coalesce(p_tenure_months,0),0),0), nullif(greatest(coalesce(p_emi_amount,0),0),0),
     v_on, p_deposit_account, 'active', auth.uid())
  returning id into v_id;

  if p_bank_txn_id is not null then
    perform public.reconcile_bank_txn(p_bank_txn_id, 'business_loan', v_id::text, 'manual');
    v_txn := p_bank_txn_id;
  else
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
    values
      (v_tenant, p_deposit_account, v_on, 'Loan received: ' || trim(p_lender), 0, p_principal, 'manual', 'business_loan', v_id::text, 'manual')
    returning id into v_txn;
  end if;
  update public.business_loans set disbursal_bank_txn_id = v_txn where id = v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_loan_emi(p_loan_id uuid, p_amount integer, p_interest integer, p_paid_on date, p_bank_account_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: the EMI line is matched to its repayment (loan_repayment + payment id), not 'manual' */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_l        public.business_loans;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
  v_pay_id   uuid;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
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
    (v_tenant, p_loan_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''))
  returning id into v_pay_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'Loan EMI: ' || v_l.lender, p_amount, 0, 'manual', 'loan_repayment', v_pay_id::text, 'manual');

  update public.business_loans
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_loan_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_emi_payment(p_purchase_id uuid, p_amount integer, p_interest integer, p_paid_on date, p_bank_account_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: the EMI line is matched to its payment (emi + payment id, as emi_mark_line does) and the payment points back at it, so Undo removes it */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_p        public.emi_purchases;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
  v_pay_id   uuid;
  v_line_id  uuid;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
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
    (v_tenant, p_purchase_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''))
  returning id into v_pay_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'EMI: ' || v_p.name, p_amount, 0, 'manual', 'emi', v_pay_id::text, 'manual')
  returning id into v_line_id;
  update public.emi_payments set bank_txn_id = v_line_id where id = v_pay_id;

  update public.emi_purchases
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_purchase_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.pay_statutory_dues(p_amount integer, p_kind text, p_paid_on date, p_bank_account_id uuid, p_notes text DEFAULT NULL::text, p_challan_no text DEFAULT NULL::text, p_period text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: the challan line is matched to its payment (statutory + payment id), not 'manual' */
declare
  v_tenant uuid := public.current_tenant_id();
  v_acct   text;
  v_sid    uuid;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
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
          nullif(trim(coalesce(p_challan_no,'')),''), nullif(trim(coalesce(p_period,'')),''))
  returning id into v_sid;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on,
     'Statutory dues paid (' || coalesce(nullif(p_kind, ''), 'mixed') || ')'
       || case when nullif(trim(coalesce(p_challan_no,'')),'') is not null then ' · challan ' || trim(p_challan_no) else '' end,
     p_amount, 0, 'manual', 'statutory', v_sid::text, 'manual');
end;
$function$;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_employee_advance(p_txn_id uuid, p_kind text, p_name text DEFAULT NULL::text, p_advance_id uuid DEFAULT NULL::uuid, p_reimbursement_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570b (R-2487): public.current_request_role() in place of the raw auth role call */
/* R-2570: money owed back / a reimbursement with no expense is 'reimbursement' (same 'reimbursement:<id>'), not 'manual' */
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_adv      public.prepaid_advances;
  v_reimb    public.reimbursements;
  v_emp      public.employees;
  v_emp_id   uuid;
  v_id       uuid;
  v_amount   integer;
  v_left     integer;
  v_result   integer;
begin
  /* R-1871: §17c guard + the advance money roles (give / top-up / settle refuse anyone else). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can book an employee advance from the bank' using errcode = '42501';
  end if;
  /* R-2407: 'owed_back' = money an employee paid in by mistake → owed back to them (a payable). */
  if p_kind is null or p_kind not in ('give', 'top_up', 'return', 'reimburse', 'owed_back') then
    raise exception 'Pick what this line is: advance given, top-up, advance returned, reimbursement or owed back to the employee.';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled — un-reconcile it first.'; end if;
  if exists (select 1 from public.bank_accounts where id = v_txn.bank_account_id and account_type = 'cash') then
    raise exception 'This is a Petty Cash line. Give or top up from Petty Cash on Accounting → Advances — it adds the cash line itself.';
  end if;

  if p_kind in ('give', 'top_up', 'reimburse') then
    v_amount := coalesce(v_txn.debit, 0);
    if v_amount <= 0 then raise exception 'Money given to an employee must be a money-out line.'; end if;
  else
    v_amount := coalesce(v_txn.credit, 0);
    if v_amount <= 0 then raise exception 'Money returned by an employee must be a money-in line.'; end if;
  end if;

  if p_kind = 'give' then
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Pick the employee who got the money.'; end if;
    -- The Advances page's own RPC. The line's account is a bank (not cash) → no extra cash line.
    v_id := public.give_employee_advance(trim(p_name), v_amount, v_txn.txn_date, 'bank_transfer', v_txn.bank_account_id,
                                         coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Office expenses'));
    update public.prepaid_advances set bank_txn_id = p_txn_id where id = v_id;
    v_result := v_amount;

  elsif p_kind = 'owed_back' then
    /* R-2407: any employee of THIS company (an active one first when two share a name). */
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Pick the employee who paid this money in.'; end if;
    -- p_name: the employee's id (the Reconcile sheet sends it — two people can share a name) or name.
    v_emp_id := case when trim(p_name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then trim(p_name)::uuid end;
    select * into v_emp from public.employees
     where tenant_id = v_tenant
       and (id = v_emp_id or (v_emp_id is null and lower(trim(name)) = lower(trim(p_name))))
     order by is_active desc nulls last, created_at
     limit 1;
    if not found then
      raise exception 'That person is not an employee of your company. Add them on Payroll → Employees first.';
    end if;
    insert into public.reimbursements
      (tenant_id, person_name, purpose, category, amount, gst_paid, incurred_on, paid_via, status, employee_id, created_by)
    values
      (v_tenant, v_emp.name,
       left('Paid to the company by mistake — owed back (bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ')'
            || coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''), 500),
       'Owed to employee', v_amount, 0, v_txn.txn_date, 'Bank (money in)', 'pending', v_emp.id, auth.uid())
    returning * into v_reimb;
    v_result := v_amount;

  elsif p_kind in ('top_up', 'return') then
    select * into v_adv from public.prepaid_advances
     where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
    if not found then raise exception 'Pick the employee''s advance — that one is not in your company.'; end if;
    v_id := v_adv.id;

    if p_kind = 'top_up' then
      v_result := public.top_up_employee_advance(v_adv.id, v_amount, v_txn.txn_date, v_txn.bank_account_id);
    else
      if v_adv.closed_at is not null then raise exception 'The advance with % is already settled.', v_adv.vendor_name; end if;
      v_left := v_adv.total_amount - v_adv.consumed_amount;
      if v_amount > v_left then
        raise exception 'Only ₹% is still with %. A return of ₹% is more than that — book the extra as something else.', v_left, v_adv.vendor_name, v_amount;
      end if;
      if v_amount = v_left then
        -- The whole balance came back: the Advances page's Settle (advance closed).
        perform public.settle_employee_advance(v_adv.id, v_txn.txn_date, v_txn.bank_account_id);
        v_result := 0;
      else
        -- Part of it came back; the rest stays with the employee (carried forward).
        update public.prepaid_advances
           set total_amount = total_amount - v_amount, updated_at = now(),
               notes = concat_ws(E'\n', notes, 'Returned ₹' || v_amount || ' on ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
                                                || ' · ₹' || (v_left - v_amount) || ' still with them')
         where id = v_adv.id;
        v_result := v_left - v_amount;
      end if;
    end if;

  else -- reimburse
    select * into v_reimb from public.reimbursements
     where id = p_reimbursement_id and tenant_id = v_tenant for update;
    if not found then raise exception 'Pick the reimbursement — that one is not in your company.'; end if;
    if v_reimb.status <> 'pending' then raise exception 'That reimbursement is already paid.'; end if;
    if v_reimb.amount <> v_amount then
      raise exception 'The reimbursement is ₹% but this line is ₹%. Pick the matching one.', v_reimb.amount, v_amount;
    end if;
    perform public.settle_reimbursement(v_reimb.id, v_txn.txn_date, 'Paid by bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY'));
    v_result := 0;
  end if;

  update public.bank_transactions
     set matched_to_type  = case when p_kind = 'owed_back' then 'reimbursement'
                                 when p_kind = 'reimburse' then
                              case when v_reimb.expense_id is not null then 'expense' else 'reimbursement' end
                            else 'prepaid' end,
         matched_to_id    = case when p_kind = 'owed_back' then 'reimbursement:' || v_reimb.id::text
                                 when p_kind = 'reimburse' then coalesce(v_reimb.expense_id, 'reimbursement:' || v_reimb.id::text)
                            else v_id::text end,
         match_confidence = 'manual', matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;
  if p_kind = 'reimburse' and v_reimb.expense_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = v_reimb.expense_id and tenant_id = v_tenant;
  end if;

  insert into public.employee_advance_bank_links (tenant_id, bank_txn_id, kind, advance_id, reimbursement_id, amount, created_by)
  values (v_tenant, p_txn_id, p_kind, case when p_kind in ('reimburse', 'owed_back') then null else v_id end,
          case when p_kind in ('reimburse', 'owed_back') then v_reimb.id end, v_amount, auth.uid());

  return jsonb_build_object('kind', p_kind, 'advance_id', case when p_kind in ('reimburse', 'owed_back') then null else v_id end,
                            'reimbursement_id', case when p_kind in ('reimburse', 'owed_back') then v_reimb.id end,
                            'employee', case when p_kind = 'owed_back' then v_emp.name end,
                            'amount', v_amount, 'left', v_result);
end;
$function$;
