-- deploy-peek: exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'cold_call_campaigns' and policyname = 'cold_call_team' and qual like '%marketing%')
-- deploy-key: r1791coldmarketing
-- prisma/migrations/20261023114500_r1791_cold_calling_marketing
-- R-1791 (Abhishek, 23 Oct 2026): the new Marketing role runs Cold Calling too (it is in its
-- part of the Marketing Hub), so the cold-calling policy admits it next to owner, manager and
-- the sales team. Same policy, one more role; app_jobs (the cron) unchanged.
begin;

do $$
declare t text;
begin
  foreach t in array array['cold_call_campaigns', 'cold_call_contacts'] loop
    execute format('drop policy if exists cold_call_team on public.%I', t);
    execute format(
      'create policy cold_call_team on public.%I for all to authenticated
         using (tenant_id = public.current_tenant_id()
                and (public.current_user_has_role(''owner'', ''manager'', ''sales_senior'', ''sales'', ''marketing'')
                     or public.current_request_role() = ''app_jobs''))
         with check (tenant_id = public.current_tenant_id()
                and (public.current_user_has_role(''owner'', ''manager'', ''sales_senior'', ''sales'', ''marketing'')
                     or public.current_request_role() = ''app_jobs''))', t);
  end loop;
end $$;

commit;
