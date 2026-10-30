-- deploy-peek: not exists(select 1 from pg_roles where rolname='resellersos_migration') or (select c.relowner::regrole::text from pg_class c where c.oid = to_regclass('public.personal_identity_link')) = 'resellersos_migration'
-- deploy-key: r2118gp16aowner
-- deploy-user: postgres
-- 20261030102051_r2118_gp16a_owner_to_migration.sql
--
-- R-2118 fix (30 Oct 2026). The staging DB step stopped at 20261030053741_gp16a_personal_identity_link.sql
-- with "permission denied for table users": personal_identity_link.auth_user_id references
-- auth.users(id), and on Cloud SQL resellersos_migration has SELECT on auth.users (cloudsql/06)
-- but not REFERENCES. b61314cdf made that file run as postgres and hand its table and both
-- functions back to resellersos_migration at its end. That handover only WARNS on failure (it
-- must never stop the DB step), and gp16a's own peek cannot tell — so this file repeats it with
-- a peek on the OWNER: false until the handover happened, so a deploy where it failed shows it
-- and the next deploy retries. (gp16a itself can no longer change: CI refuses body edits to a
-- pushed migration.)
--
-- Why resellersos_migration must own them, like every other app object:
--   · RLS on customers / outboxes is skipped only for their OWNER (no BYPASSRLS on Cloud SQL,
--     R-450) — link_personal_identity is SECURITY DEFINER and must run as that owner;
--   · it reads auth.users with resellersos_migration's SELECT (cloudsql/06);
--   · later migrations run as resellersos_migration and must be able to replace them.
-- Runs as postgres: only a member of resellersos_migration may give objects to it (cloudsql/05-07
-- grant that; it is granted again here in case). Grants to anon/authenticated/service_role and
-- the RLS policies are kept by an owner change. No such role (local Supabase) → nothing.
-- Re-runnable.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'resellersos_migration') then
    return;
  end if;
  begin   -- also when already a member: a role's creator may hold ADMIN without SET (PG16+)
    execute 'grant resellersos_migration to ' || quote_ident(current_user);
  exception when others then
    raise warning 'R-2118: could not grant resellersos_migration to %: %', current_user, sqlerrm;
  end;
  begin
    alter table public.personal_identity_link owner to resellersos_migration;
    alter function public.link_personal_identity(uuid, uuid, uuid) owner to resellersos_migration;
    alter function public.tg_gp16a_link_dms_user() owner to resellersos_migration;
  exception when others then
    raise warning 'R-2118: personal_identity_link / link_personal_identity stay owned by % (%) — run cloudsql/05, then this file again', current_user, sqlerrm;
  end;
end
$$;
