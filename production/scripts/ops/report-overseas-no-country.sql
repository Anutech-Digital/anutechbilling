-- R-2620 — READ-ONLY report: customers marked Overseas with no country outside India (9 Nov 2026).
--
-- WHY: an empty country reads as India everywhere (money-rules G5), so a customer whose GST treatment is
-- 'overseas' but whose country is empty (or India) was taxed as an Indian sale on a NEW quote / invoice —
-- 18% on what may be a 0% export under the LUT. Such rows came over from the Zoho import (staging Excel,
-- 6 Nov). R-2620 (migration 20261109063436) now refuses a sent quote / new invoice for them; this report
-- lists the customers to fix and what was already issued to them. Repairing a row (setting the real
-- country, e.g. from the Zoho billing address) is Pardeep's decision — a data repair, never automatic.
--
-- WHAT IT IS: four SELECTs. It changes NOTHING — the whole file runs inside
-- `begin; set transaction read only; … rollback;`, so even a mistake cannot write. It works on a
-- database WITHOUT R-2620 (the rule is inlined, not public.overseas_country_missing).
--
-- WHO RUNS IT: Pardeep (DB step) on staging / live; Claude only on the LOCAL DB.
-- HOW: docs/playbooks/overseas-no-country.md.
--
-- SECTIONS (0 rows in 1–3 = clean):
--   0 login check     — companies / customers this login can see (row security must not hide rows).
--   1 per company     — how many such customers each company has, and their issued invoices.
--   2 per customer    — company, customer id + name, the stored country / state / GSTIN, open quotes
--                       (sent / viewed / accepted, not yet invoiced), draft quotes, active subscriptions,
--                       Tax Invoices issued (not void): how many charged GST and their tax, how many at 0%,
--                       how many came from the Zoho import (as filed), the last invoice date.
--   3 issued invoices — every non-void Tax Invoice whose FROZEN buyer facts are Overseas + no country
--                       outside India (any customer, also one fixed since), with its tax — the ones a repair
--                       would have to look at (an issued invoice never changes by itself, G8).

begin;
set transaction read only;

\pset footer on
\pset null '·'

\echo
\echo '=== 0. Login check: companies_visible should equal the number of companies ==='
select current_user                                                                   as login,
       (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                                           as companies_visible,
       (select count(*) from public.customers)                                         as customers_visible,
       (select count(*) from public.customers where gst_treatment = 'overseas')        as overseas_customers,
       now() at time zone 'Asia/Kolkata'                                               as run_at_ist;

\echo
\echo '=== 1. Per company: Overseas customers with no country outside India (0 rows = clean) ==='
with bad as (
  select c.id, c.tenant_id
    from public.customers c
   where c.gst_treatment = 'overseas'
     and coalesce(nullif(lower(btrim(c.country)), ''), 'india') in ('india', 'in', 'ind', 'bharat')
),
inv as (
  select i.customer_id,
         count(*)                                          as invoices,
         count(*) filter (where coalesce(i.tax_amount, 0) > 0) as invoices_taxed,
         coalesce(sum(i.tax_amount), 0)                    as tax_charged
    from public.invoices i
    join bad b on b.id = i.customer_id and b.tenant_id = i.tenant_id
   where i.document_kind = 'tax_invoice' and i.status::text <> 'void'
   group by i.customer_id
)
select t.id                                      as company_id,
       t.name                                    as company,
       count(*)                                  as overseas_no_country,
       coalesce(sum(inv.invoices), 0)            as invoices_issued,
       coalesce(sum(inv.invoices_taxed), 0)      as invoices_with_gst,
       coalesce(sum(inv.tax_charged), 0)         as gst_charged_rupees
  from bad b
  join public.tenants t on t.id = b.tenant_id
  left join inv on inv.customer_id = b.id
 group by t.id, t.name
 order by count(*) desc, t.name;

\echo
\echo '=== 2. Per customer: what to fix and what was issued (0 rows = clean) ==='
with bad as (
  select c.*
    from public.customers c
   where c.gst_treatment = 'overseas'
     and coalesce(nullif(lower(btrim(c.country)), ''), 'india') in ('india', 'in', 'ind', 'bharat')
)
select t.name                                                        as company,
       b.id                                                          as customer_id,
       b.name                                                        as customer,
       coalesce(nullif(btrim(b.country), ''), '(empty)')             as country_stored,
       b.state_code,
       (nullif(btrim(coalesce(b.gstin, '')), '') is not null)        as has_gstin,
       (select count(*) from public.quotes q
         where q.tenant_id = b.tenant_id and q.customer_id = b.id
           and q.status::text in ('sent', 'viewed', 'accepted') and q.invoice_id is null)   as open_quotes,
       (select count(*) from public.quotes q
         where q.tenant_id = b.tenant_id and q.customer_id = b.id and q.status::text = 'draft') as draft_quotes,
       (select count(*) from public.subscriptions s
         where s.tenant_id = b.tenant_id and s.customer_id = b.id and s.status::text = 'active') as active_subscriptions,
       iv.invoices, iv.invoices_with_gst, iv.gst_charged_rupees, iv.invoices_at_zero, iv.from_zoho_import, iv.last_invoice
  from bad b
  join public.tenants t on t.id = b.tenant_id
  cross join lateral (
    select count(*)                                                   as invoices,
           count(*) filter (where coalesce(i.tax_amount, 0) > 0)      as invoices_with_gst,
           coalesce(sum(i.tax_amount), 0)                             as gst_charged_rupees,
           count(*) filter (where coalesce(i.tax_amount, 0) = 0)      as invoices_at_zero,
           count(*) filter (where i.party_from_source or i.zoho_invoice_id is not null) as from_zoho_import,
           max(i.invoice_date)                                        as last_invoice
      from public.invoices i
     where i.tenant_id = b.tenant_id and i.customer_id = b.id
       and i.document_kind = 'tax_invoice' and i.status::text <> 'void'
  ) iv
 order by t.name, b.name;

\echo
\echo '=== 3. Issued Tax Invoices frozen as Overseas with no country outside India (0 rows = clean) ==='
select t.name                                                        as company,
       i.id                                                          as invoice_id,
       i.invoice_date,
       i.customer_id,
       i.customer_name                                               as customer,
       coalesce(nullif(btrim(i.customer_country), ''), '(empty)')    as country_on_invoice,
       i.pos_state_code,
       i.taxable_value,
       i.tax_rate,
       i.tax_amount,
       (i.party_from_source or i.zoho_invoice_id is not null)        as from_zoho_import,
       count(*) over (partition by i.tenant_id)                      as invoices_in_company
  from public.invoices i
  join public.tenants t on t.id = i.tenant_id
 where i.gst_treatment = 'overseas'
   and coalesce(nullif(lower(btrim(i.customer_country)), ''), 'india') in ('india', 'in', 'ind', 'bharat')
   and i.document_kind = 'tax_invoice' and i.status::text <> 'void'
 order by t.name, i.invoice_date, i.id;

rollback;
