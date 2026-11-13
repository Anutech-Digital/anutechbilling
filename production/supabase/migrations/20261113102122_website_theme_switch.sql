-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'website_theme')
-- deploy-key: websitethemeswitch
-- 20261113102122_website_theme_switch.sql
--
-- Website theme switch (Pawan, 13 Nov 2026): "main admin should be able to switch back and forth
-- from the previous theme to this latest theme in settings".
--
--   tenants.website_theme  'classic' (default) = the public website as it is today (Anutech blue,
--                                                Archivo + IBM Plex Mono, src/site/site.css);
--                          'warm'              = the "Warm & approachable" theme
--                                                (docs/WEBSITE-THEME.md).
--
-- Only the website tenant's row is read (websiteTenantId(), the storefront's company); on every
-- other tenant the column is inert. The default keeps the website exactly as it is on deploy —
-- nothing changes until the owner flips the switch in Settings → Branding.
-- Owner-only, like every tenants column (RLS tenants_self_update). Theme only: no content, no money.
-- Additive and idempotent: one text column with a default and a CHECK, no data change.
--
-- Test: supabase/tests/website_theme_switch.test.sql (one transaction, rolled back).

begin;

alter table public.tenants add column if not exists website_theme text not null default 'classic';

alter table public.tenants drop constraint if exists tenants_website_theme_check;
alter table public.tenants add constraint tenants_website_theme_check
  check (website_theme in ('classic', 'warm'));

comment on column public.tenants.website_theme is
  'Public website theme: classic (Anutech blue, as before) or warm (docs/WEBSITE-THEME.md). Read only for the website tenant.';

commit;
