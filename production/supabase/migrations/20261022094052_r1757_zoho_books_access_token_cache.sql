-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenant_secrets' and column_name = 'zoho_books_access_token') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenant_secrets' and column_name = 'zoho_books_access_expires_at')
-- deploy-key: r1757zohotokencache
--
-- R-1757 — keep the short-lived Zoho Books ACCESS token until shortly before it expires.
--
-- R-1749 minted a new access token from the refresh token on every use. Zoho allows only about
-- ten access tokens per refresh token in ten minutes, then refuses — and a long "Import from
-- Zoho" dry run (R-1753) stopped with "access has ended" although access was fine.
--
-- The token is cached per tenant on tenant_secrets (one row per tenant, RLS owner-only of the
-- same tenant — R-1618 / zoho_books_connection_r1749.test.sql), sealed like the refresh token
-- (SECRET_COLUMNS in lib/crypto/tenant-secrets.ts), with its expiry, so every app instance
-- shares it. Server-only; never sent to a browser. Cleared on connect and disconnect.

alter table public.tenant_secrets add column if not exists zoho_books_access_token      text;
alter table public.tenant_secrets add column if not exists zoho_books_access_expires_at timestamptz;

comment on column public.tenant_secrets.zoho_books_access_token is
  'R-1757: cached Zoho Books access token (short-lived). Sealed by lib/crypto/tenant-secrets.ts; server-only.';
comment on column public.tenant_secrets.zoho_books_access_expires_at is
  'R-1757: when the cached Zoho Books access token expires (Zoho expires_in).';
