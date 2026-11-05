-- One Facebook Page per tenant. Tokens are encrypted by the application vault.
begin;

alter table public.tenant_secrets
  add column if not exists facebook_page_pending_token text,
  add column if not exists facebook_page_pending_at timestamptz,
  add column if not exists facebook_page_access_token text,
  add column if not exists facebook_page_id text,
  add column if not exists facebook_page_name text,
  add column if not exists facebook_page_connected_at timestamptz,
  add column if not exists facebook_page_connected_by uuid;

comment on column public.tenant_secrets.facebook_page_pending_token is
  'Short-lived Facebook user token while choosing a Page; encrypted by the application vault.';
comment on column public.tenant_secrets.facebook_page_access_token is
  'Selected Facebook Page token; encrypted by the application vault.';

commit;
