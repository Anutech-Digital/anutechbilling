-- deploy-peek: to_regclass('public.social_activity') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'social_content_settings' and column_name = 'ai_paused')
-- deploy-key: r2687socialactivity
-- R-2687 (G-SOCIAL v2): one list of everything the AI and people did on the company's social
-- accounts (planned, approved, posted, failed, stopped, paused…), and a "Stop all AI" switch that
-- wins over every AI mode. Spec: docs/specs/social-organic.md.
begin;

alter table public.social_content_settings add column if not exists ai_paused boolean not null default false;

create table if not exists public.social_activity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null check (actor in ('ai', 'person', 'system')),
  user_id uuid references public.users(id) on delete set null,
  platform text check (platform is null or platform in ('facebook', 'instagram', 'linkedin')),
  action text not null check (char_length(action) between 1 and 60),
  detail text not null default '' check (char_length(detail) <= 500),
  content_id uuid references public.social_content(id) on delete set null,
  result text not null default 'ok' check (result in ('ok', 'failed', 'waiting'))
);
create index if not exists social_activity_tenant_at_idx on public.social_activity (tenant_id, at desc);

alter table public.social_activity enable row level security;
create policy social_activity_team_read on public.social_activity for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy social_activity_team_write on public.social_activity for insert to authenticated
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy zzz_service_role_all on public.social_activity for all to service_role using (true) with check (true);
revoke all on public.social_activity from public, anon;
grant select, insert on public.social_activity to authenticated;
grant select, insert, update, delete on public.social_activity to service_role;
commit;
