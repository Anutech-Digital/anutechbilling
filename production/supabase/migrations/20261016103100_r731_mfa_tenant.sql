-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.current_tenant_id()') and prosrc like '%R-731%')
-- deploy-key: r731mfadata
-- 20261016103100_r731_mfa_tenant.sql
--
-- R-731 (P1 SECURITY, launch blocker) — part 2 of 2: current_tenant_id() is NULL for an
-- MFA-enrolled user whose session has not passed the second step.
--
-- current_tenant_id() sits behind almost every tenant RLS policy and most SECURITY DEFINER
-- guards (R-722 made it NULL for a deactivated member the same way). NULL matches no tenant_id,
-- so a password-only session of an MFA user reads 0 rows and cannot write — on every table, from
-- one place — until /mfa verifies the code and the session is aal2.
--
-- Body = the NEWEST one (20261011131500_r722_inactive_user_tenant.sql), with
-- public.session_mfa_ok() (part 1, owned by postgres) required on the two paths a browser session
-- takes: app_runtime (R-161 gateway + withTenant, app.aal) and the GoTrue/PostgREST path
-- (request.jwt.claims). Not required for app_jobs (background work for a tenant — no browser
-- session, no aal) and app_service / app_anon (NULL already; service_role is trusted, R-454).
-- Kept: STABLE, SECURITY DEFINER, search_path '', existing grants (create or replace).
-- Non-MFA users: session_mfa_ok() is true — unchanged.
--
-- Staging's apply() rewrites auth.uid() → public.current_user_id(), so it is written plainly.
-- Idempotent: create or replace.

begin;

create or replace function public.current_tenant_id() returns uuid
  language sql stable security definer set search_path = ''
as $$
  /* R-722: an inactive user (users.is_active = false) has no tenant — every policy built on
     this gives them nothing.
     R-731: an MFA-enrolled user whose session is not aal2 has no tenant either
     (public.session_mfa_ok()). */
  select case
    when session_user = 'app_runtime' then (
      select u.tenant_id from public.users u
       where u.id = nullif(current_setting('app.user_id', true), '')::uuid
         and u.is_active
         and public.session_mfa_ok()
         and (nullif(current_setting('app.tenant_id', true), '') is null
              or u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
       limit 1)
    when session_user = 'app_jobs' then
      case when nullif(current_setting('app.user_id', true), '') is null
        then nullif(current_setting('app.tenant_id', true), '')::uuid
        else (select u.tenant_id from public.users u
               where u.id = nullif(current_setting('app.user_id', true), '')::uuid
                 and u.is_active
                 and u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
               limit 1)
      end
    when session_user in ('app_service', 'app_anon') then null
    else (select u.tenant_id from public.users u
           where u.id = auth.uid() and u.is_active and public.session_mfa_ok() limit 1)
  end;
$$;

comment on function public.current_tenant_id() is
  'Tenant of the signed-in user — NULL when there is none, the user is deactivated (R-722), or MFA is enrolled and this session is not aal2 (R-731).';

commit;
