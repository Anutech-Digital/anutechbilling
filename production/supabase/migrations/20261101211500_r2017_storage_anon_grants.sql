-- deploy-peek: not exists(select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.rolname in ('anon', 'authenticated') where n.nspname = 'storage' and c.relname = 'objects' and (has_table_privilege(r.oid, c.oid, 'TRUNCATE') or (r.rolname = 'anon' and has_table_privilege(r.oid, c.oid, 'INSERT'))))
-- deploy-key: r2017storageanon
-- deploy-user: postgres
-- 20261101211500_r2017_storage_anon_grants.sql
--
-- R-2017 (G-DPDP, 27 Oct audit): 20261002191000_storage_grants.sql gave anon ALL rights on
-- storage.objects and storage.buckets ("grant all ... to anon, authenticated, service_role").
-- Only RLS stood between a logged-out caller and a file write. Two problems with that:
--   1. TRUNCATE, REFERENCES and TRIGGER are not governed by RLS at all — TRUNCATE empties the
--      table whatever the policies say. Nobody (anon or a signed-in user) needs them; storage
--      writes go through storage-api as authenticated (row by row) or as service_role.
--   2. anon never writes storage in this app: every upload/remove is either the admin client
--      (service_role — e.g. the public expense-claim receipt) or a signed-in user's client.
--      Public logos are served by storage-api's public route, which reads as its own
--      superuser, not as anon.
-- So: anon keeps SELECT only (still filtered by RLS — no anon policy matches a file today),
-- authenticated keeps SELECT/INSERT/UPDATE/DELETE (RLS decides, as before — no change for
-- signed-in users), and TRUNCATE/REFERENCES/TRIGGER go from both. service_role unchanged.
--
-- Who runs the REVOKE (R-2357, 2 Nov 2026): a privilege can only be revoked by the role that
-- granted it — on Supabase/local that is supabase_storage_admin, the owner (20261002191000 ran
-- as it), and the deploy user postgres may act as it there. This file had not reached staging
-- or live yet; on a database where storage is set up differently (they are Cloud SQL, R-161
-- path) a hard `set local role supabase_storage_admin` could stop the whole deploy run, so:
--   * no storage schema / no such table → NOTICE, nothing to do (no grant to take back);
--   * for each role that granted anon/authenticated a right they must lose (normally the
--     owner), act as that role; if the deploy user may not → NOTICE and leave it. The
--     deploy-peek then stays false, so the deploy script's last step says
--     "Still missing: r2017storageanon" out loud instead of the run dying half-way.
-- On Supabase/local nothing is skipped: supabase/tests/r2017_storage_anon_grants.test.sql still
-- fails if anon keeps INSERT or anyone keeps TRUNCATE. Idempotent — a second run finds no
-- grant to revoke and anon already has SELECT.
--
-- Deploy-peek (R-2357): finds storage.objects by OID through pg_class/pg_namespace, because the
-- deploy script reads every peek as resellersos_migration, which has no USAGE on schema storage
-- — to_regclass('storage.objects') failed there with "permission denied for schema storage" and
-- stopped the 2 Nov staging DB step. No storage.objects → true (nothing to revoke).
-- Tests: supabase/tests/r2017_storage_anon_grants.test.sql, supabase/tests/r2357_storage_peek_no_usage.test.sql
-- ============================================================================
begin;

do $$
declare
  t       text;
  v_rel   oid;
  v_owner name;
  g       record;
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'R-2017: no storage schema on this database — nothing to revoke, skipped';
    return;
  end if;

  foreach t in array array['objects', 'buckets'] loop
    v_rel := null;
    select c.oid, pg_get_userbyid(c.relowner) into v_rel, v_owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = t;
    if v_rel is null then
      raise notice 'R-2017: storage.% does not exist here — skipped', t;
      continue;
    end if;

    -- every role that granted anon / authenticated a right they must lose (normally the owner)
    for g in
      select distinct pg_get_userbyid(a.grantor) as grantor
        from pg_class c
        cross join lateral aclexplode(c.relacl) a
        join pg_roles r on r.oid = a.grantee
       where c.oid = v_rel
         and ((r.rolname = 'anon' and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'))
           or (r.rolname = 'authenticated' and a.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')))
    loop
      begin
        execute format('set local role %I', g.grantor);
        if exists (select 1 from pg_roles where rolname = 'anon') then
          execute format('revoke insert, update, delete, truncate, references, trigger on storage.%I from anon', t);
        end if;
        if exists (select 1 from pg_roles where rolname = 'authenticated') then
          execute format('revoke truncate, references, trigger on storage.%I from authenticated', t);
        end if;
        execute 'reset role';
      exception when insufficient_privilege then
        raise notice 'R-2017: % may not act as %, who granted the rights on storage.% — left as they are (deploy-peek stays false)', session_user, g.grantor, t;
      end;
    end loop;

    -- anon keeps (or gets) SELECT — RLS still decides which rows
    if exists (select 1 from pg_roles where rolname = 'anon')
       and not has_table_privilege((select oid from pg_roles where rolname = 'anon'), v_rel, 'SELECT') then
      begin
        execute format('set local role %I', v_owner);
        execute format('grant select on storage.%I to anon', t);
        execute 'reset role';
      exception when insufficient_privilege then
        raise notice 'R-2017: % may not act as %, the owner of storage.% — anon SELECT not granted', session_user, v_owner, t;
      end;
    end if;
  end loop;
end $$;

commit;
