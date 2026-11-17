-- deploy-peek: to_regclass('public.social_comments') is not null and to_regclass('public.social_followers') is not null and to_regclass('public.social_todo') is not null and to_regclass('public.social_reports') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'social_content_settings' and column_name = 'comment_mode')
-- deploy-key: r2689socialengagement
-- R-2689 / R-2690 / R-2691 (G-SOCIAL): comments on the company's posts and their replies (AI or a
-- person), a daily follower count per platform, the weekly report, and the daily to-do list of
-- things only a person may do. The marketing team runs it (R-2709). Spec: docs/specs/social-organic.md.
begin;

alter table public.social_content_settings add column if not exists comment_mode text not null default 'ask' check (comment_mode in ('off', 'ask', 'auto'));
alter table public.social_content_settings add column if not exists comments_checked_at timestamptz;
alter table public.social_content_settings add column if not exists comments_problem text check (comments_problem is null or char_length(comments_problem) <= 500);
alter table public.social_content_settings add column if not exists followers_checked_on date;

create table if not exists public.social_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram', 'linkedin')),
  external_id text not null check (char_length(external_id) <= 200),
  post_external_id text check (post_external_id is null or char_length(post_external_id) <= 200),
  content_id uuid references public.social_content(id) on delete set null,
  author text not null default '' check (char_length(author) <= 200),
  message text not null default '' check (char_length(message) <= 4000),
  commented_at timestamptz,
  kind text check (kind is null or kind in ('question', 'praise', 'complaint', 'spam', 'other')),
  status text not null default 'new' check (status in ('new', 'draft', 'replied', 'ignored', 'failed')),
  ai_reply text check (ai_reply is null or char_length(ai_reply) <= 1000),
  reply text check (reply is null or char_length(reply) <= 1000),
  replied_by text check (replied_by is null or replied_by in ('ai', 'person')),
  replied_user uuid references public.users(id) on delete set null,
  replied_at timestamptz,
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  unique (tenant_id, platform, external_id)
);
create index if not exists social_comments_tenant_status_idx on public.social_comments (tenant_id, status, commented_at desc);

create table if not exists public.social_followers (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram', 'linkedin')),
  day date not null,
  followers integer not null check (followers >= 0),
  primary key (tenant_id, platform, day)
);

create table if not exists public.social_reports (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  week_start date not null,
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  summary text not null default '' check (char_length(summary) <= 2000),
  created_at timestamptz not null default now(),
  primary key (tenant_id, week_start)
);

create table if not exists public.social_todo (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day date not null,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  created_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

do $$
declare t text;
begin
  foreach t in array array['social_comments', 'social_followers', 'social_reports', 'social_todo'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_team_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')))$p$, t || '_team_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_team_insert', t);
    execute format($p$create policy %I on public.%I for insert to authenticated
      with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')))$p$, t || '_team_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_team_update', t);
    execute format($p$create policy %I on public.%I for update to authenticated
      using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')))
      with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')))$p$, t || '_team_update', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
commit;
