-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.report_balance_sheet(date)') and prosrc like '%R-1563%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.redeem_customer_credits(uuid,integer,text)') and prosrc like '%R-1563%')
-- deploy-key: r1563bscncredit
-- 20261018181719_r1563_bs_credit_note_credit.sql
--
-- R-1563 follow-up (18 Oct 2026, found by worker-r1578): after 20261018171947 a credit note on a
-- PAID invoice moved the Trial Balance by −₹1,180 (supabase/tests/tb_money_events_balanced.test.sql
-- case 6) — the same money counted twice as a liability.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════
--   report_balance_sheet.advances_from_customers (20261018163944_r1612_balance_sheet_advances.sql)
--     (2) quotes with one invoice: max(0, received − (invoice − credit notes + debit notes)
--         − overpayment credit) — already counts what a credit note leaves over on a paid invoice
--         ("a credit note on a paid invoice with no credit row");
--     (3) + open customer_credits.
--   Since R-1566 that excess IS a credit row (source credit_note, source_invoice_id) → it is in
--   (2) and in (3): −1,180 on the TB per ₹1,180 note.
--   Also: redeem_customer_credits split rows (part of a credit used) did not carry the credit
--   note / invoice, so a part-used credit-note credit could not be traced back to its invoice.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   (2) also subtracts the invoice's credit-note credit that is open (counted in (3)) or used
--       (inside the payment that used it — part (1)/(2) of THAT quote). Refunded credit-note
--       credit is not subtracted: its payment is refunded, so it is already out of `received`.
--       Exactly how (2) treats overpayment credit (R-1612) — the money moves from "paid on the
--       invoice" to "customer credit", counted once.
--   redeem_customer_credits: a split row also keeps source_credit_note_id / source_invoice_id.
--   Every other line of both functions is the previous body as is.
--
-- Tests: supabase/tests/tb_money_events_balanced.test.sql (case 6 + new 6b–6d: credit-note
-- credit part used on another quote, full credit note then refund), r1563_credit_note_refund.

begin;

-- ── redeem_customer_credits (R-1567 body + split row keeps the credit note / invoice) ──
CREATE OR REPLACE FUNCTION public.redeem_customer_credits(p_customer_id uuid, p_amount integer, p_note text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-1567: a consumed row carries used_at = now(); a split row keeps the source payment/quote of
   the credit it came from, so a part-spent credit is still traceable to the payment that
   created it. record_desk_payment stamps applied_payment_id on the rows used in its call.
   R-1563: the split row also keeps the credit note / invoice the credit came from, so the
   balance sheet can tell a part-used credit-note credit from new money. */
declare
  v_tenant    uuid    := public.current_tenant_id();
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_consumed  integer := 0;
  v_take      integer;
  v_row       record;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can use a customer''s credit' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if v_remaining <= 0 then return 0; end if;

  for v_row in
    select id, amount, source_payment_id, source_quote_id, source_credit_note_id, source_invoice_id
      from public.customer_credits
     where tenant_id = v_tenant and customer_id = p_customer_id and status = 'open'
     order by created_at asc
     for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.amount, v_remaining);
    if v_take >= v_row.amount then
      update public.customer_credits set status = 'used', used_at = now() where id = v_row.id;
    else
      update public.customer_credits set amount = amount - v_take where id = v_row.id;
      insert into public.customer_credits
        (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id,
         source_credit_note_id, source_invoice_id, note, status, used_at)
      values (v_tenant, p_customer_id, v_take, 'redeemed_split', v_row.source_payment_id, v_row.source_quote_id,
              v_row.source_credit_note_id, v_row.source_invoice_id,
              coalesce(nullif(trim(p_note), ''), 'Partial advance credit applied'), 'used', now());
    end if;
    v_consumed  := v_consumed + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  return v_consumed;
end; $function$
;

revoke all on function public.redeem_customer_credits(uuid, integer, text) from public, anon;
grant execute on function public.redeem_customer_credits(uuid, integer, text) to authenticated, service_role;

-- ── report_balance_sheet (R-1612 body; (2) leaves out credit-note credit — R-1563) ─────
create or replace function public.report_balance_sheet(p_as_of date default null)
returns table (
  as_of                   date,
  fy_start_year           int,
  fy_label                text,
  cash_and_bank           bigint,
  undeposited_funds       bigint,
  credit_card_payable     bigint,
  receivables             bigint,
  advances_from_customers bigint,
  project_receivable      bigint,
  tds_receivable          bigint,
  employee_loans          bigint,
  prepaid_advances        bigint,
  emi_unregistered_cost   bigint,
  emi_loans_payable       bigint,
  business_loans_payable  bigint,
  payables                bigint,
  salary_payable          bigint,
  dues_salary_tds         bigint,
  dues_pf                 bigint,
  dues_esi                bigint,
  dues_vendor_tds         bigint,
  dues_paid               jsonb,
  reimbursements_payable  bigint,
  gst_output              bigint,
  bills_gst               bigint,
  itc_groups              jsonb,
  fixed_assets            jsonb,
  tax_payments            jsonb,
  expenses_payable        bigint,
  expenses_paid_unbanked  bigint,
  salary_other_deductions bigint,
  bill_itc_groups         jsonb
)
language plpgsql
stable
security invoker
set search_path = public
as $function$
#variable_conflict use_column
declare
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
                where cc.tenant_id = v_tenant and cc.source = 'overpayment'
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
                where cc.tenant_id = v_tenant and cc.source = 'overpayment'
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
    (select coalesce(sum(greatest(0, pa.total_amount - pa.consumed_amount)), 0)::bigint
       from public.prepaid_advances pa where pa.tenant_id = v_tenant),
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
    (select coalesce(sum(e.tds_amount), 0)::bigint from public.expenses e where e.tenant_id = v_tenant and e.tds_amount > 0),
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
       where i.tenant_id = v_tenant and i.invoice_date <= v_to and i.status in ('pending', 'paid', 'overdue'))
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
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)), 0)::bigint
       from public.expenses e
      where e.tenant_id = v_tenant and e.paid = false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G2): "paid" expenses jinki koi bank line match nahi — cash / UPI jo bank
    -- me abhi dikha nahi. Paisa haath se gaya; undeposited funds ka aaina (cash ka ulta).
    -- Jinka Cr pehle se kahin hai wo bahar: payroll/statutory (salary payable + dues),
    -- reimbursement (reimbursements payable), emi (loan + apni bank line), advance
    -- (employee loan / prepaid), EXP-RZPFEE-* (undeposited se ghata).
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)), 0)::bigint
       from public.expenses e
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
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g);
end;
$function$;

revoke all on function public.report_balance_sheet(date) from public, anon;
grant execute on function public.report_balance_sheet(date) to authenticated, service_role;

commit;
