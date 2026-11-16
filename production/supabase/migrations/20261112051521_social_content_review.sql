-- deploy-peek: to_regclass('public.social_content') is not null and to_regclass('public.social_content_settings') is not null
-- deploy-key: socialcontentreview
-- Organic content is drafted internally. Only an explicit reviewer action publishes it.
begin;

create table if not exists public.social_content (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram')),
  format text not null check (format in ('post', 'story')),
  caption text not null default '' check (char_length(caption) <= 2200),
  media_url text check (media_url is null or (char_length(media_url) <= 2000 and media_url ~ '^https://')),
  topic text not null default '' check (char_length(topic) <= 500),
  origin text not null default 'manual' check (origin in ('manual', 'ai', 'scheduled')),
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'publishing', 'published', 'failed')),
  created_by uuid references public.users(id),
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz,
  published_by uuid references public.users(id),
  published_at timestamptz,
  external_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_content_story_media check (format <> 'story' or media_url is not null),
  constraint social_content_facebook_story check (platform <> 'facebook' or format <> 'story')
);
create index if not exists social_content_tenant_recent_idx on public.social_content (tenant_id, created_at desc);
create index if not exists social_content_review_idx on public.social_content (tenant_id, status) where status in ('review', 'approved');

create table if not exists public.social_content_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  auto_drafts boolean not null default false,
  brief text not null default '' check (char_length(brief) <= 1000),
  last_generated_on date,
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);

alter table public.social_content enable row level security;
alter table public.social_content_settings enable row level security;
create policy social_content_team on public.social_content for all to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy social_content_settings_team on public.social_content_settings for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy social_content_settings_manage on public.social_content_settings for all to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager')))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager')));
create policy zzz_service_role_all on public.social_content for all to service_role using (true) with check (true);
create policy zzz_service_role_all on public.social_content_settings for all to service_role using (true) with check (true);
revoke all on public.social_content, public.social_content_settings from public, anon;
grant select, insert, update, delete on public.social_content to authenticated, service_role;
grant select, insert, update, delete on public.social_content_settings to authenticated, service_role;
commit;
