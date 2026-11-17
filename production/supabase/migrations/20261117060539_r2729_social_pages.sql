-- deploy-peek: to_regclass('public.social_pages') is not null and to_regclass('public.social_page_tokens') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'social_content' and column_name = 'page_id')
-- deploy-key: r2729socialpages
-- R-2729 (G-SOCIAL): one company runs MANY Facebook Pages (each with its own Instagram) from one
-- place — e.g. one person managing the Pages of several business portfolios. Each Page has its own
-- brief and AI settings (Abhishek, 13 Nov 2026); every post, comment, strategy, follower count and
-- report belongs to one Page. The company's main Page (tenant_secrets) becomes the first row.
-- "Stop all AI" (social_content_settings.ai_paused) stays one switch for the whole company.
begin;

create table if not exists public.social_pages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  page_id text not null check (page_id ~ '^\d{1,30}$'),
  name text not null default '' check (char_length(name) <= 200),
  instagram_id text check (instagram_id is null or instagram_id ~ '^\d{1,30}$'),
  instagram_username text check (instagram_username is null or char_length(instagram_username) <= 100),
  active boolean not null default false,
  is_main boolean not null default false,
  brief text not null default '' check (char_length(brief) <= 1000),
  auto_drafts boolean not null default false,
  autopilot boolean not null default false,
  posts_per_week integer not null default 3 check (posts_per_week between 1 and 7),
  picture_urls text[] not null default '{}' check (cardinality(picture_urls) <= 30),
  comment_mode text not null default 'ask' check (comment_mode in ('off', 'ask', 'auto')),
  last_generated_on date,
  comments_checked_at timestamptz,
  comments_problem text check (comments_problem is null or char_length(comments_problem) <= 500),
  followers_checked_on date,
  updated_at timestamptz not null default now(),
  unique (tenant_id, page_id)
);

-- Page tokens: sealed (lib/crypto/vault), read only by server code with the service role.
create table if not exists public.social_page_tokens (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  page_id text not null check (page_id ~ '^\d{1,30}$'),
  page_token text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, page_id)
);

alter table public.social_pages enable row level security;
drop policy if exists social_pages_team_read on public.social_pages;
create policy social_pages_team_read on public.social_pages for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
drop policy if exists social_pages_team_update on public.social_pages;
create policy social_pages_team_update on public.social_pages for update to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
drop policy if exists zzz_service_role_all on public.social_pages;
create policy zzz_service_role_all on public.social_pages for all to service_role using (true) with check (true);
revoke all on public.social_pages from public, anon;
grant select, update on public.social_pages to authenticated;
grant select, insert, update, delete on public.social_pages to service_role;

alter table public.social_page_tokens enable row level security;
drop policy if exists zzz_service_role_all on public.social_page_tokens;
create policy zzz_service_role_all on public.social_page_tokens for all to service_role using (true) with check (true);
revoke all on public.social_page_tokens from public, anon, authenticated;
grant select, insert, update, delete on public.social_page_tokens to service_role;

-- Which Page each row belongs to.
alter table public.social_content add column if not exists page_id text;
alter table public.social_activity add column if not exists page_id text;
alter table public.social_comments add column if not exists page_id text;
alter table public.social_strategy add column if not exists page_id text not null default '';
alter table public.social_followers add column if not exists page_id text not null default '';
alter table public.social_reports add column if not exists page_id text not null default '';

-- The main Page of every company that has one becomes its first social Page, with today's settings.
insert into public.social_pages (tenant_id, page_id, name, active, is_main, brief, auto_drafts, autopilot, posts_per_week,
  picture_urls, comment_mode, last_generated_on, comments_checked_at, comments_problem, followers_checked_on)
select ts.tenant_id, ts.facebook_page_id, coalesce(ts.facebook_page_name, ''), true, true,
  coalesce(s.brief, ''), coalesce(s.auto_drafts, false), coalesce(s.autopilot, false), coalesce(s.posts_per_week, 3),
  coalesce(s.picture_urls, '{}'), coalesce(s.comment_mode, 'ask'), s.last_generated_on, s.comments_checked_at, s.comments_problem, s.followers_checked_on
from public.tenant_secrets ts
left join public.social_content_settings s on s.tenant_id = ts.tenant_id
where ts.facebook_page_id ~ '^\d{1,30}$'
on conflict (tenant_id, page_id) do nothing;

insert into public.social_page_tokens (tenant_id, page_id, page_token)
select ts.tenant_id, ts.facebook_page_id, ts.facebook_page_access_token
from public.tenant_secrets ts
where ts.facebook_page_id ~ '^\d{1,30}$' and ts.facebook_page_access_token is not null
on conflict (tenant_id, page_id) do nothing;

-- Rows made before this belong to the main Page.
update public.social_content c set page_id = ts.facebook_page_id from public.tenant_secrets ts
  where c.page_id is null and ts.tenant_id = c.tenant_id and ts.facebook_page_id ~ '^\d{1,30}$';
update public.social_activity a set page_id = ts.facebook_page_id from public.tenant_secrets ts
  where a.page_id is null and a.platform in ('facebook', 'instagram') and ts.tenant_id = a.tenant_id and ts.facebook_page_id ~ '^\d{1,30}$';
update public.social_comments c set page_id = ts.facebook_page_id from public.tenant_secrets ts
  where c.page_id is null and ts.tenant_id = c.tenant_id and ts.facebook_page_id ~ '^\d{1,30}$';
update public.social_strategy x set page_id = ts.facebook_page_id from public.tenant_secrets ts
  where x.page_id = '' and x.platform in ('facebook', 'instagram') and ts.tenant_id = x.tenant_id and ts.facebook_page_id ~ '^\d{1,30}$';
update public.social_followers x set page_id = ts.facebook_page_id from public.tenant_secrets ts
  where x.page_id = '' and ts.tenant_id = x.tenant_id and ts.facebook_page_id ~ '^\d{1,30}$';
update public.social_reports x set page_id = ts.facebook_page_id from public.tenant_secrets ts
  where x.page_id = '' and ts.tenant_id = x.tenant_id and ts.facebook_page_id ~ '^\d{1,30}$';

-- Keys now include the Page.
alter table public.social_strategy drop constraint if exists social_strategy_tenant_id_platform_version_key;
drop index if exists public.social_strategy_one_active;
drop index if exists public.social_strategy_one_proposed;
create unique index if not exists social_strategy_page_version on public.social_strategy (tenant_id, page_id, platform, version);
create unique index if not exists social_strategy_page_one_active on public.social_strategy (tenant_id, page_id, platform) where status = 'active';
create unique index if not exists social_strategy_page_one_proposed on public.social_strategy (tenant_id, page_id, platform) where status = 'proposed';

alter table public.social_followers drop constraint if exists social_followers_pkey;
alter table public.social_followers add constraint social_followers_pkey primary key (tenant_id, page_id, platform, day);
alter table public.social_reports drop constraint if exists social_reports_pkey;
alter table public.social_reports add constraint social_reports_pkey primary key (tenant_id, page_id, week_start);

create index if not exists social_content_tenant_page_idx on public.social_content (tenant_id, page_id, created_at desc);
commit;
