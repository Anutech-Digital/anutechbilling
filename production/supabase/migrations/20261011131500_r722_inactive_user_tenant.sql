-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.current_tenant_id()') and prosrc like '%R-722%')
-- deploy-key: r722active
-- 20261011131500_r722_inactive_user_tenant.sql
--
-- R-722 (P1, security audit 10 Oct): a deactivated member kept everything.
--
-- ══ THE HOLE ═════════════════════════════════════════════════════════════════════
--   current_tenant_id() — the helper behind almost every tenant RLS policy and most SECURITY
--   DEFINER guards — answered `select tenant_id from users where id = auth.uid()` and never
--   looked at users.is_active. So an owner switching a member off changed nothing: while their
--   login lived, the member could still read and change every lead, invoice, customer …
--   (current_user_has_role() and current_user_is_owner() already required is_active; the
--   plain tenant check did not.)
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   current_tenant_id() is NULL unless the user row is ACTIVE. NULL matches no tenant_id, so
--   every `tenant_id = current_tenant_id()` policy gives a deactivated member 0 rows and refuses
--   their writes, and definers that check it raise / return nothing.
--   The body is the NEWEST one (prisma 20261005150000_gateway_logins: app_runtime / app_jobs /
--   app_service / app_anon branches for the R-161 data gateway), each user lookup now with
--   `and u.is_active`. app_jobs WITHOUT a user (background work for a tenant) is unchanged.
--   Kept: STABLE, SECURITY DEFINER, search_path '' and the existing grants (create or replace).
--
--   Not touched on purpose: users_self_read (id = auth.uid()) — the app reads the member's own
--   row to see is_active and sign them out (src/middleware.ts, R-722); R-712's guard already
--   stops a deactivated owner from switching themselves back on.
--
-- Staging's apply() rewrites auth.uid() → public.current_user_id(), so it is written plainly.
-- Idempotent: create or replace.

begin;

create or replace function public.current_tenant_id() returns uuid
  language sql stable security definer set search_path = ''
as $$
  /* R-722: an inactive user (users.is_active = false) has no tenant — every policy built on
     this gives them nothing. */
  select case
    when session_user = 'app_runtime' then (
      select u.tenant_id from public.users u
       where u.id = nullif(current_setting('app.user_id', true), '')::uuid
         and u.is_active
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
    else (select u.tenant_id from public.users u where u.id = auth.uid() and u.is_active limit 1)
  end;
$$;

comment on function public.current_tenant_id() is
  'Tenant of the signed-in user — NULL when there is none or the user is deactivated (R-722).';

commit;
