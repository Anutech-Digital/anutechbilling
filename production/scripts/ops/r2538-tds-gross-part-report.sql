-- R-2538 — READ-ONLY report: TDS rows whose gross is NOT the taxable value of the part the receipt paid.
-- 7 Nov 2026.
--
-- WHY: until R-2538, a bank receipt for ONE part of a sale billed in parts (half-yearly / quarterly /
-- monthly) — or a part payment of a Zoho / opening invoice — stored the WHOLE document's taxable value
-- as the TDS gross (staging, a client company: TDS-CD79F6A752 on receipt RV-A378-27-0184, part 1 of
-- Q-A378-27-0191 — gross ₹1,57,500, the part paid was ₹78,750; repaired by hand on 6 Nov). The TDS amount
-- itself was right; the gross (and a rate derived from it) was too high.
--
-- WHAT IT IS: it changes NOTHING. The whole file runs inside `begin; set transaction read only; …
-- rollback;`. No email or phone column is selected. Whether to repair any row is Pardeep's decision.
--
-- RULE (the same as public.bank_credit_tds_gross, inlined so it runs before the migration too):
--   expected gross = receipt (money + TDS) × taxable ÷ GST-inclusive total, whole rupees, never above the
--   taxable value; a receipt for the whole document gives the whole taxable.
--   Taxable and total from ONE document: the receipt's invoice when it has a taxable value, else its quote.
--   Also left out: a gross that fits its own TDS and rate (TDS ≈ gross × rate) — the customer deducted on
--   that base (e.g. 2% of the whole year from part 1), which is what 26AS shows.
--   Left out: a TDS-only receipt (net_paid ₹0 — the customer settles just the TDS part later); its gross is
--   the document it covers, not the receipt.
--
-- SECTIONS
--   0. Login check (tenants_visible must equal the number of companies).
--   1. ROWS: TDS rows whose gross differs from the expected part gross by more than ₹1, with a count per company.
--
-- WHO RUNS IT: the manager or Pardeep. Claude does not run it on staging or live.
-- HOW (same instances as production/supabase/cloudsql/{staging,live}/deploy-db-*.sh):
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   then:  \o r2538-staging.txt
--          \i scripts/ops/r2538-tds-gross-part-report.sql
--          \o
--   Local Docker (proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r2538-tds-gross-part-report.sql

begin;
set transaction read only;

\pset footer on
\pset null '·'

\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies ==='
select current_user                                                     as login,
       (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                             as tenants_visible,
       now() at time zone 'Asia/Kolkata'                                 as run_at_ist;

\echo
\echo '=== 1. TDS rows whose gross is not the part paid (difference > ₹1); rows_in_company = count per company ==='
with base as (
  select t.tenant_id, t.id as tds_id, t.customer_name, t.payment_received_date, t.section, t.rate_pct,
         t.gross_amount, t.tds_amount, t.net_paid,
         p.receipt_voucher_no, p.amount as receipt_amount,
         coalesce(p.invoice_id, t.invoice_id) as invoice_id, p.quote_id,
         /* taxable and total from ONE document: the invoice when it has a taxable value, else the quote */
         case when nullif(i.taxable_value, 0) is not null then i.taxable_value::numeric
              else coalesce(nullif(q.subtotal, 0)::numeric, round(q.amount * 100.0 / (100 + coalesce(q.tax_rate, 18)))) end as taxable,
         case when nullif(i.taxable_value, 0) is not null then coalesce(nullif(i.amount, 0), nullif(i.net_payable, 0))::numeric
              else nullif(q.amount, 0)::numeric end as total
    from public.tds_receivable t
    join public.payments p on p.id = t.payment_id and p.tenant_id = t.tenant_id
    left join public.invoices i on i.id = coalesce(p.invoice_id, t.invoice_id) and i.tenant_id = t.tenant_id
    left join public.quotes q on q.id = coalesce(p.quote_id, i.quote_id) and q.tenant_id = t.tenant_id
   where coalesce(t.net_paid, 0) > 0
), expected as (
  select b.*,
         case
           when b.taxable is null or b.taxable <= 0 then null
           when coalesce(b.total, 0) <= 0 or coalesce(b.receipt_amount, 0) >= b.total then b.taxable
           when coalesce(b.receipt_amount, 0) <= 0 then 0
           else least(b.taxable, round(b.receipt_amount * b.taxable / b.total))
         end as expected_gross
    from base b
), off as (
  select e.*
    from expected e
   where e.expected_gross is not null and abs(e.gross_amount - e.expected_gross) > 1
     /* left out: a gross that fits its own TDS and rate (the customer deducted on that base — 26AS shows it) */
     and not (coalesce(e.rate_pct, 0) > 0 and abs(round(e.gross_amount * e.rate_pct / 100) - e.tds_amount) <= 1)
)
select o.tenant_id, count(*) over (partition by o.tenant_id) as rows_in_company,
       o.tds_id, o.customer_name, o.payment_received_date, o.receipt_voucher_no,
       o.invoice_id, o.quote_id, o.receipt_amount, o.taxable as document_taxable, o.total as document_total,
       o.gross_amount as stored_gross, o.expected_gross, o.gross_amount - o.expected_gross as too_high_by,
       o.tds_amount, o.rate_pct as stored_rate,
       round(o.tds_amount * 100.0 / nullif(o.expected_gross, 0), 2) as rate_on_part,
       o.section, o.net_paid
  from off o
 order by o.tenant_id, o.payment_received_date, o.tds_id;

rollback;
