-- deploy-peek: to_regprocedure('public.report_pnl_revenue_lines(date,date,text[])') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_pnl_revenue_by_product(date,date)') and prosrc like '%R-2181%')
-- deploy-key: r2181revdrill
--
-- R-2181 (31 Oct 2026, G-ZOHO Wave 1): P&L drill-down — every row opens only its own documents,
-- and the drill total equals the number clicked (taxable, net of credit notes).
--
-- Found by the Zoho Books audit: the product rows of the P&L ("Google Workspace", "Microsoft 365",
-- ...) opened EVERY invoice of the period, at the GST-inclusive amount, with fully credited
-- invoices still at full value. Local copy, Oct 2026: the Google Workspace row ₹2,08,695
-- (13 invoices) opened 23 invoices = ₹3,81,286; the Revenue card ₹3,23,123 opened ₹3,81,286.
--
-- ══ ONE SOURCE FOR THE ROW AND ITS DRILL ═══════════════════════════════════════════════
--   report_pnl_revenue_lines(p_from, p_to, p_families) returns the DOCUMENTS behind Revenue:
--   one row per (document, family) with the document's share of the family, ex-GST, signed
--   (invoice / debit note +, credit note −). The family split is exactly R-1835's
--   (20261024110239: revenue_family() of each line, qty × rate weights, largest remainder).
--   report_pnl_revenue_by_product is redefined as the SUM of these rows (output unchanged,
--   proven by supabase/tests/r1835_pnl_revenue_by_product.test.sql) — so a row's drill total
--   can never drift from the row: it is the same rows, added up.
--   p_families null = every family (the Revenue line / card); else only those families.
--
-- SECURITY INVOKER, STABLE, read-only; fails CLOSED without a company (same message as
-- report_pnl). Rollback: re-run 20261024110239's report_pnl_revenue_by_product, then
-- drop function public.report_pnl_revenue_lines(date, date, text[]);
-- Test: supabase/tests/r2181_pnl_revenue_drill.test.sql.

begin;

-- ── 1. The documents behind Revenue, per family ────────────────────────────────────────
create or replace function public.report_pnl_revenue_lines(p_from date, p_to date, p_families text[] default null)
returns table(doc_kind text, doc_id text, invoice_id text, customer_name text, doc_date date, status text, family text, amount bigint)
language plpgsql
stable
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  /* R-2181 */
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
  with docs as (
    -- report_pnl's inv / cn / dn, row for row (same filters, same taxable rule) — R-1835.
    select 'invoice'::text as kind, i.id as doc_id, i.id as invoice_id, i.customer_name, i.invoice_date as doc_date,
           i.status::text as status,
           coalesce(i.taxable_value::bigint,
             floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as amt
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status in ('pending', 'paid', 'overdue')
       and public.invoice_is_sale(i.document_kind)
    union all
    select 'credit_note', c.id, c.invoice_id, c.customer_name, c.credit_date, null::text, c.taxable_value::bigint
      from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
    union all
    select 'debit_note', d.id, d.invoice_id, d.customer_name, d.debit_date, null::text, d.taxable_value::bigint
      from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date between p_from and p_to
  ), target as (
    select distinct d.invoice_id from docs d
  ), proj as (
    select distinct pm.invoice_id
      from public.project_milestones pm
     where pm.tenant_id = v_tenant and pm.invoice_id is not null
  ), lines as (
    select t.invoice_id, e.li
      from target t
      join public.invoices i on i.id = t.invoice_id and i.tenant_id = v_tenant
      left join public.quotes q on q.id = i.quote_id and q.tenant_id = v_tenant
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(i.line_items) = 'array' and jsonb_array_length(i.line_items) > 0 then i.line_items
             when jsonb_typeof(q.line_items) = 'array' then q.line_items
             else '[]'::jsonb end) as e(li)
     where not exists (select 1 from proj p where p.invoice_id = t.invoice_id)
       and jsonb_typeof(e.li) = 'object'
  ), weights as (
    select l.invoice_id,
           public.revenue_family(it.vendor::text, l.li) as family,
           sum(greatest(
             (case when jsonb_typeof(l.li->'qty') = 'number' then (l.li->>'qty')::numeric else 1 end)
           * (case when jsonb_typeof(l.li->'rate') = 'number' then (l.li->>'rate')::numeric else 0 end), 0)) as w
      from lines l
      left join public.items it on it.tenant_id = v_tenant and it.id = l.li->>'item_id'
     group by l.invoice_id, 2
  ), fam_w as (
    select w.invoice_id, w.family, w.w from weights w where w.w > 0
    union all
    select t.invoice_id, 'projects', 1::numeric
      from target t where exists (select 1 from proj p where p.invoice_id = t.invoice_id)
    union all
    select t.invoice_id, 'other', 1::numeric
      from target t
     where not exists (select 1 from proj p where p.invoice_id = t.invoice_id)
       and not exists (select 1 from weights w where w.invoice_id = t.invoice_id and w.w > 0)
  ), split as (
    select d.kind, d.doc_id, d.invoice_id, d.customer_name, d.doc_date, d.status, d.amt, f.family,
           d.amt::numeric * f.w / sum(f.w) over (partition by d.kind, d.doc_id) as exact
      from docs d join fam_w f on f.invoice_id = d.invoice_id
  ), ranked as (
    select s.*, floor(s.exact)::bigint as base,
           s.amt - sum(floor(s.exact)::bigint) over (partition by s.kind, s.doc_id) as left_over,
           row_number() over (partition by s.kind, s.doc_id order by s.exact - floor(s.exact) desc, s.family) as rn
      from split s
  )
  select r.kind, r.doc_id, r.invoice_id, r.customer_name, r.doc_date, r.status, r.family,
         (case when r.kind = 'credit_note' then -1 else 1 end)
           * (r.base + case when r.rn <= r.left_over then 1 else 0 end) as amount
    from ranked r
   where p_families is null or r.family = any(p_families)
   order by r.doc_date desc, r.doc_id, r.family;
end;
$function$;

revoke all on function public.report_pnl_revenue_lines(date, date, text[]) from public, anon;
grant execute on function public.report_pnl_revenue_lines(date, date, text[]) to authenticated, service_role;

-- ── 2. Revenue per family = the same rows, added up ────────────────────────────────────
create or replace function public.report_pnl_revenue_by_product(p_from date, p_to date)
returns table(family text, invoiced bigint, credit_notes bigint, debit_notes bigint, invoice_count integer)
language sql
stable
set search_path to 'public'
as $function$
  /* R-1835, R-2181: the sum of report_pnl_revenue_lines — the drill-down's own rows. */
  select l.family,
         coalesce(sum(l.amount) filter (where l.doc_kind = 'invoice'), 0)::bigint,
         coalesce(-sum(l.amount) filter (where l.doc_kind = 'credit_note'), 0)::bigint,
         coalesce(sum(l.amount) filter (where l.doc_kind = 'debit_note'), 0)::bigint,
         (count(distinct l.doc_id) filter (where l.doc_kind = 'invoice'))::int
    from public.report_pnl_revenue_lines(p_from, p_to, null) l
   group by l.family
   order by l.family;
$function$;

revoke all on function public.report_pnl_revenue_by_product(date, date) from public, anon;
grant execute on function public.report_pnl_revenue_by_product(date, date) to authenticated, service_role;

commit;
