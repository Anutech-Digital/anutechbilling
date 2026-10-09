-- deploy-key: svcrolegaps
-- deploy-peek: exists(select 1 from pg_policies where schemaname='public' and tablename='seat_increase_claims' and policyname='zzz_service_role_all') and exists(select 1 from pg_policies where schemaname='public' and tablename='rate_limit_buckets' and policyname='zzz_service_role_all')
-- 20261009150000_service_role_policy_gaps  (R-484 / R-450)
--
-- WHAT WAS WRONG
--   Subscriptions → Manage seats → "Add 5 seats" did nothing, and the server logged a 503:
--   "new row violates row-level security policy for table seat_increase_claims".
--   The add-seats route writes its idempotency claim with the service-role client. On
--   Cloud SQL (staging/live) no role may have BYPASSRLS, so service_role needs its own
--   permissive policy on every table — supabase/cloudsql/01b-grants-and-policies.sql added
--   `zzz_service_role_all` to every table that existed on 6 Sep 2026, once. Tables made
--   after that must bring their own, and two did not:
--     seat_increase_claims  (20260930177000) — only a SELECT policy for the browser.
--     rate_limit_buckets    (20260928140000) — no policy at all. Today only the SECURITY
--                           DEFINER rate_limit_hit() touches it (runs as the owner), so this
--                           one is for consistency; no new grant is given.
--
-- THE GUARD
--   src/lib/security/service-role-policies.test.ts fails a push when a new RLS table has no
--   service_role policy, so the next table cannot repeat this.
--
-- Policies only. No data changes, no grants widened. Re-runnable.

begin;

drop policy if exists zzz_service_role_all on public.seat_increase_claims;
create policy zzz_service_role_all on public.seat_increase_claims
  as permissive for all to service_role using (true) with check (true);

drop policy if exists zzz_service_role_all on public.rate_limit_buckets;
create policy zzz_service_role_all on public.rate_limit_buckets
  as permissive for all to service_role using (true) with check (true);

commit;
