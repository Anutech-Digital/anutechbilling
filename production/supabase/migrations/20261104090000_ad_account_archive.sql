-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ad_accounts' and column_name = 'archived_at') and to_regclass('public.ad_accounts_active_tenant_idx') is not null
-- deploy-key: adaccountarchive
-- Keep historical campaign spend when an ad account is removed from the workspace.
begin;

alter table public.ad_accounts
  add column if not exists archived_at timestamptz;

create index if not exists ad_accounts_active_tenant_idx
  on public.ad_accounts (tenant_id, platform)
  where archived_at is null;

commit;
