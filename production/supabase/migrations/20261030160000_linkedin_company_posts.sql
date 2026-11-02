-- LinkedIn Company Page posting (OAuth access token is encrypted by the app before storage).
-- One connection belongs to one tenant because tenant_secrets has tenant_id as its primary key.

alter table public.tenant_secrets add column if not exists linkedin_access_token text;
alter table public.tenant_secrets add column if not exists linkedin_access_expires_at timestamptz;
alter table public.tenant_secrets add column if not exists linkedin_organization_urn text;
alter table public.tenant_secrets add column if not exists linkedin_organization_name text;
alter table public.tenant_secrets add column if not exists linkedin_connected_at timestamptz;
alter table public.tenant_secrets add column if not exists linkedin_connected_by uuid;

comment on column public.tenant_secrets.linkedin_access_token is
  'LinkedIn Company Page OAuth token. Encrypted by lib/crypto/tenant-secrets.ts; server-only.';
comment on column public.tenant_secrets.linkedin_access_expires_at is
  'When the LinkedIn OAuth access token expires. LinkedIn connections must be renewed before this time.';
comment on column public.tenant_secrets.linkedin_organization_urn is
  'LinkedIn Company Page author URN, for example urn:li:organization:12345.';
comment on column public.tenant_secrets.linkedin_organization_name is
  'Display name of the connected LinkedIn Company Page.';
