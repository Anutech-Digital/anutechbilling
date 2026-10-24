-- deploy-peek: not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'session_mfa_ok' and has_function_privilege('anon', p.oid, 'EXECUTE'))
-- deploy-key: r731mfaokgrants
-- deploy-user: postgres
-- 20261017020500_r731_mfa_ok_grants.sql
--
-- R-731 follow-up: public.session_mfa_ok() is no longer executable by anon / PUBLIC.
--
-- ══ WHY ══════════════════════════════════════════════════════════════════════════
--   20261016103000_r731_session_mfa_ok.sql granted EXECUTE on the helper to PUBLIC. The
--   SQL regression suite (supabase/tests/anon_default_privileges.test.sql, check 3: no
--   public SECURITY DEFINER function outside RLS policy helpers may be anon-executable)
--   has been red in CI since 16 Oct because of that one grant. That pushed file is left
--   untouched; this file replaces the grant with the narrow set the helper actually needs.
--
-- ══ WHO CALLS session_mfa_ok() ═══════════════════════════════════════════════════
--   • public.current_tenant_id() (20261016103100_r731_mfa_tenant.sql) — SECURITY DEFINER,
--     so the inner call runs as ITS OWNER, not as the session role: resellersos_migration on
--     Cloud SQL (staging/live, the default deploy user), postgres locally. The anon /
--     app_anon / app_service branches of current_tenant_id() return NULL without touching
--     the helper, and app_jobs does not call it either — only app_runtime and the
--     GoTrue/PostgREST (auth.uid()) branch do, both via the owner. So anon never needs
--     EXECUTE directly.
--   • The gateway roles (app_runtime / app_jobs / app_service) and authenticated /
--     service_role may call it directly (tests, future policies) — granted explicitly.
--   Roles that do not exist on a given database are skipped (to_regrole guard), so this
--   applies cleanly to local Supabase (no app_* / resellersos_* roles) and to Cloud SQL.
--
-- Runs as postgres (header above) because postgres owns the function: only the owner may change its grants.
-- Idempotent: revoke/grant are repeatable.

begin;

revoke execute on function public.session_mfa_ok() from public, anon;

grant execute on function public.session_mfa_ok() to authenticated, service_role;

do $$
declare r text;
begin
  foreach r in array array['app_runtime', 'app_jobs', 'app_service', 'resellersos_migration', 'resellersos_app']
  loop
    if to_regrole(r) is not null then
      execute format('grant execute on function public.session_mfa_ok() to %I', r);
    end if;
  end loop;
end $$;

-- Fail the apply loudly if anon can still execute the helper.
do $$
begin
  if has_function_privilege('anon', 'public.session_mfa_ok()', 'EXECUTE') then
    raise exception 'R-731: anon still has EXECUTE on public.session_mfa_ok()';
  end if;
end $$;

commit;
