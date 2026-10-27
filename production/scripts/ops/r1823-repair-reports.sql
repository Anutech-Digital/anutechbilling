-- R-1824 — READ-ONLY reports for the data-repair decisions on R-1823 (24 Oct 2026).
--
-- WHAT IT IS: one section per R-1823 item. Each section prints a per-tenant count, then up to
-- 20 sample rows (ids, numbers, dates, amounts). No email or phone column is ever selected.
-- It changes NOTHING. The whole file runs inside `begin; set transaction read only; … rollback;`
-- so even a mistake cannot write. Whether to repair anything is Pardeep's decision (R-1823);
-- each "theek karo" gets its own repair card.
--
-- WHO RUNS IT: the manager (deploy step) or Pardeep. Claude does not run it on staging or live.
--
-- HOW (same instance names as production/supabase/cloudsql/{staging,live}/deploy-db-2026-10-07.sh):
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   LIVE:    gcloud sql connect resellersos-db         --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   then at the psql prompt:
--     \o r1823-staging.txt          (or r1823-live.txt — saves the output to a file)
--     \i scripts/ops/r1823-repair-reports.sql
--     \o
--   Local Docker (test data, proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r1823-repair-reports.sql
--   Section 0 prints whether the login sees every tenant. If tenants_visible is 0 or 1 on
--   staging/live, row security is hiding rows: reconnect as the table owner and run again.
--
-- "fix_live_at" (sections 1 and 4): when the code fix reached that database. Rows after it are
-- not affected. Default = Thursday deploy 29 Oct 2026 16:00 IST; if the deploy happened on another
-- day, edit the two literals below before running.
--
-- Times: every *_ist column is shown in IST. Night window = created 18:30–24:00 UTC
-- = 00:00–05:30 IST next day.

begin;
set transaction read only;

\pset footer on
\pset null '·'

-- ═══ 0. Who is reading ═══════════════════════════════════════════════════════════════════════
\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies ==='
select current_user                                                     as login,
       (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                             as tenants_visible,
       now() at time zone 'Asia/Kolkata'                                 as run_at_ist;

-- ═══ 1. R-1711 ══════════════════════════════════════════════════════════════════════════════
-- Cancelled with "Clear the due" (cancel_due_cleared > 0) while an invoice of that subscription
-- (own quote, renewal quote, its instalments — cancel_subscription's match) is still open.
-- Decision: credit note on the invoice, or put the due back on the subscription?
\echo
\echo '=== 1. R-1711: cancelled + due cleared, invoice still open — per tenant ==='
with params as (select timestamptz '2026-10-29 16:00:00+05:30' as fix_live_at),
hit as (
  select s.tenant_id, s.id as subscription_id, s.customer_name, s.plan, s.cancelled_at,
         s.cancel_due_cleared, s.quote_id, s.renewal_quote_id,
         i.id as invoice_id, i.status::text as invoice_status, i.invoice_date,
         coalesce(i.net_payable, i.amount, 0) as invoice_value,
         coalesce(i.paid_amount, 0) as invoice_paid,
         greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) as invoice_due
    from public.subscriptions s
    join public.invoices i
      on i.tenant_id = s.tenant_id
     and i.status::text in ('pending', 'overdue')
     and i.written_off_at is null
     and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
     and (   (s.quote_id is not null and i.quote_id = s.quote_id)
          or (s.renewal_quote_id is not null and i.quote_id = s.renewal_quote_id)
          or exists (select 1 from public.subscription_billings b
                      where b.subscription_id = s.id and b.tenant_id = s.tenant_id and b.invoice_id = i.id))
   cross join params p
   where s.status::text = 'cancelled'
     and coalesce(s.cancel_due_cleared, 0) > 0
     and (s.cancelled_at is null or s.cancelled_at < p.fix_live_at)
)
select tenant_id,
       count(distinct subscription_id) as subscriptions,
       count(distinct invoice_id)      as open_invoices,
       sum(invoice_due)                as invoice_due_total
  from hit group by tenant_id order by tenant_id;

\echo '--- 1. samples (max 20) ---'
with params as (select timestamptz '2026-10-29 16:00:00+05:30' as fix_live_at)
select s.tenant_id, s.id as subscription_id, s.customer_name, s.plan,
       s.cancelled_at at time zone 'Asia/Kolkata' as cancelled_at_ist,
       s.cancel_due_cleared,
       i.id as invoice_id, i.status::text as invoice_status, i.invoice_date,
       coalesce(i.net_payable, i.amount, 0) as invoice_value,
       coalesce(i.paid_amount, 0) as invoice_paid,
       greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) as invoice_due,
       (select coalesce(sum(cn.amount), 0) from public.credit_notes cn
         where cn.invoice_id = i.id and cn.tenant_id = i.tenant_id) as credit_noted
  from public.subscriptions s
  join public.invoices i
    on i.tenant_id = s.tenant_id
   and i.status::text in ('pending', 'overdue')
   and i.written_off_at is null
   and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
   and (   (s.quote_id is not null and i.quote_id = s.quote_id)
        or (s.renewal_quote_id is not null and i.quote_id = s.renewal_quote_id)
        or exists (select 1 from public.subscription_billings b
                    where b.subscription_id = s.id and b.tenant_id = s.tenant_id and b.invoice_id = i.id))
 cross join params p
 where s.status::text = 'cancelled'
   and coalesce(s.cancel_due_cleared, 0) > 0
   and (s.cancelled_at is null or s.cancelled_at < p.fix_live_at)
 order by s.cancelled_at desc nulls last, i.id
 limit 20;

-- ═══ 2. R-1635 ══════════════════════════════════════════════════════════════════════════════
-- Subscriptions written off BEFORE write_off_subscription existed: the subscription carries
-- written_off_at, but its invoices (same match) are still pending/overdue without the stamp, so
-- Collections / dunning still chase them. Decision: stamp them written_off_at too?
-- shared_with_live_sub = another live subscription sells through the same quote (the RPC would
-- leave that invoice open).
\echo
\echo '=== 2. R-1635: written-off subscription, invoice still open and unstamped — per tenant ==='
with hit as (
  select s.tenant_id, s.id as subscription_id, i.id as invoice_id,
         greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) as invoice_due
    from public.subscriptions s
    join public.invoices i
      on i.tenant_id = s.tenant_id
     and i.status::text in ('pending', 'overdue')
     and i.written_off_at is null
     and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
     and (   (s.quote_id is not null and i.quote_id = s.quote_id)
          or (s.renewal_quote_id is not null and i.quote_id = s.renewal_quote_id)
          or exists (select 1 from public.subscription_billings b
                      where b.subscription_id = s.id and b.tenant_id = s.tenant_id and b.invoice_id = i.id))
   where s.written_off_at is not null
)
select tenant_id,
       count(distinct subscription_id) as subscriptions,
       count(distinct invoice_id)      as open_invoices,
       sum(invoice_due)                as invoice_due_total
  from hit group by tenant_id order by tenant_id;

\echo '--- 2. samples (max 20) ---'
select s.tenant_id, s.id as subscription_id, s.customer_name, s.plan,
       s.written_off_at at time zone 'Asia/Kolkata' as sub_written_off_at_ist,
       i.id as invoice_id, i.status::text as invoice_status, i.invoice_date, i.due_date,
       coalesce(i.net_payable, i.amount, 0) as invoice_value,
       coalesce(i.paid_amount, 0) as invoice_paid,
       greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) as invoice_due,
       exists (select 1 from public.subscriptions s2
                where s2.tenant_id = s.tenant_id and s2.id <> s.id
                  and i.quote_id is not null
                  and (s2.quote_id = i.quote_id or s2.renewal_quote_id = i.quote_id)
                  and s2.written_off_at is null and s2.status::text <> 'cancelled') as shared_with_live_sub
  from public.subscriptions s
  join public.invoices i
    on i.tenant_id = s.tenant_id
   and i.status::text in ('pending', 'overdue')
   and i.written_off_at is null
   and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
   and (   (s.quote_id is not null and i.quote_id = s.quote_id)
        or (s.renewal_quote_id is not null and i.quote_id = s.renewal_quote_id)
        or exists (select 1 from public.subscription_billings b
                    where b.subscription_id = s.id and b.tenant_id = s.tenant_id and b.invoice_id = i.id))
 where s.written_off_at is not null
 order by s.written_off_at desc, i.id
 limit 20;

-- ═══ 3. R-1716 + R-1653 ═════════════════════════════════════════════════════════════════════
-- Rows created 00:00–05:30 IST (18:30–24:00 UTC) whose stored date equals the UTC day, i.e. one
-- day BEFORE the IST day they were made. On the 1st of a month that is the previous month; on
-- 1 April the previous financial year (moved_period = true).
-- CANNOT PROVE: a person may have picked yesterday's date on purpose; such a row looks the same.
-- TDS stamps (Form 16A received / in 26AS / claimed in ITR) are set by a later edit, so for them
-- the row's updated_at is used, not created_at — if the row was edited again after the stamp,
-- the stamp's real moment is lost and the row is not listed.
-- Email expenses = expenses made from inbound_purchases with no order date (that fallback used
-- the UTC day); expenses typed by hand are not listed.
\echo
\echo '=== 3. R-1716 + R-1653: night-hours rows dated one day early — per tenant and kind ==='
with night as (
  select 'quote'::text as kind, q.tenant_id, q.id as row_id, q.id as doc_no, q.created_date as stored_date,
         q.created_at as made_at, q.amount
    from public.quotes q
   where (q.created_at at time zone 'UTC')::time >= time '18:30'
     and q.created_date = (q.created_at at time zone 'UTC')::date
  union all
  select 'invoice', i.tenant_id, i.id, i.id, i.invoice_date, i.created_at, i.amount
    from public.invoices i
   where i.import_batch_id is null
     and coalesce(i.document_kind, 'tax_invoice') <> 'opening_invoice'
     and (i.created_at at time zone 'UTC')::time >= time '18:30'
     and i.invoice_date = (i.created_at at time zone 'UTC')::date
  union all
  select 'credit_note', c.tenant_id, c.id, c.id, c.credit_date, c.created_at, c.amount
    from public.credit_notes c
   where (c.created_at at time zone 'UTC')::time >= time '18:30'
     and c.credit_date = (c.created_at at time zone 'UTC')::date
  union all
  select 'debit_note', d.tenant_id, d.id, d.id, d.debit_date, d.created_at, d.amount
    from public.debit_notes d
   where (d.created_at at time zone 'UTC')::time >= time '18:30'
     and d.debit_date = (d.created_at at time zone 'UTC')::date
  union all
  select 'customer_since', cu.tenant_id, cu.id::text, cu.customer_number, cu.since, cu.created_at, null::integer
    from public.customers cu
   where (cu.created_at at time zone 'UTC')::time >= time '18:30'
     and cu.since = (cu.created_at at time zone 'UTC')::date
  union all
  select 'email_expense', e.tenant_id, e.id, e.bill_no, e.expense_date, e.created_at, e.amount
    from public.expenses e
    join public.inbound_purchases ip on ip.expense_id = e.id and ip.tenant_id = e.tenant_id
   where ip.order_date is null
     and (e.created_at at time zone 'UTC')::time >= time '18:30'
     and e.expense_date = (e.created_at at time zone 'UTC')::date
  union all
  select 'tds_form16a_received', t.tenant_id, t.id, t.invoice_id, t.form_16a_received_date, t.updated_at, t.tds_amount
    from public.tds_receivable t
   where (t.updated_at at time zone 'UTC')::time >= time '18:30'
     and t.form_16a_received_date = (t.updated_at at time zone 'UTC')::date
  union all
  select 'tds_in_26as', t.tenant_id, t.id, t.invoice_id, t.appears_in_26as_date, t.updated_at, t.tds_amount
    from public.tds_receivable t
   where (t.updated_at at time zone 'UTC')::time >= time '18:30'
     and t.appears_in_26as_date = (t.updated_at at time zone 'UTC')::date
  union all
  select 'tds_claimed_in_itr', t.tenant_id, t.id, t.invoice_id, t.claimed_in_itr_date, t.updated_at, t.tds_amount
    from public.tds_receivable t
   where (t.updated_at at time zone 'UTC')::time >= time '18:30'
     and t.claimed_in_itr_date = (t.updated_at at time zone 'UTC')::date
)
select tenant_id, kind, count(*) as rows_one_day_early,
       count(*) filter (where extract(day from stored_date + 1) = 1) as moved_period
  from night group by tenant_id, kind order by tenant_id, kind;

\echo '--- 3. samples (max 20, mixed kinds) ---'
with night as (
  select 'quote'::text as kind, q.tenant_id, q.id as row_id, q.id as doc_no, q.created_date as stored_date,
         q.created_at as made_at, q.amount
    from public.quotes q
   where (q.created_at at time zone 'UTC')::time >= time '18:30'
     and q.created_date = (q.created_at at time zone 'UTC')::date
  union all
  select 'invoice', i.tenant_id, i.id, i.id, i.invoice_date, i.created_at, i.amount
    from public.invoices i
   where i.import_batch_id is null
     and coalesce(i.document_kind, 'tax_invoice') <> 'opening_invoice'
     and (i.created_at at time zone 'UTC')::time >= time '18:30'
     and i.invoice_date = (i.created_at at time zone 'UTC')::date
  union all
  select 'credit_note', c.tenant_id, c.id, c.id, c.credit_date, c.created_at, c.amount
    from public.credit_notes c
   where (c.created_at at time zone 'UTC')::time >= time '18:30'
     and c.credit_date = (c.created_at at time zone 'UTC')::date
  union all
  select 'debit_note', d.tenant_id, d.id, d.id, d.debit_date, d.created_at, d.amount
    from public.debit_notes d
   where (d.created_at at time zone 'UTC')::time >= time '18:30'
     and d.debit_date = (d.created_at at time zone 'UTC')::date
  union all
  select 'customer_since', cu.tenant_id, cu.id::text, cu.customer_number, cu.since, cu.created_at, null::integer
    from public.customers cu
   where (cu.created_at at time zone 'UTC')::time >= time '18:30'
     and cu.since = (cu.created_at at time zone 'UTC')::date
  union all
  select 'email_expense', e.tenant_id, e.id, e.bill_no, e.expense_date, e.created_at, e.amount
    from public.expenses e
    join public.inbound_purchases ip on ip.expense_id = e.id and ip.tenant_id = e.tenant_id
   where ip.order_date is null
     and (e.created_at at time zone 'UTC')::time >= time '18:30'
     and e.expense_date = (e.created_at at time zone 'UTC')::date
  union all
  select 'tds_form16a_received', t.tenant_id, t.id, t.invoice_id, t.form_16a_received_date, t.updated_at, t.tds_amount
    from public.tds_receivable t
   where (t.updated_at at time zone 'UTC')::time >= time '18:30'
     and t.form_16a_received_date = (t.updated_at at time zone 'UTC')::date
  union all
  select 'tds_in_26as', t.tenant_id, t.id, t.invoice_id, t.appears_in_26as_date, t.updated_at, t.tds_amount
    from public.tds_receivable t
   where (t.updated_at at time zone 'UTC')::time >= time '18:30'
     and t.appears_in_26as_date = (t.updated_at at time zone 'UTC')::date
  union all
  select 'tds_claimed_in_itr', t.tenant_id, t.id, t.invoice_id, t.claimed_in_itr_date, t.updated_at, t.tds_amount
    from public.tds_receivable t
   where (t.updated_at at time zone 'UTC')::time >= time '18:30'
     and t.claimed_in_itr_date = (t.updated_at at time zone 'UTC')::date
),
ranked as (
  select n.*, row_number() over (partition by n.kind order by n.made_at desc) as rn from night n
)
select kind, tenant_id, row_id, doc_no, stored_date,
       (made_at at time zone 'Asia/Kolkata')::date as ist_day_made,
       made_at at time zone 'Asia/Kolkata'         as made_at_ist,
       amount,
       extract(day from stored_date + 1) = 1        as moved_period
  from ranked
 order by rn, kind
 limit 20;

-- ═══ 4. R-1652 ══════════════════════════════════════════════════════════════════════════════
-- Subscriptions the Google import made (vendor google, no quote, no parent): before the fix the
-- browser turned "November 27, 2026" into local midnight and stored the UTC day, so in an IST
-- browser BOTH start_date and renewal_date came out exactly one day early.
-- WHAT THIS CAN SHOW: which rows came from that import, when, and whether they were changed
-- since (renewed / edited — a +1 day repair must not touch those blindly).
-- WHAT IT CANNOT PROVE without Google's CSV (or the Reseller panel): that a given date is wrong.
-- The stored date alone does not say which browser time zone did the import, and a row edited
-- by hand afterwards may already be right. Only matching each row (domain + plan) against the
-- CSV's "Renewal date" / "Creation date" proves it. Hints shown: renewal on the last day of a
-- month (Google renews on the 1st more often than the 31st/30th) and start/renewal day-of-month
-- still equal (both shifted together = import shape).
-- Rows from the generic CSV import (import-subscriptions-dialog) are only affected when that
-- file used "Month D, YYYY" text dates; they look like hand-made rows and are not listed.
\echo
\echo '=== 4. R-1652: Google-import subscriptions made before the fix — per tenant ==='
with params as (select timestamptz '2026-10-29 16:00:00+05:30' as fix_live_at),
imp as (
  select s.*
    from public.subscriptions s cross join params p
   where s.vendor::text = 'google'
     and s.quote_id is null
     and s.parent_subscription_id is null
     and s.created_at < p.fix_live_at
)
select tenant_id,
       count(*) as imported_rows,
       count(*) filter (where vendor_synced_at is not null
                          and abs(extract(epoch from (vendor_synced_at - created_at))) < 120) as import_shape_sure,
       count(*) filter (where renewal_date = (date_trunc('month', renewal_date) + interval '1 month - 1 day')::date) as renewal_on_month_end,
       count(*) filter (where updated_at > created_at + interval '5 minutes') as changed_since_import,
       min(created_at at time zone 'Asia/Kolkata') as first_import_ist,
       max(created_at at time zone 'Asia/Kolkata') as last_import_ist
  from imp group by tenant_id order by tenant_id;

\echo '--- 4. samples (max 20) ---'
with params as (select timestamptz '2026-10-29 16:00:00+05:30' as fix_live_at)
select s.tenant_id, s.id as subscription_id, s.domain, s.plan, s.seats, s.status::text as status,
       s.start_date, s.renewal_date,
       s.renewal_date + 1 as renewal_if_one_day_early,
       s.created_at at time zone 'Asia/Kolkata' as imported_at_ist,
       (s.vendor_synced_at is not null
        and abs(extract(epoch from (s.vendor_synced_at - s.created_at))) < 120) as import_shape_sure,
       s.updated_at > s.created_at + interval '5 minutes' as changed_since_import
  from public.subscriptions s cross join params p
 where s.vendor::text = 'google'
   and s.quote_id is null
   and s.parent_subscription_id is null
   and s.created_at < p.fix_live_at
 order by s.created_at desc
 limit 20;

-- ═══ 5. R-1709 ══════════════════════════════════════════════════════════════════════════════
-- Invoices with status 'paid' and a credit note, where the money columns (paid_amount + advances
-- adjusted at issue) are below amount + debit notes — the app now shows them "Credited".
-- Old invoices were marked paid before paid_amount existed, so real money may have come in.
-- payments_on_invoice / payments_on_quote = received payments linked to it: when these cover the
-- invoice, money did come and paid_amount is the gap; when 0, "Credited" is probably right.
\echo
\echo '=== 5. R-1709: paid + credit note, money columns short — per tenant ==='
with inv as (
  select i.tenant_id, i.id, i.quote_id, i.invoice_date, i.amount,
         coalesce(i.paid_amount, 0) as paid_amount,
         coalesce((select sum(case when (a ->> 'amount') ~ '^-?[0-9]+([.][0-9]+)?$' then (a ->> 'amount')::numeric else 0 end)
                     from jsonb_array_elements(case when jsonb_typeof(i.adjusted_advances) = 'array'
                                                    then i.adjusted_advances else '[]'::jsonb end) a), 0) as advances,
         (select coalesce(sum(cn.amount), 0) from public.credit_notes cn where cn.invoice_id = i.id and cn.tenant_id = i.tenant_id) as credit_noted,
         (select coalesce(sum(dn.amount), 0) from public.debit_notes dn where dn.invoice_id = i.id and dn.tenant_id = i.tenant_id) as debit_noted
    from public.invoices i
   where i.status::text = 'paid'
)
select tenant_id, count(*) as invoices,
       count(*) filter (where paid_amount = 0) as paid_amount_zero,
       sum(amount + debit_noted - paid_amount - advances) as money_gap_total
  from inv
 where credit_noted > 0
   and paid_amount + advances < amount + debit_noted - 1
 group by tenant_id order by tenant_id;

\echo '--- 5. samples (max 20) ---'
with inv as (
  select i.tenant_id, i.id, i.quote_id, i.customer_name, i.invoice_date, i.paid_date, i.amount,
         coalesce(i.paid_amount, 0) as paid_amount,
         coalesce((select sum(case when (a ->> 'amount') ~ '^-?[0-9]+([.][0-9]+)?$' then (a ->> 'amount')::numeric else 0 end)
                     from jsonb_array_elements(case when jsonb_typeof(i.adjusted_advances) = 'array'
                                                    then i.adjusted_advances else '[]'::jsonb end) a), 0) as advances,
         (select coalesce(sum(cn.amount), 0) from public.credit_notes cn where cn.invoice_id = i.id and cn.tenant_id = i.tenant_id) as credit_noted,
         (select coalesce(sum(dn.amount), 0) from public.debit_notes dn where dn.invoice_id = i.id and dn.tenant_id = i.tenant_id) as debit_noted
    from public.invoices i
   where i.status::text = 'paid'
)
select v.tenant_id, v.id as invoice_id, v.customer_name, v.invoice_date, v.paid_date,
       v.amount, v.paid_amount, v.advances, v.credit_noted, v.debit_noted,
       (select coalesce(sum(p.amount), 0) from public.payments p
         where p.tenant_id = v.tenant_id and p.invoice_id = v.id and p.status = 'received') as payments_on_invoice,
       (select coalesce(sum(p.amount), 0) from public.payments p
         where p.tenant_id = v.tenant_id and v.quote_id is not null and p.quote_id = v.quote_id
           and p.status = 'received') as payments_on_quote
  from inv v
 where v.credit_noted > 0
   and v.paid_amount + v.advances < v.amount + v.debit_noted - 1
 order by v.invoice_date desc, v.id
 limit 20;

-- ═══ 6. R-1643 ══════════════════════════════════════════════════════════════════════════════
-- Tax invoices issued without the company's own GSTIN (invoices.seller_gstin is the snapshot at
-- issue, R-043). Opening invoices (Zoho import) and Bills of Supply are left out.
-- CANNOT SHOW: the company address at issue (not snapshotted) — company_address_now is today's.
-- Invoices older than 1 Oct 2026 got seller_gstin from a backfill with the GSTIN the company had
-- then; a GSTIN added before that backfill hides that the original copy lacked it.
\echo
\echo '=== 6. R-1643: Tax Invoices issued without company GSTIN — per tenant ==='
select i.tenant_id, count(*) as invoices, sum(i.amount) as amount_total,
       min(i.invoice_date) as first_date, max(i.invoice_date) as last_date,
       bool_or(nullif(btrim(coalesce(t.gstin, '')), '') is not null)   as company_gstin_now,
       bool_or(nullif(btrim(coalesce(t.address, '')), '') is not null) as company_address_now
  from public.invoices i
  join public.tenants t on t.id = i.tenant_id
 where coalesce(i.document_kind, 'tax_invoice') = 'tax_invoice'
   and i.status::text <> 'draft'
   and nullif(btrim(coalesce(i.seller_gstin, '')), '') is null
 group by i.tenant_id order by i.tenant_id;

\echo '--- 6. samples (max 20) ---'
select i.tenant_id, i.id as invoice_id, i.status::text as status, i.invoice_date,
       i.amount, i.taxable_value, i.tax_amount, i.customer_gstin is not null as customer_has_gstin,
       nullif(btrim(coalesce(t.gstin, '')), '') is not null   as company_gstin_now,
       nullif(btrim(coalesce(t.address, '')), '') is not null as company_address_now
  from public.invoices i
  join public.tenants t on t.id = i.tenant_id
 where coalesce(i.document_kind, 'tax_invoice') = 'tax_invoice'
   and i.status::text <> 'draft'
   and nullif(btrim(coalesce(i.seller_gstin, '')), '') is null
 order by i.invoice_date desc, i.id
 limit 20;

-- ═══ 7. R-1708 ══════════════════════════════════════════════════════════════════════════════
-- Same rule as scripts/ops/r1708-dues-drift-report.sql (that file is the full list): stored
-- subscriptions.outstanding_amount differs from quote_open_balance(quote) by ₹1 or more.
-- quote_invoiced = an invoice exists for the quote (then the invoice is the claim).
\echo
\echo '=== 7. R-1708: stored subscription balance differs from quote_open_balance — per tenant ==='
with drift as (
  select s.tenant_id, s.id, s.quote_id,
         coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id) as difference
    from public.subscriptions s
   where s.quote_id is not null
     and s.written_off_at is null
)
select tenant_id, count(*) as subscriptions,
       round(sum(difference)::numeric, 2)      as difference_total,
       round(sum(abs(difference))::numeric, 2) as abs_difference_total
  from drift where abs(difference) >= 1
 group by tenant_id order by tenant_id;

\echo '--- 7. samples (max 20, biggest difference first) ---'
select s.tenant_id,
       s.id                                                                     as subscription_id,
       s.customer_name,
       s.quote_id,
       round(coalesce(s.outstanding_amount, 0)::numeric, 2)                     as stored_outstanding,
       round(public.quote_open_balance(s.quote_id)::numeric, 2)                 as quote_open_balance,
       round((coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id))::numeric, 2) as difference,
       exists (select 1 from public.invoices i where i.quote_id = s.quote_id)    as quote_invoiced
  from public.subscriptions s
 where s.quote_id is not null
   and s.written_off_at is null
   and abs(coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id)) >= 1
 order by abs(coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id)) desc
 limit 20;

\echo
\echo '=== end — nothing was changed (rollback) ==='
rollback;
