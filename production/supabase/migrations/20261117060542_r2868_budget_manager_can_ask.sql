-- deploy-peek: exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'marketing_budgets' and policyname = 'r1792_insert' and with_check ilike '%manager%') and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'marketing_payment_requests' and policyname = 'r1792_insert' and with_check ilike '%manager%')
-- deploy-key: r2868budgetmanagercanask
-- R-2868 (Abhishek, 16 Nov 2026): the company's marketing login has the Manager role, so it could not
-- open Budget & Payments or ask for a budget ("You don't have access…", and "Approved ad budgets didn't
-- load" on Paid ads). The app now lets a manager see and ask like marketing (BUDGET_ROLES /
-- canAskBudget); this lets the database accept the manager's own request. Reading stays as before:
-- a person sees the budgets they asked for, the owner / billing / accountant see all. Approving stays
-- owner-only (the update trigger in 20261024060820_r1792_marketing_budget is unchanged).
begin;
do $$
declare t text;
begin
  foreach t in array array['marketing_budgets', 'marketing_payment_requests'] loop
    execute format('drop policy if exists r1792_insert on public.%I', t);
    execute format(
      'create policy r1792_insert on public.%I for insert to authenticated
         with check (tenant_id = public.current_tenant_id()
                     and requested_by = public.current_user_id()
                     and public.current_user_has_role(''marketing'', ''manager'', ''owner''))', t);
  end loop;
end $$;
commit;
