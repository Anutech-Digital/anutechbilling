-- R-1792 (Abhishek, 23 Oct 2026): the marketing budget rules, proved against the database as
-- the app's own login (app_runtime + app.user_id), not as a superuser.
--   * marketing asks; only the OWNER approves (billing / marketing cannot)
--   * a payment must fit what is left; over it is refused with the amount left
--   * only billing / owner mark a payment paid; marketing cannot
--   * marketing sees its own requests; a sales user sees none
-- LOCAL ONLY (it uses the demo tenant), so it lives here and not in supabase/tests, which
-- test:sql runs against production. Run as app_runtime (needs the demo tenant + the users from db/local/demo-login.sql and
-- db/local/demo-team-logins.sql):
--   docker exec -i -e PGPASSWORD=localdev ros-pg psql -h localhost -U app_runtime -d ros -v ON_ERROR_STOP=1 < db/local/tests/marketing_budget_guards.test.sql
begin;

-- who is who (demo tenant d…0001)
\set owner     '''d0000000-0000-4000-8000-0000000000aa'''
\set marketing '''d0000000-0000-4000-8000-0000000000b1'''
\set billing   '''d0000000-0000-4000-8000-0000000000b2'''
\set tenant    '''d0000000-0000-4000-8000-000000000001'''

create temp table t_ids (k text primary key, v uuid);

-- 1. marketing asks for ₹50,000 of Google Ads for November
select set_config('app.user_id', :marketing, true), set_config('app.tenant_id', :tenant, true);
with b as (
  insert into public.marketing_budgets (tenant_id, requested_by, channel, product_name, month, amount_requested, note)
  values (:tenant::uuid, :marketing::uuid, 'google-ads', 'Google Workspace', '2026-11-01', 50000, 'test')
  returning id)
insert into t_ids select 'budget', id from b;

-- 2. marketing cannot approve its own request
do $$ begin
  update public.marketing_budgets set status = 'approved', amount_approved = 50000
   where id = (select v from t_ids where k = 'budget');
  raise exception 'FAIL: marketing approved its own budget';
exception when insufficient_privilege then
  if sqlerrm not like 'Only the owner can approve%' then raise exception 'FAIL: wrong refusal: %', sqlerrm; end if;
end $$;

-- 3. billing cannot approve either
select set_config('app.user_id', :billing, true);
do $$ begin
  update public.marketing_budgets set status = 'approved', amount_approved = 50000
   where id = (select v from t_ids where k = 'budget');
  raise exception 'FAIL: billing approved a budget';
exception when insufficient_privilege then null;
end $$;

-- 4. a payment against a budget that is not approved is refused
select set_config('app.user_id', :marketing, true);
do $$ begin
  insert into public.marketing_payment_requests (tenant_id, budget_id, requested_by, amount, pay_to)
  values (current_setting('app.tenant_id')::uuid, (select v from t_ids where k = 'budget'),
          current_setting('app.user_id')::uuid, 1000, 'Google Ads');
  raise exception 'FAIL: paid against a pending budget';
exception when insufficient_privilege then null;
end $$;

-- 5. the owner approves ₹40,000 (less than asked)
select set_config('app.user_id', :owner, true);
update public.marketing_budgets set status = 'approved', amount_approved = 40000
 where id = (select v from t_ids where k = 'budget');
do $$ begin
  if (select decided_by from public.marketing_budgets where id = (select v from t_ids where k = 'budget'))
     <> current_setting('app.user_id')::uuid then raise exception 'FAIL: decided_by not the owner'; end if;
end $$;

-- 6. marketing asks billing for ₹30,000 — fits
select set_config('app.user_id', :marketing, true);
with p as (
  insert into public.marketing_payment_requests (tenant_id, budget_id, requested_by, amount, pay_to)
  values (:tenant::uuid, (select v from t_ids where k = 'budget'), :marketing::uuid, 30000, 'Google Ads')
  returning id)
insert into t_ids select 'pay1', id from p;

-- 7. ₹15,000 more does not fit (only ₹10,000 left) — refused, and says how much is left
do $$ begin
  insert into public.marketing_payment_requests (tenant_id, budget_id, requested_by, amount, pay_to)
  values (current_setting('app.tenant_id')::uuid, (select v from t_ids where k = 'budget'),
          current_setting('app.user_id')::uuid, 15000, 'Google Ads');
  raise exception 'FAIL: went over the budget';
exception when check_violation then
  if sqlerrm not like 'Only Rs 10000 is left%' then raise exception 'FAIL: wrong message: %', sqlerrm; end if;
end $$;
do $$ begin
  if public.marketing_budget_left((select v from t_ids where k = 'budget')) <> 10000 then
    raise exception 'FAIL: left should be 10000';
  end if;
end $$;

-- 8. marketing cannot mark its own request paid
do $$ begin
  update public.marketing_payment_requests set status = 'paid', paid_on = current_date
   where id = (select v from t_ids where k = 'pay1');
  raise exception 'FAIL: marketing marked a payment paid';
exception when insufficient_privilege then null;
end $$;

-- 9. billing marks it paid; paid_by is billing; and it cannot be changed afterwards
select set_config('app.user_id', :billing, true);
update public.marketing_payment_requests set status = 'paid', paid_on = current_date, reference = 'UTR123'
 where id = (select v from t_ids where k = 'pay1');
do $$ begin
  if (select paid_by from public.marketing_payment_requests where id = (select v from t_ids where k = 'pay1'))
     <> current_setting('app.user_id')::uuid then raise exception 'FAIL: paid_by not billing'; end if;
  update public.marketing_payment_requests set status = 'cancelled' where id = (select v from t_ids where k = 'pay1');
  raise exception 'FAIL: a paid request was changed';
exception when insufficient_privilege then null;
end $$;

-- 10. a sales user sees none of it
select set_config('app.user_id', (select id::text from public.users
  where tenant_id = :tenant::uuid and role = 'sales' limit 1), true);
do $$ begin
  if current_setting('app.user_id') <> '' and exists (select 1 from public.marketing_budgets) then
    raise exception 'FAIL: a sales user can read marketing budgets';
  end if;
end $$;

select 'marketing_budget_guards: all checks passed' as result;
rollback;
