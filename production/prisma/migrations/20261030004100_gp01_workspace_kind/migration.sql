-- deploy-peek: exists(select 1 from pg_constraint where conname = 'tenants_workspace_kind_check')
-- deploy-key: gp01workspacekindprisma
-- prisma/migrations/20261030004100_gp01_workspace_kind
-- R-2110 (GP-01, goal G-PERSONAL): tenants.workspace_kind — the column + CHECK only, same as
-- supabase/migrations/20261030004100_gp01_workspace_kind.sql. The R-720 guard that makes the
-- column platform-owned lives ONLY in that supabase migration (one copy of the function body —
-- redefine it there). Idempotent: a no-op where the supabase migration already ran.

alter table public.tenants add column if not exists workspace_kind text not null default 'business';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_workspace_kind_check') then
    alter table public.tenants add constraint tenants_workspace_kind_check
      check (workspace_kind in ('personal', 'business'));
  end if;
end $$;
