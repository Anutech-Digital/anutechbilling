-- R-529 (9 Oct 2026) — let the Auth.js login find the EXISTING account. Run ONCE per database
-- as an admin (Cloud SQL: `postgres`), AFTER prisma migration 20261009200000_login_profile_lookup.
-- No password, no secrets; safe to run again.
--
--   psql "<admin url>" -f db/ops/21-auth-login-link.sql
--
-- What app_auth gains (src/server/auth/accounts.ts#linkOAuthUser):
--   · SELECT on auth.identities — the Google identity (provider + sub) GoTrue linked to a login,
--     so a Google sign-in lands on the same auth.users id GoTrue used.
--   · EXECUTE on public.login_profile_id_for_email(text) (+ USAGE on schema public to call it) —
--     returns only the public.users id that owns an email. Still NO grant on any public table;
--     the check at the end (same as 20-auth-login.sql) refuses to finish otherwise.
-- Until this runs, the login falls back to auth.users-by-email (logs "[auth] … unavailable").

set role supabase_auth_admin;
grant select on auth.identities to app_auth;
reset role;

grant usage on schema public to app_auth;
grant execute on function public.login_profile_id_for_email(text) to app_auth;

do $$
begin
  if exists (select 1 from information_schema.role_table_grants
              where grantee = 'app_auth' and table_schema = 'public') then
    raise exception 'app_auth must not have grants on public tables';
  end if;
  if not has_function_privilege('app_auth', 'public.login_profile_id_for_email(text)', 'execute') then
    raise exception 'app_auth cannot execute public.login_profile_id_for_email';
  end if;
  if not has_table_privilege('app_auth', 'auth.identities', 'select') then
    raise exception 'app_auth cannot read auth.identities';
  end if;
  raise notice 'R-529 login link grants OK';
end $$;
