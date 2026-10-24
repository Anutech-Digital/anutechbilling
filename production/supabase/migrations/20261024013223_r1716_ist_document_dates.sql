-- deploy-peek: exists(select 1 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = to_regclass('public.quotes') and a.attname = 'created_date' and pg_get_expr(d.adbin, d.adrelid) like '%Asia/Kolkata%')
-- deploy-key: r1716istdocdates
-- 20261024013223_r1716_ist_document_dates.sql
--
-- R-1716 (billing audit, 20 Oct 2026): a quote, invoice, credit note or debit note saved
-- between 00:00 and 05:30 IST got YESTERDAY's date. Their date columns default to
-- CURRENT_DATE, which is the day in the session time zone — UTC on Cloud SQL. 00:00 IST
-- 21 Oct is 18:30 UTC 20 Oct, so T-A1's quote read 20 Oct, "Customer since 20 Oct", and the
-- dues Age "-1d".
--
-- The fix is the default only: the IST calendar day, the same expression public.ist_today()
-- returns (20260930172000), written inline so the column does not depend on that function.
-- Rows already saved are NOT changed (any repair is a decision for the owner — see the card).
-- Explicit values written by the app (istToday() on the client) are untouched.

alter table public.quotes       alter column created_date set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.invoices     alter column invoice_date set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.credit_notes alter column credit_date  set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.debit_notes  alter column debit_date   set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.customers    alter column since        set default ((now() at time zone 'Asia/Kolkata')::date);
