-- deploy-peek: (to_regclass('storage.objects') is not null and not has_table_privilege('anon', 'storage.objects', 'INSERT') and not has_table_privilege('anon', 'storage.objects', 'TRUNCATE') and not has_table_privilege('authenticated', 'storage.objects', 'TRUNCATE'))
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
-- Runs as supabase_storage_admin, the owner (same as 20261002191000). Idempotent; a table a
-- storage version does not have is skipped.
-- Test: supabase/tests/r2017_storage_anon_grants.test.sql
-- ============================================================================
begin;
set local role supabase_storage_admin;

do $$
declare t text;
begin
  foreach t in array array['objects', 'buckets'] loop
    if to_regclass('storage.' || t) is not null then
      execute format('revoke insert, update, delete, truncate, references, trigger on storage.%I from anon', t);
      execute format('revoke truncate, references, trigger on storage.%I from authenticated', t);
      execute format('grant select on storage.%I to anon', t);
    end if;
  end loop;
end $$;

reset role;
commit;
