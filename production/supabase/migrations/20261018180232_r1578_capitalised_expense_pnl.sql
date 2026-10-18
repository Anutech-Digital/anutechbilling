-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.report_pnl(date,date)') and prosrc like '%R-1578%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_pnl_monthly(date,date)') and prosrc like '%R-1578%')
-- deploy-key: r1578capitalised
--
-- R-1578 (P1, 18 Oct 2026): an 'Equipment' expense turned into a fixed asset (Accounting →
-- Assets → Add asset → pick the expense; fixed_assets.expense_id) stayed a full cost in the
-- P&L while the Balance Sheet also carried the asset — one laptop counted twice, profit (and
-- taxable income) understated by its cost in the year of purchase, and the Trial Balance
-- 'Difference' line moved by the cost.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════════════
--   20261018045438_r1576_bill_itc.sql, report_pnl, CTE exps: every expense in the range, no
--   look at fixed_assets.expense_id. Same in report_pnl_monthly (20261009170000, the trend).
--
-- ══ WHAT CHANGES — one condition in each; every other line is the newest body as is ══════
--   exps / the trend's expense leg skip an expense that a fixed asset of the SAME tenant points
--   at (expense_id is a plain FK, not tenant-checked). Its cost reaches the P&L as depreciation
--   from the register, computed in TS (lib/accounting/depreciation.ts → pnl-assemble.ts) — the
--   same IT Act WDV the register and Balance Sheet already use. Delete the asset and the
--   expense is a cost again. RETURNS unchanged, so create or replace (no drop).
--   Partial index for the lookup.

create index if not exists fixed_assets_expense_idx on public.fixed_assets (tenant_id, expense_id) where expense_id is not null;

-- ── P&L ──────────────────────────────────────────────────────────────────────
create or replace function public.report_pnl(p_from date, p_to date)
 returns table(inv_taxable bigint, inv_tax bigint, revenue_count integer, cn_taxable bigint, cn_tax bigint, dn_taxable bigint, dn_tax bigint, revenue_by_project jsonb, cogs bigint, cogs_count integer, bills_gst bigint, expense_groups jsonb, itc_groups jsonb, unassigned_by_category jsonb, project_expenses jsonb, commissions bigint, commissions_count integer, bill_itc_groups jsonb)
 language plpgsql
 stable
 set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_tenant uuid := public.current_tenant_id();
  v_own_state text;
begin
  if v_tenant is null then
    raise exception 'P&L nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'P&L ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye — range dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;

  -- R-1576: hamara rajya (state check ke liye) — report.ts jaisa: state_code, warna GSTIN ke pehle 2.
  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_tenant;

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
    select vb.subtotal, vb.cgst, vb.sgst, vb.igst, vb.document_type, vb.category, vb.vendor_gstin
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
       and vb.category like 'COGS-%'
  ), exps as (
    select e.amount::bigint as amount, e.gst_paid, e.category, e.vendor_name, e.expense_date, e.bill_type,
           e.project_id, e.description, v.gstin
      from public.expenses e
      left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
       -- R-1578: asset bana kharcha capitalised hai — P&L me sirf depreciation (register, TS) se.
       and not exists (select 1 from public.fixed_assets fa where fa.tenant_id = v_tenant and fa.expense_id = e.id)
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
    (select count(*)::int from comms),
    -- R-1576: bills ka GST bhi ITC niyam se (lib/gst/bill-itc.ts) — document_type, vendor GSTIN,
    -- heads (state check ke liye IGST / CGST+SGST alag group), category (s.17(5)). TS tay karta hai.
    (select coalesce(jsonb_agg(jsonb_build_object('document_type', g.document_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'cgst', g.cgst, 'sgst', g.sgst, 'igst', g.igst,
                                                  'n', g.n, 'ownStateCode', v_own_state)), '[]'::jsonb)
       from (select b.document_type, b.category, b.vendor_gstin as gstin,
                    sum(b.cgst)::bigint as cgst, sum(b.sgst)::bigint as sgst, sum(b.igst)::bigint as igst, count(*)::int as n
               from bills b where b.cgst + b.sgst + b.igst > 0
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g);
end;
$function$;

revoke all on function public.report_pnl(date, date) from public, anon;
grant execute on function public.report_pnl(date, date) to authenticated, service_role;

-- ── P&L trend ────────────────────────────────────────────────────────────────
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
             -- R-1578: report_pnl jaisa — asset bana kharcha trend me bhi kharcha nahi.
             and not exists (select 1 from public.fixed_assets fa where fa.tenant_id = v_tenant and fa.expense_id = e.id)
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
