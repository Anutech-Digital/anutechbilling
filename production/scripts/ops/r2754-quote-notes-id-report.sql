-- R-2754 — READ-ONLY report: quotes whose stored notes carry an internal subscription id (a UUID)
-- in the CUSTOMER part of the field. 14 Nov 2026.
--
-- WHY: renewal / extension / domain-renewal quotes are written by the app with a system sentence such
-- as "Renewal quote (operator-generated) for subscription <uuid>". Every customer surface (accept page,
-- QuotePDF for email / WhatsApp / download, preview) already replaces it with a plain line at render
-- time (lib/quotes/customer-notes.ts, R-813 / R-817), and from R-2754 the quote editor no longer shows
-- it in "Notes for customer". The STORED text is not rewritten — renewals/open-renewal-quotes.ts reads
-- "subscription <id>" from it to find a subscription's open quote. Rewriting stored notes would be a data
-- repair (Pardeep's call); this report only counts them.
--
-- WHAT IT IS: it changes NOTHING. The whole file runs inside `begin; set transaction read only; … rollback;`.
-- No email, phone or note text is selected — only counts and quote numbers.
--
-- "customer part" = the notes before the line "Staff only (not shown to the customer):" (the whole field
-- when there is no such line).
--
-- SECTIONS
--   0. Login check (tenants_visible must equal the number of companies).
--   1. COUNT per company and status (sent / viewed / accepted / … vs draft), and how many of them are
--      renewal / extension quotes.
--   2. ROWS: the 50 newest non-draft quotes with an id in the customer part (quote number, status, kind).
--
-- WHO RUNS IT: the manager or Pardeep on staging/live. Claude does not run it there.
--   Local Docker (proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r2754-quote-notes-id-report.sql

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
\echo '=== 1. Quotes with a subscription id in the customer part of notes, per company and status ==='
with q as (
  select qu.id, qu.tenant_id, qu.status::text as status, qu.created_at,
         coalesce(qu.is_renewal, false) as is_renewal,
         coalesce(qu.is_extension, false) as is_extension,
         split_part(qu.notes, 'Staff only (not shown to the customer):', 1) as customer_part
    from public.quotes qu
   where qu.notes is not null
)
select t.name                                       as company,
       q.status,
       count(*)                                     as quotes_with_id,
       count(*) filter (where q.is_renewal)         as renewal,
       count(*) filter (where q.is_extension)       as extension
  from q
  join public.tenants t on t.id = q.tenant_id
 where q.customer_part ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
 group by t.name, q.status
 order by t.name, q.status;

\echo
\echo '=== 2. Newest 50 non-draft quotes with an id in the customer part (no note text shown) ==='
with q as (
  select qu.id, qu.tenant_id, qu.status::text as status, qu.created_at,
         coalesce(qu.is_renewal, false) as is_renewal,
         coalesce(qu.is_extension, false) as is_extension,
         split_part(qu.notes, 'Staff only (not shown to the customer):', 1) as customer_part
    from public.quotes qu
   where qu.notes is not null
)
select t.name as company, q.id as quote, q.status,
       case when q.is_extension then 'extension' when q.is_renewal then 'renewal' else 'other' end as kind,
       (q.created_at at time zone 'Asia/Kolkata')::date as created_ist
  from q
  join public.tenants t on t.id = q.tenant_id
 where q.status <> 'draft'
   and q.customer_part ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
 order by q.created_at desc
 limit 50;

rollback;
