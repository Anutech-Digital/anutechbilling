-- deploy-peek: to_regclass('public.ad_plans') is not null and to_regclass('public.ad_target_groups') is not null and to_regclass('public.ad_creatives') is not null and to_regclass('public.ad_copies') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'ad_copies' and policyname = 'zzz_service_role_all')
-- deploy-key: r1878adcopilot
-- 20261025001000_ad_copilot_tables.sql
--
-- R-1878 (25 Oct 2026, epic R-1874 — AI campaign co-pilot, phase A): the tables the co-pilot
-- wizard saves into. Pardeep's list was Brands, Products, AdAccounts, Campaigns, TargetGroups,
-- Creatives, AdCopies. Campaigns (marketing_campaigns), AdAccounts (ad_accounts) and Products
-- (items) already exist — reused, not copied. Brands get their own card (R-1882).
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--   ad_plans          — one co-pilot plan: the prompt, objective, platforms, tone/language,
--                       status draft → ready → publishing → live | failed. Hangs under a
--                       marketing_campaigns row (optional while it is a draft: a plan can start
--                       from a prompt before the campaign's dates and code exist).
--   ad_target_groups  — who sees the ads: kind generic | genz | custom | lookalike, ages,
--                       genders, regions + interests (jsonb, platform-neutral). platform null = all.
--   ad_creatives      — an uploaded image / video (storage path, mime, size, w × h, duration).
--                       The storage bucket itself is R-1883.
--   ad_copies         — one line of ad text: platform + format + field (keys from
--                       lib/marketing/copilot/channel-specs.ts) + position. ai_generated marks
--                       what the AI wrote (R-1876) vs what a person typed.
--
-- ─── WHO ────────────────────────────────────────────────────────────────────
-- Read and write: owner, manager, marketing of the SAME company (epic R-1874: "marketing +
-- owner/manager"). Nobody else — sales, billing, accounts — sees a plan. RLS uses
-- current_tenant_id() + current_user_has_role(), so a deactivated user or an MFA user without
-- the second step gets nothing (R-722, R-731, R-1618).
-- Decision (worker, recorded on the card): the card said "writes via API (service role)".
-- Writes go through RLS instead (withTenant), so the database itself keeps one company's
-- plan away from another's; the server (service_role) still has its own policy (R-450) for the
-- publisher (R-1886+).
--
-- ─── SAME-COMPANY LINKS ─────────────────────────────────────────────────────
-- Children point at (tenant_id, plan_id) — a composite FK, so a row can never sit under
-- another company's plan. The plan's campaign and product are checked by a trigger (same as
-- expenses.campaign_id): an FK alone would take another company's id typed into an API call.
-- Deleting a campaign clears the link and keeps the plan; deleting a plan deletes its rows.
--
-- No functions callable by users (only a trigger), no stored data changed.
-- Test: supabase/tests/r1878_ad_copilot_tables.test.sql

begin;

-- ── ad_plans ─────────────────────────────────────────────────────────────────
create table if not exists public.ad_plans (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  marketing_campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  -- R-1882 adds the brands table and its FK; until then always null.
  brand_id              uuid,
  item_id               text references public.items(id) on delete set null,
  name                  text not null check (char_length(btrim(name)) between 1 and 120),
  objective             text not null check (objective in ('awareness', 'traffic', 'engagement', 'lead_gen', 'sales')),
  platforms             text[] not null check (cardinality(platforms) >= 1 and platforms <@ array['google-ads', 'meta-ads']::text[]),
  prompt                text not null default '' check (char_length(prompt) <= 4000),
  -- Brand voice for this plan (R-1876 copy writer); null = the company's default.
  tone                  text check (tone is null or char_length(tone) <= 200),
  language              text not null default 'en' check (language in ('en', 'hinglish', 'hi')),
  status                text not null default 'draft' check (status in ('draft', 'ready', 'publishing', 'live', 'failed')),
  created_by            uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, id)
);

comment on table public.ad_plans is
  'R-1878: AI campaign co-pilot plan (prompt, objective, platforms, status) under a marketing_campaigns row. Owner / manager / marketing only.';

create index if not exists ad_plans_tenant_recent_idx on public.ad_plans (tenant_id, created_at desc);
create index if not exists ad_plans_campaign_idx on public.ad_plans (marketing_campaign_id) where marketing_campaign_id is not null;
create index if not exists ad_plans_item_idx on public.ad_plans (item_id) where item_id is not null;

-- ── ad_target_groups ─────────────────────────────────────────────────────────
create table if not exists public.ad_target_groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  plan_id     uuid not null,
  platform    text check (platform is null or platform in ('google-ads', 'meta-ads')),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  kind        text not null default 'generic' check (kind in ('generic', 'genz', 'custom', 'lookalike')),
  age_min     smallint check (age_min is null or age_min between 13 and 65),
  age_max     smallint check (age_max is null or age_max between 13 and 65),
  genders     text[] not null default '{}' check (genders <@ array['male', 'female']::text[]),
  regions     jsonb not null default '[]'::jsonb check (jsonb_typeof(regions) = 'array'),
  interests   jsonb not null default '[]'::jsonb check (jsonb_typeof(interests) = 'array'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ad_target_groups_ages check (age_min is null or age_max is null or age_min <= age_max),
  constraint ad_target_groups_plan_fk foreign key (tenant_id, plan_id)
    references public.ad_plans (tenant_id, id) on delete cascade
);

create index if not exists ad_target_groups_plan_idx on public.ad_target_groups (tenant_id, plan_id);

-- ── ad_creatives ─────────────────────────────────────────────────────────────
create table if not exists public.ad_creatives (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  plan_id           uuid not null,
  storage_path      text not null check (char_length(storage_path) between 1 and 500),
  mime_type         text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime')),
  size_bytes        bigint not null check (size_bytes > 0),
  width             integer check (width is null or width > 0),
  height            integer check (height is null or height > 0),
  duration_seconds  numeric(8, 2) check (duration_seconds is null or duration_seconds > 0),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  constraint ad_creatives_plan_fk foreign key (tenant_id, plan_id)
    references public.ad_plans (tenant_id, id) on delete cascade
);

create index if not exists ad_creatives_plan_idx on public.ad_creatives (tenant_id, plan_id);

-- ── ad_copies ────────────────────────────────────────────────────────────────
create table if not exists public.ad_copies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  plan_id       uuid not null,
  platform      text not null check (platform in ('google-ads', 'meta-ads')),
  format        text not null check (format ~ '^[a-z_]{1,40}$'),
  field         text not null check (field ~ '^[a-z_]{1,40}$'),
  text          text not null check (char_length(btrim(text)) between 1 and 2000),
  position      smallint not null default 0 check (position between 0 and 49),
  ai_generated  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint ad_copies_slot unique (plan_id, platform, format, field, position),
  constraint ad_copies_plan_fk foreign key (tenant_id, plan_id)
    references public.ad_plans (tenant_id, id) on delete cascade
);

create index if not exists ad_copies_plan_idx on public.ad_copies (tenant_id, plan_id);

-- ── updated_at ───────────────────────────────────────────────────────────────
drop trigger if exists trg_ad_plans_updated_at on public.ad_plans;
create trigger trg_ad_plans_updated_at before update on public.ad_plans
  for each row execute function public.handle_updated_at();
drop trigger if exists trg_ad_target_groups_updated_at on public.ad_target_groups;
create trigger trg_ad_target_groups_updated_at before update on public.ad_target_groups
  for each row execute function public.handle_updated_at();
drop trigger if exists trg_ad_copies_updated_at on public.ad_copies;
create trigger trg_ad_copies_updated_at before update on public.ad_copies
  for each row execute function public.handle_updated_at();

-- ── A plan's campaign and product must be its own company's ─────────────────
create or replace function public.tg_ad_plan_links_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.marketing_campaign_id is not null and not exists (
    select 1 from public.marketing_campaigns c where c.id = new.marketing_campaign_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'Campaign not found for this company.' using errcode = '23503';
  end if;
  if new.item_id is not null and not exists (
    select 1 from public.items i where i.id = new.item_id and i.tenant_id = new.tenant_id
  ) then
    raise exception 'Product not found for this company.' using errcode = '23503';
  end if;
  return new;
end $$;

revoke all on function public.tg_ad_plan_links_same_tenant() from public, anon, authenticated;

drop trigger if exists trg_ad_plan_links_same_tenant on public.ad_plans;
create trigger trg_ad_plan_links_same_tenant
  before insert or update of tenant_id, marketing_campaign_id, item_id on public.ad_plans
  for each row execute function public.tg_ad_plan_links_same_tenant();

-- ── RLS: same company AND owner / manager / marketing ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['ad_plans', 'ad_target_groups', 'ad_creatives', 'ad_copies'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists r1878_copilot_team on public.%I', t);
    execute format(
      'create policy r1878_copilot_team on public.%I as permissive for all to authenticated
         using (tenant_id = (select public.current_tenant_id())
                and (select public.current_user_has_role(''owner'', ''manager'', ''marketing'')))
         with check (tenant_id = (select public.current_tenant_id())
                and (select public.current_user_has_role(''owner'', ''manager'', ''marketing'')))', t);
    -- Cloud SQL has no BYPASSRLS: the server (service_role) needs its own policy (R-450).
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format(
      'create policy zzz_service_role_all on public.%I as permissive for all to service_role
         using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
  end loop;
end $$;

commit;
