-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenant_secrets' and column_name = 'linkedin_ads_client_secret')
-- deploy-key: linkedinadstenantcredentials
-- Local/workspace setup for LinkedIn Advertising API. The secret is encrypted by
-- lib/crypto/tenant-secrets before being written.
alter table public.tenant_secrets
  add column if not exists linkedin_ads_client_id text,
  add column if not exists linkedin_ads_client_secret text;

comment on column public.tenant_secrets.linkedin_ads_client_secret is
  'LinkedIn Advertising API client secret, encrypted by the application vault.';
