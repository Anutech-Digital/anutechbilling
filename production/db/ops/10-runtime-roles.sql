-- Run ONCE per database as an admin (Cloud SQL: `postgres`), BEFORE the app uses Prisma.
-- Not a migration: it needs CREATEROLE and passwords, and passwords never go in git.
--
--   psql "<admin url>" -v runtime_pw="'...'" -v jobs_pw="'...'" -v anon_pw="'...'" \
--        -v service_pw="'...'" -f db/ops/10-runtime-roles.sql
--
-- app_runtime — the web app, signed-in users (Cloud Run `resellersos`). DATABASE_URL.
-- app_jobs    — background jobs only (separate Cloud Run service). JOBS_DATABASE_URL.
-- app_anon    — gateway, signed-out visitors. ANON_DATABASE_URL.
-- app_service — gateway, what the service-role key / createAdminClient is today.
--               SERVICE_DATABASE_URL. Temporary: shrinks as admin call sites move to withTenant.
--
-- app_runtime and app_jobs are members of `authenticated`, app_anon of `anon`, app_service of
-- `service_role` — so the existing policies and grants apply to each exactly as they apply to
-- the matching PostgREST role. None may own a table, be a superuser or have BYPASSRLS; the
-- last block refuses to finish otherwise, and tests/isolation re-checks it on every run.

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

alter role app_runtime with password :runtime_pw;
alter role app_jobs    with password :jobs_pw;
alter role app_anon    with password :anon_pw;
alter role app_service with password :service_pw;

grant authenticated to app_runtime, app_jobs;
grant anon to app_anon;
grant service_role to app_service;
grant usage on schema public, auth, storage to app_runtime, app_jobs, app_anon, app_service;

-- A request that hangs must not hold a row lock forever (record_payment locks quotes).
alter role app_runtime set statement_timeout = '30s';
alter role app_jobs    set statement_timeout = '120s';
alter role app_anon    set statement_timeout = '15s';
alter role app_service set statement_timeout = '120s';
alter role app_runtime set idle_in_transaction_session_timeout = '60s';
alter role app_jobs    set idle_in_transaction_session_timeout = '60s';
alter role app_anon    set idle_in_transaction_session_timeout = '60s';
alter role app_service set idle_in_transaction_session_timeout = '60s';

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
