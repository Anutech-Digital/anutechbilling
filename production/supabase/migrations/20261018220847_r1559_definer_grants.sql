-- deploy-peek: case when to_regclass('public.payment_followups') is null then false else not has_column_privilege('authenticated', 'public.payment_followups', 'created_by', 'UPDATE') end
-- deploy-key: r1559grants
-- ============================================================================
-- R-1559 (19 Oct 2026) — two grant holes found by the 18 Oct security SQL audit.
--
-- (a) payment_followups: R-1515 granted table-level UPDATE to authenticated, and the update
--     policy's WITH CHECK pins only tenant_id. So a sales user could rewrite created_by
--     ("who logged it") and created_at ("when") on their own rows, and an insert could pick
--     its own created_at (back-dated history) — R-1528's trigger guards only assigned_to.
--     Now: column grants. UPDATE only on the fields a follow-up edit changes; INSERT on
--     everything except id and created_at (created_by stays insertable — the insert policy
--     pins it to auth.uid()). service_role (cron/admin) keeps full access.
--
-- (b) login_profile_id_for_email (prisma/migrations/20261009200000_login_profile_lookup):
--     any email → the user id that owns it, across every company. That migration revoked
--     only PUBLIC; on a database where postgres' default privileges hand new functions to
--     anon/authenticated/service_role (supabase/cloudsql/01a-roles-and-auth.sql §5, local
--     Supabase) they could call it too. Only the login role app_auth may
--     (db/ops/21-auth-login-link.sql; src/server/auth/accounts.ts#profileIdForEmail).
--     Also: postgres' default EXECUTE on future public functions for anon/authenticated is
--     removed — staging/live already behave this way (R-401) and every migration since
--     20261001 grants explicitly (src/lib/security/invoker-function-grants.test.ts).
--
-- Test: supabase/tests/r1559_followup_columns_login_grants.test.sql
-- Rollback: grant update, insert on public.payment_followups to authenticated;
--           alter default privileges for role postgres in schema public grant execute on functions to authenticated;
-- ============================================================================

begin;

-- (a) payment_followups column grants
revoke all on public.payment_followups from anon;
revoke insert, update, truncate, references, trigger on public.payment_followups from authenticated;
grant select, delete on public.payment_followups to authenticated;
grant insert (tenant_id, customer_id, invoice_id, quote_id, subscription_id, kind, note,
              promised_amount, promised_on, next_follow_up_on, outcome, assigned_to, created_by)
  on public.payment_followups to authenticated;
grant update (kind, note, promised_amount, promised_on, next_follow_up_on, outcome,
              assigned_to, invoice_id, quote_id, subscription_id)
  on public.payment_followups to authenticated;

-- (b) login lookup: app_auth only
do $$ begin
  if to_regprocedure('public.login_profile_id_for_email(text)') is not null then
    execute 'revoke all on function public.login_profile_id_for_email(text) from public, anon, authenticated, service_role';
    if exists (select 1 from pg_roles where rolname = 'app_auth') then
      execute 'grant execute on function public.login_profile_id_for_email(text) to app_auth';
    end if;
  end if;
end $$;

-- (b) no default EXECUTE for anon/authenticated on future public functions
alter default privileges in schema public revoke execute on functions from anon, authenticated;
do $$ begin
  if current_user = 'postgres' or pg_has_role(current_user, 'postgres', 'member') then
    execute 'alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated';
  end if;
end $$;

commit;
