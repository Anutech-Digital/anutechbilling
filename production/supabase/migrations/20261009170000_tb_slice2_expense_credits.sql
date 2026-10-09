-- deploy-peek: exists(select 1 from pg_proc where proname='report_balance_sheet' and pronamespace='public'::regnamespace and prosrc like '%S45-SLICE2%') and exists(select 1 from pg_proc where proname='set_opening_balances' and pronamespace='public'::regnamespace)
-- deploy-key: tbslice2
-- S45 slice 2 — Trial Balance: kharche ka Cr side, salary "other" deduction, settlement fee,
-- aur CA ke opening balances.
--
-- ─── BUG (supabase/tests/tb_money_events_balanced.test.sql ne naapa) ─────────
-- TB derived hai (report_balance_sheet + report_pnl), journal nahi. Slice 1 ke baad bhi ye
-- events Dr − Cr hilaate the, farq "Difference" line me jaata tha:
--   G1. Settlement fee: ₹11,800 ka receipt, bank me ₹11,564 aaya aur match kiya → ₹236
--       asset gaya, kharcha kahin nahi (−236).
--   G2. Cash expense bina bank line: P&L me Dr 500, Cr kahin nahi (+500).
--   G3. Salary "other" deduction: kharcha gross, net payable kam, ₹500 kisi liability me
--       nahi (+500).
--   G4. Unpaid expense (paid = false): P&L me Dr, koi payable nahi (+amount).
--   Razorpay fee pehle se book ho (EXP-RZPFEE-<payment>, R-045): fee P&L me, par undeposited
--   funds poora amount ginta tha → fee do baar (+fee) jab tak bank line match na ho.
--
-- ─── FIX (sirf report functions; koi data, koi invoice raqam nahi badalti) ─────
--   report_balance_sheet: 3 naye column (isliye drop + create; grants dobara):
--     expenses_payable        unpaid expenses (amount − TDS), bank line se match nahi.
--     expenses_paid_unbanked  "paid" expenses jinki koi bank line match nahi (cash / UPI
--                             jo abhi bank me dikha nahi) — paisa haath se gaya: cash ka
--                             ulta (undeposited funds ka aaina). Bank line match → 0.
--     salary_other_deductions salary se kaata "other" — rakha hua, kisi ko dena/wapas.
--     undeposited_funds       − us payment ki book hui gateway fee (EXP-RZPFEE-<id>).
--   Credit side jinka pehle se kahin hai, wo kharche bahar: payroll / statutory (salary
--   payable + dues), reimbursement (reimbursements payable), emi (loan + bank line),
--   advance (employee loan / prepaid), EXP-RZPFEE-* (undeposited se ghata), aur har expense
--   jo kisi table se expense_id se juda hai (reimbursements, salary, emi, loan, tax, claims,
--   inbound purchases, fixed assets) ya bank line se match hai — report_expense_has_own_credit().
--   report_settlement_shortfalls(): payment ki bank line receipt se kam (fee kaat kar aayi)
--     → farq "Bank Charges" kharcha, bank line ki tareekh par. report_pnl aur
--     report_pnl_monthly dono isi se padhte hain (headline = trend).
--   opening_balances: CA ke diye opening capital + pichhle saalon ka profit (owner hi, Balance Sheet page se
--     likhe, set_opening_balances). Khaali = Difference line jaisi thi. Kuch ghada nahi jaata.

-- ── 1. Settlement shortfall (G1) ─────────────────────────────────────────────
create or replace function public.report_settlement_shortfalls(p_from date, p_to date)
returns table (txn_date date, amount bigint, payment_id uuid, reference text)
language sql
stable
security invoker
set search_path = public
as $function$
  -- Payment ke aane wale paise = amount − customer ka TDS − book hui gateway fee. Us payment
  -- se match hui bank lines ka credit usse kam ho to farq bank / gateway ne rakha.
  -- Zyada aaya ho to yahan kuch nahi (wo galat match hai, kharcha nahi).
  with m as (
    select p.id, p.reference,
           p.amount::bigint
             - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                          where t.tenant_id = p.tenant_id and t.payment_id = p.id), 0)
             - coalesce((select e.amount from public.expenses e
                          where e.tenant_id = p.tenant_id and e.id = 'EXP-RZPFEE-' || p.id::text), 0) as expected,
           sum(b.credit)::bigint as credited,
           max(b.txn_date) as txn_date
      from public.payments p
      join public.bank_transactions b
        on b.tenant_id = p.tenant_id and b.matched_to_type = 'payment' and b.matched_to_id = p.id::text
     where p.tenant_id = public.current_tenant_id() and p.status = 'received'
     group by p.id, p.reference, p.amount, p.tenant_id
  )
  select m.txn_date, (m.expected - m.credited)::bigint, m.id, m.reference
    from m
   where m.expected > m.credited and m.txn_date between p_from and p_to;
$function$;

revoke all on function public.report_settlement_shortfalls(date, date) from public, anon;
grant execute on function public.report_settlement_shortfalls(date, date) to authenticated, service_role;

-- ── 2. P&L: shortfall = "Bank Charges" (G1) ──────────────────────────────────
-- 20260928110000 ka report_pnl, sirf `exps` CTE me ek union all (same RETURNS TABLE).
create or replace function public.report_pnl(p_from date, p_to date)
 returns table(inv_taxable bigint, inv_tax bigint, revenue_count integer, cn_taxable bigint, cn_tax bigint, dn_taxable bigint, dn_tax bigint, revenue_by_project jsonb, cogs bigint, cogs_count integer, bills_gst bigint, expense_groups jsonb, itc_groups jsonb, unassigned_by_category jsonb, project_expenses jsonb, commissions bigint, commissions_count integer)
 language plpgsql
 stable
 set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'P&L nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'P&L ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye — range dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with inv as (
    select i.id, i.amount::bigint as amount, i.tax_amount::bigint as tax_amount,
           coalesce(i.taxable_value::bigint,
             floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as taxable
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status in ('pending', 'paid', 'overdue')
  ), cn as (
    select c.invoice_id, c.taxable_value::bigint as taxable_value, c.tax_amount::bigint as tax_amount
      from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
  ), dn as (
    select d.invoice_id, d.taxable_value::bigint as taxable_value, d.tax_amount::bigint as tax_amount
      from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date between p_from and p_to
  ), ms as (
    select distinct on (pm.invoice_id) pm.invoice_id, pm.project_id
      from public.project_milestones pm
     where pm.tenant_id = v_tenant and pm.invoice_id is not null
     order by pm.invoice_id, pm.project_id
  ), proj_rev as (
    select ms.project_id, inv.taxable as rev from inv join ms on ms.invoice_id = inv.id
    union all
    select ms.project_id, dn.taxable_value from dn join ms on ms.invoice_id = dn.invoice_id
    union all
    select ms.project_id, -cn.taxable_value from cn join ms on ms.invoice_id = cn.invoice_id
  ), bills as (
    select vb.subtotal, vb.cgst, vb.sgst, vb.igst
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
       and vb.category like 'COGS-%'
  ), exps as (
    select e.amount::bigint as amount, e.gst_paid, e.category, e.vendor_name, e.expense_date, e.bill_type,
           e.project_id, e.description, v.gstin
      from public.expenses e
      left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
    union all
    -- S45-SLICE2 (G1): settlement receipt se kam aaya — farq bank / gateway ka charge.
    select s.amount, 0, 'Bank Charges', 'Settlement short of receipt', s.txn_date, 'none',
           null::uuid, 'Bank line short of receipt' || coalesce(' ' || s.reference, ''), null::text
      from public.report_settlement_shortfalls(p_from, p_to) s
  ), comms as (
    select rc.gross_commission
      from public.referral_commissions rc
     where rc.tenant_id = v_tenant and rc.earned_date between p_from and p_to
       and rc.status <> 'cancelled'
  )
  select
    (select coalesce(sum(inv.taxable), 0)::bigint from inv),
    (select coalesce(sum(coalesce(inv.tax_amount, inv.amount - inv.taxable)), 0)::bigint from inv),
    (select count(*)::int from inv),
    (select coalesce(sum(cn.taxable_value), 0)::bigint from cn),
    (select coalesce(sum(cn.tax_amount), 0)::bigint from cn),
    (select coalesce(sum(dn.taxable_value), 0)::bigint from dn),
    (select coalesce(sum(dn.tax_amount), 0)::bigint from dn),
    (select coalesce(jsonb_agg(jsonb_build_object('project_id', r.project_id, 'revenue', r.revenue) order by r.project_id), '[]'::jsonb)
       from (select pr.project_id, sum(pr.rev)::bigint as revenue from proj_rev pr group by pr.project_id) r),
    (select coalesce(sum(b.subtotal), 0)::bigint from bills b),
    (select count(*)::int from bills),
    (select coalesce(sum(b.cgst + b.sgst + b.igst), 0)::bigint from bills b),
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'vendor_name', g.vendor_name,
                                                  'month', g.month, 'amount', g.amount, 'n', g.n)), '[]'::jsonb)
       from (select x.category, x.vendor_name, to_char(x.expense_date, 'YYYY-MM') as month,
                    sum(x.amount)::bigint as amount, count(*)::int as n
               from exps x group by x.category, x.vendor_name, to_char(x.expense_date, 'YYYY-MM')) g),
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select x.bill_type, x.category, x.gstin, sum(x.gst_paid)::bigint as gst, count(*)::int as n
               from exps x where x.gst_paid > 0 group by x.bill_type, x.category, x.gstin) g),
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'amount', g.amount)), '[]'::jsonb)
       from (select x.category, sum(x.amount)::bigint as amount from exps x where x.project_id is null group by x.category) g),
    (select coalesce(jsonb_agg(jsonb_build_object('project_id', x.project_id, 'amount', x.amount, 'category', x.category,
                                                  'expense_date', x.expense_date, 'vendor_name', x.vendor_name,
                                                  'description', x.description)
                               order by x.expense_date, x.amount desc), '[]'::jsonb)
       from exps x where x.project_id is not null),
    (select coalesce(sum(c.gross_commission), 0)::bigint from comms c),
    (select count(*)::int from comms);
end;
$function$;

revoke all on function public.report_pnl(date, date) from public, anon;
grant execute on function public.report_pnl(date, date) to authenticated, service_role;

-- ── 3. P&L trend: wahi shortfall (headline = trend) ──────────────────────────
create or replace function public.report_pnl_monthly(p_from date, p_to date)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'P&L trend nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'revenue', m.revenue, 'expenses', m.expenses)
                            order by m.month), '[]'::jsonb)
    into v_out
    from (
      select k.month, sum(k.rev)::bigint as revenue, sum(k.exp)::bigint as expenses
        from (
          select to_char(i.invoice_date, 'YYYY-MM') as month,
                 coalesce(i.taxable_value::bigint,
                   floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as rev,
                 0::bigint as exp
            from public.invoices i
           where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
             and i.status in ('pending', 'paid', 'overdue')
          union all
          select to_char(e.expense_date, 'YYYY-MM'), 0, e.amount::bigint
            from public.expenses e
           where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
          union all
          -- S45-SLICE2 (G1): report_pnl jaisa settlement shortfall.
          select to_char(s.txn_date, 'YYYY-MM'), 0, s.amount
            from public.report_settlement_shortfalls(p_from, p_to) s
          union all
          select to_char(c.credit_date, 'YYYY-MM'), -coalesce(c.taxable_value, 0)::bigint, 0
            from public.credit_notes c
           where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
          union all
          select to_char(d.debit_date, 'YYYY-MM'), coalesce(d.taxable_value, 0)::bigint, 0
            from public.debit_notes d
           where d.tenant_id = v_tenant and d.debit_date between p_from and p_to
        ) k
       group by k.month
    ) m;
  return v_out;
end;
$function$;

revoke all on function public.report_pnl_monthly(date, date) from public, anon;
grant execute on function public.report_pnl_monthly(date, date) to authenticated, service_role;

-- ── 4. Opening balances (CA ke aankde; owner hi likhe) ──────────────────────
create table if not exists public.opening_balances (
  tenant_id          uuid primary key references public.tenants(id) on delete cascade,
  as_of              date not null,
  owner_capital      bigint,
  retained_earnings  bigint,
  notes              text check (notes is null or char_length(notes) <= 500),
  updated_by         uuid,
  updated_at         timestamptz not null default now()
);
comment on table public.opening_balances is
  'S45 slice 2: opening capital + retained earnings (previous years) as at as_of, from the CA. Whole rupees; retained_earnings may be negative (losses). NULL = not entered. Balance Sheet / Trial Balance use them instead of a Difference plug. Written only via set_opening_balances (owner).';

alter table public.opening_balances enable row level security;
revoke all on table public.opening_balances from anon, public;
grant select on table public.opening_balances to authenticated;
grant all on table public.opening_balances to service_role;

drop policy if exists opening_balances_select on public.opening_balances;
create policy opening_balances_select on public.opening_balances
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
drop policy if exists opening_balances_service_role on public.opening_balances;
create policy opening_balances_service_role on public.opening_balances
  to service_role using (true) with check (true);

create or replace function public.set_opening_balances(
  p_as_of date default null, p_owner_capital bigint default null, p_retained_earnings bigint default null,
  p_notes text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'Opening balances save nahi hue: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.current_user_is_owner() then
    raise exception 'Opening balances sirf owner badal sakta hai. Owner se kahein ki Balance Sheet page par CA ke aankde bharein.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Dono khaali = hata do (Difference line wapas, jaisi thi).
  if p_owner_capital is null and p_retained_earnings is null then
    delete from public.opening_balances where tenant_id = v_tenant;
    return;
  end if;
  if p_as_of is null then
    raise exception 'Opening balances kis tareekh ke hain? CA ki balance sheet ki tareekh (jaise 31 Mar) bharein.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_as_of > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Opening balances ki tareekh aage ki nahi ho sakti (%). CA ki pichhli balance sheet ki tareekh bharein.', p_as_of
      using errcode = 'invalid_parameter_value';
  end if;
  if p_owner_capital is not null and p_owner_capital < 0 then
    raise exception 'Owner''s capital minus nahi ho sakta. Nikala hua paisa Balance Sheet par "Drawings" line me daalein.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.opening_balances (tenant_id, as_of, owner_capital, retained_earnings, notes, updated_by, updated_at)
  values (v_tenant, p_as_of, p_owner_capital, p_retained_earnings, nullif(trim(coalesce(p_notes, '')), ''), auth.uid(), now())
  on conflict (tenant_id) do update
     set as_of = excluded.as_of, owner_capital = excluded.owner_capital,
         retained_earnings = excluded.retained_earnings, notes = excluded.notes,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end;
$function$;

revoke all on function public.set_opening_balances(date, bigint, bigint, text) from public, anon;
grant execute on function public.set_opening_balances(date, bigint, bigint, text) to authenticated, service_role;

-- ── 4b. Expense jiska Cr side pehle se kahin aur hai ───────────────────────────
-- Salary / reimbursement / EMI / loan / tax challan / expense claim / inbound purchase /
-- fixed asset apni table se expense_id jodte hain — unka Cr (payable, loan, bank line, asset)
-- wahan hai. Bank line se match hua expense bhi bahar. Inhe expenses_payable /
-- expenses_paid_unbanked me gine to wahi ₹ do baar Cr.
create or replace function public.report_expense_has_own_credit(p_tenant uuid, p_expense_id text)
returns boolean
language sql
stable
security invoker
set search_path = public
as $function$
  select exists (select 1 from public.reimbursements x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.salary_payments x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.emi_payments x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.business_loan_payments x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.employee_loan_repayments x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.tax_payments x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.expense_claims x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.inbound_purchases x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.fixed_assets x where x.tenant_id = p_tenant and x.expense_id = p_expense_id)
      or exists (select 1 from public.bank_transactions b where b.tenant_id = p_tenant
                    and b.matched_to_type = 'expense' and b.matched_to_id = p_expense_id);
$function$;

revoke all on function public.report_expense_has_own_credit(uuid, text) from public, anon;
grant execute on function public.report_expense_has_own_credit(uuid, text) to authenticated, service_role;

-- ── 5. Balance sheet: 3 naye column (G2, G3, G4) + fee-aware undeposited ─────
-- RETURNS TABLE badla, isliye create or replace nahi chalega — drop + create, grants niche.
drop function if exists public.report_balance_sheet(date);

create function public.report_balance_sheet(p_as_of date default null)
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
  salary_other_deductions bigint
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
    ((select coalesce(sum(p.amount - coalesce((select sum(t.tds_amount) from public.tds_receivable t
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
    ((select coalesce(sum(p.amount), 0)
        from public.payments p
        join public.quotes q on q.id = p.quote_id and q.tenant_id = v_tenant
       where p.tenant_id = v_tenant and p.status = 'received' and q.invoice_id is null)
   + (select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (i.amount
                - coalesce((select sum(c.amount) from public.credit_notes c
                             where c.tenant_id = v_tenant and c.invoice_id = i.id), 0)
                + coalesce((select sum(d.amount) from public.debit_notes d
                             where d.tenant_id = v_tenant and d.invoice_id = i.id), 0)))), 0)
        from public.quotes q
        join public.invoices i on i.id = q.invoice_id and i.tenant_id = v_tenant
       where q.tenant_id = v_tenant
         and i.status in ('pending', 'paid', 'overdue')
         and not exists (select 1 from public.invoices i2
                          where i2.tenant_id = v_tenant and i2.quote_id = q.id and i2.id <> i.id)
         and not exists (select 1 from public.project_milestones pm
                          where pm.tenant_id = v_tenant and pm.invoice_id = i.id)))::bigint,
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
       from public.salary_payments s where s.tenant_id = v_tenant);
end;
$function$;

revoke all on function public.report_balance_sheet(date) from public, anon;
grant execute on function public.report_balance_sheet(date) to authenticated, service_role;
