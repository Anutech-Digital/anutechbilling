-- deploy-key: loginlink
-- deploy-peek: exists(select 1 from pg_proc where proname='login_profile_id_for_email' and pronamespace='public'::regnamespace)
-- ============================================================================
-- R-529 (9 Oct 2026): link an Auth.js Google sign-in to the EXISTING profile.
--
-- Staging: Pardeep signed in with Google and got a new auth.users id (6172ee49-…) instead of
-- the id his public.users row (tenant + role) hangs off — empty workspace, "Loading…".
-- src/server/auth/accounts.ts#linkOAuthUser now asks, in order: the Google identity GoTrue
-- linked (auth.identities), the public.users profile that owns the verified email (this
-- function), then auth.users by email — and creates a login only for a brand-new address.
--
-- The login role app_auth has NO access to public tables (db/ops/20-auth-login.sql) and keeps
-- none: this SECURITY DEFINER function answers one question — "which profile id owns this
-- exact email?" — and returns only that id (or null). Execute is granted to app_auth only.
-- The grant is repeated in db/ops/21-auth-login-link.sql for databases where app_auth is
-- created after this migration runs.
--
-- Additive and idempotent. Rollback: drop function public.login_profile_id_for_email(text);
-- ============================================================================

begin;

create or replace function public.login_profile_id_for_email(p_email text) returns uuid
  language sql stable security definer set search_path = ''
as $$
  -- Only an active profile; if one address somehow has several, the oldest (the original).
  select u.id
    from public.users u
   where lower(u.email) = lower(btrim(p_email))
     and u.is_active
   order by u.created_at, u.id
   limit 1;
$$;

comment on function public.login_profile_id_for_email(text) is
  'R-529: for the Auth.js login (app_auth) only — the public.users id that owns this email, so a Google sign-in links to the existing account instead of creating a new one.';

revoke all on function public.login_profile_id_for_email(text) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_auth') then
    execute 'grant execute on function public.login_profile_id_for_email(text) to app_auth';
  end if;
end $$;

commit;
