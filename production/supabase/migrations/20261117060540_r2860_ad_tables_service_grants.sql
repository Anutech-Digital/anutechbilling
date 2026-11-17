-- deploy-peek: has_table_privilege('service_role', 'public.ad_spend_daily', 'INSERT') and has_table_privilege('service_role', 'public.ad_sync_runs', 'INSERT') and has_table_privilege('service_role', 'public.ad_accounts', 'UPDATE')
-- deploy-key: r2860adtablesservicegrants
-- R-2860: on staging (Cloud SQL) the ad sync failed for every Meta account with
-- "permission denied for table ad_spend_daily" (Abhishek, 16 Nov 2026). 20260927260000_ad_platforms
-- gave service_role a policy but no table GRANT — hosted Supabase grants it by default, Cloud SQL
-- only for tables the postgres role creates (01a-roles-and-auth.sql default privileges), and these
-- were created by the migration role. The server's admin client (service_role) reads and writes all
-- three tables; the browser keeps only what its RLS read policy allows (unchanged here).
begin;
grant select, insert, update, delete on public.ad_spend_daily to service_role;
grant select, insert, update, delete on public.ad_sync_runs to service_role;
grant select, insert, update, delete on public.ad_accounts to service_role;
commit;
