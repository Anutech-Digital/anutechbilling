-- R-2693 — READ-ONLY report: every scanned Zoho FY 2025-26 customer payment that is NOT in
-- zoho_fy_receipts, with the reason the import leaves it out (12 Nov 2026: 482 such payments on
-- staging, only 4 with a stored reason).
--
-- WHAT IT IS: section 1 = count per reason; section 2 = every payment (number, date, customer,
-- money — a foreign-currency one in its own currency — deposit account, reason). Same order of
-- checks as the import (receipts-import/plan.ts buildReceiptsPlan + SQL import_zoho_fy_receipts).
-- Two reasons the database cannot know and the report says so instead of guessing:
--   * the owner's "Leave these out" / account choice lives in the dialog, not the database —
--     the deposit account is shown so they can be read off (e.g. Kachha Khata, Petty Cash);
--   * "more than due" depends on the order the payments are booked — shown as "would be checked
--     against the due at import" with the invoice's due today.
-- It changes NOTHING: the file runs inside `begin; set transaction read only; … rollback;`.
--
-- WHO RUNS IT: the manager / Pardeep, AFTER the scan details are complete (R-2653: "Read from
-- Zoho" — start, not restart — reads the 2,329 missing details). Claude does not run it on staging.
-- Before that, section 0 shows how many payments still have no detail (reason "Not read from Zoho
-- yet"), so a half-read scan is never mistaken for 2,000 missing invoices.
--
-- HOW (psql, same instance as the deploy-db scripts):
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   then:   \set tenant_id '<the company id>'
--           \o r2693-staging.txt
--           \i scripts/ops/r2693-receipts-not-imported.sql
--           \o
--   Local Docker (proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 -v tenant_id=<id> < scripts/ops/r2693-receipts-not-imported.sql

begin;
set transaction read only;

-- 0. Is the scan complete?
select count(*)                                  as scanned,
       count(*) filter (where s.payload is null) as no_detail_yet
  from public.zoho_fy_scan s
 where s.tenant_id = :'tenant_id'::uuid and s.kind = 'customerpayments' and s.fy = '2025-26';

-- 1. Every payment left out, with its reason; reason_count = how many share that kind of reason
--    (amounts / numbers taken out, as the screen groups them). Biggest reason first, then oldest.
with t as (
  select :'tenant_id'::uuid as tenant_id,
         public.books_start_for(:'tenant_id'::uuid) as books_start,
         (select books_locked_until from public.tenants where id = :'tenant_id'::uuid) as locked_until
), scan as (
  select s.zoho_id, s.number, s.doc_date, s.payload p
    from public.zoho_fy_scan s, t
   where s.tenant_id = t.tenant_id and s.kind = 'customerpayments' and s.fy = '2025-26'
     and not exists (select 1 from public.zoho_fy_receipts r where r.tenant_id = t.tenant_id and r.zoho_payment_id = s.zoho_id)
), line_check as (
  -- the first line whose invoice is not an imported FY sale here (the import skips the whole payment)
  select sc.zoho_id,
         (select l->>'invoiceNumber'
            from jsonb_array_elements(case when jsonb_typeof(sc.p->'lines') = 'array' then sc.p->'lines' else '[]'::jsonb end) l
           where not exists (select 1 from public.invoices i, t where i.tenant_id = t.tenant_id and i.zoho_invoice_id = l->>'zohoInvoiceId')
           limit 1) as missing_invoice,
         (select count(distinct i.customer_id)
            from jsonb_array_elements(case when jsonb_typeof(sc.p->'lines') = 'array' then sc.p->'lines' else '[]'::jsonb end) l
            join public.invoices i on i.zoho_invoice_id = l->>'zohoInvoiceId'
            join t on i.tenant_id = t.tenant_id) as customers
    from scan sc
), last_refusal as (
  -- the newest reason the SQL import stored for it (a batch's skipped list), if any
  select distinct on (x->>'zoho_payment_id') x->>'zoho_payment_id' as zoho_id, x->>'reason' as reason
    from public.zoho_fy_import_batches b, t, jsonb_array_elements(b.skipped) x
   where b.tenant_id = t.tenant_id and b.kind = 'customerpayments' and b.fy = '2025-26' and b.removed_at is null
   order by x->>'zoho_payment_id', b.created_at desc
), left_rows as (
select sc.number,
       sc.doc_date,
       sc.p->>'customerName'                                          as customer,
       coalesce(sc.p->>'currency', substring(sc.p->'problems'->>0 from '^Received in ([A-Z]{3}) in Zoho'), 'INR') as currency,
       case when coalesce(sc.p->>'currency', 'INR') = 'INR' and coalesce(sc.p->'problems'->>0, '') !~ '^Received in [A-Z]{3} in Zoho'
            then (sc.p->>'amount')::numeric end                       as inr,
       coalesce((sc.p->>'foreignAmount')::numeric,
                case when sc.p->'problems'->>0 ~ '^Received in [A-Z]{3} in Zoho' then (sc.p->>'amount')::numeric end) as foreign_amount,
       sc.p->>'depositAccountName'                                    as zoho_account,
       case
         when sc.p is null then 'Not read from Zoho yet (no detail) — Read from Zoho first.'
         when jsonb_typeof(sc.p->'problems') = 'array' and jsonb_array_length(sc.p->'problems') > 0 then sc.p->'problems'->>0
         when sc.doc_date is null or sc.doc_date < date '2025-04-01' or sc.doc_date > date '2026-03-31' then 'Outside the year.'
         when t.books_start is null then 'The books start date is not set.'
         when sc.doc_date < t.books_start then 'Before the books start.'
         when t.locked_until is not null and sc.doc_date <= t.locked_until then 'Inside the books lock.'
         when jsonb_typeof(sc.p->'lines') <> 'array' or jsonb_array_length(sc.p->'lines') = 0 then 'Not applied to any invoice in Zoho (an advance).'
         when lc.missing_invoice is not null then lc.missing_invoice || ' is not an FY sale imported from Zoho here (or an opening invoice).'
         when lc.customers > 1 then 'Its invoices belong to different customers here.'
         when lr.reason is not null then 'Refused by the import: ' || lr.reason
         else 'No rule leaves it out — check the deposit account choice (Leave these out?) or the invoice''s due; Check first will say.'
       end                                                           as reason
  from scan sc
  cross join t
  join line_check lc on lc.zoho_id = sc.zoho_id
  left join last_refusal lr on lr.zoho_id = sc.zoho_id
), kinds as (
  select lr2.*, regexp_replace(lr2.reason, '₹[\d,.]+|INV\S*|"[^"]*"|\d{1,2} \w{3} \d{4}', '…', 'g') as reason_kind
    from left_rows lr2
)
select count(*) over (partition by reason_kind) as reason_count, reason_kind,
       number, doc_date, customer, currency, inr, foreign_amount, zoho_account, reason
  from kinds
 order by reason_count desc, reason_kind, doc_date, number;

rollback;
