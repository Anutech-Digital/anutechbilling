-- Regression test: anon default privileges (migration 20260927280000).
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/anon_default_privileges.test.sql
--
-- What it proves:
--   1. A brand-new SECURITY DEFINER function is NOT anon-executable by default any more.
--   2. A brand-new table is NOT anon-readable by default.
--   3. No existing public definer function (outside RLS policy helpers) is anon-executable.
--   4. schema_one_off_fixes has RLS and anon cannot select from it.
--   5. authenticated still receives its defaults (a new function is callable) — the change
--      is scoped to anon.

begin;

create function public.__t_definer_probe() returns int language sql security definer as 'select 1';
create table public.__t_table_probe (id int);

do $$
declare
  v_policy_fns text[];
  v_bad text;
begin
  -- 1
  if has_function_privilege('anon', 'public.__t_definer_probe()', 'EXECUTE') then
    raise exception 'FAIL 1: anon can EXECUTE a freshly created definer function';
  end if;
  -- 5
  -- R-401: only where the DB hands authenticated a default at all. CI's Cloud SQL emulation
  -- (sql-tests.yml) revokes every function default, as staging/live have none.
  if exists (select 1 from pg_default_acl d
              where d.defaclrole = 'postgres'::regrole and d.defaclobjtype = 'f'
                and d.defaclnamespace = 'public'::regnamespace
                and d.defaclacl::text like '%authenticated=X%')
     and not has_function_privilege('authenticated', 'public.__t_definer_probe()', 'EXECUTE') then
    raise exception 'FAIL 5: authenticated lost its default EXECUTE';
  end if;
  -- 2
  if has_table_privilege('anon', 'public.__t_table_probe', 'SELECT') then
    raise exception 'FAIL 2: anon can SELECT a freshly created table';
  end if;
  -- 3
  select coalesce(array_agg(distinct m[1]), '{}') into v_policy_fns
    from pg_policy pol,
         regexp_matches(
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
           '(?:public\.)?([a-z_]+)\(', 'g') m;
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname not like '\_\_t\_%'
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not (p.proname = any (v_policy_fns));
  if v_bad is not null then
    raise exception 'FAIL 3: anon can EXECUTE definer functions: %', v_bad;
  end if;
  -- 4
  if not (select relrowsecurity from pg_class where oid = 'public.schema_one_off_fixes'::regclass) then
    raise exception 'FAIL 4: schema_one_off_fixes has no RLS';
  end if;
  if has_table_privilege('anon', 'public.schema_one_off_fixes', 'SELECT') then
    raise exception 'FAIL 4: anon can SELECT schema_one_off_fixes';
  end if;
  raise notice 'anon default privileges: all checks passed';
end $$;

rollback;
