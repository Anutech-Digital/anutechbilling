-- deploy-key: trghelpers
-- deploy-peek: has_function_privilege('authenticated', 'public.ad_channel_guess(text)', 'execute') and has_function_privilege('authenticated', 'public.referral_code_slug(text)', 'execute')
-- ============================================================================
-- R-401 follow-up (7 Oct 2026): same trap as R-400, older code.
--
-- The R-401 scan, run back to the 7 Sep Cloud SQL cut-over, found two SECURITY INVOKER
-- trigger helpers with no EXECUTE grant:
--   ad_channel_guess(text)     ← tg_prepaid_advance_channel (prepaid advances)
--   referral_code_slug(text)   ← tg_referral_partner_code   (referral partners)
-- On Cloud SQL (no PUBLIC default) a signed-in user writing those tables gets
-- "permission denied for function …" unless someone granted it by hand. Both helpers are
-- pure text functions (read no table), so granting EXECUTE to the writing roles is safe.
-- Not anon (definer-hardening-holds.test.ts).
-- ============================================================================

grant execute on function public.ad_channel_guess(text) to authenticated, service_role;
grant execute on function public.referral_code_slug(text) to authenticated, service_role;
grant execute on function public.tg_prepaid_advance_channel() to authenticated, service_role;
grant execute on function public.tg_referral_partner_code() to authenticated, service_role;

do $$
declare r text;
begin
  foreach r in array array['app_runtime', 'app_jobs'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function public.ad_channel_guess(text) to %I', r);
      execute format('grant execute on function public.referral_code_slug(text) to %I', r);
      execute format('grant execute on function public.tg_prepaid_advance_channel() to %I', r);
      execute format('grant execute on function public.tg_referral_partner_code() to %I', r);
    end if;
  end loop;
end $$;
