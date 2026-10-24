-- deploy-peek: to_regprocedure('public.report_pnl_revenue_by_product(date,date)') is not null and to_regprocedure('public.revenue_family(text,jsonb)') is not null
-- deploy-key: r1835revbyproduct
--
-- R-1835 (24 Oct 2026): P&L — Revenue split by what was sold.
-- Pardeep: "usi tarah bakiyo ko bhi dikhao, jaise revenue". R-1833 split Revenue only into what
-- report_pnl knows (sales / software projects / credit / debit notes). This adds the split by
-- product family: Google Workspace, Microsoft 365, Zoho, Hosting, Domains, In-House Support,
-- Software projects, Other.
--
-- ══ CHOICE: a companion RPC, report_pnl untouched ═══════════════════════════════════════
--   report_pnl (19 OUT columns, grants from 20261018180232 / r1645) is NOT dropped and recreated.
--   A new read-only function reads the SAME documents with the SAME filters as report_pnl's
--   inv / cn / dn CTEs and returns one row per family. The app adds them up and shows them only
--   when they equal report_pnl's Revenue to the rupee (else R-1833's lines stay) — so an old
--   database (function missing) and a half-way state both keep working.
--
-- ══ HOW A RUPEE GETS ITS FAMILY ════════════════════════════════════════════════════════
--   * Invoice of a project milestone (same rule as report_pnl.revenue_by_project) → 'projects'.
--   * Otherwise the invoice's lines: invoices.line_items when it has lines, else the quote's
--     lines (the PDF / cost-fill rule — 20261009180000). Each line's family:
--       revenue_family(items.vendor of line.item_id, line) — item vendor first
--       (google / microsoft / zoho / hosting / domain / support), then the line itself
--       (hostingPlan → hosting; the name: "Google Workspace…", "M365…", "Zoho…", "…hosting",
--       "Domain …"); anything else → 'other'.
--   * The invoice's ex-GST taxable value (report_pnl's `taxable`) is shared over its families by
--     each family's qty × rate, LARGEST REMAINDER, so the parts of one invoice add up to its
--     taxable value exactly — and the families add up to report_pnl.inv_taxable exactly.
--     No line with a positive value → the whole invoice is 'other'.
--   * A credit note / debit note (no lines of its own) is shared over ITS invoice's families the
--     same way (pro-rata), with its own date in the range — same rows as report_pnl.cn / dn.
--   Revenue = Σ invoiced − Σ credit_notes + Σ debit_notes = report_pnl's inv − cn + dn.
--
-- SECURITY INVOKER, STABLE, read-only; fails CLOSED without a company (same message as
-- report_pnl). Rollback: drop function public.report_pnl_revenue_by_product(date, date);
-- drop function public.revenue_family(text, jsonb); — nothing else depends on them.
-- Test: supabase/tests/r1835_pnl_revenue_by_product.test.sql.

begin;

-- ── 1. One line's product family ───────────────────────────────────────────────────────
create or replace function public.revenue_family(p_vendor text, p_line jsonb)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  /* R-1835 */
  select case
    when p_vendor in ('google', 'microsoft', 'zoho', 'hosting', 'domain', 'support') then p_vendor
    when nullif(btrim(coalesce(p_line->>'hostingPlan', '')), '') is not null then 'hosting'
    else (
      select case
        when s ~ '(google|g ?suite|workspace|gmail)' then 'google'
        when s ~ '(microsoft|\mm365\M|office ?365|\mo365\M|exchange online)' then 'microsoft'
        when s ~ '\mzoho\M' then 'zoho'
        -- an edition name only one vendor sells (Business Standard is both → falls through)
        when s ~ '\mbusiness (starter|plus)\M' then 'google'
        when s ~ '\mbusiness (basic|premium)\M' then 'microsoft'
        when s ~ '(hosting|cpanel|directadmin|\mvps\M)' then 'hosting'
        when s ~ '\mdomains?\M' then 'domain'
        when nullif(btrim(coalesce(p_line->>'domain', '')), '') is not null and p_line ? 'years' then 'domain'
        else 'other'
      end
      from (select lower(coalesce(p_line->>'name', '')) as s) n
    )
  end
$function$;

revoke all on function public.revenue_family(text, jsonb) from public, anon;
grant execute on function public.revenue_family(text, jsonb) to authenticated, service_role;

-- ── 2. Revenue of a period per family ──────────────────────────────────────────────────
create or replace function public.report_pnl_revenue_by_product(p_from date, p_to date)
returns table(family text, invoiced bigint, credit_notes bigint, debit_notes bigint, invoice_count integer)
language plpgsql
stable
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  /* R-1835 */
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
    -- report_pnl's inv / cn / dn, row for row (same filters, same taxable rule).
    select 'i:' || i.id as doc, 'inv'::text as kind, i.id as invoice_id,
           coalesce(i.taxable_value::bigint,
             floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as amt
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status in ('pending', 'paid', 'overdue')
       and public.invoice_is_sale(i.document_kind)
    union all
    select 'c:' || c.id, 'cn', c.invoice_id, c.taxable_value::bigint
      from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
    union all
    select 'd:' || d.id, 'dn', d.invoice_id, d.taxable_value::bigint
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
    select d.doc, d.kind, d.amt, f.family,
           d.amt::numeric * f.w / sum(f.w) over (partition by d.doc) as exact
      from docs d join fam_w f on f.invoice_id = d.invoice_id
  ), ranked as (
    select s.doc, s.kind, s.family, floor(s.exact)::bigint as base,
           s.amt - sum(floor(s.exact)::bigint) over (partition by s.doc) as left_over,
           row_number() over (partition by s.doc order by s.exact - floor(s.exact) desc, s.family) as rn
      from split s
  ), parts as (
    select r.kind, r.family, r.doc, r.base + case when r.rn <= r.left_over then 1 else 0 end as part
      from ranked r
  )
  select p.family,
         coalesce(sum(p.part) filter (where p.kind = 'inv'), 0)::bigint,
         coalesce(sum(p.part) filter (where p.kind = 'cn'), 0)::bigint,
         coalesce(sum(p.part) filter (where p.kind = 'dn'), 0)::bigint,
         (count(distinct p.doc) filter (where p.kind = 'inv'))::int
    from parts p
   group by p.family
   order by p.family;
end;
$function$;

revoke all on function public.report_pnl_revenue_by_product(date, date) from public, anon;
grant execute on function public.report_pnl_revenue_by_product(date, date) to authenticated, service_role;

commit;
