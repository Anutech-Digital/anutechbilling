-- R-2357 — the R-2017 deploy-peek must run as a role with NO usage on schema storage.
-- Migration: 20261101211500_r2017_storage_anon_grants.sql (its `-- deploy-peek:` line).
--
-- 2 Nov 2026 the staging DB step stopped silently at step 2: the deploy script reads every
-- migration's peek in ONE import as resellersos_migration, which has no USAGE on schema storage.
-- The old R-2017 peek named the table as text — to_regclass('storage.objects') and
-- has_table_privilege('anon', 'storage.objects', …) — and a qualified name lookup needs schema
-- USAGE: "ERROR: permission denied for schema storage", no PEEK line, nothing applied.
-- The new peek finds the table by OID through pg_class/pg_namespace (catalogs every role can
-- read) and asks has_table_privilege(role oid, table oid, …), which needs no schema USAGE.
--
--   1. the old peek, run as such a role, fails with 42501 (the bug, reproduced);
--   2. the new peek, run as that role, returns a boolean, and the same answer the old one gives
--      as postgres (who has USAGE) — today true locally (R-2017 applied);
--   3. anon given INSERT back on storage.objects → the new peek reads false (not applied);
--   4. storage.objects absent → true (nothing to revoke).
-- With the OLD peek text in place of PEEK_NEW below, case 2 fails (proved 2 Nov, see R-2357).
--
-- tests/r2357-deploy-db-peek.test.ts proves the PEEK_NEW line below is byte-identical to the
-- migration's header.
--
-- SAFETY: a throwaway role + catalog reads; one transaction ending in ROLLBACK.

begin;

create role r2357_no_storage_usage nologin;
grant r2357_no_storage_usage to current_user;

create function pg_temp.r2357_old() returns boolean language sql as $f$
  select (to_regclass('storage.objects') is not null and not has_table_privilege('anon', 'storage.objects', 'INSERT') and not has_table_privilege('anon', 'storage.objects', 'TRUNCATE') and not has_table_privilege('authenticated', 'storage.objects', 'TRUNCATE'))
$f$;
create function pg_temp.r2357_new() returns boolean language sql as $f$
  select
-- PEEK_NEW
not exists(select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.rolname in ('anon', 'authenticated') where n.nspname = 'storage' and c.relname = 'objects' and (has_table_privilege(r.oid, c.oid, 'TRUNCATE') or (r.rolname = 'anon' and has_table_privilege(r.oid, c.oid, 'INSERT'))))
$f$;
grant execute on function pg_temp.r2357_old() to r2357_no_storage_usage;
grant execute on function pg_temp.r2357_new() to r2357_no_storage_usage;

do $$
begin
  if has_schema_privilege('r2357_no_storage_usage', 'storage', 'USAGE') then
    raise exception 'SETUP: the test role has USAGE on schema storage (PUBLIC grant?) — this test would prove nothing';
  end if;
  perform set_config('r2357.expected', pg_temp.r2357_old()::text, true);
end $$;

-- ── 1 + 2. as a role without storage USAGE ──────────────────────────────────────────
set local role r2357_no_storage_usage;
do $$
declare v boolean;
begin
  begin
    perform pg_temp.r2357_old();
    raise exception 'FAIL 1: the old peek ran without schema USAGE — the reproduction is gone';
  exception when insufficient_privilege then
    raise notice 'PASS 1: old peek as a no-USAGE role: permission denied for schema storage (the 2 Nov bug)';
  end;

  v := pg_temp.r2357_new();   -- an error here is the 2 Nov bug: the whole PEEK import fails
  if v is null then raise exception 'FAIL 2: new peek returned NULL'; end if;
  if v::text <> current_setting('r2357.expected') then
    raise exception 'FAIL 2: new peek says % but the old one (as postgres) says %', v, current_setting('r2357.expected');
  end if;
  raise notice 'PASS 2: new peek as a no-USAGE role = % (same as the old peek with USAGE)', v;
end $$;
reset role;

-- ── 3. anon gets INSERT back → not applied ──────────────────────────────────────────
do $$
declare v_owner name;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'storage.objects'::regclass;
  execute format('set local role %I', v_owner);
  grant insert on storage.objects to anon;
  reset role;
end $$;
set local role r2357_no_storage_usage;
do $$
begin
  if pg_temp.r2357_new() then raise exception 'FAIL 3: anon has INSERT on storage.objects but the peek says applied'; end if;
  raise notice 'PASS 3: anon INSERT → peek false';
end $$;
reset role;

-- ── 4. no storage.objects → true ────────────────────────────────────────────────────
do $$
declare v_owner name;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'storage.objects'::regclass;
  execute format('set local role %I', v_owner);
  alter table storage.objects rename to objects_r2357_gone;
  reset role;
end $$;
set local role r2357_no_storage_usage;
do $$
begin
  if not pg_temp.r2357_new() then raise exception 'FAIL 4: no storage.objects, peek should be true (nothing to revoke)'; end if;
  raise notice 'PASS 4: no storage.objects → peek true';
end $$;
reset role;

rollback;
