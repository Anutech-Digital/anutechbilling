-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenant_secrets' and column_name = 'zoho_books_refresh_token')
-- deploy-key: r1749zohobooks
--
-- R-1749 — each company (tenant) connects ITS OWN Zoho Books account (read-only OAuth).
--
-- Stored on tenant_secrets, the table every per-tenant integration credential already lives in:
--   * one row per tenant (primary key tenant_id), so a connection cannot belong to two tenants;
--   * RLS owner-only of the SAME tenant (tenant_secrets_owner_* policies, R-1618), so a user of
--     tenant B can never read tenant A's row — supabase/tests/zoho_books_connection_r1749.test.sql;
--   * the app reads and writes it only server-side (service role, filtered by the caller's own
--     tenant), and the refresh token is sealed by lib/crypto/tenant-secrets.ts (SECRET_COLUMNS,
--     the `rosv1:` envelope with SECRETS_MASTER_KEY) before it is stored. It never reaches a browser.
--
-- zoho_books_org_id / _org_name: the ONE Zoho organization the owner picked after connecting.
-- Null with a token present = connected, organization not chosen yet.

alter table public.tenant_secrets add column if not exists zoho_books_refresh_token text;
alter table public.tenant_secrets add column if not exists zoho_books_org_id        text;
alter table public.tenant_secrets add column if not exists zoho_books_org_name      text;
alter table public.tenant_secrets add column if not exists zoho_books_connected_at  timestamptz;
alter table public.tenant_secrets add column if not exists zoho_books_connected_by  uuid;

comment on column public.tenant_secrets.zoho_books_refresh_token is
  'R-1749: Zoho Books OAuth refresh token (read-only scopes). Sealed by lib/crypto/tenant-secrets.ts; server-only.';
comment on column public.tenant_secrets.zoho_books_org_id is
  'R-1749: the Zoho Books organization_id this tenant chose. Null = connected but no organization picked yet.';
comment on column public.tenant_secrets.zoho_books_org_name is
  'R-1749: display name of the chosen Zoho Books organization.';
comment on column public.tenant_secrets.zoho_books_connected_at is
  'R-1749: when Zoho Books was connected.';
comment on column public.tenant_secrets.zoho_books_connected_by is
  'R-1749: the user (users.id) who connected Zoho Books.';
