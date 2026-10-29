-- deploy-peek: not exists(select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') and (has_table_privilege('authenticated', c.oid, 'TRUNCATE') or has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRIGGER') or has_table_privilege('anon', c.oid, 'TRIGGER') or has_table_privilege('authenticated', c.oid, 'REFERENCES') or has_table_privilege('anon', c.oid, 'REFERENCES')))
-- deploy-key: r2091tablegrants
-- ============================================================================
-- R-2091 (29 Oct 2026) — anon/authenticated lose TRUNCATE, TRIGGER, REFERENCES (and MAINTAIN on
-- PG17+) on every public table/view.
--
-- WHY
--   baseline.sql carries Supabase's stock `GRANT ALL ON TABLE … TO anon / authenticated` for every
--   table, plus `ALTER DEFAULT PRIVILEGES FOR ROLE postgres … GRANT ALL ON TABLES TO anon,
--   authenticated` (Cloud SQL: supabase/cloudsql/01a §5 + 01b). "ALL" includes TRUNCATE. Row Level
--   Security does NOT apply to TRUNCATE — a role holding it empties the whole table, every tenant
--   at once. R-2088's check on the local DB: 141 public tables TRUNCATE-able by anon, 185 by
--   authenticated (support_sync_outbox among them). PostgREST never issues TRUNCATE, but any
--   direct SQL session as these roles (or a SECURITY INVOKER path that builds SQL) would.
--   TRIGGER (create a trigger on someone else's table), REFERENCES (create a FK to it — a way to
--   probe or block deletes) and MAINTAIN (PG17: LOCK TABLE / VACUUM / REFRESH MATERIALIZED VIEW —
--   an ACCESS EXCLUSIVE lock would freeze the app) are the same kind: DDL-ish, outside RLS, and
--   no app path needs them from a browser role.
--
-- CHECKED FIRST (no app path needs them)
--   • grep src/, scripts/, supabase/migrations, supabase/tests: no TRUNCATE statement, no
--     LOCK TABLE / REFRESH MATERIALIZED VIEW / VACUUM; triggers and FKs are only created by
--     migrations, which run as the table owner (postgres locally, resellersos_migration on
--     Cloud SQL), never as anon/authenticated.
--   • SELECT / INSERT / UPDATE / DELETE are NOT touched — RLS governs those, and column grants
--     (payment_followups R-1559, secret columns R-833) stay as they are.
--   • service_role keeps everything (cron/admin).
--
-- FUTURE TABLES
--   Default privileges are per creating role: the current role (whoever applies migrations),
--   plus postgres and resellersos_migration when we may act for them. anon's table defaults were
--   already cleared by 20260927280000; authenticated keeps arwd (RLS decides rows).
--
-- Test: supabase/tests/r2091_table_grants.test.sql
-- Rollback: grant truncate, trigger, references on all tables in schema public to authenticated;
--           alter default privileges for role postgres in schema public grant truncate, trigger, references on tables to authenticated;
-- ============================================================================

revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_role text;
  v_left text;
begin
  if v_maintain then
    execute 'revoke maintain on all tables in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke maintain on tables from anon, authenticated';
  end if;

  foreach v_role in array array['postgres', 'resellersos_migration'] loop
    if v_role <> current_user
       and exists (select 1 from pg_roles where rolname = v_role)
       and pg_has_role(current_user, v_role, 'member') then
      execute format('alter default privileges for role %I in schema public revoke truncate, trigger, references on tables from anon, authenticated', v_role);
      if v_maintain then
        execute format('alter default privileges for role %I in schema public revoke maintain on tables from anon, authenticated', v_role);
      end if;
    end if;
  end loop;

  -- A non-owner revoke only removes grants the applying role made; name anything left so the
  -- deploy log shows it (the deploy-peek above stays false until it is gone).
  select string_agg(c.relname, ', ' order by c.relname) into v_left
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
     and (has_table_privilege('authenticated', c.oid, 'TRUNCATE')
       or has_table_privilege('anon', c.oid, 'TRUNCATE')
       or has_table_privilege('authenticated', c.oid, 'TRIGGER')
       or has_table_privilege('anon', c.oid, 'TRIGGER')
       or has_table_privilege('authenticated', c.oid, 'REFERENCES')
       or has_table_privilege('anon', c.oid, 'REFERENCES'));
  if v_left is not null then
    raise warning 'R-2091: still granted to anon/authenticated (owner must revoke): %', v_left;
  end if;
end $$;
