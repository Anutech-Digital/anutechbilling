-- deploy-peek: (to_regprocedure('public.demo_pre_request()') is null or not has_function_privilege('anon', 'public.demo_pre_request()', 'execute'))
-- deploy-key: demonoanon
-- 20261010030000_demo_pre_request_no_anon
--
-- R-531 (10 Oct 2026). 20261009220000 granted EXECUTE on the security-definer
-- public.demo_pre_request() to anon, because the wiring (20261009220100) runs it
-- before every PostgREST request. That wiring is now deploy-skip until it is redesigned,
-- so nothing needs anon to call it, and the anon_default_privileges suite flags it:
-- "anon can EXECUTE definer functions: demo_pre_request".
-- The redesign grants whatever it needs again.

revoke execute on function public.demo_pre_request() from anon, public;
