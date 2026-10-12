begin;

alter table public.tenant_secrets
  add column if not exists resend_api_key text;

comment on column public.tenant_secrets.resend_api_key is
  'Tenant''s own Resend API key, envelope-encrypted (rosv1:). NULL = fall back to the deployment-wide RESEND_API_KEY. Listed in SECRET_COLUMNS so it is never returned to a browser in the clear.';

-- The From: address Resend sends as. Not a secret, so it lives on `tenants`
-- rather than `tenant_secrets` — and it is separate from the key because a
-- tenant can hold a valid key and still have an unverified domain, which is the
-- single most common reason mail silently stops.
alter table public.tenants
  add column if not exists email_from_address text,
  add column if not exists email_from_name text;

comment on column public.tenants.email_from_address is
  'From: address for outbound mail, e.g. billing@example.test. Must be on a domain verified in that tenant''s own Resend account, or Resend rejects the send.';

commit;
