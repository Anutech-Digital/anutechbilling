-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_line_bookings(uuid)') and prosrc like '%R-2570%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_advance(uuid,text,text,text)') and prosrc like '%R-2570%') and exists(select 1 from pg_constraint where conname = 'bank_transactions_matched_to_type_check' and pg_get_constraintdef(oid) like '%employee_loan%')
-- deploy-key: r2570banklineowntype
--
-- R-2570 (7 Nov 2026, G-RECON; root-cause follow-up of R-2378) — the flows that book a bank line
-- (or write their own cash line) stored matched_to_type = 'manual' with no matched_to_id and kept
-- the real link on their own table. R-2378's bank_line_bookings() found the booking when the bank
-- page READS the line; every reader of the column itself (CSV, cash flow, reports) still saw
-- "manual". From this migration each writer stores its OWN type + the id of its record:
--
--   book_bank_advance / book_bank_credit         → 'bs_item'        + balance_sheet_items.id   (new type)
--   disburse / edit employee loan, staff loan
--     repayment, expense-advance returned cash   → 'employee_loan'  + employee_loans.id        (new type)
--   staff money owed back / reimbursement paid
--     with no expense (employee advance flows)   → 'reimbursement'  + 'reimbursement:<id>'     (new type, same id shape)
--   give_loan (Loans given → Give loan)          → 'loan_given'     + loans_given.id
--   record_business_loan (Add loan, own line)    → 'business_loan'  + business_loans.id
--   record_loan_emi (business loan EMI)          → 'loan_repayment' + business_loan_payments.id
--   record_emi_payment (pre-R-1864 asset EMI)    → 'emi'            + emi_payments.id (as emi_mark_line), and the
--                                                   payment's bank_txn_id now points at it (Undo removes the line)
--   pay_statutory_dues (challan)                 → 'statutory'      + statutory_dues_payments.id
--
-- Kept as 'manual' on purpose: the "Correction: reversed loan/advance to …" line of a deleted
-- pre-R-1873 loan (its loan is gone — nothing to point at) and a real "Mark reconciled manually".
-- record_emi_purchase is not changed: the app no longer calls it (R-1864's record_emi_loan_taken
-- already writes 'emi').
--
-- Un-reconcile keeps working as before: the three new types have no unmatch trigger (same as
-- 'manual'); reconcile_bank_txn(null) still removes a bs_item / statutory row by bank_txn_id. Two
-- reused types DO have one (they drop the loan when the line is un-reconciled), so a line the loan's
-- own form made (source 'manual', no import, its own words) is refused there with the page to undo it on:
-- tg_loan_given_line_unmatched, tg_business_loan_line_unmatched. 'emi' already refuses own lines.
-- reconcile_bank_txn already refuses the new types for a signed-in caller ("only from its own
-- Reconcile option"); bank_match_target_tenant learns them so the R-2472 company gate checks them.
--
-- Old rows: bank_line_bookings() still finds the booking behind an old 'manual' line, and now also
-- returns rows for the new/reused types (the page keeps the party). A read-only count report and a
-- separate repair script are in production/scripts/ops/r2570-bank-line-type-{report,repair}.mjs —
-- the repair is NOT run by this migration (data repair on staging/live needs Pardeep's yes).
-- Test: supabase/tests/r2570_bank_line_own_type.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. matched_to_type gains 'bs_item', 'employee_loan', 'reimbursement' (R-2374's pattern) ──
do $$
declare v_def text; v_vals text[]; v_add text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.bank_transactions'::regclass and c.conname = 'bank_transactions_matched_to_type_check';
  if v_def is null then raise exception 'bank_transactions_matched_to_type_check is missing'; end if;
  if v_def ~ '\{[a-z_,]+\}' then
    v_vals := string_to_array(substring(v_def from '\{([a-z_,]+)\}'), ',');
  else
    select array_agg(m[1] order by ord) into v_vals
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;
  if v_vals is null or cardinality(v_vals) = 0 then raise exception 'Could not read bank_transactions_matched_to_type_check: %', v_def; end if;
  if 'bs_item' = any (v_vals) and 'employee_loan' = any (v_vals) and 'reimbursement' = any (v_vals) then return; end if;
  foreach v_add in array array['bs_item', 'employee_loan', 'reimbursement'] loop
    if not (v_add = any (v_vals)) then v_vals := array_append(v_vals, v_add); end if;
  end loop;
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

-- ── 2. The writers (each from its latest definition) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.book_bank_advance(p_txn_id uuid, p_counterparty text, p_kind text DEFAULT 'given'::text, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570: the line is matched to its own balance-sheet row (bs_item + its id), not 'manual' */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_amount  int;
  v_section text;
  v_label   text;
  v_party   text;
  v_item    uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_party := nullif(trim(coalesce(p_counterparty, '')), '');

  if p_kind = 'given' then
    v_section := 'asset';
    if coalesce(v_txn.debit, 0) > 0 then
      v_amount := v_txn.debit;
      v_label  := 'Advance/loan given' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.credit, 0) > 0 then
      v_amount := -v_txn.credit;
      v_label  := 'Advance/loan returned' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  elsif p_kind = 'received' then
    v_section := 'liability';
    if coalesce(v_txn.credit, 0) > 0 then
      v_amount := v_txn.credit;
      v_label  := 'Loan received' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.debit, 0) > 0 then
      v_amount := -v_txn.debit;
      v_label  := 'Loan repaid' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  else
    raise exception 'Unknown kind: %', p_kind;
  end if;

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, v_section, v_label, v_amount, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id)
  returning id into v_item;

  update public.bank_transactions
     set matched_to_type = 'bs_item', matched_to_id = v_item::text,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.book_bank_credit(p_txn_id uuid, p_kind text, p_label text, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570: the line is matched to its own balance-sheet row (bs_item + its id), not 'manual' */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_section text;
  v_label   text;
  v_item    uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'This is only for money-in (credit) lines';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_section := case p_kind
                 when 'capital'       then 'equity'
                 when 'director_loan' then 'liability'
                 else null end;
  if v_section is null then raise exception 'Unknown kind: %', p_kind; end if;

  v_label := coalesce(nullif(trim(p_label), ''),
                      case p_kind when 'capital' then 'Owner''s capital' else 'Director''s loan' end);

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, v_section, v_label, v_txn.credit, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id)
  returning id into v_item;

  update public.bank_transactions
     set matched_to_type = 'bs_item', matched_to_id = v_item::text,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.disburse_employee_loan(p_employee_name text, p_principal integer, p_disbursed_on date, p_bank_account_id uuid, p_kind text DEFAULT 'loan'::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570: the payout line is matched to its loan (employee_loan + loan id), not 'manual' */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
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
/* R-2570: the loan's own line is 'employee_loan' + loan id (old lines: 'manual'); an edit names it so */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
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
/* R-2570: the loan's own line is 'employee_loan' + loan id (old lines: 'manual') — not 'booked elsewhere' */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
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

CREATE OR REPLACE FUNCTION public.settle_expense_advance(p_loan_id uuid, p_spent_amount integer, p_category text, p_return_amount integer, p_return_account uuid, p_date date, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570: the returned-cash line is matched to its advance (employee_loan + loan id), not 'manual' */
declare
  v_tenant      uuid := public.current_tenant_id();
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
  v_exp_id      text;
  v_ret_method  text;
begin
  p_spent_amount  := coalesce(p_spent_amount, 0);
  p_return_amount := coalesce(p_return_amount, 0);

  if p_spent_amount < 0 or p_return_amount < 0 then
    raise exception 'Amounts cannot be negative';
  end if;
  if p_spent_amount + p_return_amount <= 0 then
    raise exception 'Nothing to settle';
  end if;

  select * into v_loan from public.employee_loans
    where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Advance not found'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = p_loan_id;
  v_outstanding := v_loan.principal - v_paid;

  if p_spent_amount + p_return_amount > v_outstanding then
    raise exception 'Settlement (%) exceeds outstanding (%)', p_spent_amount + p_return_amount, v_outstanding;
  end if;

  if p_spent_amount > 0 then
    if trim(coalesce(p_category, '')) = '' then
      raise exception 'An expense category is required for the spent amount';
    end if;
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                       || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values
      (v_exp_id, v_tenant, trim(p_category), v_loan.employee_name, p_date, p_spent_amount, 0, 'advance',
       'Settled from expense advance to ' || v_loan.employee_name);

    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes)
    values
      (v_tenant, p_loan_id, p_spent_amount, p_date, 'expense', null, v_exp_id,
       nullif(trim(coalesce(p_notes, '')), ''));
  end if;

  if p_return_amount > 0 then
    if p_return_account is null then
      raise exception 'A receiving account is required for the returned cash';
    end if;
    select case when account_type = 'cash' then 'cash' else 'bank' end
      into v_ret_method
      from public.bank_accounts where id = p_return_account and tenant_id = v_tenant;
    if not found then raise exception 'Receiving account not found'; end if;

    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values
      (v_tenant, p_loan_id, p_return_amount, p_date, v_ret_method, p_return_account,
       nullif(trim(coalesce(p_notes, '')), ''));

    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
    values
      (v_tenant, p_return_account, p_date,
       'Advance returned — ' || v_loan.employee_name, 0, p_return_amount, 'manual', 'employee_loan', p_loan_id::text, 'manual');
  end if;

  update public.employee_loans
     set status     = case when v_outstanding - (p_spent_amount + p_return_amount) <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = p_loan_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.give_loan(p_borrower_name text, p_borrower_type text, p_principal integer, p_given_on date, p_paid_from uuid, p_interest_rate numeric DEFAULT 0, p_repayment_plan text DEFAULT 'one_shot'::text, p_due_on date DEFAULT NULL::date, p_instalments integer DEFAULT NULL::integer, p_customer_id uuid DEFAULT NULL::uuid, p_vendor_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570: the payout line is matched to its loan (loan_given + loan id), not 'manual' */
declare
  v_tenant uuid := public.current_tenant_id();
  v_name   text := trim(coalesce(p_borrower_name, ''));
  v_id     uuid;
  v_txn    uuid;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record loans given — ask your owner to do it.';
  end if;
  if v_name = '' then raise exception 'Add the borrower''s name.'; end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Loan amount must be more than ₹0.'; end if;
  if p_given_on is null then raise exception 'Pick the date the loan was given.'; end if;
  if coalesce(p_interest_rate, 0) < 0 or coalesce(p_interest_rate, 0) > 100 then
    raise exception 'Interest must be between 0%% and 100%% a year (0 = interest-free).';
  end if;
  if coalesce(p_borrower_type, 'person') not in ('person', 'company') then
    raise exception 'Borrower type must be person or company.';
  end if;
  if coalesce(p_repayment_plan, 'one_shot') not in ('one_shot', 'instalments') then
    raise exception 'Pick how it will be repaid: one date, or monthly instalments.';
  end if;
  if p_repayment_plan = 'instalments' and (p_instalments is null or p_instalments < 1 or p_due_on is null) then
    raise exception 'For monthly instalments, add the number of months and the first due date.';
  end if;
  if p_due_on is not null and p_due_on < p_given_on then
    raise exception 'The due date is before the date the loan was given — check the dates.';
  end if;
  if p_paid_from is null then raise exception 'Pick the account the money was paid from.'; end if;
  perform 1 from public.bank_accounts where id = p_paid_from and tenant_id = v_tenant;
  if not found then raise exception 'That account is not in your company — pick another, or add it in Banking.'; end if;
  if p_customer_id is not null then
    perform 1 from public.customers where id = p_customer_id and tenant_id = v_tenant;
    if not found then raise exception 'That customer is not in your company.'; end if;
  end if;
  if p_vendor_id is not null then
    perform 1 from public.vendors where id = p_vendor_id and tenant_id = v_tenant;
    if not found then raise exception 'That vendor is not in your company.'; end if;
  end if;

  -- Cash out (money leaves the account → debit).
  v_id := gen_random_uuid();
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
  values
    (v_tenant, p_paid_from, p_given_on, 'Loan given: ' || v_name, p_principal, 0, 'manual', 'loan_given', v_id::text, 'manual')
  returning id into v_txn;

  insert into public.loans_given
    (id, tenant_id, borrower_name, borrower_type, customer_id, vendor_id, principal, given_on, interest_rate,
     repayment_plan, due_on, instalments, paid_from_account_id, bank_txn_id, notes, status, created_by)
  values
    (v_id, v_tenant, v_name, coalesce(p_borrower_type, 'person'), p_customer_id, p_vendor_id, p_principal, p_given_on,
     coalesce(p_interest_rate, 0), coalesce(p_repayment_plan, 'one_shot'), p_due_on,
     case when p_repayment_plan = 'instalments' then p_instalments else null end,
     p_paid_from, v_txn, nullif(trim(coalesce(p_notes, '')), ''), 'open', auth.uid())
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_business_loan(p_lender text, p_purpose text, p_principal integer, p_interest_rate numeric, p_tenure_months integer, p_emi_amount integer, p_disbursed_on date, p_deposit_account uuid, p_bank_txn_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
/* R-2570: the challan line is matched to its payment (statutory + payment id), not 'manual' */
declare
  v_tenant uuid := public.current_tenant_id();
  v_acct   text;
  v_sid    uuid;
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
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
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

CREATE OR REPLACE FUNCTION public.bank_match_target_tenant(p_type text, p_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2472: the company that owns record p_id in the table match type p_type points at;
   null = no such record (or a type this helper does not know). */
declare
  v_uuid uuid := public.bank_match_uuid(p_id);
begin
  if p_id is null then return null; end if;
  return case p_type
    when 'expense'        then (select x.tenant_id from public.expenses x                where x.id = p_id)
    when 'vendor_bill'    then (select x.tenant_id from public.vendor_bills x            where x.id = p_id)
    when 'payment'        then (select x.tenant_id from public.payments x                where x.id = v_uuid)
    when 'project'        then (select x.tenant_id from public.project_payments x        where x.id = v_uuid)
    when 'salary'         then (select x.tenant_id from public.salary_payments x         where x.id = v_uuid)
    when 'transfer'       then (select x.tenant_id from public.bank_transactions x       where x.id = v_uuid)
    when 'other_income'   then (select x.tenant_id from public.other_incomes x           where x.id = v_uuid)
    when 'loan_given'     then coalesce((select x.tenant_id from public.loan_repayments x where x.id = v_uuid),
                                        (select x.tenant_id from public.loans_given x     where x.id = v_uuid))
    when 'business_loan'  then (select x.tenant_id from public.business_loans x          where x.id = v_uuid)
    when 'loan_drawdown'  then (select x.tenant_id from public.business_loan_drawdowns x where x.id = v_uuid)
    when 'loan_repayment' then (select x.tenant_id from public.business_loan_payments x  where x.id = v_uuid)
    -- R-2570: the types the own-line writers now set
    when 'bs_item'        then (select x.tenant_id from public.balance_sheet_items x     where x.id = v_uuid)
    when 'employee_loan'  then (select x.tenant_id from public.employee_loans x          where x.id = v_uuid)
    -- 'reimbursement:<id>' (the shape the staff-advance flow writes) or a bare id — both are checked
    when 'reimbursement'  then (select x.tenant_id from public.reimbursements x
                                 where x.id = coalesce(v_uuid, public.bank_match_uuid(substr(p_id, length('reimbursement:') + 1))))
    when 'statutory'      then (select x.tenant_id from public.statutory_dues_payments x where x.id = v_uuid)
    else null
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tg_loan_given_line_unmatched()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rep public.loan_repayments;
  v_l   public.loans_given;
  v_n   integer;
begin
  -- R-2340
  if old.matched_to_type = 'loan_given'
     and (new.matched_to_type is distinct from 'loan_given' or new.matched_to_id is distinct from old.matched_to_id) then
    select * into v_rep from public.loan_repayments where bank_txn_id = old.id for update;
    if found then
      select count(*) into v_n from public.loan_repayments r
       where r.loan_id = v_rep.loan_id and r.id <> v_rep.id
         and (r.repaid_on > v_rep.repaid_on or (r.repaid_on = v_rep.repaid_on and r.created_at > v_rep.created_at));
      if v_n > 0 then
        raise exception '% later receipt(s) of this loan are on the books — undo the latest receipt first, then this one', v_n;
      end if;
      delete from public.other_incomes where bank_txn_id = old.id;
      delete from public.loan_repayments where id = v_rep.id;
      update public.loans_given set status = 'open', closed_on = null, updated_at = now() where id = v_rep.loan_id;
      -- R-2346: a line Record repayment added (never on a statement) goes with its repayment.
      if old.source = 'manual' and old.import_batch_id is null and old.reference = 'LOAN-REPAYMENT' then
        delete from public.bank_transactions where id = old.id;
      end if;
      return null;
    end if;
    select * into v_l from public.loans_given where bank_txn_id = old.id for update;
    if found then
      -- R-2570: the payout line Give loan made itself (no statement behind it) — un-reconciling would
      -- drop the loan and leave the line. Delete the loan on Loans given instead (its line goes with it).
      if old.source = 'manual' and old.import_batch_id is null and old.description = 'Loan given: ' || v_l.borrower_name then
        raise exception 'This line was made by Loans given (loan to %) — delete that loan on Accounting → Loans given instead; its line goes with it', v_l.borrower_name
          using errcode = '23514';
      end if;
      select count(*) into v_n from public.loan_repayments where loan_id = v_l.id;
      if v_n > 0 then
        raise exception 'This line is the money lent to % and % receipt(s) of it are reconciled — undo those first, then un-reconcile this line',
          v_l.borrower_name, v_n;
      end if;
      delete from public.loans_given where id = v_l.id;
    end if;
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tg_business_loan_line_unmatched()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_l public.business_loans;
  v_n integer;
begin
  -- R-2377
  if old.matched_to_type = 'business_loan'
     and (new.matched_to_type is distinct from 'business_loan' or new.matched_to_id is distinct from old.matched_to_id) then
    select * into v_l from public.business_loans where disbursal_bank_txn_id = old.id for update;
    if found then
      -- R-2570: the money-in line Add loan made itself — undone by deleting the loan on Business Loans.
      if old.source = 'manual' and old.import_batch_id is null and old.description = 'Loan received: ' || v_l.lender then
        raise exception 'This line was made by Business Loans (loan from %) — delete that loan on Accounting → Business Loans instead; its line goes with it', v_l.lender
          using errcode = '23514';
      end if;
      select count(*) into v_n from public.business_loan_payments where loan_id = v_l.id;
      if v_n > 0 then
        raise exception 'This line is the money of the loan from % and % EMI payment(s) of it are recorded — delete those first, then un-reconcile this line',
          v_l.lender, v_n;
      end if;
      delete from public.business_loans where id = v_l.id;
    end if;
  end if;
  return null;
end;
$function$;

-- ── 3. bank_line_bookings reads the new types too ───────────────────────────────────────
create or replace function public.bank_line_bookings(p_bank_account_id uuid)
returns table (txn_id uuid, source text, sub text, party text, amount numeric)
language sql
stable
security invoker
set search_path to 'public'
as $function$
  /* R-2378: what a matched_to_type = 'manual' line really booked. First match per line wins.
     R-2570: the writers now store their own type + id (bs_item, employee_loan, reimbursement,
     loan_given, business_loan, loan_repayment, emi, statutory) — those lines are read here too, so
     the line keeps its party ("Loan received · Bajaj Finance"); 'manual' rows from before R-2570
     are still found the R-2378 way. */
  with lines as (
    select t.id, t.source, t.description, t.txn_date, t.debit, t.credit, t.matched_to_type,
           /* the record id as uuid (a non-uuid id → null), so the joins below use the primary keys */
           case when t.matched_to_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then t.matched_to_id::uuid end as mid
      from public.bank_transactions t
     where t.bank_account_id = p_bank_account_id
       and t.matched_to_type in ('manual', 'bs_item', 'employee_loan', 'reimbursement', 'loan_given', 'business_loan',
                                 'loan_drawdown', 'loan_repayment', 'emi', 'statutory')
  ), found as (
    select b.bank_txn_id as txn_id, 1 as pri, 'bs_item'::text as source, b.section as sub, b.label as party, b.amount::numeric as amount
      from public.balance_sheet_items b join lines l on l.id = b.bank_txn_id
    union all
    select e.bank_txn_id, 2, 'employee_loan', e.kind, e.employee_name, e.principal::numeric
      from public.employee_loans e join lines l on l.id = e.bank_txn_id
    union all
    /* R-2570: a staff loan's repayment / an advance's returned cash — matched to the loan by id. */
    select l.id, 2, case when e.kind = 'expense_advance' then 'employee_advance_returned' else 'employee_loan_repayment' end,
           null, e.employee_name, l.credit::numeric
      from lines l join public.employee_loans e on e.id = l.mid
     where l.matched_to_type = 'employee_loan' and l.credit > 0
    union all
    select g.bank_txn_id, 3, 'loan_given', g.borrower_type, g.borrower_name, g.principal::numeric
      from public.loans_given g join lines l on l.id = g.bank_txn_id
    union all
    select r.bank_txn_id, 4, 'loan_given_repayment', r.mode, g.borrower_name, r.amount::numeric
      from public.loan_repayments r join lines l on l.id = r.bank_txn_id
      join public.loans_given g on g.id = r.loan_id
    union all
    select bl.disbursal_bank_txn_id, 5, 'business_loan', bl.kind, bl.lender, bl.principal::numeric
      from public.business_loans bl join lines l on l.id = bl.disbursal_bank_txn_id
    union all
    select p.bank_txn_id, 6, 'business_loan_payment', bl.kind, bl.lender, p.amount::numeric
      from public.business_loan_payments p join lines l on l.id = p.bank_txn_id
      join public.business_loans bl on bl.id = p.loan_id
    union all
    /* R-2570: record_loan_emi's own line — matched to the repayment by id (the payment has no bank_txn_id). */
    select l.id, 6, 'business_loan_payment', bl.kind, bl.lender, p.amount::numeric
      from lines l join public.business_loan_payments p on p.id = l.mid
      join public.business_loans bl on bl.id = p.loan_id
     where l.matched_to_type = 'loan_repayment' and p.bank_txn_id is null
    union all
    select d.bank_txn_id, 7, 'business_loan_drawdown', bl.kind, bl.lender, d.amount::numeric
      from public.business_loan_drawdowns d join lines l on l.id = d.bank_txn_id
      join public.business_loans bl on bl.id = d.loan_id
    union all
    select ep.bank_txn_id, 8, 'emi_payment', ep.kind, coalesce(nullif(trim(pu.lender), ''), pu.name), ep.amount::numeric
      from public.emi_payments ep join lines l on l.id = ep.bank_txn_id
      join public.emi_purchases pu on pu.id = ep.purchase_id
    union all
    select pu.down_bank_txn_id, 9, 'emi_down_payment', pu.kind, pu.name, pu.down_payment::numeric
      from public.emi_purchases pu join lines l on l.id = pu.down_bank_txn_id
    union all
    select pu.received_bank_txn_id, 10, 'emi_loan_received', pu.kind, coalesce(nullif(trim(pu.lender), ''), pu.name), pu.financed::numeric
      from public.emi_purchases pu join lines l on l.id = pu.received_bank_txn_id
    union all
    select k.bank_txn_id, 11, 'staff_advance', k.kind, coalesce(rb.person_name, pa.vendor_name), k.amount::numeric
      from public.employee_advance_bank_links k join lines l on l.id = k.bank_txn_id
      left join public.reimbursements rb on rb.id = k.reimbursement_id
      left join public.prepaid_advances pa on pa.id = k.advance_id
    union all
    select s.bank_txn_id, 12, 'statutory', s.kind, s.challan_no, s.amount::numeric
      from public.statutory_dues_payments s join lines l on l.id = s.bank_txn_id
    union all
    /* R-2570: pay_statutory_dues' own line — matched to the payment by id. */
    select l.id, 12, 'statutory', s.kind, s.challan_no, s.amount::numeric
      from lines l join public.statutory_dues_payments s on s.id = l.mid
     where l.matched_to_type = 'statutory'
    union all
    /* A staff loan from before R-1873 (no bank_txn_id): its own hand-entered line, found the way
       employee_loan_legacy_line() finds it. */
    select l.id, 13, 'employee_loan', e.kind, e.employee_name, e.principal::numeric
      from lines l join public.employee_loans e
        on e.bank_txn_id is null and e.bank_account_id = p_bank_account_id
       and l.source = 'manual' and l.txn_date = e.disbursed_on and l.debit = e.principal
       and l.description in ('Loan/advance to ' || e.employee_name, 'Expense advance to ' || e.employee_name)
     where l.matched_to_type = 'manual'
    union all
    /* The lines the staff-loan RPCs wrote with no link at all (before R-2570) — their words name the booking. */
    select l.id, 14, 'employee_loan_reversal', null, substr(l.description, length('Correction: reversed loan/advance to ') + 1), null::numeric
      from lines l where l.matched_to_type = 'manual' and l.source = 'manual' and l.description like 'Correction: reversed loan/advance to %'
    union all
    select l.id, 15, 'employee_loan_repayment', null, substr(l.description, length('Loan repayment — ') + 1), null::numeric
      from lines l where l.matched_to_type = 'manual' and l.source = 'manual' and l.description like 'Loan repayment — %'
    union all
    select l.id, 16, 'employee_advance_returned', null, substr(l.description, length('Advance returned — ') + 1), null::numeric
      from lines l where l.matched_to_type = 'manual' and l.source = 'manual' and l.description like 'Advance returned — %'
  )
  select distinct on (f.txn_id) f.txn_id, f.source, f.sub, f.party, f.amount
    from found f
   order by f.txn_id, f.pri;
$function$;

revoke all on function public.bank_line_bookings(uuid) from public;
revoke all on function public.bank_line_bookings(uuid) from anon;
grant execute on function public.bank_line_bookings(uuid) to authenticated;
grant execute on function public.bank_line_bookings(uuid) to service_role;

commit;
