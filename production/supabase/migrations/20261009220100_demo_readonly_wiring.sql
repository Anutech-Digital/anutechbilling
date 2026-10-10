-- deploy-peek: (exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='demo visitor no insert') and exists(select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname='authenticator' and array_to_string(s.setconfig, ',') like '%demo_pre_request%'))
-- deploy-key: demowiring
-- deploy-user: postgres
-- deploy-skip: R-531 global authenticator pre_request; keep out of every deploy until redesigned
-- 20261009220100_demo_readonly_wiring
--
-- R-524, part 2 of 2 (part 1: 20261009220000_demo_tenant_readonly.sql — run that first).
-- Two things the migration user cannot do on Cloud SQL, so this file runs as postgres:
--
--   1. RESTRICTIVE policies on storage.objects (owned by supabase_storage_admin — same pattern as
--      20261002190000_storage_policies): a demo visitor can never upload, replace or delete a file.
--   2. pgrst.db_pre_request = public.demo_pre_request on the authenticator role, then NOTIFY so
--      PostgREST reloads its config. From then on every request of the demo visitor runs in a
--      READ ONLY transaction. (If PGRST_DB_PRE_REQUEST were ever set in the PostgREST container
--      env it would win over this — it is not set today: supabase/cloudsql/phase2/docker-compose.yml.)
--
-- Idempotent.

begin;

-- ── 4. Storage: no uploads, replacements or deletes for a demo visitor ──────────

-- (EXECUTE on public.is_demo_visitor() was granted to supabase_storage_admin in part 1.)
grant usage on schema public to supabase_storage_admin;

set local role supabase_storage_admin;

drop policy if exists "demo visitor no insert" on storage.objects;
create policy "demo visitor no insert" on storage.objects as restrictive for insert to public
  with check (not (select public.is_demo_visitor()));
drop policy if exists "demo visitor no update" on storage.objects;
create policy "demo visitor no update" on storage.objects as restrictive for update to public
  using (not (select public.is_demo_visitor())) with check (not (select public.is_demo_visitor()));
drop policy if exists "demo visitor no delete" on storage.objects;
create policy "demo visitor no delete" on storage.objects as restrictive for delete to public
  using (not (select public.is_demo_visitor()));

reset role;

-- ── Wire the wall into PostgREST ────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_pre_request to ''public.demo_pre_request''';
  end if;
end $$;

notify pgrst, 'reload config';

commit;
