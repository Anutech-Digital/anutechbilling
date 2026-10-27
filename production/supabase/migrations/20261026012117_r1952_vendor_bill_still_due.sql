-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.payment_run_outstanding(uuid,text,text)') and prosrc like '%R-1952%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_payment_run(jsonb,uuid,date,text)') and prosrc like '%R-1952%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.approve_payment_run(uuid)') and prosrc like '%R-1952%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.mark_payment_run_paid(uuid,date)') and prosrc like '%R-1952%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_balance_sheet(date)') and prosrc like '%R-1952%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.expense_delete_blocker(uuid,text)') and prosrc like '%R-1952%')
-- deploy-key: r1952vendorbillstilldue
-- 20261026012117_r1952_vendor_bill_still_due.sql
--
-- R-1952 (26 Oct 2026, p1, goal G-RECON — follow-up of R-1913 29381e0a and R-1915 f065d35d).
-- One rule everywhere an expense (vendor) bill is paid or shown:
--     still due = amount − tds_amount − advance_applied − paid_amount        (never the full bill)
--
-- ─── THE BUGS (proven by supabase/tests/r1952_still_due.test.sql before this file) ───────────
--   P  payment_run_outstanding gave an expense bill its FULL amount: Verma's ₹5,000 bill with
--      ₹3,000 of his advance applied was offered (and paid) as ₹5,000; a part-paid ₹10,000 bill
--      as ₹10,000; a ₹10,000 bill with ₹1,000 TDS as ₹10,000. A run could also pay LESS than the
--      rest and mark_payment_run_paid then closed the whole bill.
--   B  report_balance_sheet took the applied advance and the bank parts off the bill for ANY
--      as-of date — a Balance Sheet for a day before the advance was applied showed the bill
--      already reduced and the advance already gone from prepaid.
--   D  Deleting a part-paid bill stopped on a raw foreign-key error
--      (bank_vendor_payment_lines_expense_id_fkey) for a plain delete.
--
-- ─── THE FIX ────────────────────────────────────────────────────────────────────────────────
--   payment_run_outstanding  expense: amount − tds − advance_applied − paid_amount (unpaid only).
--   create_payment_run       an expense bill pays exactly its rest (more or less is refused).
--   approve / mark paid      refused when an expense bill's rest is no longer the run's amount.
--   report_balance_sheet     as of p_as_of: only advance applications with applied_on ≤ as-of and
--                            bank parts whose bank line txn_date ≤ as-of come off; bills settled by
--                            the advance / last bank part after that date are still payable; the
--                            advance applied after it is still prepaid.
--   expense_delete_blocker   a bill with bank parts: "un-reconcile its bank parts first".
--   (Screens, same rule: bulk Mark paid dialog and the Reconcile button — R-1952 TS changes.)
--
-- Started from the LATEST definitions:
--   payment_run_outstanding, approve_payment_run   20261005110000_payment_runs (+ prisma
--     20261006090000 token rewrite: public.current_user_id());
--   create_payment_run, mark_payment_run_paid      20261024085113_r1828 (+ the same token);
--   report_balance_sheet                           20261025174159_r1915;
--   expense_delete_blocker                         20261018180436_r1577.
-- Guards unchanged (roles, tenant, no double run). Test: supabase/tests/r1952_still_due.test.sql

begin;

-- ── 1. Payment runs: what an expense bill still owes ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.payment_run_outstanding(p_tenant uuid, p_source text, p_doc text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /* R-1952: an expense bill owes amount − TDS − advance applied − bank parts paid. */
  select case p_source
    when 'vendor_bill' then (select greatest(coalesce(b.total,0) - coalesce(b.paid_amount,0), 0)
                               from public.vendor_bills b
                              where b.id = p_doc and b.tenant_id = p_tenant and coalesce(b.status,'unpaid') <> 'paid'
                                and upper(coalesce(b.currency,'INR')) = 'INR')
    when 'expense'     then (select greatest(coalesce(e.amount,0) - coalesce(e.tds_amount,0)
                                             - coalesce(e.advance_applied,0) - coalesce(e.paid_amount,0), 0)
                               from public.expenses e
                              where e.id = p_doc and e.tenant_id = p_tenant and coalesce(e.paid, true) = false
                                and e.reconciled_txn_id is null
                                and upper(coalesce(e.currency,'INR')) = 'INR')
  end;
$function$;
revoke all on function public.payment_run_outstanding(uuid, text, text) from public, anon, authenticated;
grant execute on function public.payment_run_outstanding(uuid, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.create_payment_run(p_items jsonb, p_bank_account_id uuid, p_pay_on date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  /* R-1952: an expense bill is owed its rest (payment_run_outstanding), paid in full. */
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  v_run    uuid;
  v_no     text;
  v_total  bigint := 0;
  it       jsonb;
  v_src    text; v_doc text; v_amt integer; v_owed integer;
  v_vid uuid; v_vname text; v_ref text;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can create a payment run' using errcode = 'insufficient_privilege';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Pick at least one bill to pay';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'At most 200 bills in one run'; end if;
  if not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'Pay-from bank account not found';
  end if;

  -- Run number: PR-YYYYMM-NNN, per tenant. The advisory lock makes two creates in the same
  -- instant take turns instead of colliding on the unique (tenant_id, run_no).
  perform pg_advisory_xact_lock(hashtext('payment_run_no:' || v_tenant::text));
  select 'PR-' || to_char(coalesce(p_pay_on, public.ist_today()), 'YYYYMM') || '-' ||
         lpad((count(*) + 1)::text, 3, '0')
    into v_no
    from public.payment_runs
   where tenant_id = v_tenant and run_no like 'PR-' || to_char(coalesce(p_pay_on, public.ist_today()), 'YYYYMM') || '-%';

  insert into public.payment_runs (tenant_id, run_no, bank_account_id, pay_on, note, created_by)
  values (v_tenant, v_no, p_bank_account_id, coalesce(p_pay_on, public.ist_today()), nullif(trim(p_note), ''), public.current_user_id())
  returning id into v_run;

  for it in select * from jsonb_array_elements(p_items) loop
    v_src := it->>'source';
    v_doc := it->>'doc_id';
    v_amt := (it->>'amount')::integer;
    if v_src not in ('vendor_bill','expense') or v_doc is null then raise exception 'Bad item in the run'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Amount must be more than zero (%)', v_doc; end if;

    v_owed := public.payment_run_outstanding(v_tenant, v_src, v_doc);
    if v_owed is null or v_owed = 0 then raise exception '% is already paid or not found', v_doc; end if;
    if v_amt > v_owed then raise exception '% — ₹% is more than the ₹% still owed', v_doc, v_amt, v_owed; end if;
    /* R-1952: marking the run paid settles an expense bill, so the run pays exactly its rest
       (amount − TDS − advance applied − bank parts) — never less (the bill would close short). */
    if v_src = 'expense' and v_amt <> v_owed then
      raise exception '% — an expense bill in a payment run pays its whole rest of ₹% (not ₹%). For a part payment, pay it from Banking → the payment line.', v_doc, v_owed, v_amt;
    end if;

    if exists (select 1 from public.payment_run_items i join public.payment_runs r on r.id = i.run_id
                where i.tenant_id = v_tenant and i.source = v_src and i.doc_id = v_doc
                  and r.status in ('draft','approved') and r.id <> v_run) then
      raise exception '% is already in another open payment run', v_doc;
    end if;

    if v_src = 'vendor_bill' then
      select b.vendor_id, b.vendor_name, b.bill_no into v_vid, v_vname, v_ref from public.vendor_bills b where b.id = v_doc;
    else
      select e.vendor_id, coalesce(e.vendor_name, e.category), e.bill_no into v_vid, v_vname, v_ref from public.expenses e where e.id = v_doc;
    end if;

    insert into public.payment_run_items (run_id, tenant_id, source, doc_id, doc_ref, vendor_id, vendor_name, amount)
    values (v_run, v_tenant, v_src, v_doc, v_ref, v_vid, coalesce(v_vname, 'Vendor'), v_amt);
    v_total := v_total + v_amt;
  end loop;

  update public.payment_runs set total = v_total where id = v_run;
  return v_run;
end $function$;

CREATE OR REPLACE FUNCTION public.approve_payment_run(p_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
  it       public.payment_run_items;
  v_owed   integer;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if v_role is null or v_role not in ('owner','manager') then
    raise exception 'Only the owner or a manager can approve a payment run' using errcode = 'insufficient_privilege';
  end if;
  if v_role = 'manager' and r.created_by = public.current_user_id() then
    raise exception 'A manager cannot approve a run they created — ask the owner or another manager' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'draft' then raise exception 'Only a draft run can be approved (this one is %)', r.status; end if;

  -- Re-check: a bill may have been paid by hand since the draft was made.
  for it in select * from public.payment_run_items where run_id = r.id loop
    v_owed := public.payment_run_outstanding(v_tenant, it.source, it.doc_id);
    -- R-1952: an expense bill's rest must still be exactly the run's amount (it is settled by it).
    if v_owed is null or v_owed < it.amount or (it.source = 'expense' and v_owed <> it.amount) then
      raise exception '% (%) is no longer owed in full — cancel this run and make a new one', coalesce(it.doc_ref, it.doc_id), it.vendor_name;
    end if;
  end loop;

  update public.payment_runs set status = 'approved', approved_by = public.current_user_id(), approved_at = now(), updated_at = now() where id = r.id;
end $function$;

CREATE OR REPLACE FUNCTION public.mark_payment_run_paid(p_run_id uuid, p_paid_on date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
  it       public.payment_run_items;
  v_owed   integer;
  v_on     date := coalesce(p_paid_on, public.ist_today());
  v_txn    uuid;
  v_bill   public.vendor_bills;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can mark a run paid' using errcode = 'insufficient_privilege';
  end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved run can be marked paid (this one is %)', r.status; end if;

  for it in select * from public.payment_run_items where run_id = r.id order by vendor_name loop
    v_owed := public.payment_run_outstanding(v_tenant, it.source, it.doc_id);
    -- R-1952: an expense bill's rest must still be exactly the run's amount (it is settled by it).
    if v_owed is null or v_owed < it.amount or (it.source = 'expense' and v_owed <> it.amount) then
      raise exception '% (%) was paid elsewhere after approval — nothing was marked; check it and try again', coalesce(it.doc_ref, it.doc_id), it.vendor_name;
    end if;

    if it.source = 'vendor_bill' then
      select * into v_bill from public.vendor_bills where id = it.doc_id and tenant_id = v_tenant for update;
      update public.vendor_bills
         set paid_amount = coalesce(paid_amount,0) + it.amount,
             status = case when coalesce(paid_amount,0) + it.amount >= total then 'paid' else 'partial' end,
             updated_at = now()
       where id = it.doc_id and tenant_id = v_tenant;
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Bill payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'vendor_bill', it.doc_id, 'manual', r.run_no);
    else
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Expense payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'expense', it.doc_id, 'manual', r.run_no)
      returning id into v_txn;
      update public.expenses
         set paid = true, paid_date = v_on, payment_method = 'bank_transfer',
             bank_account_id = r.bank_account_id, reconciled_txn_id = v_txn
       where id = it.doc_id and tenant_id = v_tenant;
    end if;
  end loop;

  update public.payment_runs set status = 'paid', paid_by = public.current_user_id(), paid_at = now(), paid_on = v_on, updated_at = now() where id = r.id;
end $function$;
revoke all on function public.create_payment_run(jsonb, uuid, date, text) from public, anon;
grant execute on function public.create_payment_run(jsonb, uuid, date, text) to authenticated;
revoke all on function public.approve_payment_run(uuid) from public, anon;
grant execute on function public.approve_payment_run(uuid) to authenticated;
revoke all on function public.mark_payment_run_paid(uuid, date) from public, anon;
grant execute on function public.mark_payment_run_paid(uuid, date) to authenticated;

-- ── 2. Balance Sheet as of a date ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.report_balance_sheet(p_as_of date DEFAULT NULL::date)
 RETURNS TABLE(as_of date, fy_start_year integer, fy_label text, cash_and_bank bigint, undeposited_funds bigint, credit_card_payable bigint, receivables bigint, advances_from_customers bigint, project_receivable bigint, tds_receivable bigint, employee_loans bigint, prepaid_advances bigint, emi_unregistered_cost bigint, emi_loans_payable bigint, business_loans_payable bigint, payables bigint, salary_payable bigint, dues_salary_tds bigint, dues_pf bigint, dues_esi bigint, dues_vendor_tds bigint, dues_paid jsonb, reimbursements_payable bigint, gst_output bigint, bills_gst bigint, itc_groups jsonb, fixed_assets jsonb, tax_payments jsonb, expenses_payable bigint, expenses_paid_unbanked bigint, salary_other_deductions bigint, bill_itc_groups jsonb, commissions_payable bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  -- R-1580: commission TDS in dues_vendor_tds; commissions_payable.
  -- R-1739: gst_output skips imported Zoho opening invoices (receivables keep them).
  -- R-1849: partner TDS in dues_vendor_tds.
  -- R-1913: expenses_payable / expenses_paid_unbanked less the advance applied to the bill (the advance left the prepaid asset when applied).
  -- R-1915: and less the cash its bank parts paid (expenses.paid_amount — that money is in the bank balance).
  -- R-1952: as of the report date — only advance applications dated on or before it
  --   (vendor_advance_applications.applied_on) and bank parts whose bank line is dated on or before it
  --   come off the bill; a bill settled by its advance / last bank part AFTER that date is still payable
  --   then, and an advance applied after it is still prepaid.
  v_tenant  uuid := public.current_tenant_id();
  v_to      date := coalesce(p_as_of, (now() at time zone 'Asia/Kolkata')::date);
  v_fy_year int;
  v_cash    bigint;
  v_card    bigint;
  v_own_state text;
begin
  if v_tenant is null then
    raise exception 'Balance sheet nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Indian FY: April se pehle ke mahine pichhle saal ke FY me.
  v_fy_year := case when extract(month from v_to) < 4 then extract(year from v_to)::int - 1
                    else extract(year from v_to)::int end;

  -- Cash & bank: har account = opening + sum(credit − debit), ek hi pass me (N+1 khatam).
  -- Credit card liability hai: negative = card par bakaya; positive (overpaid) = cash.
  select coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then 0 else b.bal end), 0),
         coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then -b.bal else 0 end), 0)
    into v_cash, v_card
    from (
      select a.account_type,
             a.opening_balance::bigint + coalesce((
               select sum(t.credit - t.debit)
                 from public.bank_transactions t
                where t.bank_account_id = a.id and t.tenant_id = v_tenant), 0) as bal
        from public.bank_accounts a
       where a.tenant_id = v_tenant
    ) b;

  -- R-1576: hamara rajya (state check ke liye) — report.ts jaisa: state_code, warna GSTIN ke pehle 2.
  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_tenant;

  return query
  select
    v_to,
    v_fy_year,
    'FY ' || v_fy_year || '-' || lpad(((v_fy_year + 1) % 100)::text, 2, '0'),
    v_cash,
    -- R-179: receipts jo kisi bank line se match nahi hue — paisa haath me, asset.
    -- S45-TB: payment.amount me customer ka kaata hua TDS bhi hai (record_payment_with_tds
    -- invoice ko gross se settle karta hai). Wo TDS paisa kabhi aaya hi nahi — tds_receivable
    -- me asset hai. Yahan bhi gina to ek hi ₹ do baar Dr. Isliye us payment ka TDS ghatao.
    -- R-1612: amount − credit_applied — advance credit inside a payment was money in on the
    -- payment that created it (R-1565), not again here.
    ((select coalesce(sum(p.amount - p.credit_applied - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                                                where t.tenant_id = v_tenant and t.payment_id = p.id), 0)
                                  -- S45-SLICE2: Razorpay fee book ho chuki (EXP-RZPFEE-<id>, R-045) to wo
                                  -- paisa kabhi bank me nahi aayega — fee P&L me hai, yahan bhi gini to do baar.
                                  - coalesce((select e.amount from public.expenses e
                                               where e.tenant_id = v_tenant and e.id = 'EXP-RZPFEE-' || p.id::text), 0)), 0)
        from public.payments p
       where p.tenant_id = v_tenant and p.status = 'received'
         and not exists (select 1 from public.bank_transactions t
                          where t.tenant_id = v_tenant and t.matched_to_type = 'payment'
                            and t.matched_to_id = p.id::text))
   + (select coalesce(sum(pp.amount), 0)
        from public.project_payments pp
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null))::bigint,
    v_card,
    -- Trade receivables (accrual): pending/overdue, project-milestone invoices CHHOD kar
    -- (wo project_receivable me hain — dono me gine to double count).
    -- S45-TB: net_payable − paid_amount. record_payment har part payment par paid_amount
    -- likhta hai (R-015) aur Aging bhi yahi padhta hai; poora net_payable ginne se ₹40,000
    -- ka part payment cash me bhi aur receivable me bhi — TB me utna farq.
    (select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::bigint
       from public.invoices i
      where i.tenant_id = v_tenant
        and i.status in ('pending', 'overdue')
        and not exists (select 1 from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.invoice_id = i.id)),
    -- Customer advances: received payments jinke quote par abhi invoice nahi — liability.
    -- S45-TB: + invoice ke BAAD customer ka bakaaya paisa (overpayment, ya paid invoice par
    -- credit note): quote par mila − (invoice − credit notes + debit notes), jab > 0. Pehle
    -- ye kahin nahi tha — paisa cash me, deni-daari kahin nahi. Sirf quote ka apna ek hi
    -- invoice (split billing ke kai invoice wale quote chhode — wahan ye hisaab nahi banta).
    -- R-1612: (1) − the overpayment credit those payments opened (open credit is in (3); used
    -- credit sits in the payment that used it) − what is applied to the quote's raised
    -- instalment invoices (split billing: no invoice of its own, R-1564); (2) − the same
    -- credit; (3) + the customer's open (unused) credit.
    ((select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(i.paid_amount), 0)
                  from public.subscriptions s
                  join public.subscription_billings b on b.subscription_id = s.id and b.tenant_id = v_tenant
                  join public.invoices i on i.id = b.invoice_id and i.tenant_id = v_tenant
                 where s.tenant_id = v_tenant and s.quote_id = q.id
                   and i.status in ('pending', 'paid', 'overdue')))), 0)
        from public.quotes q
       where q.tenant_id = v_tenant and q.invoice_id is null)
   + (select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (i.amount
                - coalesce((select sum(c.amount) from public.credit_notes c
                             where c.tenant_id = v_tenant and c.invoice_id = i.id), 0)
                + coalesce((select sum(d.amount) from public.debit_notes d
                             where d.tenant_id = v_tenant and d.invoice_id = i.id), 0))
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             /* R-1563: the excess a credit note left on this invoice now sits in a
                customer_credits row (source_invoice_id) — open: counted in (3); used: inside the
                payment that used it; refunded: paid out with its payment. Not here again. */
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                where cc.tenant_id = v_tenant and cc.source_invoice_id = i.id
                  and cc.status in ('open', 'used')))), 0)
        from public.quotes q
        join public.invoices i on i.id = q.invoice_id and i.tenant_id = v_tenant
       where q.tenant_id = v_tenant
         and i.status in ('pending', 'paid', 'overdue')
         and not exists (select 1 from public.invoices i2
                          where i2.tenant_id = v_tenant and i2.quote_id = q.id and i2.id <> i.id)
         and not exists (select 1 from public.project_milestones pm
                          where pm.tenant_id = v_tenant and pm.invoice_id = i.id))
   + (select coalesce(sum(cc.amount), 0)
        from public.customer_credits cc
       where cc.tenant_id = v_tenant and cc.status = 'open'))::bigint,
    -- Project receivable: har active/completed project ka max(0, invoiced milestones − received).
    (select coalesce(sum(greatest(0,
              coalesce((select sum(pm.total_amount) from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.project_id = ps.id and pm.invoice_id is not null), 0)
            - coalesce((select sum(pp.amount) from public.project_payments pp
                         where pp.tenant_id = v_tenant and pp.project_id = ps.id), 0))), 0)::bigint
       from public.project_sales ps
      where ps.tenant_id = v_tenant and ps.status in ('active', 'completed')),
    (select coalesce(sum(t.tds_amount), 0)::bigint
       from public.tds_receivable t
      where t.tenant_id = v_tenant and t.status in ('pending_cert', 'cert_received', 'verified_26as')),
    -- Employee loans: KUL principal − KUL repayments (per-loan max(0) nahi — purana TS bhi
    -- total par karta tha; parity ke liye waise hi).
    greatest(0,
      (select coalesce(sum(l.principal), 0) from public.employee_loans l where l.tenant_id = v_tenant)
    - (select coalesce(sum(r.amount), 0) from public.employee_loan_repayments r where r.tenant_id = v_tenant))::bigint,
    ((select coalesce(sum(greatest(0, pa.total_amount - pa.consumed_amount)), 0)
        from public.prepaid_advances pa where pa.tenant_id = v_tenant)
     -- R-1952: an advance applied to a bill after the report date was still an advance then.
   + (select coalesce(sum(a.amount), 0)
        from public.vendor_advance_applications a where a.tenant_id = v_tenant and a.applied_on > v_to))::bigint,
    -- EMI purchase jo abhi fixed-asset register me nahi — cost par (register wale WDV par, TS me).
    (select coalesce(sum(ep.total_cost), 0)::bigint
       from public.emi_purchases ep
      where ep.tenant_id = v_tenant
        and not exists (select 1 from public.fixed_assets fa
                         where fa.tenant_id = v_tenant and fa.emi_purchase_id = ep.id)),
    greatest(0,
      (select coalesce(sum(ep.financed), 0) from public.emi_purchases ep where ep.tenant_id = v_tenant)
    - (select coalesce(sum(em.principal_part), 0) from public.emi_payments em where em.tenant_id = v_tenant))::bigint,
    greatest(0,
      (select coalesce(sum(bl.principal), 0) from public.business_loans bl where bl.tenant_id = v_tenant)
    - (select coalesce(sum(bp.principal_part), 0) from public.business_loan_payments bp where bp.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, vb.total - vb.paid_amount)), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.status <> 'paid'),
    (select coalesce(sum(greatest(0, s.net - s.paid_amount)), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant and s.paid_status <> 'paid'),
    -- Statutory dues ke hisse (har booked salary, paid ho ya nahi; employer share bhi) —
    -- statutoryDues() TS me jodta hai, taaki Payroll banner aur ye ek hi niyam rahein.
    (select coalesce(sum(s.tds), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.pf + s.pf_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.esi + s.esi_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1580: + TDS kaata partner commission par (194H) — credit (earned) hote hi sarkar ka
    -- dena, commission paid ho ya nahi; cancelled me kuch kaata nahi. Challan dues_paid me.
    ((select coalesce(sum(e.tds_amount), 0) from public.expenses e where e.tenant_id = v_tenant and e.tds_amount > 0)
   + (select coalesce(sum(rc.tds_amount), 0) from public.referral_commissions rc
       where rc.tenant_id = v_tenant and rc.tds_amount > 0 and rc.status <> 'cancelled')
    -- R-1891: 194Q TDS deducted when a COGS bill was paid from the bank.
   + (select coalesce(sum(l.tds_amount), 0) from public.bank_vendor_payment_lines l
       where l.tenant_id = v_tenant and l.kind in ('bill', 'new_bill') and l.tds_amount > 0)
    -- R-1849: TDS on partners' interest + remuneration (194T / 393(3)), owed from the year-end credit.
   + (select coalesce(sum(pl.tds), 0) from public.partner_appropriation_lines pl
       where pl.tenant_id = v_tenant and pl.tds > 0))::bigint,
    (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'amount', d.amount) order by d.kind), '[]'::jsonb)
       from (select sd.kind, sum(sd.amount)::bigint as amount
               from public.statutory_dues_payments sd where sd.tenant_id = v_tenant group by sd.kind) d),
    (select coalesce(sum(r.amount), 0)::bigint
       from public.reimbursements r where r.tenant_id = v_tenant and r.status = 'pending'),
    -- GST CUMULATIVE (≤ as_of): frozen tax_amount, purani row me amount se reverse-derive
    -- (rate ?? 18), phir credit note ghatao, debit note jodo.
    ((select coalesce(sum(coalesce(i.tax_amount,
               floor(i.amount::numeric * coalesce(i.tax_rate, 18) / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint)), 0)
        from public.invoices i
       where i.tenant_id = v_tenant and i.invoice_date <= v_to and i.status in ('pending', 'paid', 'overdue')
         and public.invoice_is_sale(i.document_kind))  -- R-1739: no GST on an imported Zoho opening invoice
     - (select coalesce(sum(c.tax_amount), 0) from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date <= v_to)
     + (select coalesce(sum(d.tax_amount), 0) from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date <= v_to))::bigint,
    (select coalesce(sum(vb.cgst + vb.sgst + vb.igst), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.bill_date <= v_to),
    -- ITC: expense GST ko (bill_type, category, vendor GSTIN) par group karke — eligibility
    -- splitItc() TS me hi tay karta hai. Sirf gst_paid > 0 rows (splitItc 0 ko chhod deta hai).
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select e.bill_type, e.category, v.gstin, sum(e.gst_paid)::bigint as gst, count(*)::int as n
               from public.expenses e
               left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
              where e.tenant_id = v_tenant and e.expense_date <= v_to and e.gst_paid > 0
              group by e.bill_type, e.category, v.gstin) g),
    -- Fixed-asset register (chhoti table) — WDV bookValueNow() TS me.
    (select coalesce(jsonb_agg(jsonb_build_object('id', fa.id, 'name', fa.name, 'block', fa.block, 'cost', fa.cost,
                                                  'put_to_use', fa.put_to_use, 'disposed_on', fa.disposed_on,
                                                  'disposal_value', fa.disposal_value, 'emi_purchase_id', fa.emi_purchase_id)
                               order by fa.put_to_use, fa.id), '[]'::jsonb)
       from public.fixed_assets fa where fa.tenant_id = v_tenant),
    -- Tax challans (GST + income tax) — kind/period/fy par jode hue.
    (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'amount', t.amount, 'period', t.period, 'fy', t.fy)), '[]'::jsonb)
       from (select tp.kind, tp.period, tp.fy, sum(tp.amount)::bigint as amount
               from public.tax_payments tp where tp.tenant_id = v_tenant group by tp.kind, tp.period, tp.fy) t),
    -- S45-SLICE2 (G4): unpaid expenses — P&L me kharcha, ab tak koi payable nahi tha.
    -- amount − TDS (TDS dues_vendor_tds me pehle se). Bank line se match = paid, bahar.
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)
                          - (coalesce(e.advance_applied, 0) - x.adv_after)
                          - (coalesce(e.paid_amount, 0) - x.parts_after)), 0)::bigint
       from public.expenses e
       -- R-1952: what came off the bill AFTER the report date (advance applied, bank parts).
       cross join lateral (
         select coalesce((select sum(a.amount) from public.vendor_advance_applications a
                           where a.tenant_id = v_tenant and a.expense_id = e.id and a.applied_on > v_to), 0) as adv_after,
                coalesce((select sum(l.cash) from public.bank_vendor_payment_lines l
                            join public.bank_transactions t on t.id = l.bank_txn_id
                           where l.tenant_id = v_tenant and l.expense_id = e.id and l.kind = 'expense'
                             and t.txn_date > v_to), 0) as parts_after) x
      where e.tenant_id = v_tenant
        and ((e.paid = false and e.reconciled_txn_id is null
              and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance'))
             -- R-1952: settled from the vendor's advance after the report date → still owed then.
             or (e.paid and e.reconciled_txn_id is null and e.payment_method = 'advance' and x.adv_after > 0)
             -- R-1952: its last bank part came after the report date → still owed then.
             or (e.paid and e.reconciled_txn_id is not null and x.parts_after > 0
                 and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')))
        and e.expense_date <= v_to
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G2): "paid" expenses jinki koi bank line match nahi — cash / UPI jo bank
    -- me abhi dikha nahi. Paisa haath se gaya; undeposited funds ka aaina (cash ka ulta).
    -- Jinka Cr pehle se kahin hai wo bahar: payroll/statutory (salary payable + dues),
    -- reimbursement (reimbursements payable), emi (loan + apni bank line), advance
    -- (employee loan / prepaid), EXP-RZPFEE-* (undeposited se ghata).
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)
                          - (coalesce(e.advance_applied, 0) - x.adv_after)
                          - (coalesce(e.paid_amount, 0) - x.parts_after)), 0)::bigint
       from public.expenses e
       -- R-1952: what came off the bill AFTER the report date (advance applied, bank parts).
       cross join lateral (
         select coalesce((select sum(a.amount) from public.vendor_advance_applications a
                           where a.tenant_id = v_tenant and a.expense_id = e.id and a.applied_on > v_to), 0) as adv_after,
                coalesce((select sum(l.cash) from public.bank_vendor_payment_lines l
                            join public.bank_transactions t on t.id = l.bank_txn_id
                           where l.tenant_id = v_tenant and l.expense_id = e.id and l.kind = 'expense'
                             and t.txn_date > v_to), 0) as parts_after) x
      where e.tenant_id = v_tenant and e.paid is distinct from false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G3): salary se kaata "other" deduction — kharcha gross hai, net payable
    -- kam; ye raqam company ke paas rakhi hai (kisi ko dena / wapas). Pehle kahin nahi.
    (select coalesce(sum(s.other_deduction), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1576: bills ka GST bhi ITC niyam se (lib/gst/bill-itc.ts) — document_type, vendor GSTIN,
    -- heads (state check ke liye IGST / CGST+SGST alag group), category (s.17(5)). TS tay karta hai.
    (select coalesce(jsonb_agg(jsonb_build_object('document_type', g.document_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'cgst', g.cgst, 'sgst', g.sgst, 'igst', g.igst,
                                                  'n', g.n, 'ownStateCode', v_own_state)), '[]'::jsonb)
       from (select b.document_type, b.category, b.vendor_gstin as gstin,
                    sum(b.cgst)::bigint as cgst, sum(b.sgst)::bigint as sgst, sum(b.igst)::bigint as igst, count(*)::int as n
               from public.vendor_bills b
              where b.tenant_id = v_tenant and b.bill_date <= v_to and b.cgst + b.sgst + b.igst > 0
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g),
    -- R-1580: partner commission earned par abhi diya nahi — P&L me gross kharcha, yahan net
    -- deni-daari (TDS upar dues_vendor_tds me). pay_referral_commission status 'paid' karta hai.
    (select coalesce(sum(rc.net_payable), 0)::bigint
       from public.referral_commissions rc
      where rc.tenant_id = v_tenant and rc.status = 'earned');
end;
$function$;


revoke all on function public.report_balance_sheet(date) from public, anon;
grant execute on function public.report_balance_sheet(date) to authenticated, service_role;

-- ── 3. Deleting a bill paid from bank lines: a sentence, not a foreign-key error ─────────────
-- Internal: called only from security-definer code (delete_expense and the delete trigger).
create or replace function public.expense_delete_blocker(p_tenant uuid, p_id text, out o_msg text, out o_href text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  r record;
begin
  select coalesce(e.name, 'employee') as who, sp.period
    into r
    from public.salary_payments sp left join public.employees e on e.id = sp.employee_id
   where sp.tenant_id = p_tenant and sp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s ki %s ki salary ka hai — ise Expenses se delete nahi kar sakte (salary ''Paid'' dikhti aur uska kharcha P&L se gayab ho jaata). Payroll me us salary par Undo dabao — salary aur ye kharcha dono saath hat jaayenge.', r.who, r.period);
    o_href := '/accounting/payroll';
    return;
  end if;

  select coalesce(p.name, 'EMI') as what, ep.paid_on, ep.amount
    into r
    from public.emi_payments ep left join public.emi_purchases p on p.id = ep.purchase_id
   where ep.tenant_id = p_tenant and ep.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha EMI "%s" ki %s wali kist (₹%s) ka byaaj hai — ise akele delete karne se kist bachi rehti par byaaj books se gayab ho jaata. Assets & EMIs page par wo EMI kholo.', r.what, to_char(r.paid_on, 'DD Mon YYYY'), r.amount);
    o_href := '/accounting/assets';
    return;
  end if;

  select coalesce(l.lender, 'loan') as what, lp.paid_on, lp.amount
    into r
    from public.business_loan_payments lp left join public.business_loans l on l.id = lp.loan_id
   where lp.tenant_id = p_tenant and lp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s loan ki %s wali EMI (₹%s) ka byaaj hai — ise akele delete karne se EMI bachi rehti par byaaj books se gayab ho jaata. Business Loans page par wo loan kholo.', r.what, to_char(r.paid_on, 'DD Mon YYYY'), r.amount);
    o_href := '/accounting/business-loans';
    return;
  end if;

  select coalesce(l.employee_name, 'employee') as who, rp.repaid_on, rp.amount
    into r
    from public.employee_loan_repayments rp left join public.employee_loans l on l.id = rp.loan_id
   where rp.tenant_id = p_tenant and rp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s ke loan ki %s wali wapsi (₹%s) se juda hai — ise akele delete karne se loan ka hisaab toot jaata. Loans & Salary Advances page par wo loan kholo.', r.who, to_char(r.repaid_on, 'DD Mon YYYY'), r.amount);
    o_href := '/accounting/loans';
    return;
  end if;

  select tp.kind, coalesce(tp.period, '') as period, tp.paid_on
    into r
    from public.tax_payments tp
   where tp.tenant_id = p_tenant and tp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s tax challan (%s, %s) ka hai — ise akele delete karne se challan bacha rehta par uska kharcha books se gayab ho jaata. Banking me us challan ki bank line par Un-reconcile dabao — challan aur ye kharcha dono saath hat jaayenge.', upper(r.kind), nullif(r.period, ''), to_char(r.paid_on, 'DD Mon YYYY'));
    o_href := '/accounting/banking';
    return;
  end if;

  select rb.person_name, rb.purpose
    into r
    from public.reimbursements rb
   where rb.tenant_id = p_tenant and rb.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s ke reimbursement (%s) ka hai — ise akele delete karne se reimbursement bacha rehta. Reimbursements page par wo reimbursement delete karo — ye kharcha bhi saath hat jaayega.', r.person_name, r.purpose);
    o_href := '/accounting/reimbursements';
    return;
  end if;

  select ec.amount, ec.spent_on
    into r
    from public.expense_claims ec
   where ec.tenant_id = p_tenant and ec.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha ek employee claim (₹%s, %s) se bana hai — ise akele delete karne se claim ''approved'' rehta aur advance ka hisaab toot jaata. Loans & Salary Advances page par wo claim kholo.', r.amount, to_char(r.spent_on, 'DD Mon YYYY'));
    o_href := '/accounting/loans';
    return;
  end if;

  select fa.name
    into r
    from public.fixed_assets fa
   where fa.tenant_id = p_tenant and fa.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha fixed asset "%s" ki khareed hai — ise delete karne se asset register me rehta par uski khareed books se gayab ho jaati. Assets & EMIs page par pehle wo asset hatao, phir ye kharcha.', r.name);
    o_href := '/accounting/assets';
    return;
  end if;

  select pr.run_no, pr.status
    into r
    from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
   where it.tenant_id = p_tenant and it.source = 'expense' and it.doc_id = p_id
     and pr.status in ('draft', 'approved') limit 1;
  if found then
    o_msg := format('Ye kharcha payment run %s (%s) me hai — delete karne par run ise bina kharche ke pay kar deta. Payment Runs me wo run cancel karo, phir ye kharcha delete karo.', r.run_no, r.status);
    o_href := '/accounting/payment-runs';
    return;
  end if;

  /* R-1952: paid (in part or whole) from bank lines — bank_vendor_payment_lines keeps the bill
     (on delete restrict), so a delete stopped on a raw foreign-key error. Say what to do. */
  select coalesce(e.bill_no, e.id) as bill, sum(l.cash) as cash, count(*) as n,
         min(bt.bank_account_id::text) as acct
    into r
    from public.bank_vendor_payment_lines l
    join public.expenses e on e.id = l.expense_id
    join public.bank_transactions bt on bt.id = l.bank_txn_id
   where l.tenant_id = p_tenant and l.expense_id = p_id
   group by coalesce(e.bill_no, e.id);
  if found then
    o_msg := format('Bill %s has ₹%s paid from the bank (%s bank %s) — un-reconcile its bank parts first (Banking → the payment line → Un-reconcile), then delete the bill.',
      r.bill, r.cash, r.n, case when r.n = 1 then 'line' else 'lines' end);
    o_href := '/accounting/banking/' || r.acct;
    return;
  end if;
end;
$function$;

revoke all on function public.expense_delete_blocker(uuid, text) from public, anon, authenticated;
grant execute on function public.expense_delete_blocker(uuid, text) to service_role;

commit;
