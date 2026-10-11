\set ON_ERROR_STOP on
-- Regression test: the two public views v_tenant_with_parent and purchase_order_summary never
-- hand one tenant's rows to anyone else. Migration 20261011060000_r713_views_tenant_scope.sql (R-713).
-- Rolled back — safe anywhere.
--
-- Before R-713 both views were owned by postgres WITHOUT security_invoker (so the RLS of tenants /
-- purchase_orders never applied), had no tenant filter, and anon + authenticated held GRANT ALL.
-- With the public anon key anyone read every tenant's id, name, tier, parent GSTIN and every
-- tenant's purchase orders (customer, plan, seats, unit cost).
--
--   BLOCKED  anon reading v_tenant_with_parent / purchase_order_summary (permission denied)
--   BLOCKED  a signed-in user of tenant A seeing tenant B's row / B's purchase orders
--   BLOCKED  authenticated writing through either view (SELECT only)
--   ALLOWED  a signed-in user of tenant A seeing A's own row and A's own purchase orders,
--            with A's own allocation totals (Procurement variance card, Profitability report)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code, gstin) values
  ('71300000-0000-4000-8000-000000000001', 'R713 TENANT A', 'r713-a@example.in', '07', 'R73A', null),
  ('71300000-0000-4000-8000-000000000002', 'R713 TENANT B', 'r713-b@example.in', '07', 'R73B', '07AAAAA0000A1Z5');

insert into auth.users (id, instance_id, aud, role, email) values
  ('71300000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r713-a@example.in'),
  ('71300000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r713-b@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('71300000-0000-4000-8000-00000000000a', '71300000-0000-4000-8000-000000000001', 'r713-a@example.in', 'owner', true),
  ('71300000-0000-4000-8000-00000000000b', '71300000-0000-4000-8000-000000000002', 'r713-b@example.in', 'owner', true);

insert into public.purchase_orders (id, tenant_id, customer_name, vendor, plan, seats, unit_cost_pm, total_cost) values
  ('PO-R713-A1', '71300000-0000-4000-8000-000000000001', 'A Customer', 'google', 'Business Starter', 5, 100, 6000),
  ('PO-R713-B1', '71300000-0000-4000-8000-000000000002', 'B Secret Customer', 'google', 'Business Plus', 40, 900, 432000);

do $$
declare
  v_err boolean; v_n int; v_total int;
  c_a constant uuid := '71300000-0000-4000-8000-000000000001';
  c_b constant uuid := '71300000-0000-4000-8000-000000000002';
begin
  -- ── BLOCKED: anon (public anon key, nobody signed in) ────────────────────
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  v_err := false;
  begin
    select count(*) into v_n from public.v_tenant_with_parent;
    if v_n = 0 then v_err := true; end if;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 1: anon read % tenant row(s) from v_tenant_with_parent', v_n; end if;

  v_err := false;
  begin
    select count(*) into v_n from public.purchase_order_summary;
    if v_n = 0 then v_err := true; end if;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: anon read % purchase order(s) from purchase_order_summary', v_n; end if;
  reset role;

  -- ── Signed in as tenant A's owner ────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','71300000-0000-4000-8000-00000000000a','role','authenticated')::text, true);

  -- BLOCKED: tenant B's row / B's purchase orders
  select count(*) into v_n from public.v_tenant_with_parent where id = c_b;
  if v_n <> 0 then raise exception 'FAIL 3: tenant A saw tenant B in v_tenant_with_parent'; end if;
  select count(*) into v_n from public.v_tenant_with_parent where id <> c_a;
  if v_n <> 0 then raise exception 'FAIL 4: tenant A saw % other tenant row(s) in v_tenant_with_parent', v_n; end if;

  select count(*) into v_n from public.purchase_order_summary where tenant_id = c_b;
  if v_n <> 0 then raise exception 'FAIL 5: tenant A saw tenant B purchase orders in purchase_order_summary'; end if;
  select count(*) into v_n from public.purchase_order_summary where tenant_id is distinct from c_a;
  if v_n <> 0 then raise exception 'FAIL 6: tenant A saw % other tenant purchase order(s)', v_n; end if;

  -- BLOCKED: writing through the views (SELECT only)
  v_err := false;
  begin
    delete from public.purchase_order_summary where purchase_order_id = 'PO-R713-A1';
  exception when insufficient_privilege or object_not_in_prerequisite_state or feature_not_supported then v_err := true; end;
  if not v_err then raise exception 'FAIL 7: authenticated could write through purchase_order_summary'; end if;
  if has_table_privilege('authenticated', 'public.v_tenant_with_parent', 'UPDATE')
     or has_table_privilege('authenticated', 'public.purchase_order_summary', 'INSERT') then
    raise exception 'FAIL 8: authenticated still holds write privileges on the views';
  end if;

  -- ALLOWED: own row and own purchase orders
  select count(*) into v_n from public.v_tenant_with_parent where id = c_a and name = 'R713 TENANT A';
  if v_n <> 1 then raise exception 'FAIL 9: tenant A cannot see its own row in v_tenant_with_parent'; end if;

  select count(*), max(expected_cost) into v_n, v_total from public.purchase_order_summary where purchase_order_id = 'PO-R713-A1';
  if v_n <> 1 or v_total <> 6000 then raise exception 'FAIL 10: tenant A cannot see its own purchase order (n=%, cost=%)', v_n, v_total; end if;
  reset role;

  -- ── Same from tenant B's side ────────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','71300000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  select count(*) into v_n from public.purchase_order_summary where purchase_order_id = 'PO-R713-A1';
  if v_n <> 0 then raise exception 'FAIL 11: tenant B saw tenant A purchase order'; end if;
  select count(*) into v_n from public.purchase_order_summary where purchase_order_id = 'PO-R713-B1';
  if v_n <> 1 then raise exception 'FAIL 12: tenant B cannot see its own purchase order'; end if;
  reset role;

  raise notice 'r713_views_tenant: all checks passed';
end $$;

rollback;
