-- deploy-peek: coalesce(obj_description(to_regclass('public.app_rule_dates'), 'pg_class') like '%R-2727 invoice period rule%', false)
-- deploy-key: r2727invoiceperiodrulefrom
-- 20261113181025_r2727_invoice_period_rule_from.sql
--
-- R-2727 review (MED, 13 Nov 2026): the renewal-period rule for INVOICE PDFs changed with this card
-- (the renewed term starts ON the renewal date for an app-made subscription — billing's
-- followingTermStart — instead of the day after). An issued invoice's PDF must never re-print a
-- different period, and invoices store no period, so the new rule may apply only to invoices made
-- AFTER the code that uses it is live on THAT environment. A hard-coded date cannot say that
-- (staging and live deploy on different days): an invoice dated after the constant but issued by
-- the old code would re-print one day earlier after the deploy.
--
-- public.app_rule_dates: one row per rule, from_at = the moment this file ran on this database
-- (= the deploy that brought the new code — the DB step and the code deploy are one train).
-- lib/quotes/service-period.ts invoicePeriodSubscription applies the new rule only to an invoice
-- whose created_at >= from_at; no row (file not applied yet) or an older invoice → exactly the old
-- rule. Read-only for the app (select for signed-in users; no write policy for them — a rule date
-- is set by a migration, never from the app; service_role gets the zzz_service_role_all policy so
-- the server PDF route can read it on Cloud SQL). Not tenant data: one date per database.
-- Test: supabase/tests/r2727_app_rule_dates.test.sql (rolled back).

begin;

create table if not exists public.app_rule_dates (
  key      text primary key,
  from_at  timestamptz not null default now(),
  note     text
);
comment on table public.app_rule_dates is
  'R-2727 invoice period rule: the moment a rule change went live on THIS database (from_at), one row per rule key. Set by migrations only.';

alter table public.app_rule_dates enable row level security;
drop policy if exists app_rule_dates_select_signed_in on public.app_rule_dates;
drop policy if exists zzz_service_role_all on public.app_rule_dates;
create policy app_rule_dates_select_signed_in on public.app_rule_dates
  for select to authenticated using (true);
/* R-2727 re-review (MED): Cloud SQL's service_role has no BYPASSRLS — without this policy the
   invoice PDF route (admin client) reads 0 rows and keeps the old rule forever while the invoice
   screen shows the new one. Same pattern as R-2322. */
create policy zzz_service_role_all on public.app_rule_dates as permissive for all to service_role
  using (true) with check (true);
revoke all on table public.app_rule_dates from public, anon, authenticated;
grant select on table public.app_rule_dates to authenticated;
grant all on table public.app_rule_dates to service_role;

insert into public.app_rule_dates (key, from_at, note)
values ('r2727_invoice_period_rule', now(),
        'Invoices created from this moment print a renewal period that starts ON the renewal date for an app-made subscription (billing followingTermStart); earlier invoices keep the day-after rule.')
on conflict (key) do nothing;

commit;
