-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_txn(uuid,text,text,text)') and prosrc like '%R-2472%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.sync_salary_paid_status()') and prosrc like '%R-2472%') and exists(select 1 from pg_trigger where tgname = 'trg_bank_match_target_company')
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
--   bank_match_uuid(text) / bank_match_target_tenant(text,text) — new helpers: one place that says
--     which table each match type points at, and which company owns that record
--     (uuid ids cast once, regex-guarded, so the primary-key index is used).
--   reconcile_bank_txn(uuid,text,text,text) ← 20261104060346_r2364_suggestions_skip_used (latest;
--     checked all anutech/* branches: no later redefinition). R-2364 + R-718 body unchanged, plus:
--       • a caller with no company and not trusted → refused (fail closed, before reading the line);
--       • only the match types this RPC is meant for: payment, expense, project, salary,
--         vendor_bill, transfer, other_income, loan_given, business_loan, loan_drawdown,
--         loan_repayment (with an id), manual / split (no id), customer_refund (R-2322's trigger
--         refuses it unless its refund names the line). statutory / prepaid / owner_equity /
--         vendor_payment / emi / referral_commission are booked only by their own flows (which
--         write the books) — refused here for a signed-in caller, so a line can't be "reconciled"
--         with nothing booked;
--       • a target id must be a row of the bank line's company → else 42501, nothing changed;
--       • the project / expense reverse-link writes and the R-2364 receipt lock use the checked
--         uuid / carry tenant_id.
--   trg_bank_match_target_company (new, BEFORE INSERT / UPDATE OF matched_to_type, matched_to_id on
--     bank_transactions): the same company check for every path — a plain UPDATE of one's own line
--     (RLS allows it) can no longer point it at another company's payment / expense / project
--     receipt / salary / bill / bank line / income / loan row. An id with no record yet passes
--     (record_loan_repayment writes the line first, the repayment right after — R-2346; old test
--     fixtures use placeholder ids); the RPC above still needs the record. Types booked only by their own
--     definer flows (statutory, prepaid, owner_equity, vendor_payment, emi, referral_commission,
--     customer_refund) are left to those flows (each checks the company itself).
--   sync_salary_paid_status() (trigger trg_sync_salary_paid) ← supabase/baseline.sql (latest; no
--     migration redefines it): the salary row is looked up and updated only inside the line's own
--     company (old.tenant_id / new.tenant_id); a non-uuid id finds nothing instead of raising.
--
-- Audited, same gap NOT present (each checks every target id against the bank line's company, and
-- the line against the caller): bank_credit_pay_item (R-2466 20261104045700; service_role only),
-- reconcile_bank_credit_to_item + reconcile_bank_credit_split + bank_credit_book_advance (R-2430
-- 20261103200938), reconcile_bank_credit_fx_invoice (R-2427 20261104001617),
-- reconcile_expenses_to_bank_txn + reconcile_salaries_to_bank_txn (R-885 20261012025800),
-- suggest_bank_transaction_matches (R-2364), tg_bank_txn_payment_link (R-2095, tenant-scoped).
-- Test: supabase/tests/r2472_bank_target_tenant_gate.test.sql (begin … rollback; red without this file).
begin;

CREATE OR REPLACE FUNCTION public.bank_match_uuid(p_id text)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
AS $function$
  /* R-2472: a matched_to_id that is a uuid, as a uuid (so a lookup uses the primary key); else null. */
  select case when p_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_id::uuid end;
$function$;

CREATE OR REPLACE FUNCTION public.bank_match_target_tenant(p_type text, p_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
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
    else null
  end;
end;
$function$;
revoke all on function public.bank_match_target_tenant(text, text) from public, anon, authenticated;
grant execute on function public.bank_match_target_tenant(text, text) to service_role;

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
  v_target uuid := public.bank_match_uuid(p_matched_to_id);
  v_known  boolean := false;
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
  /* A company login: only its own lines. No company here means a trusted caller (refused above otherwise). */
  if v_txn.tenant_id is distinct from coalesce(v_tenant, v_txn.tenant_id) then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-2472: what the line is matched to must be in the line's own company
     (bank_match_target_tenant); 'manual' / 'split' carry no id; customer_refund is R-2322's
     trigger's call; the types only their own booking flows set are refused for a signed-in caller. */
  if p_matched_to_type in ('manual', 'split') then
    if p_matched_to_id is not null then
      raise exception 'A % match takes no linked record. Nothing was changed.', p_matched_to_type using errcode = '22023';
    end if;
  elsif p_matched_to_type is not null and p_matched_to_type <> 'customer_refund' then
    v_known := p_matched_to_type in ('payment', 'expense', 'project', 'salary', 'vendor_bill', 'transfer', 'other_income',
                                    'loan_given', 'business_loan', 'loan_drawdown', 'loan_repayment');
    if not v_known and not v_trusted then
      raise exception 'A bank line is booked as % only from its own Reconcile option. Nothing was changed.', replace(p_matched_to_type, '_', ' ')
        using errcode = 'insufficient_privilege';
    end if;
    if v_known and p_matched_to_id is not null
       and public.bank_match_target_tenant(p_matched_to_type, p_matched_to_id) is distinct from v_txn.tenant_id then
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
     where p.tenant_id = v_txn.tenant_id and p.id = v_target for update;
    select t.txn_date, greatest(t.credit, t.debit) into v_other_date, v_other_amt
      from public.bank_transactions t
     where t.tenant_id = v_txn.tenant_id and t.id <> p_txn_id
       and ((t.matched_to_type = 'payment' and t.matched_to_id = p_matched_to_id)
            or (t.matched_to_type is not null
                and t.id = (select p.bank_txn_id from public.payments p
                             where p.tenant_id = v_txn.tenant_id and p.id = v_target)))
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
     where id = v_target and tenant_id = v_txn.tenant_id;
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

CREATE OR REPLACE FUNCTION public.tg_bank_match_target_company()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2472: every path that points a bank line at a record (RPC, a definer flow, or a plain UPDATE
   that RLS allows on one's own line) — the record must be in the line's own company. Types the
   helper does not know (statutory, prepaid, owner_equity, vendor_payment, emi, referral_commission,
   customer_refund, manual, split) are set only by their own definer flows, which check the company. */
begin
  if new.matched_to_type is null or new.matched_to_id is null then return new; end if;
  if tg_op = 'UPDATE'
     and new.matched_to_type is not distinct from old.matched_to_type
     and new.matched_to_id is not distinct from old.matched_to_id
     and new.tenant_id is not distinct from old.tenant_id then
    return new;
  end if;
  /* Another company's record → refused. No record yet is let through: some flows write the line
     first and the record right after, in the same transaction (record_loan_repayment, R-2346). */
  if public.bank_match_target_tenant(new.matched_to_type, new.matched_to_id) is distinct from new.tenant_id
     and public.bank_match_target_tenant(new.matched_to_type, new.matched_to_id) is not null then
    raise exception 'The % this bank line is being matched to is not in your company. Nothing was changed.',
      replace(new.matched_to_type, '_', ' ')
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$function$;
revoke all on function public.tg_bank_match_target_company() from public, anon, authenticated;

drop trigger if exists trg_bank_match_target_company on public.bank_transactions;
create trigger trg_bank_match_target_company
  before insert or update of matched_to_type, matched_to_id, tenant_id on public.bank_transactions
  for each row execute function public.tg_bank_match_target_company();

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
     changes nothing there. bank_match_uuid: a non-uuid id finds nothing instead of raising. */
  if tg_op = 'UPDATE' and old.matched_to_type = 'salary' and old.matched_to_id is not null then
    select id into v_old_sal from public.salary_payments
     where id = public.bank_match_uuid(old.matched_to_id) and tenant_id = old.tenant_id;
  elsif tg_op = 'UPDATE' and old.matched_to_type = 'expense' and old.matched_to_id is not null then
    select id into v_old_sal from public.salary_payments
     where expense_id = old.matched_to_id and tenant_id = old.tenant_id;
  end if;

  if new.matched_to_type = 'salary' and new.matched_to_id is not null then
    select id into v_new_sal from public.salary_payments
     where id = public.bank_match_uuid(new.matched_to_id) and tenant_id = new.tenant_id;
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
