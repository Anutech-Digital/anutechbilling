-- deploy-peek: (exists(select 1 from pg_constraint where conname = 'tenants_workspace_kind_check') and exists(select 1 from pg_proc where oid = to_regprocedure('public.r720_tenants_column_guard()') and prosrc like '%R-2110%'))
-- deploy-key: gp01workspacekind
-- R-2110 (GP-01, goal G-PERSONAL, 30 Oct 2026): tenants.workspace_kind — platform-owned.
--
--   business  every workspace that exists today (the default — existing rows change nothing).
--   personal  one person's own money + digital assets, no company / GSTIN (G-PERSONAL).
--
-- Platform-owned like tier / parent_tenant_id (R-720): only the server (admin client =
-- service_role, SECURITY DEFINER functions, psql) decides it — at personal signup (GP-05) and at
-- the paid upgrade to business (GP-25). An owner flipping it from the browser would either hide
-- their books behind the personal walls or unlock business features without the upgrade (D2).
--
-- r720_tenants_column_guard is redefined from its LATEST body (20261011093000:71-122 — no later
-- migration changed it; 20261019002811 only mentions it). Two additions, marked R-2110:
--   UPDATE  a request role (authenticated / anon / app_runtime) cannot change workspace_kind;
--   INSERT  a request role cannot create a tenant with a kind other than 'business'.
-- Everything else in the guard is unchanged. The app reads the value through
-- lib/workspace/kind.ts (parseWorkspaceKind: missing / unknown → 'business').
-- The column + CHECK are also in prisma/migrations/20261030004100_gp01_workspace_kind; this file
-- is the ONLY copy of the guard. Re-runnable. business_type is NOT touched (card rule).
-- Test: supabase/tests/gp01_workspace_kind_guard.test.sql (rolled back).

begin;

alter table public.tenants add column if not exists workspace_kind text not null default 'business';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_workspace_kind_check') then
    alter table public.tenants add constraint tenants_workspace_kind_check
      check (workspace_kind in ('personal', 'business'));
  end if;
end $$;

comment on column public.tenants.workspace_kind is
  'R-2110: business (default) | personal. Platform-owned: request roles cannot change it (r720_tenants_column_guard); only the server sets it at personal signup / paid upgrade.';

create or replace function public.r720_tenants_column_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if current_user::text not in ('authenticated', 'anon', 'app_runtime') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- No request-role insert policy exists any more; this is the second wall.
    if new.parent_tenant_id is not null
       or new.gstin_verified_at is not null
       or new.gstin_verification is not null
       or coalesce(new.tier, 'reseller') <> 'reseller'
       -- R-2110: a personal workspace is created only by the server (GP-05).
       or coalesce(new.workspace_kind, 'business') <> 'business' then
      raise exception 'Only the server can create a workspace with a tier, parent, GSTIN verification or workspace kind.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tier is distinct from old.tier
     or new.parent_tenant_id is distinct from old.parent_tenant_id then
    raise exception 'Workspace tier and parent distributor are set by the platform, not from the app.'
      using errcode = '42501';
  end if;

  -- R-2110: personal ↔ business is the platform's decision (signup / paid upgrade), never the app's.
  if new.workspace_kind is distinct from old.workspace_kind then
    raise exception 'Workspace kind (personal or business) is set by the platform, not from the app.'
      using errcode = '42501';
  end if;

  if (new.gstin_verified_at is distinct from old.gstin_verified_at and new.gstin_verified_at is not null)
     or (new.gstin_verification is distinct from old.gstin_verification and new.gstin_verification is not null) then
    raise exception 'GSTIN verification is recorded only by the Verify with GSTN check.'
      using errcode = '42501';
  end if;

  -- A new GSTIN is not the one that was verified.
  if upper(btrim(coalesce(new.gstin, ''))) is distinct from upper(btrim(coalesce(old.gstin, ''))) then
    new.gstin_verified_at  := null;
    new.gstin_verification := null;
  end if;

  if new.gmail_sender_user_id is distinct from old.gmail_sender_user_id
     and new.gmail_sender_user_id is not null
     and not exists (select 1 from public.users u
                      where u.id = new.gmail_sender_user_id and u.tenant_id = new.id) then
    raise exception 'The Gmail sender must be a member of this workspace.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function public.r720_tenants_column_guard() from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
