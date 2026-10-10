-- Run ONCE per database as an admin (Cloud SQL: `postgres`), before switching login to Auth.js
-- (AUTH_PROVIDER=authjs). Not a migration: needs CREATEROLE, a password, and rights on the
-- `auth` schema, which belongs to GoTrue's role (supabase_auth_admin), not to the migrator.
--
--   psql "<admin url>" -v auth_pw="'...'" -f db/ops/20-auth-login.sql
--
-- app_auth — used ONLY by src/server/auth (AUTH_DATABASE_URL): read/write accounts and
-- two-step factors in GoTrue's own tables (auth.users, auth.mfa_factors). Same tables GoTrue
-- uses, so switching back to GoTrue keeps every account and password. It has no access to
-- the app's tables at all, and no role memberships.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_auth') then
    create role app_auth login noinherit nobypassrls nocreatedb nocreaterole;
  end if;
end $$;
alter role app_auth with password :auth_pw;
alter role app_auth set statement_timeout = '15s';
alter role app_auth set idle_in_transaction_session_timeout = '30s';

-- The grants must come from the owner of the auth tables (cloudsql/06 gave postgres this role).
set role supabase_auth_admin;
grant usage on schema auth to app_auth;
grant select, insert, update, delete on auth.users to app_auth;
grant select, insert, update, delete on auth.mfa_factors to app_auth;
reset role;

do $$
declare bad text;
begin
  if exists (select 1 from pg_roles where rolname = 'app_auth' and (rolsuper or rolbypassrls)) then
    raise exception 'app_auth must not be superuser or bypass RLS';
  end if;
  select string_agg(r.rolname, ', ') into bad from pg_auth_members am
    join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member
   where m.rolname = 'app_auth';
  if bad is not null then raise exception 'app_auth must not belong to any role: %', bad; end if;
  if exists (select 1 from information_schema.role_table_grants
              where grantee = 'app_auth' and table_schema = 'public') then
    raise exception 'app_auth must not have grants on public tables';
  end if;
end $$;
