-- deploy-peek: to_regclass('public.ad_copy_sets') is not null and to_regclass('public.ad_copy_set_versions') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ad_copies' and column_name = 'audience') and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'ad_copy_set_versions' and policyname = 'zzz_service_role_all')
-- deploy-key: r1897adcopysets
-- 20261025092735_r1897_ad_copy_sets.sql
--
-- R-1897 (25 Oct 2026, epic R-1874 — Campaign Co-pilot Step 3, the ad copy). Pardeep:
-- "campaign me ad copy kaise banegi iska bhi poora logical system banao taki user aasani se
-- kaam kar sake". Step 3 writes, edits and autosaves ad copy per platform AND per audience.
--
-- ─── WHAT THIS CHANGES ──────────────────────────────────────────────────────
--   ad_copies            + audience  (ad_target_groups.kind: 'generic' = Main audience,
--                                     'lookalike' = People like my customers, …). Default
--                                     'generic', so every existing row stays the main audience.
--                        + locked    "Keep": a new AI run does not replace the line.
--                        + pinned    Google pin position 1–3 (null = not pinned).
--                        slot unique now includes the audience (same headline position can
--                        exist once per audience).
--   ad_copy_sets         one row per plan × platform × audience: the format and a VERSION that
--                        goes up on every save. A save with an old version is refused by the
--                        app (two tabs never overwrite each other silently).
--   ad_copy_set_versions every saved version's lines (jsonb), so an earlier version can be
--                        brought back. The app keeps the latest 20 per set.
--
-- Why audience is a KEY and not a FK to ad_target_groups: step 2 replaces the target-group rows
-- on every save (R-1879 writePlan), so their ids change; the kind does not.
--
-- ─── WHO ────────────────────────────────────────────────────────────────────
-- Same as R-1878: owner, manager, marketing of the SAME company (RLS current_tenant_id() +
-- current_user_has_role()); the server (service_role) has its own policy (Cloud SQL, R-450).
-- Children point at (tenant_id, parent id) — composite FKs, so a row can never sit under
-- another company's plan or set.
--
-- No functions, no stored data changed (existing ad_copies rows get audience 'generic').
-- Test: supabase/tests/r1897_ad_copy_sets.test.sql

begin;

-- ── ad_copies: audience, keep, pin ──────────────────────────────────────────
alter table public.ad_copies
  add column if not exists audience text not null default 'generic',
  add column if not exists locked   boolean not null default false,
  add column if not exists pinned   smallint;

alter table public.ad_copies drop constraint if exists ad_copies_audience_check;
alter table public.ad_copies add constraint ad_copies_audience_check
  check (audience in ('generic', 'genz', 'custom', 'lookalike'));
alter table public.ad_copies drop constraint if exists ad_copies_pinned_check;
alter table public.ad_copies add constraint ad_copies_pinned_check
  check (pinned is null or pinned between 1 and 3);

alter table public.ad_copies drop constraint if exists ad_copies_slot;
alter table public.ad_copies add constraint ad_copies_slot
  unique (plan_id, platform, audience, format, field, position);

-- ── ad_copy_sets ─────────────────────────────────────────────────────────────
create table if not exists public.ad_copy_sets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  plan_id     uuid not null,
  platform    text not null check (platform in ('google-ads', 'meta-ads')),
  audience    text not null default 'generic' check (audience in ('generic', 'genz', 'custom', 'lookalike')),
  format      text not null check (format ~ '^[a-z_]{1,40}$'),
  version     integer not null default 1 check (version >= 1),
  updated_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ad_copy_sets_one_per_audience unique (tenant_id, plan_id, platform, audience),
  constraint ad_copy_sets_tenant_id unique (tenant_id, id),
  constraint ad_copy_sets_plan_fk foreign key (tenant_id, plan_id)
    references public.ad_plans (tenant_id, id) on delete cascade
);

comment on table public.ad_copy_sets is
  'R-1897: one ad-copy set per co-pilot plan × platform × audience; version goes up on every save. Owner / manager / marketing only.';

-- ── ad_copy_set_versions ─────────────────────────────────────────────────────
create table if not exists public.ad_copy_set_versions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  set_id     uuid not null,
  version    integer not null check (version >= 1),
  lines      jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  saved_by   uuid default auth.uid(),
  saved_at   timestamptz not null default now(),
  constraint ad_copy_set_versions_one unique (set_id, version),
  constraint ad_copy_set_versions_set_fk foreign key (tenant_id, set_id)
    references public.ad_copy_sets (tenant_id, id) on delete cascade
);

create index if not exists ad_copy_set_versions_recent_idx on public.ad_copy_set_versions (tenant_id, set_id, version desc);

drop trigger if exists trg_ad_copy_sets_updated_at on public.ad_copy_sets;
create trigger trg_ad_copy_sets_updated_at before update on public.ad_copy_sets
  for each row execute function public.handle_updated_at();

-- ── RLS: same company AND owner / manager / marketing (as R-1878) ───────────
do $$
declare t text;
begin
  foreach t in array array['ad_copy_sets', 'ad_copy_set_versions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists r1897_copilot_team on public.%I', t);
    execute format(
      'create policy r1897_copilot_team on public.%I as permissive for all to authenticated
         using (tenant_id = (select public.current_tenant_id())
                and (select public.current_user_has_role(''owner'', ''manager'', ''marketing'')))
         with check (tenant_id = (select public.current_tenant_id())
                and (select public.current_user_has_role(''owner'', ''manager'', ''marketing'')))', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format(
      'create policy zzz_service_role_all on public.%I as permissive for all to service_role
         using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
  end loop;
end $$;

commit;
