-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.report_pnl(date,date)') and 'cogs_by_category' = any(proargnames))
-- deploy-key: r1645cogsbycategory
--
-- R-1645 (P1, 23 Oct 2026): P&L — one vendor's bill switched off EVERY vendor's estimated
-- licence cost. lib/accounting/pnl.ts buildPnl took "billed COGS > 0" (report_pnl.cogs, one total
-- for all COGS-* bills) as "the period is billed" and dropped the subscription estimate for all
-- vendors: a ₹500 Zoho bill made the whole Google cost disappear and profit jumped by it.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════════════
--   report_pnl gains ONE output column, cogs_by_category = [{category, subtotal, n}] of the
--   same `bills` CTE that report_pnl.cogs sums (so the parts add up to cogs). TS maps a category
--   to its vendor (COGS-Workspace → google, COGS-M365 → microsoft, COGS-Zoho → zoho) and keeps
--   the estimate for every vendor without a bill. Every other line is the newest body
--   (20261022013149_r1739_zoho_opening_invoices.sql) as is.
--   A new OUT column cannot be added by create or replace, so drop + create, then the same grants.
--   Nothing in SQL calls report_pnl; the app reads the new column only when it is there.
--
-- Rollback: drop function public.report_pnl(date, date); then re-run the report_pnl part of
--   20261022013149_r1739_zoho_opening_invoices.sql (and its grants from 20261018180232).

drop function if exists public.report_pnl(date, date);

CREATE FUNCTION public.report_pnl(p_from date, p_to date)
 RETURNS TABLE(inv_taxable bigint, inv_tax bigint, revenue_count integer, cn_taxable bigint, cn_tax bigint, dn_taxable bigint, dn_tax bigint, revenue_by_project jsonb, cogs bigint, cogs_count integer, bills_gst bigint, expense_groups jsonb, itc_groups jsonb, unassigned_by_category jsonb, project_expenses jsonb, commissions bigint, commissions_count integer, bill_itc_groups jsonb, cogs_by_category jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  /* R-1739 */ /* R-1645 */
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
       and public.invoice_is_sale(i.document_kind)  -- R-1739: an imported Zoho opening invoice is not revenue
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
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g),
    -- R-1645: COGS bills per category (pre-GST subtotal) — lib/accounting/pnl.ts turns the licence
    -- estimate off only for the vendor a category belongs to, not for every vendor.
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'subtotal', g.subtotal, 'n', g.n)
                               order by g.category), '[]'::jsonb)
       from (select b.category, sum(b.subtotal)::bigint as subtotal, count(*)::int as n
               from bills b group by b.category) g);
end;
$function$;

revoke all on function public.report_pnl(date, date) from public, anon;
grant execute on function public.report_pnl(date, date) to authenticated, service_role;
