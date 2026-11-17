-- R-2895 — READ-ONLY report: part proformas that still say "Advance payment for …" (R-2865 changed the wording
-- of NEW ones to "Payment for …"). Shows which ones a later repair (scripts/ops/r2895-relabel-repair.sql) would
-- relabel and which it would NOT touch, and why. Changes nothing: the whole run is one read-only transaction
-- that ends with rollback. It needs no migration — it reads the tables only (same rule as the repair's plan,
-- supabase/migrations/20261117050700_r2895_relabel_old_part_proformas.sql, function r2895_plan).
--
-- Run on staging with C:/Users/mso50/Anutech-HQ/drafts/r2895/read-r2895-report.ps1 (tunnel + password typed by you).
-- Local Docker:
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r2895-relabel-report.sql
--
-- BUCKETS (first that applies):
--   change                    WILL CHANGE   — unpaid, not invoiced, not cancelled, open (sent / viewed / accepted)
--   paid                      will NOT      — part-paid or paid
--   invoiced                  will NOT      — its tax invoice exists
--   cancelled                 will NOT      — cancelled proforma
--   closed                    will NOT      — draft / rejected / expired
--   label_shape_unrecognised  will NOT      — says "Advance payment for …" but is not month N / part N / Qn / Hn (read it yourself)
--   not_a_part_request        will NOT      — a quote that is no part request but has that text in a line
-- The full list goes to /tmp/r2895-report.csv inside the container (the .ps1 copies it out for you).

\set ON_ERROR_STOP on
\pset footer on
\pset null '·'

begin;
set transaction read only;

\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies; bypasses_row_security should be t ==='
select current_user as login,
       (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants) as tenants_visible,
       now() at time zone 'Asia/Kolkata' as run_at_ist;

\echo
\echo '=== 1. How many, per bucket (change = WILL be relabelled by the repair; every other bucket is left exactly as it is) ==='
with c as (
  select q.id, q.tenant_id, q.customer_name, q.amount, q.status::text as status, q.payment_status::text as pay,
         q.line_items, q.notes,
         (q.subscription_billing_id is not null or q.cancelled_part_billing_id is not null) as is_part,
         (q.cancelled_at is not null or q.cancelled_part_billing_id is not null) as cancelled,
         (q.invoice_id is not null or q.payment_status::text = 'invoiced'
          or exists (select 1 from public.subscription_billings b where b.id = q.subscription_billing_id and b.invoice_id is not null)) as invoiced,
         (q.payment_status::text in ('partial', 'received')
          or exists (select 1 from public.payments p where p.quote_id = q.id and p.status::text = 'received' and p.amount > 0)) as paid,
         exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) l
                  where (l ->> 'name') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)'
                     or (l ->> 'description') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)') as shape_line,
         coalesce(q.notes ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)', false) as notes_lead
    from public.quotes q
   where q.line_items::text like '%Advance payment for%' or q.notes like 'Advance payment for%'
), v as (
  select c.*,
         case
           when not c.is_part then 'not_a_part_request'
           when c.cancelled then 'cancelled'
           when c.invoiced then 'invoiced'
           when c.paid then 'paid'
           when c.status not in ('sent', 'viewed', 'accepted') or c.pay not in ('none', 'awaiting') then 'closed'
           when not c.shape_line and not c.notes_lead then 'label_shape_unrecognised'
           else 'change'
         end as verdict,
         coalesce((select case when (l ->> 'name') like 'Advance payment for%' then l ->> 'name' else l ->> 'description' end
                     from jsonb_array_elements(case when jsonb_typeof(c.line_items) = 'array' then c.line_items else '[]'::jsonb end) with ordinality e(l, i)
                    where (l ->> 'name') like 'Advance payment for%' or (l ->> 'description') like 'Advance payment for%'
                    order by i limit 1), left(c.notes, 80)) as old_text
    from c
)
select verdict as bucket,
       case verdict
         when 'change' then 'WILL CHANGE — unpaid, not invoiced, not cancelled, open'
         when 'paid' then 'will NOT change — part-paid or paid'
         when 'invoiced' then 'will NOT change — tax invoice exists'
         when 'cancelled' then 'will NOT change — cancelled proforma'
         when 'closed' then 'will NOT change — draft / rejected / expired'
         when 'label_shape_unrecognised' then 'will NOT change — not the label shape (month N / part N / Qn / Hn)'
         else 'will NOT change — not a part request' end as meaning,
       count(*) as proformas,
       count(*) filter (where notes_lead) as notes_also_start_with_old_label
  from v group by verdict
 order by (verdict = 'change') desc, verdict;

\echo
\echo '=== 2. Per company: will change / will not change ==='
with c as (
  select q.id, q.tenant_id, q.customer_name, q.amount, q.status::text as status, q.payment_status::text as pay,
         q.line_items, q.notes,
         (q.subscription_billing_id is not null or q.cancelled_part_billing_id is not null) as is_part,
         (q.cancelled_at is not null or q.cancelled_part_billing_id is not null) as cancelled,
         (q.invoice_id is not null or q.payment_status::text = 'invoiced'
          or exists (select 1 from public.subscription_billings b where b.id = q.subscription_billing_id and b.invoice_id is not null)) as invoiced,
         (q.payment_status::text in ('partial', 'received')
          or exists (select 1 from public.payments p where p.quote_id = q.id and p.status::text = 'received' and p.amount > 0)) as paid,
         exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) l
                  where (l ->> 'name') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)'
                     or (l ->> 'description') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)') as shape_line,
         coalesce(q.notes ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)', false) as notes_lead
    from public.quotes q
   where q.line_items::text like '%Advance payment for%' or q.notes like 'Advance payment for%'
), v as (
  select c.*,
         case
           when not c.is_part then 'not_a_part_request'
           when c.cancelled then 'cancelled'
           when c.invoiced then 'invoiced'
           when c.paid then 'paid'
           when c.status not in ('sent', 'viewed', 'accepted') or c.pay not in ('none', 'awaiting') then 'closed'
           when not c.shape_line and not c.notes_lead then 'label_shape_unrecognised'
           else 'change'
         end as verdict,
         coalesce((select case when (l ->> 'name') like 'Advance payment for%' then l ->> 'name' else l ->> 'description' end
                     from jsonb_array_elements(case when jsonb_typeof(c.line_items) = 'array' then c.line_items else '[]'::jsonb end) with ordinality e(l, i)
                    where (l ->> 'name') like 'Advance payment for%' or (l ->> 'description') like 'Advance payment for%'
                    order by i limit 1), left(c.notes, 80)) as old_text
    from c
)
select t.name as company,
       count(*) filter (where v.verdict = 'change') as will_change,
       count(*) filter (where v.verdict <> 'change') as will_not_change
  from v join public.tenants t on t.id = v.tenant_id
 group by t.name order by will_change desc, t.name;

\echo
\echo '=== 3. The ones that WILL change (old text -> new text; amounts, GST, periods, links, numbers stay) ==='
with c as (
  select q.id, q.tenant_id, q.customer_name, q.amount, q.status::text as status, q.payment_status::text as pay,
         q.line_items, q.notes,
         (q.subscription_billing_id is not null or q.cancelled_part_billing_id is not null) as is_part,
         (q.cancelled_at is not null or q.cancelled_part_billing_id is not null) as cancelled,
         (q.invoice_id is not null or q.payment_status::text = 'invoiced'
          or exists (select 1 from public.subscription_billings b where b.id = q.subscription_billing_id and b.invoice_id is not null)) as invoiced,
         (q.payment_status::text in ('partial', 'received')
          or exists (select 1 from public.payments p where p.quote_id = q.id and p.status::text = 'received' and p.amount > 0)) as paid,
         exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) l
                  where (l ->> 'name') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)'
                     or (l ->> 'description') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)') as shape_line,
         coalesce(q.notes ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)', false) as notes_lead
    from public.quotes q
   where q.line_items::text like '%Advance payment for%' or q.notes like 'Advance payment for%'
), v as (
  select c.*,
         case
           when not c.is_part then 'not_a_part_request'
           when c.cancelled then 'cancelled'
           when c.invoiced then 'invoiced'
           when c.paid then 'paid'
           when c.status not in ('sent', 'viewed', 'accepted') or c.pay not in ('none', 'awaiting') then 'closed'
           when not c.shape_line and not c.notes_lead then 'label_shape_unrecognised'
           else 'change'
         end as verdict,
         coalesce((select case when (l ->> 'name') like 'Advance payment for%' then l ->> 'name' else l ->> 'description' end
                     from jsonb_array_elements(case when jsonb_typeof(c.line_items) = 'array' then c.line_items else '[]'::jsonb end) with ordinality e(l, i)
                    where (l ->> 'name') like 'Advance payment for%' or (l ->> 'description') like 'Advance payment for%'
                    order by i limit 1), left(c.notes, 80)) as old_text
    from c
)
select t.name as company, v.id as quote_no, v.customer_name as customer, v.status, v.pay as payment_state,
       v.amount as amount_rs, v.old_text, regexp_replace(v.old_text, '^Advance payment for ', 'Payment for ') as new_text, v.notes_lead as notes_also
  from v join public.tenants t on t.id = v.tenant_id
 where v.verdict = 'change' order by t.name, v.id;

\echo
\echo '=== 4. The ones that will NOT change (and why) ==='
with c as (
  select q.id, q.tenant_id, q.customer_name, q.amount, q.status::text as status, q.payment_status::text as pay,
         q.line_items, q.notes,
         (q.subscription_billing_id is not null or q.cancelled_part_billing_id is not null) as is_part,
         (q.cancelled_at is not null or q.cancelled_part_billing_id is not null) as cancelled,
         (q.invoice_id is not null or q.payment_status::text = 'invoiced'
          or exists (select 1 from public.subscription_billings b where b.id = q.subscription_billing_id and b.invoice_id is not null)) as invoiced,
         (q.payment_status::text in ('partial', 'received')
          or exists (select 1 from public.payments p where p.quote_id = q.id and p.status::text = 'received' and p.amount > 0)) as paid,
         exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) l
                  where (l ->> 'name') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)'
                     or (l ->> 'description') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)') as shape_line,
         coalesce(q.notes ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)', false) as notes_lead
    from public.quotes q
   where q.line_items::text like '%Advance payment for%' or q.notes like 'Advance payment for%'
), v as (
  select c.*,
         case
           when not c.is_part then 'not_a_part_request'
           when c.cancelled then 'cancelled'
           when c.invoiced then 'invoiced'
           when c.paid then 'paid'
           when c.status not in ('sent', 'viewed', 'accepted') or c.pay not in ('none', 'awaiting') then 'closed'
           when not c.shape_line and not c.notes_lead then 'label_shape_unrecognised'
           else 'change'
         end as verdict,
         coalesce((select case when (l ->> 'name') like 'Advance payment for%' then l ->> 'name' else l ->> 'description' end
                     from jsonb_array_elements(case when jsonb_typeof(c.line_items) = 'array' then c.line_items else '[]'::jsonb end) with ordinality e(l, i)
                    where (l ->> 'name') like 'Advance payment for%' or (l ->> 'description') like 'Advance payment for%'
                    order by i limit 1), left(c.notes, 80)) as old_text
    from c
)
select t.name as company, v.id as quote_no, v.customer_name as customer, v.status, v.pay as payment_state,
       case when v.invoiced then 'yes' else 'no' end as invoiced,
       case when v.cancelled then 'yes' else 'no' end as cancelled, v.verdict as why, left(v.old_text, 70) as old_text
  from v join public.tenants t on t.id = v.tenant_id
 where v.verdict <> 'change' order by v.verdict, t.name, v.id;

-- Full list as CSV for the file
\o /tmp/r2895-report.csv
\pset format csv
with c as (
  select q.id, q.tenant_id, q.customer_name, q.amount, q.status::text as status, q.payment_status::text as pay,
         q.line_items, q.notes,
         (q.subscription_billing_id is not null or q.cancelled_part_billing_id is not null) as is_part,
         (q.cancelled_at is not null or q.cancelled_part_billing_id is not null) as cancelled,
         (q.invoice_id is not null or q.payment_status::text = 'invoiced'
          or exists (select 1 from public.subscription_billings b where b.id = q.subscription_billing_id and b.invoice_id is not null)) as invoiced,
         (q.payment_status::text in ('partial', 'received')
          or exists (select 1 from public.payments p where p.quote_id = q.id and p.status::text = 'received' and p.amount > 0)) as paid,
         exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) l
                  where (l ->> 'name') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)'
                     or (l ->> 'description') ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)') as shape_line,
         coalesce(q.notes ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)', false) as notes_lead
    from public.quotes q
   where q.line_items::text like '%Advance payment for%' or q.notes like 'Advance payment for%'
), v as (
  select c.*,
         case
           when not c.is_part then 'not_a_part_request'
           when c.cancelled then 'cancelled'
           when c.invoiced then 'invoiced'
           when c.paid then 'paid'
           when c.status not in ('sent', 'viewed', 'accepted') or c.pay not in ('none', 'awaiting') then 'closed'
           when not c.shape_line and not c.notes_lead then 'label_shape_unrecognised'
           else 'change'
         end as verdict,
         coalesce((select case when (l ->> 'name') like 'Advance payment for%' then l ->> 'name' else l ->> 'description' end
                     from jsonb_array_elements(case when jsonb_typeof(c.line_items) = 'array' then c.line_items else '[]'::jsonb end) with ordinality e(l, i)
                    where (l ->> 'name') like 'Advance payment for%' or (l ->> 'description') like 'Advance payment for%'
                    order by i limit 1), left(c.notes, 80)) as old_text
    from c
)
select t.name as company, v.id as quote_no, v.customer_name as customer, v.status, v.pay as payment_state,
       case when v.invoiced then 'yes' else 'no' end as invoiced, case when v.cancelled then 'yes' else 'no' end as cancelled,
       v.verdict, v.amount as amount_rs, v.old_text, regexp_replace(v.old_text, '^Advance payment for ', 'Payment for ') as new_text, v.notes_lead as notes_also
  from v join public.tenants t on t.id = v.tenant_id
 order by (v.verdict = 'change') desc, v.verdict, t.name, v.id;
\o
\pset format aligned

rollback;
