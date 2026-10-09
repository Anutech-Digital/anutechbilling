-- deploy-key: hierarchysvc
-- deploy-peek: coalesce(position('service_role' in pg_get_functiondef(to_regprocedure('public.hierarchy_sees_all()'))) > 0, false)
-- 20261009200000_hierarchy_service_role
--
-- R-458 (Abhishek's audit, Scenario 13, 8 Oct 2026)
--
-- WHAT WAS BROKEN
--   On the R-161 stack (Auth.js + /api/sb gateway; createAdminClient() logs in as
--   app_service, NOBYPASSRLS) and equally on Cloud SQL (service_role has no BYPASSRLS),
--   the RESTRICTIVE policies {leads,quotes,customers}_hierarchy_{select,write,delete}
--   are evaluated for the service connection too. They let a row through when
--       owner_id is null  or  hierarchy_sees_all()  or  owner_id = any(visible_owner_ids())
--   hierarchy_sees_all() looks the caller up in public.users by auth.uid(); the service
--   connection has no user → false, and visible_owner_ids() is empty → every row WITH an
--   owner was hidden from every server-side read: lead drawer → Email answered
--   "That lead no longer exists" (404), crons / webhooks / post-payment work saw nothing.
--   On hosted Supabase service_role had BYPASSRLS, so this never showed there.
--
-- THE FIX
--   hierarchy_sees_all() also returns true when the request role is service_role.
--   The reporting tree is a rule about which SALES PEOPLE see which pipeline; the
--   service key has always meant "server code, no user" and was never meant to be
--   scoped by it (it was not, on Supabase). Nothing changes for any user:
--     • manager-pardeep / hosted Supabase: auth.role() comes from the verified JWT —
--       only the service key carries role service_role.
--     • staging / Cloud SQL (R-161): the deploy script rewrites auth.role() →
--       public.current_request_role(), which answers from session_user: only the
--       app_service login is 'service_role'; app_runtime is always 'authenticated',
--       whatever request.jwt.claims says.
--   A sales user still sees only their own + their reports' records; owner/admin and
--   portal customers are unchanged (same two branches as before, first in the OR).
--
-- `create or replace` keeps the function's existing grants; the grant below only makes
-- sure the two roles that evaluate the policies can execute it (never anon here).
-- Test: supabase/tests/hierarchy_service_role.test.sql (rolled back).

create or replace function public.hierarchy_sees_all() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select public.current_customer_id() is not null
      or exists (select 1 from public.users u
                  where u.id = auth.uid()
                    and u.role not in ('sales','sales_senior','manager'))
      or coalesce(auth.role() = 'service_role', false)
$$;

comment on function public.hierarchy_sees_all() is
  'True when the caller is NOT scoped by the reporting tree: a portal customer, a staff role other than sales/sales_senior/manager, or the service connection (request role service_role, R-458). Zero-argument so RLS can evaluate it once per query as an InitPlan: (select public.hierarchy_sees_all()).';

grant execute on function public.hierarchy_sees_all() to authenticated, service_role;
