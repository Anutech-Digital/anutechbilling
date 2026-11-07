-- R-2518 — READ-ONLY report: bank-receipt sales that merged SEVERAL Zoho invoices into ONE app invoice
-- (or carry no Zoho number although Zoho has one). 6 Nov 2026.
--
-- WHY: until R-2518, "Find in Zoho" and the bulk "Reconcile from Zoho" put the lines of every Zoho
-- invoice a payment settled on ONE app sale, with no Zoho number (staging, a client company: UPI ₹6,294 of
-- 29 Jun 2026 = INV/26-27/0516 ₹3,243 + a ₹3,051 invoice → one app invoice INV-A378-27-0490).
--
-- WHAT IT IS: it changes NOTHING. The whole file runs inside `begin; set transaction read only; …
-- rollback;`. No email or phone column is selected. Whether to repair anything is Pardeep's decision;
-- the repair (public.repair_split_merged_bank_sale, owner only, dry run by default) is never run by
-- this file.
--
-- SECTIONS
--   0. Login check (tenants_visible must equal the number of companies).
--   1. CANDIDATES (no Zoho data needed): app invoices of sales booked from a bank receipt
--      (quotes.invoice_on_receipt) with no Zoho number and 2+ lines — the lines, the bank line.
--   2. CONFIRMED by the server's stored Zoho receipts scan (zoho_fy_scan kind customerpayments,
--      R-2501): the bank line's reference is a Zoho payment's reference, and that payment settled
--      2+ Zoho invoices (merged) or exactly 1 (number missing) — while the app has the sale(s) with
--      no Zoho number.
--   3. CONFIRMED by the stored Zoho invoices scan (zoho_fy_scan kind invoices, R-2499): Zoho invoices
--      of the same customer (GSTIN, else name) within 7 days of the bank date whose totals add up to
--      the app invoice (2+ of them).
--   4. INPUT for the grouping script: per section-2 hit, the app quote's lines + Zoho's invoices with
--      their lines (from the invoices scan) as one JSON row. Save the column to a file and run
--        node scripts/ops/r2518-group-merged-sale.mjs <file.json>
--      → it prints the DRY-RUN repair call for each invoice. Pardeep reads the dry run's answer, then
--      decides; the real run (p_dry_run false) is his step.
--   Sections 2–4 return nothing on a database where the Zoho scan was never run (Settings → Zoho →
--   FY import) — then section 1 is the list to check by hand in Zoho.
--
-- WHO RUNS IT: the manager or Pardeep. Claude does not run it on staging or live.
-- HOW (same instances as production/supabase/cloudsql/{staging,live}/deploy-db-*.sh):
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   then:  \o r2518-staging.txt
--          \i scripts/ops/r2518-merged-bank-sales-report.sql
--          \o
--   Local Docker (proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r2518-merged-bank-sales-report.sql

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
\echo '=== 1. CANDIDATES: bank-receipt sale invoices, no Zoho number, 2+ lines ==='
with bank_sale as (
  select i.tenant_id, i.id as invoice_id, i.invoice_date, i.customer_name, i.amount, i.status::text as status,
         q.id as quote_id, q.line_items,
         (select t.id from public.payments p
            join public.bank_transactions t on t.tenant_id = p.tenant_id
             and (t.id = p.bank_txn_id or (t.matched_to_type = 'payment' and t.matched_to_id = p.id::text))
           where p.quote_id = q.id and p.tenant_id = q.tenant_id
           order by p.received_at limit 1) as bank_txn_id
    from public.invoices i
    join public.quotes q on q.id = i.quote_id and q.tenant_id = i.tenant_id
   where q.invoice_on_receipt
     and nullif(btrim(coalesce(i.external_number, '')), '') is null
     and i.status::text <> 'void'
     and jsonb_typeof(q.line_items) = 'array' and jsonb_array_length(q.line_items) >= 2
)
select b.tenant_id, b.invoice_id, b.invoice_date, b.customer_name, b.amount, b.status, b.quote_id,
       jsonb_array_length(b.line_items) as lines,
       (select string_agg((li->>'qty') || ' × ' || (li->>'rate') || ' ' || coalesce(li->>'name', ''), ' | ' order by ord)
          from jsonb_array_elements(b.line_items) with ordinality as x(li, ord)) as line_summary,
       t.txn_date as bank_date, t.reference as bank_reference, t.credit as bank_credit,
       exists (select 1 from public.credit_notes cn where cn.invoice_id = b.invoice_id) as has_credit_note
  from bank_sale b
  left join public.bank_transactions t on t.id = b.bank_txn_id
 order by b.tenant_id, b.invoice_date, b.invoice_id
 limit 500;

\echo
\echo '=== 2. CONFIRMED by the Zoho receipts scan: one bank line, Zoho payment for N invoices, app sale(s) with no Zoho number ==='
with zpay as (
  select s.tenant_id, s.zoho_id, s.number as zoho_payment_no, s.doc_date,
         btrim(coalesce(s.payload->>'reference', '')) as reference,
         (select array_agg(distinct btrim(l->>'invoiceNumber') order by btrim(l->>'invoiceNumber'))
            from jsonb_array_elements(coalesce(s.payload->'lines', '[]'::jsonb)) l
           where nullif(btrim(coalesce(l->>'invoiceNumber', '')), '') is not null) as zoho_invoices,
         (select string_agg(btrim(l->>'invoiceNumber') || ' ₹' || coalesce(l->>'settle', '?'), ', ')
            from jsonb_array_elements(coalesce(s.payload->'lines', '[]'::jsonb)) l) as zoho_settles
    from public.zoho_fy_scan s
   where s.kind = 'customerpayments' and s.payload is not null
), line_sales as (
  select t.tenant_id, t.id as bank_txn_id, t.txn_date, t.reference, t.credit,
         array_agg(distinct i.id order by i.id) as app_invoices,
         bool_and(nullif(btrim(coalesce(i.external_number, '')), '') is null) as none_has_zoho_no
    from public.bank_transactions t
    join public.payments p on p.tenant_id = t.tenant_id
     and (p.bank_txn_id = t.id or (t.matched_to_type = 'payment' and t.matched_to_id = p.id::text))
    join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id and q.invoice_on_receipt
    join public.invoices i on i.id = q.invoice_id and i.tenant_id = q.tenant_id and i.status::text <> 'void'
                         and not exists (select 1 from public.credit_notes cn where cn.invoice_id = i.id)   -- taken back already
   where nullif(btrim(coalesce(t.reference, '')), '') is not null
   group by t.tenant_id, t.id, t.txn_date, t.reference, t.credit
)
select ls.tenant_id, ls.txn_date as bank_date, ls.reference as bank_reference, ls.credit as bank_credit,
       ls.app_invoices, z.zoho_payment_no, z.zoho_invoices, z.zoho_settles,
       case when cardinality(z.zoho_invoices) > cardinality(ls.app_invoices) then 'MERGED — split per Zoho invoice'
            else 'Zoho number missing' end as finding
  from line_sales ls
  join zpay z on z.tenant_id = ls.tenant_id and upper(z.reference) = upper(btrim(ls.reference))
 where ls.none_has_zoho_no and coalesce(cardinality(z.zoho_invoices), 0) >= 1
 order by ls.tenant_id, ls.txn_date
 limit 500;

\echo
\echo '=== 3. CONFIRMED by the Zoho invoices scan: 2+ Zoho invoices of the customer (±7 days) add up to one app invoice ==='
with bank_sale as (
  select i.tenant_id, i.id as invoice_id, i.invoice_date, i.amount, c.gstin, c.name as customer_name
    from public.invoices i
    join public.quotes q on q.id = i.quote_id and q.tenant_id = i.tenant_id
    join public.customers c on c.id = i.customer_id and c.tenant_id = i.tenant_id
   where q.invoice_on_receipt
     and nullif(btrim(coalesce(i.external_number, '')), '') is null
     and i.status::text <> 'void'
     and not exists (select 1 from public.credit_notes cn where cn.invoice_id = i.id)
), zinv as (
  select s.tenant_id, s.number, s.doc_date, (s.payload->>'amount')::numeric as amount,
         upper(btrim(coalesce(s.payload->>'gstin', ''))) as gstin,
         lower(regexp_replace(coalesce(s.payload->>'customerName', ''), '[^a-zA-Z0-9]+', '', 'g')) as name_key
    from public.zoho_fy_scan s
   where s.kind = 'invoices' and s.payload is not null and lower(coalesce(s.zoho_status, '')) not in ('void', 'draft')
)
select b.tenant_id, b.invoice_id, b.invoice_date, b.customer_name, b.amount as app_amount,
       array_agg(z.number order by z.number) as zoho_invoices, sum(z.amount) as zoho_total
  from bank_sale b
  join zinv z on z.tenant_id = b.tenant_id
   and abs(z.doc_date - b.invoice_date) <= 7
   and z.amount <= b.amount
   and ((b.gstin is not null and z.gstin = upper(btrim(b.gstin)))
        or (coalesce(b.gstin, '') = '' and z.name_key = lower(regexp_replace(b.customer_name, '[^a-zA-Z0-9]+', '', 'g'))))
 group by b.tenant_id, b.invoice_id, b.invoice_date, b.customer_name, b.amount
having count(*) >= 2 and abs(sum(z.amount) - b.amount) <= 1
 order by b.tenant_id, b.invoice_date
 limit 500;

\echo
\echo '=== 4. INPUT for scripts/ops/r2518-group-merged-sale.mjs (one JSON per merged invoice from section 2) ==='
with zpay as (
  select s.tenant_id, btrim(coalesce(s.payload->>'reference', '')) as reference,
         (select array_agg(distinct btrim(l->>'invoiceNumber'))
            from jsonb_array_elements(coalesce(s.payload->'lines', '[]'::jsonb)) l
           where nullif(btrim(coalesce(l->>'invoiceNumber', '')), '') is not null) as zoho_invoices
    from public.zoho_fy_scan s
   where s.kind = 'customerpayments' and s.payload is not null
), merged as (
  select distinct on (i.id) i.tenant_id, i.id as invoice_id, q.line_items, z.zoho_invoices
    from public.bank_transactions t
    join public.payments p on p.tenant_id = t.tenant_id
     and (p.bank_txn_id = t.id or (t.matched_to_type = 'payment' and t.matched_to_id = p.id::text))
    join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id and q.invoice_on_receipt
    join public.invoices i on i.id = q.invoice_id and i.tenant_id = q.tenant_id and i.status::text <> 'void'
                         and not exists (select 1 from public.credit_notes cn where cn.invoice_id = i.id)   -- taken back already
    join zpay z on z.tenant_id = t.tenant_id and upper(z.reference) = upper(btrim(t.reference))
   where nullif(btrim(coalesce(i.external_number, '')), '') is null
     and cardinality(z.zoho_invoices) >= 2
)
select jsonb_build_object(
         'invoice_id', m.invoice_id,
         'quote_lines', m.line_items,
         'zoho_invoices', coalesce((
           select jsonb_agg(jsonb_build_object('number', s.number, 'lines', coalesce(s.payload->'lines', '[]'::jsonb)) order by s.number)
             from public.zoho_fy_scan s
            where s.tenant_id = m.tenant_id and s.kind = 'invoices' and s.number = any(m.zoho_invoices)), '[]'::jsonb),
         'zoho_numbers', to_jsonb(m.zoho_invoices)) as grouping_input
  from merged m
 order by m.tenant_id, m.invoice_id
 limit 200;

rollback;
