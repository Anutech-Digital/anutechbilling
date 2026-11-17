-- deploy-peek: to_regclass('public.social_strategy') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'social_content' and column_name = 'stats')
-- deploy-key: r2705socialstrategy
-- R-2705 / R-2706 / R-2707 (G-SOCIAL): a strategy for each platform that the AI follows when it
-- writes posts, the results of each post, and a new strategy version every week that keeps what
-- worked and changes what did not. The marketing team runs it (R-2709). Spec: docs/specs/social-organic.md (v3).
begin;

-- One row per strategy version. Exactly one 'active' per company + platform; the AI's weekly
-- change waits as 'proposed' when the company chose "Ask me first".
create table if not exists public.social_strategy (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram', 'linkedin')),
  version integer not null check (version >= 1),
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  reason text not null default '' check (char_length(reason) <= 1500),
  status text not null default 'active' check (status in ('active', 'proposed', 'replaced', 'rejected')),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, platform, version)
);
create unique index if not exists social_strategy_one_active on public.social_strategy (tenant_id, platform) where status = 'active';
create unique index if not exists social_strategy_one_proposed on public.social_strategy (tenant_id, platform) where status = 'proposed';

alter table public.social_strategy enable row level security;
create policy social_strategy_team_read on public.social_strategy for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy social_strategy_team_insert on public.social_strategy for insert to authenticated
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy social_strategy_team_update on public.social_strategy for update to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy zzz_service_role_all on public.social_strategy for all to service_role using (true) with check (true);
revoke all on public.social_strategy from public, anon;
grant select, insert, update on public.social_strategy to authenticated;
grant select, insert, update, delete on public.social_strategy to service_role;

-- Each post: which kind of post it is, the strategy version it followed, and its results.
alter table public.social_content add column if not exists post_type text check (post_type is null or char_length(post_type) <= 40);
alter table public.social_content add column if not exists strategy_version integer;
alter table public.social_content add column if not exists stats jsonb check (stats is null or jsonb_typeof(stats) = 'object');
alter table public.social_content add column if not exists stats_at timestamptz;
commit;
