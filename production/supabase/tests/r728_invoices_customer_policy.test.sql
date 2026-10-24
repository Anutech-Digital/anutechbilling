-- R-728 — invoices_select_own_customer is gone; a customer-portal-style login reads no invoice.
-- Migration: 20261019013050_r1006_export_log.sql (R-728 half)
--
-- The policy let a customer_users login (current_customer_id()) SELECT whole invoice rows —
-- line_items[].cost (our purchase cost, R-487) included. The portal is being rebuilt (R-844)
-- and will read through a definer that leaves cost out (R-845).
--
--   1. The policy no longer exists.
--   2. A portal-style login (auth user linked in customer_users, no public.users row) reads 0
--      invoices — its own customer's included.
--   3. The company owner still reads the invoice.
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r728_invoices_customer_policy.test.sql

begin;

do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoices'
                and policyname = 'invoices_select_own_customer') then
    raise exception 'FAIL 1: invoices_select_own_customer still exists';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoices'
                and coalesce(qual, '') ~* 'current_customer_id\(\)') then
    raise exception 'FAIL 1: another invoices policy still reads current_customer_id()';
  end if;
end $$;

insert into auth.users (id, email) values
  ('c0728000-0000-0000-0000-0000000000a1', 'r728-owner@example.test'),
  ('c0728000-0000-0000-0000-0000000000c1', 'r728-portal@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c0728000-0000-0000-0000-0000000000f1', 'R728 Co', 'r728c@example.test', '07', 'R728C');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c0728000-0000-0000-0000-0000000000a1', 'c0728000-0000-0000-0000-0000000000f1', 'r728-owner@example.test', 'R728 Owner', 'owner', true);

-- triggers (customer number, document checks) need the owner's session
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0728000-0000-0000-0000-0000000000a1', 'role', 'authenticated', 'aal', 'aal1')::text, true);

insert into public.customers (id, tenant_id, name) values
  ('c0728000-0000-0000-0000-0000000000e1', 'c0728000-0000-0000-0000-0000000000f1', 'R728 Customer');

insert into public.customer_users (tenant_id, customer_id, auth_user_id, email) values
  ('c0728000-0000-0000-0000-0000000000f1', 'c0728000-0000-0000-0000-0000000000e1',
   'c0728000-0000-0000-0000-0000000000c1', 'r728-portal@example.test');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date,
                             taxable_value, tax_amount, tax_rate, line_items)
  values ('R728-INV-1', 'c0728000-0000-0000-0000-0000000000f1', 'c0728000-0000-0000-0000-0000000000e1',
          'R728 Customer', 100, 'pending', public.ist_today(), 100, 0, 0,
          '[{"description":"x","qty":1,"rate":100,"cost":60}]'::jsonb);

create function pg_temp.r728_as(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;
grant execute on function pg_temp.r728_as(uuid) to authenticated;

set local role authenticated;

do $$
declare v_n int;
begin
  perform pg_temp.r728_as('c0728000-0000-0000-0000-0000000000c1');
  if public.current_customer_id() is distinct from 'c0728000-0000-0000-0000-0000000000e1'::uuid then
    raise exception 'SETUP: portal login does not resolve to its customer';
  end if;
  select count(*) into v_n from public.invoices;
  if v_n <> 0 then raise exception 'FAIL 2: portal login reads % invoice(s) (cost leak)', v_n; end if;

  perform pg_temp.r728_as('c0728000-0000-0000-0000-0000000000a1');
  select count(*) into v_n from public.invoices where id = 'R728-INV-1';
  if v_n <> 1 then raise exception 'FAIL 3: owner lost the invoice (% rows)', v_n; end if;
end $$;

reset role;
do $$ begin raise notice 'R-728 invoices_select_own_customer: all checks passed'; end $$;

rollback;
