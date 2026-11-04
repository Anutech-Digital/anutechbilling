-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_txn(uuid,text,text,text)') and prosrc like '%R-2472%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.sync_salary_paid_status()') and prosrc like '%R-2472%')
-- deploy-key: r2472banktargettenant
--
-- R-2472 (4 Nov 2026, p1 security, money) — found by the R-2364 worker. reconcile_bank_txn is
-- SECURITY DEFINER and, since R-718, checked only that the BANK LINE was the caller's company —
-- never the id it links the line to. Proven on the local DB (supabase/tests/r2472_…, red without
-- this file): company A's billing login matched A's lines to company B's payment, expense, project
-- receipt, salary and bank line; B's project receipt then pointed at A's line
-- (project_payments.bank_txn_id) and B's salary turned paid (trg_sync_salary_paid runs as definer and
-- updated salary_payments by id alone — reachable even by a plain UPDATE of A's own line, which RLS
-- allows).
--
-- ─── WHAT THIS CHANGES ────────────────────────────────────────────────────────
--   reconcile_bank_txn(uuid,text,text,text) ← 20261104060346_r2364_suggestions_skip_used (latest;
--     checked all anutech/* branches: no later redefinition). R-2364 + R-718 body unchanged, plus:
--       • a caller with no company and not trusted → refused (fail closed, before reading the line);
--       • a target id must be a row of the bank line's company in the table its match type names
--         (payment → payments, expense → expenses, project → project_payments, salary →
--         salary_payments, transfer → bank_transactions, … every type in
--         bank_transactions_matched_to_type_check; customer_refund stays with R-2322's trigger); 'manual' / 'split' take no id; an unknown type
--         or an id not found in the company → refused with 42501, nothing changed;
--       • the project / expense reverse-link writes also carry tenant_id (defence in depth).
--   sync_salary_paid_status() (trigger trg_sync_salary_paid) ← supabase/baseline.sql (latest; no
--     migration redefines it): the salary row is looked up and updated only inside the line's own
--     company (old.tenant_id / new.tenant_id), and a non-uuid id no longer raises a cast error.
--
-- Audited, same gap NOT present (each checks every target id against the bank line's company, and
-- the line against the caller): bank_credit_pay_item (R-2466 20261104045700; service_role only),
-- reconcile_bank_credit_to_item + reconcile_bank_credit_split + bank_credit_book_advance (R-2430
-- 20261103200938), reconcile_bank_credit_fx_invoice (R-2427 20261104001617),
-- reconcile_expenses_to_bank_txn + reconcile_salaries_to_bank_txn (R-885 20261012025800),
-- suggest_bank_transaction_matches (R-2364), tg_bank_txn_payment_link (R-2095, tenant-scoped).
-- Test: supabase/tests/r2472_bank_target_tenant_gate.test.sql (begin … rollback; red without this file).
begin;

CREATE OR REPLACE FUNCTION public.reconcile_bank_txn(p_txn_id uuid, p_matched_to_type text, p_matched_to_id text, p_match_confidence text)
 RETURNS bank_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_trusted boolean;
  v_txn    public.bank_transactions;
  v_row    public.bank_transactions;
  v_tax_expenses text[];
  v_used   integer;
  v_other_date date;
  v_other_amt  bigint;
  v_target_ok  boolean;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match a bank line' using errcode = '42501';
  end if;
  /* R-2472: fail closed — a request without a company never reaches a bank line. */
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found then
    raise exception 'Bank transaction not found' using errcode = 'no_data_found';
  end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_txn.tenant_id is distinct from v_tenant) then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-2472: what the line is matched to must be in the line's own company. Each match type names
     its table (bank_transactions_matched_to_type_check lists them all); 'manual' and 'split' carry
     no id; anything else, or an id not found in this company → refused, nothing changed. */
  if p_matched_to_type is not null and p_matched_to_id is not null then
    v_target_ok := case p_matched_to_type
      when 'payment'             then exists (select 1 from public.payments x               where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'expense'             then exists (select 1 from public.expenses x               where x.id       = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'vendor_bill'         then exists (select 1 from public.vendor_bills x           where x.id       = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'transfer'            then exists (select 1 from public.bank_transactions x      where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'salary'              then exists (select 1 from public.salary_payments x        where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'project'             then exists (select 1 from public.project_payments x       where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'statutory'           then exists (select 1 from public.tax_payments x           where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
                                   or exists (select 1 from public.statutory_dues_payments x where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'prepaid'             then exists (select 1 from public.prepaid_advances x       where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'referral_commission' then exists (select 1 from public.referral_commissions x   where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'owner_equity'        then exists (select 1 from public.owner_equity_movements x where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'vendor_payment'      then exists (select 1 from public.vendors x                where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'emi'                 then exists (select 1 from public.emi_payments x           where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
                                   or exists (select 1 from public.emi_purchases x          where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'other_income'        then exists (select 1 from public.other_incomes x          where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      -- tg_customer_refund_line (R-2322) already refuses any customer_refund link whose refund row
      -- does not name THIS line (bank_txn_id = the line) — keep its message ("only through
      -- Reconcile → Customer refund"); a refund naming this line is this company's.
      when 'customer_refund'     then true
      when 'loan_given'          then exists (select 1 from public.loans_given x            where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
                                   or exists (select 1 from public.loan_repayments x        where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'business_loan'       then exists (select 1 from public.business_loans x         where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'loan_drawdown'       then exists (select 1 from public.business_loan_drawdowns x where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      when 'loan_repayment'      then exists (select 1 from public.business_loan_payments x where x.id::text = p_matched_to_id and x.tenant_id = v_txn.tenant_id)
      else false
    end;
    if not coalesce(v_target_ok, false) then
      raise exception 'The % this bank line is being matched to is not in your company (or no longer exists). Nothing was changed.',
        replace(p_matched_to_type, '_', ' ')
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  /* R-2364: one receipt, one bank line. Another line already matched to this payment, or a
     reconciled split line holding it (payments.bank_txn_id, R-2098) → refused, nothing changed. */
  if p_matched_to_type = 'payment' and p_matched_to_id is not null then
    /* Lock the receipt first: two lines matched to it at the same moment (auto-reconcile + a click)
       wait for each other, and the second one's check below sees the first one's match. */
    perform 1 from public.payments p
     where p.tenant_id = v_txn.tenant_id and p.id::text = p_matched_to_id for update;
    select t.txn_date, greatest(t.credit, t.debit) into v_other_date, v_other_amt
      from public.bank_transactions t
     where t.tenant_id = v_txn.tenant_id and t.id <> p_txn_id
       and ((t.matched_to_type = 'payment' and t.matched_to_id = p_matched_to_id)
            or (t.matched_to_type is not null
                and t.id = (select p.bank_txn_id from public.payments p
                             where p.tenant_id = v_txn.tenant_id and p.id::text = p_matched_to_id)))
     limit 1;
    if found then
      raise exception 'This receipt is already reconciled to another bank line (% · ₹%). Un-reconcile that line first, or match this line to a different receipt. Nothing was changed.',
        to_char(v_other_date, 'DD Mon YYYY'), v_other_amt
        using errcode = 'unique_violation';
    end if;
  end if;

  -- A prepaid line that stops being one: refuse if its advance was already used.
  if v_txn.matched_to_type = 'prepaid' and p_matched_to_type is distinct from 'prepaid' then
    select coalesce(sum(consumed_amount), 0) into v_used
      from public.prepaid_advances where bank_txn_id = p_txn_id;
    if v_used > 0 then
      raise exception 'This advance has ₹% already booked as expenses from invoices. Delete those invoice expenses first (Prepaid page), then un-reconcile.', v_used;
    end if;
  end if;

  if p_matched_to_type is not null then
    update public.bank_transactions
       set matched_to_type  = p_matched_to_type,
           matched_to_id    = p_matched_to_id,
           matched_at       = now(),
           matched_by       = auth.uid(),
           match_confidence = coalesce(p_match_confidence, 'manual')
     where id = p_txn_id
     returning * into v_row;
  else
    update public.bank_transactions
       set matched_to_type  = null,
           matched_to_id    = null,
           matched_at       = null,
           matched_by       = null,
           match_confidence = null
     where id = p_txn_id
     returning * into v_row;
  end if;

  if p_matched_to_type is distinct from 'prepaid' then
    delete from public.prepaid_advances where bank_txn_id = p_txn_id;
  end if;

  -- Tax payment on this line: gone once the line is no longer a tax payment.
  if p_matched_to_type is distinct from 'statutory' then
    select array_agg(expense_id) filter (where expense_id is not null) into v_tax_expenses
      from public.tax_payments where bank_txn_id = p_txn_id;
    delete from public.tax_payments where bank_txn_id = p_txn_id;
    if v_tax_expenses is not null then
      delete from public.expenses where id = any (v_tax_expenses);
    end if;
  end if;

  -- Reverse link on project_payments: clear any stale pointer to this line,
  -- then set it when matching to a project payment. (project_payments.id is uuid.)
  -- R-2472: both writes stay inside the line's company.
  update public.project_payments set bank_txn_id = null where bank_txn_id = p_txn_id and tenant_id = v_txn.tenant_id;
  if p_matched_to_type = 'project' and p_matched_to_id is not null then
    update public.project_payments set bank_txn_id = p_txn_id
     where id::text = p_matched_to_id and tenant_id = v_txn.tenant_id;
  end if;

  -- Reverse link on expenses: same clear-then-set. (expenses.id is text.)
  update public.expenses set reconciled_txn_id = null where reconciled_txn_id = p_txn_id and tenant_id = v_txn.tenant_id;
  if p_matched_to_type = 'expense' and p_matched_to_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id
     where id = p_matched_to_id and tenant_id = v_txn.tenant_id;
  end if;

  -- Un-reconcile also reverses a line booked as capital / director's loan
  -- (balance sheet) or a statutory (TDS/PF/ESI) challan, so nothing drifts.
  if p_matched_to_type is null then
    delete from public.balance_sheet_items       where bank_txn_id = p_txn_id;
    delete from public.statutory_dues_payments    where bank_txn_id = p_txn_id;
  end if;

  return v_row;
end;
$function$
;
revoke all on function public.reconcile_bank_txn(uuid, text, text, text) from public, anon;
grant execute on function public.reconcile_bank_txn(uuid, text, text, text) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_salary_paid_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old_sal uuid;
  v_new_sal uuid;
begin
  /* R-2472: the salary is looked up and changed only inside the bank line's own company — a line
     pointed at another company's salary id (any way: RPC or a plain UPDATE of one's own line)
     changes nothing there. id::text so a non-uuid id finds nothing instead of raising. */
  if tg_op = 'UPDATE' and old.matched_to_type = 'salary' and old.matched_to_id is not null then
    select id into v_old_sal from public.salary_payments
     where id::text = old.matched_to_id and tenant_id = old.tenant_id;
  elsif tg_op = 'UPDATE' and old.matched_to_type = 'expense' and old.matched_to_id is not null then
    select id into v_old_sal from public.salary_payments
     where expense_id = old.matched_to_id and tenant_id = old.tenant_id;
  end if;

  if new.matched_to_type = 'salary' and new.matched_to_id is not null then
    select id into v_new_sal from public.salary_payments
     where id::text = new.matched_to_id and tenant_id = new.tenant_id;
  elsif new.matched_to_type = 'expense' and new.matched_to_id is not null then
    select id into v_new_sal from public.salary_payments
     where expense_id = new.matched_to_id and tenant_id = new.tenant_id;
  end if;

  if v_old_sal is not null and v_old_sal is distinct from v_new_sal then
    update public.salary_payments
       set paid_amount = greatest(0, paid_amount - old.debit),
           paid_status = case
             when greatest(0, paid_amount - old.debit) <= 0   then 'unpaid'
             when greatest(0, paid_amount - old.debit) >= net then 'paid'
             else 'partial' end,
           reconciled_txn_id = case when reconciled_txn_id = old.id then null else reconciled_txn_id end
     where id = v_old_sal and tenant_id = old.tenant_id;
  end if;

  if v_new_sal is not null and (tg_op = 'INSERT' or v_new_sal is distinct from v_old_sal) then
    update public.salary_payments
       set paid_amount = paid_amount + new.debit,
           paid_status = case
             when paid_amount + new.debit >= net then 'paid'
             when paid_amount + new.debit <= 0   then 'unpaid'
             else 'partial' end,
           reconciled_txn_id = case when paid_amount + new.debit >= net then new.id else reconciled_txn_id end
     where id = v_new_sal and tenant_id = new.tenant_id;
  end if;

  if tg_op = 'UPDATE' and old.matched_to_type = 'split' and new.matched_to_type is null then
    update public.salary_payments
       set paid_status = 'unpaid', paid_amount = 0, reconciled_txn_id = null
     where reconciled_txn_id = old.id and tenant_id = old.tenant_id;
    update public.expenses set reconciled_txn_id = null where reconciled_txn_id = old.id and tenant_id = old.tenant_id;
  end if;

  return new;
end;
$function$
;
revoke all on function public.sync_salary_paid_status() from public;
grant all on function public.sync_salary_paid_status() to authenticated, service_role;

commit;
