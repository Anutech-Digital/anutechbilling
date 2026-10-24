-- deploy-peek: exists(select 1 from pg_constraint where conname='tenants_sell_mode_check')
-- deploy-key: r1860sellmode
-- R-1860 (epic R-1841, Phase 5 — Pardeep, 24 Oct 2026): "What do you sell?"
--
-- One answer per workspace: subscriptions | one_time | both. It decides what the app puts up
-- front (menu rows, dashboard tiles, the Products tab) — R-1861 / R-1862. It never blocks a
-- page or deletes data: the role guard (nav.ts allowedRoutesForRole → middleware) does not
-- read it, and hidden rows come back by themselves once the workspace has that kind of data.
--
-- Default 'both' = exactly what every workspace sees today, so existing tenants change
-- nothing. Asked once during onboarding (welcome → new business) and changeable any time in
-- Settings → Company (owner only — the existing owner-only tenant update policy; no new grant).
--
-- The app reads it through lib/queries/sell-mode.ts and treats a missing column as 'both', so
-- it works before and after this migration. Idempotent.

alter table public.tenants add column if not exists sell_mode text not null default 'both';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_sell_mode_check') then
    alter table public.tenants add constraint tenants_sell_mode_check
      check (sell_mode in ('subscriptions', 'one_time', 'both'));
  end if;
end $$;

comment on column public.tenants.sell_mode is
  'R-1860: subscriptions | one_time | both (default). What the workspace sells — decides what menu rows and dashboard tiles come first. Display only: never gates a route.';

notify pgrst, 'reload schema';
