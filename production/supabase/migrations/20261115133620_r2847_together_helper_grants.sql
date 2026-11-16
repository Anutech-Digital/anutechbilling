-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.r2847_is_together_quote(text)') and not has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute'))
-- deploy-key: r2847togetherhelpergrants
--
-- R-2847 CI fix (15 Nov 2026, SQL tests red on b9eec44a7: anon_default_privileges FAIL 3 and r1560_definer_catalog_guard
-- c_public_execute). The SECURITY DEFINER helper public.r2847_is_together_quote(text) — called by the invoker trigger
-- trg_quotes_renewal_together_guarded — was granted EXECUTE to PUBLIC, so anon could call it. Grants only, no logic:
-- PUBLIC / anon lose EXECUTE; authenticated + service_role keep it (R-2389), and the server login roles that write quotes
-- get it by name where they exist (the R-2485 is_direct_request_login precedent; never app_anon — nobody logged out
-- writes quotes).
begin;

revoke all on function public.r2847_is_together_quote(text) from public, anon;
grant execute on function public.r2847_is_together_quote(text) to authenticated, service_role;

do $$
declare r text;
begin
  foreach r in array array['app_runtime', 'app_jobs', 'app_service', 'resellersos_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function public.r2847_is_together_quote(text) to %I', r);
    end if;
  end loop;
end $$;

commit;
