-- deploy-peek: exists(select 1 from pg_constraint where conname = 'ad_accounts_platform_check' and pg_get_constraintdef(oid) like '%linkedin-ads%')
-- deploy-key: linkedinadssync
-- Let the existing ad-account sync engine store LinkedIn Advertising API accounts.
alter table public.ad_accounts
  drop constraint if exists ad_accounts_platform_check;

alter table public.ad_accounts
  add constraint ad_accounts_platform_check
  check (platform in ('google-ads', 'meta-ads', 'linkedin-ads'));

comment on table public.ad_accounts is
  'Google Ads, Meta Ads, and LinkedIn Ads accounts connected by a tenant; access tokens are hidden from browser roles.';
