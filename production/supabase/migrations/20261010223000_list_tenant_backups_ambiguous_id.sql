-- deploy-key: backuplistid
-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.list_tenant_backups()') and prosrc like '%R-823%')
-- 20261010223000_list_tenant_backups_ambiguous_id.sql
--
-- R-823 (p1 bug, Pawan on staging, 10 Oct 2026): Settings → Backup & Restore never shows
-- its list. POST /api/sb/rest/v1/rpc/list_tenant_backups → HTTP 400.
--
-- WHAT WAS BROKEN
--   20260930175000_role_hardening rewrote list_tenant_backups() as plpgsql with
--       returns table(id uuid, created_at …, …)
--   and looked the caller's tenant up with
--       (select tenant_id from public.users where id = auth.uid())
--   In plpgsql every RETURNS TABLE column is also a variable, so the bare `id` matches both
--   the OUT column and users.id and Postgres refuses the query on every call:
--       42702 column reference "id" is ambiguous
--   PostgREST and the R-161 gateway both map SQLSTATE 42xxx to HTTP 400. It was not the
--   gateway (no allow-list, empty body is accepted) and it was never role/claims: the
--   function failed for every caller, owner included, on every database that has the
--   backup schema (local Supabase has no backup schema, so it showed 404 there, not 400).
--   The other four backup RPCs return jsonb/void — no OUT columns, nothing to collide with.
--   A plpgsql_check sweep of every plpgsql function in public found no other 42702.
--
-- THE FIX
--   Same function, same guard, same tenant rule — every column reference qualified.
--   Tenant isolation is unchanged and fails closed: no public.users row for auth.uid()
--   → tenant null → `s.tenant_id = null` → no rows. Owner-only guard stays first.
--
-- Test: supabase/tests/list_tenant_backups.test.sql

begin;

create or replace function public.list_tenant_backups()
returns table(id uuid, created_at timestamp with time zone, label text, kind text, table_count integer, bytes integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- R-823: every column qualified — a bare `id` collides with the RETURNS TABLE column (42702).
  perform public.guard_backup_owner_only();
  return query
    select s.id, s.created_at, s.label, s.kind, s.table_count, length(s.payload::text)
      from backup.snapshots s
     where s.tenant_id = (select u.tenant_id from public.users u where u.id = auth.uid())
     order by s.created_at desc;
end $function$;

revoke all on function public.list_tenant_backups() from public, anon;
grant execute on function public.list_tenant_backups() to authenticated, service_role;

commit;
