-- R-1901 (25 Oct 2026): public.current_user_id() / public.current_request_role() must exist on a
-- database built from supabase/migrations alone (CI, local, LIVE deploy-db) — six 24 Oct
-- migrations (r1863, r1866, r1864, r1867, r1877, r1891) call them. Before
-- 20261025065946_r1901_request_context_helpers.sql they came only from prisma/migrations, so CI
-- failed 10 files with "function public.current_request_role() does not exist".
--
-- Proves: both helpers exist, match the Prisma definition's shape (stable, NOT security definer,
-- search_path = ''), are executable by authenticated/service_role (CI emulates Cloud SQL,
-- where only explicit grants count; anon is deliberately not granted, R-013), and — for a non-app_* login — return exactly what
-- auth.uid() / auth.role() return (the Supabase fallback). Rolled back; touches no data.
begin;

do $$
declare
  v_uid  uuid := '7e57e57e-1901-4000-8000-000000000001';
  v_fn   text;
  v_role text;
  r      record;
begin
  -- 1. Both exist.
  if to_regprocedure('public.current_user_id()') is null then
    raise exception 'R-1901 FAIL: public.current_user_id() does not exist';
  end if;
  if to_regprocedure('public.current_request_role()') is null then
    raise exception 'R-1901 FAIL: public.current_request_role() does not exist';
  end if;

  -- 2. Same shape as prisma 20261005150000_gateway_logins.
  for r in
    select p.proname, p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) as res
      from pg_proc p
     where p.oid in (to_regprocedure('public.current_user_id()'), to_regprocedure('public.current_request_role()'))
  loop
    if r.prosecdef then
      raise exception 'R-1901 FAIL: % must not be security definer', r.proname;
    end if;
    if r.provolatile <> 's' then
      raise exception 'R-1901 FAIL: % must be stable (got %)', r.proname, r.provolatile;
    end if;
    if r.proconfig is null or not (r.proconfig @> array['search_path=""']) then
      raise exception 'R-1901 FAIL: % must set search_path = '''' (got %)', r.proname, r.proconfig;
    end if;
    if r.proname = 'current_user_id' and r.res <> 'uuid' then
      raise exception 'R-1901 FAIL: current_user_id() must return uuid (got %)', r.res;
    end if;
    if r.proname = 'current_request_role' and r.res <> 'text' then
      raise exception 'R-1901 FAIL: current_request_role() must return text (got %)', r.res;
    end if;
  end loop;

  -- 3. Explicit grants (Cloud SQL / CI emulation gives no default EXECUTE).
  foreach v_role in array array['authenticated', 'service_role'] loop
    if not has_function_privilege(v_role, 'public.current_user_id()', 'execute')
       or not has_function_privilege(v_role, 'public.current_request_role()', 'execute') then
      raise exception 'R-1901 FAIL: % cannot execute the request-context helpers', v_role;
    end if;
  end loop;

  -- 4. Supabase fallback: a signed-in PostgREST caller.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  if public.current_user_id() is distinct from v_uid then
    raise exception 'R-1901 FAIL: current_user_id() = %, expected the JWT sub % (auth.uid() fallback)',
      public.current_user_id(), v_uid;
  end if;
  if public.current_user_id() is distinct from auth.uid() then
    raise exception 'R-1901 FAIL: current_user_id() differs from auth.uid()';
  end if;
  v_fn := public.current_request_role();
  if v_fn is distinct from 'authenticated' or v_fn is distinct from auth.role() then
    raise exception 'R-1901 FAIL: current_request_role() = %, expected authenticated (auth.role() fallback)', v_fn;
  end if;

  -- 5. The service-role key: no user, role service_role (what the six RPCs' v_trusted check reads).
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  if public.current_user_id() is not null then
    raise exception 'R-1901 FAIL: service_role caller must have no user id (got %)', public.current_user_id();
  end if;
  if public.current_request_role() is distinct from 'service_role' then
    raise exception 'R-1901 FAIL: current_request_role() = %, expected service_role', public.current_request_role();
  end if;

  -- 6. No JWT at all (a direct DB login such as the migrator): both NULL, never a guessed role.
  perform set_config('request.jwt.claims', '', true);
  if public.current_user_id() is not null or public.current_request_role() is not null then
    raise exception 'R-1901 FAIL: with no JWT both helpers must be NULL (got %, %)',
      public.current_user_id(), public.current_request_role();
  end if;

  raise notice 'R-1901 PASS: request-context helpers exist, granted, auth.uid()/auth.role() fallback';
end $$;

-- 7. Callable AS the authenticated role (the grant really works, not just has_function_privilege).
select set_config('request.jwt.claims',
  json_build_object('sub', '7e57e57e-1901-4000-8000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if public.current_user_id() is distinct from '7e57e57e-1901-4000-8000-000000000002'::uuid
     or public.current_request_role() is distinct from 'authenticated' then
    raise exception 'R-1901 FAIL: as role authenticated the helpers returned %, %',
      public.current_user_id(), public.current_request_role();
  end if;
end $$;
reset role;

rollback;
