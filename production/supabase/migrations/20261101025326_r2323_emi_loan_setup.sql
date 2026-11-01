-- deploy-peek: to_regprocedure('public.record_emi_loan_taken(jsonb)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'emi_purchases' and column_name = 'kind') and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_balance_sheet(date)') and prosrc like '%R-2323%')
-- deploy-key: r2323emiloansetup
-- R-2323 (1 Nov 2026): Loan / EMI set-up so EMI debits can be reconciled.
--
-- Staging money-out reconcile (31 Oct, R-2319): EMI debits (Bike EMI ₹19,054, SBI car SI, Bajaj,
-- Tata Capital) stayed unreconciled — the Loan / EMI tile only knows loans recorded as an asset
-- bought on EMI (R-1864), and there was no way to set up a loan from the EMI line itself.
--
-- ══ WHAT THIS ADDS ══════════════════════════════════════════════════════════════════════
--   emi_purchases.kind = 'loan': a loan the company TOOK, with no asset. It reuses the R-1864
--   EMI loan as it is — the reducing-balance schedule (emi_schedule, re-checked by
--   emi_replace_unpaid_schedule), matching a debit to the next instalment
--   (emi_matches_for_bank_txn), the principal + interest split (reconcile_bank_debit_to_emi),
--   late fee / prepayment, Auto-reconcile, undo (undo_emi_payment and the un-reconcile trigger).
--   No new money rule:
--     each EMI   Dr loan (principal) + Dr Interest (P&L) / Cr Bank — R-1864 unchanged;
--     the loan   came into a bank account → ONE manual money-in line on it (record_business_loan's
--                rule): Dr Bank / Cr loan;
--                taken before these books → no bank line: the amount still owed is an opening
--                balance (books-lite: like a bank account's opening balance, absorbed in equity).
--   report_balance_sheet: a 'loan' row is not an asset — it is left out of emi_unregistered_cost
--   (that line is the cost of an item bought on EMI and not in the asset register). Body = the
--   R-2098 one (20261029054707) with that one condition.
--
-- record_emi_loan_taken(p jsonb): lender, lender_ref, principal (owed at the schedule start),
-- interest_rate, schedule (rows from lib/accounting/loan-setup.ts), account_id + received_on
-- (optional), reconcile_txn_id (optional: this statement line is reconciled as EMI 1 in the same
-- transaction — refused, nothing written, unless it is exactly EMI 1).
--
-- Existing rows are unchanged (kind defaults to 'asset'). §17c guard + money roles via emi_guard.
-- Proof: supabase/tests/r2323_emi_loan_setup.test.sql (one rollback).

begin;

-- ── 1. Columns ───────────────────────────────────────────────────────────────────────────
alter table public.emi_purchases
  add column if not exists kind text not null default 'asset',
  add column if not exists received_bank_txn_id uuid references public.bank_transactions(id) on delete set null;
alter table public.emi_purchases drop constraint if exists emi_purchases_kind_r2323;
alter table public.emi_purchases add constraint emi_purchases_kind_r2323 check (kind in ('asset', 'loan'));
comment on column public.emi_purchases.kind is
  'R-2323: asset = an item bought on EMI (R-1864, in the asset register); loan = a loan taken with no asset (set up from an EMI line).';
comment on column public.emi_purchases.received_bank_txn_id is
  'R-2323: the manual money-in line when the loan money came into one of our accounts (null = taken before these books).';

-- ── 2. Set up a loan taken (from an EMI line) ────────────────────────────────────────────
create or replace function public.record_emi_loan_taken(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.emi_guard('set up a loan');
  v_lender   text := nullif(trim(coalesce(p ->> 'lender', '')), '');
  v_ref      text := nullif(trim(coalesce(p ->> 'lender_ref', '')), '');
  v_prin     integer := (p ->> 'principal')::integer;
  v_rate     numeric := nullif(p ->> 'interest_rate', '')::numeric;
  v_account  uuid := nullif(p ->> 'account_id', '')::uuid;
  v_recv_on  date := nullif(p ->> 'received_on', '')::date;
  v_txn_id   uuid := nullif(p ->> 'reconcile_txn_id', '')::uuid;
  v_rows     jsonb := p -> 'schedule';
  v_first    date := (v_rows -> 0 ->> 'due_on')::date;
  v_id       uuid := gen_random_uuid();
  v_line     public.bank_transactions;
  v_rec      jsonb;
begin
  -- R-2323
  if v_lender is null then raise exception 'Enter the lender (bank / NBFC)'; end if;
  if char_length(v_lender) > 100 then raise exception 'Keep the lender name under 100 characters'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'Keep the loan number under 60 characters'; end if;
  if v_prin is null or v_prin <= 0 then raise exception 'Enter the amount still owed'; end if;
  if v_rate is null or v_rate < 0 or v_rate > 60 then raise exception 'Enter the interest rate (0 to 60%% a year)'; end if;
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 or v_first is null then
    raise exception 'The EMI schedule is missing';
  end if;
  if v_account is not null then
    if v_recv_on is null then raise exception 'Enter the date the loan money came in'; end if;
    if v_recv_on > v_first then raise exception 'The loan money must come in on or before the first EMI'; end if;
    perform 1 from public.bank_accounts where id = v_account and tenant_id = v_tenant;
    if not found then raise exception 'That bank / cash account is not in your company'; end if;
  end if;

  insert into public.emi_purchases
    (id, tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on,
     lender, status, created_by, interest_rate, no_cost, first_emi_on, lender_ref, kind)
  values
    (v_id, v_tenant, 'Loan — ' || v_lender, 'other', v_prin, 0, v_prin, jsonb_array_length(v_rows),
     (v_rows -> 0 ->> 'emi')::integer, coalesce(v_recv_on, v_first),
     v_lender, 'active', public.current_user_id(), v_rate, v_rate = 0, v_first, v_ref, 'loan');

  perform public.emi_replace_unpaid_schedule(v_tenant, v_id, 1, v_prin, v_rows, v_rate = 0, coalesce(v_recv_on, v_first));

  if v_account is not null then
    insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source)
    values (v_tenant, v_account, v_recv_on, 'Loan received: ' || v_lender, 0, v_prin, 'manual')
    returning * into v_line;
    perform public.emi_mark_line(v_line.id, v_id);
    update public.emi_purchases set received_bank_txn_id = v_line.id where id = v_id;
  end if;

  if v_txn_id is not null then
    v_rec := public.reconcile_bank_debit_to_emi(v_txn_id, v_id, 1);
  end if;

  return jsonb_build_object('purchase_id', v_id, 'reconciled', v_rec);
end;
$$;
revoke all on function public.record_emi_loan_taken(jsonb) from public, anon;
grant execute on function public.record_emi_loan_taken(jsonb) to authenticated, service_role;

-- ── 3. report_balance_sheet — R-2098 body; a 'loan' row is not an asset ──────────────────
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
  -- R-1992: project TDS (project_payments method 'tds') is not undeposited cash — it is in
  --   tds_receivable; project money received beyond the invoiced milestones is an advance
  --   from the customer (liability), the mirror of project_receivable.
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
                            and t.matched_to_id = p.id::text)
         -- R-2098: one bank line carrying several receipts (payments.bank_txn_id) — each is banked.
         and not (p.bank_txn_id is not null
                  and exists (select 1 from public.bank_transactions t2
                               where t2.tenant_id = v_tenant and t2.id = p.bank_txn_id
                                 and t2.matched_to_type is not null)))
   + (select coalesce(sum(pp.amount), 0)
        from public.project_payments pp
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null
         -- R-1992: the TDS part (record_project_receipt_with_tds) never came in as cash — it is
         -- in tds_receivable already; counting it here made the same ₹ an asset twice.
         and coalesce(pp.method, '') <> 'tds'))::bigint,
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
       where cc.tenant_id = v_tenant and cc.status = 'open')
    -- R-1992: (4) project money received beyond the invoiced milestones (an advance before the
    -- invoice, or more than invoiced) — the mirror of project_receivable below, same projects,
    -- so per project receivable − advance = invoiced − received.
   + (select coalesce(sum(greatest(0,
              coalesce((select sum(pp.amount) from public.project_payments pp
                         where pp.tenant_id = v_tenant and pp.project_id = ps.id), 0)
            - coalesce((select sum(pm.total_amount) from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.project_id = ps.id and pm.invoice_id is not null), 0))), 0)
        from public.project_sales ps
       where ps.tenant_id = v_tenant and ps.status in ('active', 'completed')))::bigint,
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
    -- R-2323: a loan taken with no asset (kind = 'loan') is not an asset — left out.
    (select coalesce(sum(ep.total_cost), 0)::bigint
       from public.emi_purchases ep
      where ep.tenant_id = v_tenant and ep.kind = 'asset'
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

commit;
