-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenant_secrets' and column_name = 'meta_capi_token')
-- deploy-key: r1979metapixelsecrets
-- 20261026174905_r1979_meta_pixel_secrets.sql
--
-- R-1979 (26 Oct 2026, goal G-ADS): Meta Pixel + Conversions API settings per tenant, on
-- tenant_secrets — the table every per-tenant integration credential already lives in, RLS
-- owner-only of the same tenant (tenant_secrets_owner_* policies, R-1618).
--   meta_pixel_id         the Pixel (dataset) id — not a secret; it is in the page's script.
--   meta_capi_token       the Conversions API access token — a SECRET: sealed with the vault
--                         (lib/crypto/vault.ts, "rosv1:" envelope) by lib/crypto/tenant-secrets.ts
--                         SECRET_COLUMNS before it is written; never sent to a browser.
--   meta_test_event_code  optional "TEST12345" code from Events Manager → Test events, so a
--                         test purchase shows there; empty in normal use.
-- No pixel id → no script on any page and no server event (the code checks; nothing here).
-- Additive, nullable, idempotent.

begin;

alter table public.tenant_secrets add column if not exists meta_pixel_id        text;
alter table public.tenant_secrets add column if not exists meta_capi_token      text;
alter table public.tenant_secrets add column if not exists meta_test_event_code text;

comment on column public.tenant_secrets.meta_pixel_id is
  'R-1979: Meta Pixel id (digits). Not secret — the public pages load the pixel with it. NULL = no pixel, no Conversions API event.';
comment on column public.tenant_secrets.meta_capi_token is
  'R-1979: Meta Conversions API access token — SEALED (vault envelope rosv1:, tenant-secrets.ts SECRET_COLUMNS). Never sent to a browser.';
comment on column public.tenant_secrets.meta_test_event_code is
  'R-1979: optional Events Manager test code (TEST…); when set, server events go to Test events. Clear it after testing.';

commit;
