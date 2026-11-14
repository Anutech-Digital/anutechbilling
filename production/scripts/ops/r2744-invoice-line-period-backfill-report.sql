-- R-2744 — READ-ONLY report: what a backfill of OLD invoices' line periods would store. 13 Nov 2026.
--
-- WHY: from migration 20261113210500 every invoice made from a quote stores each line's service period at
-- issue (invoices.line_items[i].service_period), so its PDF / screen never re-print a different period.
-- Invoices issued BEFORE it store nothing and still print a period worked out from today's quote + the
-- renewed subscription (lineServicePeriod, with the R-2727 cutoff). Storing those now would freeze what
-- they print TODAY — a data repair on issued GST invoices, so it is Pardeep's decision, not done here.
--
-- WHAT IT IS: it changes NOTHING. The whole file runs inside `begin; set transaction read only; … rollback;`.
-- No email or phone column is selected.
--
-- RULE (same function and inputs as the issue-time trigger tg_invoice_stamp_line_periods):
--   invoices with a quote, not void, whose lines carry no service_period yet. Lines = the invoice's own
--   line_items; an old invoice with NULL line_items is shown with the quote's lines (lines_source
--   'quote' — a backfill would have to fill line_items too, the once-set path). would_store = what
--   public.invoice_line_service_period returns now (quote as it is today, the renewed subscription's
--   start/term today, app_rule_dates vs the invoice's created_at). 'no period' = an explicit null.
--   line_count_differs: the quote's line count today differs from the lines shown — the PDF then
--   prints the invoice's own lines and (R-375) usually no period; check those by hand.
--
-- SECTIONS
--   0. Login check (tenants_visible must equal the number of companies).
--   1. One row per line, with the company totals (company_*) on every row (a read-only transaction
--      cannot create a temp view, so totals ride on the rows).
--
-- WHO RUNS IT: the manager or Pardeep. Claude does not run it on staging or live.
-- HOW (same instances as production/supabase/cloudsql/{staging,live}/deploy-db-*.sh), after the
-- R-2744 migration is applied there:
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   then:  \o r2744-staging.txt
--          \i scripts/ops/r2744-invoice-line-period-backfill-report.sql
--          \o
--   LOCAL:  docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres < scripts/ops/r2744-invoice-line-period-backfill-report.sql

begin;
set transaction read only;

-- 0. Login check
select count(*) as tenants_visible from public.tenants;

-- 1. Rows
with inv as (
  select i.id as invoice_id, i.tenant_id, i.invoice_date, i.created_at, i.customer_name,
         case when jsonb_typeof(i.line_items) = 'array' then i.line_items else q.line_items end as lines,
         case when jsonb_typeof(i.line_items) = 'array' then 'invoice' else 'quote' end as lines_source,
         to_jsonb(q) as q,
         jsonb_array_length(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) as quote_line_count,
         (select jsonb_build_object('start_date', s.start_date, 'term_months', s.term_months)
            from public.subscriptions s
           where s.tenant_id = i.tenant_id
             and (q.is_renewal or q.is_extension)
             and case when q.renewal_subscription_id is not null then s.id = q.renewal_subscription_id
                      else s.renewal_quote_id = q.id end
           limit 1) as sub
    from public.invoices i
    join public.quotes q on q.id = i.quote_id and q.tenant_id = i.tenant_id
   where i.status::text <> 'void'
), rule as (
  select (select r.from_at from public.app_rule_dates r where r.key = 'r2727_invoice_period_rule') as from_at
), lines as (
  select inv.tenant_id, inv.invoice_id, inv.invoice_date, inv.customer_name, inv.lines_source,
         e.i - 1 as line_index, e.l->>'name' as line_name,
         public.invoice_line_service_period(e.l, inv.q, inv.sub, rule.from_at, inv.created_at) as would_store,
         jsonb_array_length(inv.lines) <> inv.quote_line_count as line_count_differs,
         e.i = min(e.i) over (partition by inv.invoice_id) as first_line
    from inv
    cross join rule
    cross join lateral jsonb_array_elements(inv.lines) with ordinality as e(l, i)
   where jsonb_typeof(inv.lines) = 'array'
     and jsonb_typeof(e.l) = 'object'
     and not (e.l ? 'service_period')
)
select t.name as company,
       count(*) filter (where l.first_line) over (partition by l.tenant_id) as company_invoices,
       count(*) over (partition by l.tenant_id) as company_lines,
       count(*) filter (where l.would_store is not null) over (partition by l.tenant_id) as company_lines_with_period,
       count(*) filter (where l.lines_source = 'quote') over (partition by l.tenant_id) as company_lines_needing_line_items_fill,
       count(*) filter (where l.line_count_differs) over (partition by l.tenant_id) as company_lines_to_check_by_hand,
       l.invoice_id, l.invoice_date, l.customer_name, l.lines_source, l.line_index, l.line_name,
       coalesce(l.would_store->>'from' || ' to ' || (l.would_store->>'to')
                || coalesce(' (' || (l.would_store->>'months') || ' months)', ''), 'no period') as would_store,
       l.line_count_differs
  from lines l join public.tenants t on t.id = l.tenant_id
 order by t.name, l.invoice_date, l.invoice_id, l.line_index;

rollback;
