-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.suggest_bank_transaction_matches(uuid)') and prosrc like '%R-2364%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_txn(uuid,text,text,text)') and prosrc like '%R-2364%')
-- deploy-key: r2364suggestionsskipused
--
-- R-2364 (4 Nov 2026, p1 money) — Banking → Reconcile → "Suggested matches" offered a receipt that
-- another bank line already uses. Chrome, scenario zero-ref-credits: two ₹5,000 lines (ref 000…, same
-- customer). Line 1 booked → receipt BANK-<line 1>; opening line 2 showed "Payment · High — SCN Zero
-- Ref Traders · BANK-<line 1> · ₹5,000" with Match → one receipt on two bank lines (₹5,000 counted
-- once in the books, banked twice). 2 Nov staging: a Pathak line was offered another Pathak line's
-- receipt; the Gibi Paul ₹3,717 line (a known payer of Bethelsoft) was offered other customers' ₹3,717
-- receipts first. auto_reconcile_bank_account (R-1657 / R-1867) takes the top suggestion too, so the
-- same mistake could be booked without a click.
--
-- ─── WHAT THIS CHANGES ────────────────────────────────────────────────────────
--   suggest_bank_transaction_matches(uuid) ← 20261018044814_r1565_credit_applied_not_cash (latest):
--     payments — never one that ANOTHER bank line already carries: matched to it (matched_to_type
--       'payment'), or a reconciled split line holding it (payments.bank_txn_id, R-2098), or one
--       created from another existing line (reference BANK-<that line id>);
--       a KNOWN PAYER's customer ranks first — the line's own payer answer (bank_transactions.payer
--       customer_id, R-2025) or exactly one customer whose customer_payers key is in the narration —
--       and then other customers' receipts are 'low' (their name stays in the label);
--     expenses — never one already reconciled to another line (expenses.reconciled_txn_id, or a line
--       matched to it) — the server twin of R-2325's browser filter;
--     project / salary unchanged (project already skips pp.bank_txn_id; salary only 'unpaid').
--   reconcile_bank_txn(uuid,text,text,text) ← 20261011120000_r718_money_roles (latest; checked: no later
--     redefinition): matching a line to a payment another line already carries (matched to it, or a
--     reconciled split line holding it) is refused with unique_violation — R-2098's replay rule. The
--     BANK- reference rule is not used here: a receipt created from a line is matched to that line in
--     the same transaction. The rest is the R-718 body unchanged.
-- Test: supabase/tests/r2364_suggestions_skip_used.test.sql (begin … rollback; red without this file).
begin;

CREATE OR REPLACE FUNCTION public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
 RETURNS TABLE(match_type text, match_id text, match_label text, match_amount integer, match_date date, match_confidence text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_txn record; v_tenant uuid; v_search_amount integer; v_is_credit boolean;
  v_caller uuid; v_trusted boolean; v_known uuid; v_key text; v_payer_customers uuid[];
begin
  /* R-715: a signed-in caller sees suggestions only for their own company's bank line.
     No company (null-caller) → refused; another company's line → nothing (as "not found"). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  if not v_trusted and v_txn.tenant_id is distinct from v_caller then return; end if;
  v_tenant := v_txn.tenant_id; v_search_amount := greatest(v_txn.debit, v_txn.credit); v_is_credit := v_txn.credit > 0;
  if v_is_credit then
    /* R-2364: who paid — the line's own payer answer (R-2025), else exactly one customer whose
       known payer is named in the narration. Two customers → no guess. */
    if coalesce(v_txn.payer->>'customer_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select c.id into v_known from public.customers c
       where c.id = (v_txn.payer->>'customer_id')::uuid and c.tenant_id = v_tenant;
    end if;
    if v_known is null then
      v_key := public.payer_name_key(coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.reference, ''));
      if v_key is not null then
        select array_agg(distinct cp.customer_id) into v_payer_customers
          from public.customer_payers cp
         where cp.tenant_id = v_tenant
           and position(' ' || cp.payer_name_key || ' ' in ' ' || v_key || ' ') > 0;
        if cardinality(v_payer_customers) = 1 then v_known := v_payer_customers[1]; end if;
      end if;
    end if;

    return query
    select 'payment'::text, p.id::text,
           coalesce(c.name, p.receipt_voucher_no, 'Payment') || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end,
           (p.amount - p.credit_applied), p.received_at::date,
           case when v_known is not null and p.customer_id is distinct from v_known then 'low'
                when (p.amount - p.credit_applied) = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
                when (p.amount - p.credit_applied) = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.payments p left join public.customers c on c.id = p.customer_id
    -- R-1565: the bank saw only the cash part; a payment paid wholly by advance credit is never suggested.
    where p.tenant_id = v_tenant and p.status = 'received' and (p.amount - p.credit_applied) > 0
      and abs((p.amount - p.credit_applied) - v_search_amount) <= 100 and abs(p.received_at::date - v_txn.txn_date) <= 7
      -- R-2364: never a receipt another bank line already carries …
      and not exists (select 1 from public.bank_transactions t
                       where t.tenant_id = v_tenant and t.id <> v_txn.id
                         and t.matched_to_type = 'payment' and t.matched_to_id = p.id::text)
      -- … nor one a reconciled split line holds (R-2098) …
      and not (p.bank_txn_id is not null and p.bank_txn_id <> v_txn.id
               and exists (select 1 from public.bank_transactions t2
                            where t2.id = p.bank_txn_id and t2.tenant_id = v_tenant and t2.matched_to_type is not null))
      -- … nor one created from another existing line (BANK-<line id>).
      and not (coalesce(p.reference, '') ~* '^BANK-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and lower(substr(p.reference, 6)) <> v_txn.id::text
               and exists (select 1 from public.bank_transactions t3
                            where t3.id = lower(substr(p.reference, 6))::uuid and t3.tenant_id = v_tenant))
    order by (v_known is not null and p.customer_id = v_known) desc,
             abs((p.amount - p.credit_applied) - v_search_amount), abs(p.received_at::date - v_txn.txn_date) limit 5;

    return query
    select 'project'::text, pp.id::text,
           coalesce(ps.customer_name, ps.title, 'Project payment') || ' · project',
           pp.amount, pp.received_at::date,
           case when pp.amount = v_search_amount and pp.received_at::date = v_txn.txn_date then 'exact'
                when pp.amount = v_search_amount and abs(pp.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.project_payments pp
    join public.project_sales ps on ps.id = pp.project_id
    where pp.tenant_id = v_tenant and pp.bank_txn_id is null
      and abs(pp.amount - v_search_amount) <= 100 and abs(pp.received_at::date - v_txn.txn_date) <= 7
    order by abs(pp.amount - v_search_amount), abs(pp.received_at::date - v_txn.txn_date) limit 5;
  end if;
  if not v_is_credit then
    return query
    select 'salary'::text, sp.id::text, e.name || ' · salary ' || sp.period, sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high' else 'low' end::text
    from public.salary_payments sp join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid' and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date) limit 5;
    return query
    select 'expense'::text, e.id::text, coalesce(e.vendor_name, e.category, 'Expense'), e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.expenses e
    where e.tenant_id = v_tenant and e.category <> 'Salaries' and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
      -- R-2364: never an expense already reconciled to another bank line (R-2325's browser rule).
      and (e.reconciled_txn_id is null or e.reconciled_txn_id = v_txn.id)
      and not exists (select 1 from public.bank_transactions t
                       where t.tenant_id = v_tenant and t.id <> v_txn.id
                         and t.matched_to_type = 'expense' and t.matched_to_id = e.id)
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date) limit 5;
  end if;
end; $function$;
revoke all on function public.suggest_bank_transaction_matches(uuid) from public, anon;
grant execute on function public.suggest_bank_transaction_matches(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reconcile_bank_txn(p_txn_id uuid, p_matched_to_type text, p_matched_to_id text, p_match_confidence text)
 RETURNS bank_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_row    public.bank_transactions;
  v_tax_expenses text[];
  v_used   integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match a bank line' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found then
    raise exception 'Bank transaction not found' using errcode = 'no_data_found';
  end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_txn.tenant_id is distinct from v_tenant) then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-2364: one receipt, one bank line. Another line already matched to this payment, or a
     reconciled split line holding it (payments.bank_txn_id, R-2098) → refused, nothing changed. */
  if p_matched_to_type = 'payment' and p_matched_to_id is not null
     and (exists (select 1 from public.bank_transactions t
                   where t.tenant_id = v_txn.tenant_id and t.id <> p_txn_id
                     and t.matched_to_type = 'payment' and t.matched_to_id = p_matched_to_id)
          or exists (select 1 from public.payments p
                       join public.bank_transactions t2 on t2.id = p.bank_txn_id and t2.tenant_id = p.tenant_id
                      where p.tenant_id = v_txn.tenant_id and p.id::text = p_matched_to_id
                        and p.bank_txn_id <> p_txn_id and t2.matched_to_type is not null)) then
    raise exception 'This receipt is already reconciled to another bank line. Open that line and un-reconcile it first, or match this line to a different receipt. Nothing was changed.'
      using errcode = 'unique_violation';
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
  update public.project_payments set bank_txn_id = null where bank_txn_id = p_txn_id;
  if p_matched_to_type = 'project' and p_matched_to_id is not null then
    update public.project_payments set bank_txn_id = p_txn_id where id = p_matched_to_id::uuid;
  end if;

  -- Reverse link on expenses: same clear-then-set. (expenses.id is text.)
  update public.expenses set reconciled_txn_id = null where reconciled_txn_id = p_txn_id;
  if p_matched_to_type = 'expense' and p_matched_to_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = p_matched_to_id;
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

commit;
