-- LOCAL ONLY (R-1837, 24 Oct 2026). Lets the Prisma path (withTenant / dbFor / gateway / jobs)
-- run against the LOCAL Supabase stack (`npx supabase start`, container supabase_db_<project>,
-- port 54322) exactly as it runs on staging and live. NEVER run against staging or live:
-- production created these roles with real passwords (db/ops/10-runtime-roles.sql) and got the
-- helpers + rewrite from prisma/migrations/20261005120000_tenant_context and
-- 20261005150000_gateway_logins.
--
-- `npm run dev:local` runs this on every start (scripts/dev-local.mjs), only after it has
-- checked that `supabase status` points at localhost. Safe to run again: every step is
-- "create if missing" or a rewrite that finds nothing the second time.
--
-- Why it is needed: the local Supabase stack is built from supabase/migrations only, so
--   · the app_* logins do not exist (dev:local had no DATABASE_URL → every withTenant route
--     answered 500 "db: DATABASE_URL is not set");
--   · current_user_id() / current_request_role() were hand-made shims that read the JWT only;
--   · ~60 policies and ~190 functions still read auth.uid() / auth.role() directly, which is
--     NULL for an app_runtime connection (no JWT) — e.g. current_user_has_role(), so the
--     Marketing budget and Cold calling policies refused every row.
-- Local passwords are all "localdev", same as db/local/build.sh.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < production/db/local/supabase-stack-runtime.sql

begin;

-- ─── 1. Logins (same attributes and memberships as db/ops/10-runtime-roles.sql) ──────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime login inherit nobypassrls nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_jobs') then
    create role app_jobs login inherit nobypassrls nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_anon') then
    create role app_anon login inherit nobypassrls nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_service') then
    create role app_service login inherit nobypassrls nocreatedb nocreaterole;
  end if;
end $$;

alter role app_runtime with password 'localdev';
alter role app_jobs    with password 'localdev';
alter role app_anon    with password 'localdev';
alter role app_service with password 'localdev';

grant authenticated to app_runtime, app_jobs;
grant anon to app_anon;
grant service_role to app_service;
grant usage on schema public, auth, storage to app_runtime, app_jobs, app_anon, app_service;

alter role app_runtime set statement_timeout = '30s';
alter role app_jobs    set statement_timeout = '120s';
alter role app_anon    set statement_timeout = '15s';
alter role app_service set statement_timeout = '120s';
alter role app_runtime set idle_in_transaction_session_timeout = '60s';
alter role app_jobs    set idle_in_transaction_session_timeout = '60s';
alter role app_anon    set idle_in_transaction_session_timeout = '60s';
alter role app_service set idle_in_transaction_session_timeout = '60s';

-- ─── 2. Helpers — the production bodies (prisma 20261005150000_gateway_logins) ──────────
-- PostgREST callers (session_user = authenticator) still get auth.uid() / auth.role(), so the
-- supabase-js path behaves exactly as before.
create or replace function public.current_user_id() returns uuid
  language sql stable set search_path = ''
as $$
  select case
    when session_user in ('app_runtime', 'app_jobs')
      then nullif(current_setting('app.user_id', true), '')::uuid
    when session_user in ('app_service', 'app_anon') then null
    else auth.uid()
  end;
$$;

create or replace function public.current_request_role() returns text
  language sql stable set search_path = ''
as $$
  select case session_user
    when 'app_runtime' then 'authenticated'
    when 'app_jobs'    then 'app_jobs'
    when 'app_service' then 'service_role'
    when 'app_anon'    then 'anon'
    else auth.role()
  end;
$$;

grant execute on function public.current_user_id(), public.current_request_role()
  to anon, authenticated, service_role;

-- ─── 3. The tenant_context rewrite, done live (prisma 20261005120000 did it from a file) ──
-- Only the tokens auth.uid() → public.current_user_id() and auth.role() →
-- public.current_request_role() change. current_tenant_id() already has its app_runtime branch.
do $$
declare r record; n_fn int := 0; n_pol int := 0; def text; q text; c text; stmt text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.prokind in ('f', 'p')
       and p.prosrc ~* 'auth\.(uid|role)\(\)'
       and p.proname not in ('current_user_id', 'current_request_role', 'current_tenant_id')
  loop
    def := pg_get_functiondef(r.oid);
    def := regexp_replace(def, 'auth\.uid\(\)', 'public.current_user_id()', 'gi');
    def := regexp_replace(def, 'auth\.role\(\)', 'public.current_request_role()', 'gi');
    execute def;
    n_fn := n_fn + 1;
  end loop;

  for r in
    select schemaname, tablename, policyname, qual, with_check from pg_policies
     where schemaname = 'public'
       and coalesce(qual, '') || coalesce(with_check, '') ~* 'auth\.(uid|role)\(\)'
  loop
    q := regexp_replace(regexp_replace(r.qual, 'auth\.uid\(\)', 'public.current_user_id()', 'gi'),
                        'auth\.role\(\)', 'public.current_request_role()', 'gi');
    c := regexp_replace(regexp_replace(r.with_check, 'auth\.uid\(\)', 'public.current_user_id()', 'gi'),
                        'auth\.role\(\)', 'public.current_request_role()', 'gi');
    stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if q is not null then stmt := stmt || format(' using (%s)', q); end if;
    if c is not null then stmt := stmt || format(' with check (%s)', c); end if;
    execute stmt;
    n_pol := n_pol + 1;
  end loop;

  raise notice 'R-1837 local: % functions and % policies moved to current_user_id()/current_request_role()', n_fn, n_pol;
end $$;

-- ─── 4. Same safety checks as production ─────────────────────────────────────────────────
do $$
declare bad text;
begin
  select string_agg(rolname, ', ') into bad from pg_roles
   where rolname in ('app_runtime', 'app_jobs', 'app_anon', 'app_service') and (rolsuper or rolbypassrls);
  if bad is not null then raise exception 'unsafe role attributes: %', bad; end if;

  select string_agg(m.rolname || ' in ' || r.rolname, ', ') into bad
    from pg_auth_members am
    join pg_roles r on r.oid = am.roleid
    join pg_roles m on m.oid = am.member
   where (m.rolname in ('app_runtime', 'app_jobs') and r.rolname <> 'authenticated')
      or (m.rolname = 'app_anon' and r.rolname <> 'anon')
      or (m.rolname = 'app_service' and r.rolname <> 'service_role');
  if bad is not null then raise exception 'unexpected role membership: %', bad; end if;

  if exists (select 1 from pg_class where relowner in
             (select oid from pg_roles where rolname in ('app_runtime', 'app_jobs', 'app_anon', 'app_service'))) then
    raise exception 'app_* logins must not own any relation';
  end if;
end $$;

commit;
