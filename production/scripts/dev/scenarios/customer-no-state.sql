-- R-2458 scenario "customer-no-state" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2363 / R-2442 / R-2448: a customer saved with State "Not known yet" (the form saves NO state) and a
-- DRAFT quote for them — Send / PDF / WhatsApp / Mark as sent must wait until the state is set.

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_name, contact_phone, notes) values
  ('c2458000-0000-4000-8000-000000000001', :'tenant', 'SCN Pathak Fabrication', null, null, 'business',
   'Rakesh Pathak', '9810024581', 'SCN scenario customer-no-state (R-2458): State "Not known yet"');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           tax_rate, discount_pct, status, created_date, expires_date, billing_cycle, currency,
                           owner_id, line_items, notes) values
  ('Q-SCN-NS-1', :'tenant', 'c2458000-0000-4000-8000-000000000001', 'SCN Pathak Fabrication',
   'Google Workspace Business Starter', 5, 7080, 6000, 5000, 18, 0, 'draft', current_date, current_date + 15, 'yearly', 'INR',
   pg_temp.scn_user(:'tenant', 'owner'),
   '[{"id": "line-1", "qty": 5, "cost": 1000, "name": "SCN Google Workspace Business Starter", "rate": 1200, "commitment": "annual_yearly"}]'::jsonb,
   'SCN scenario customer-no-state (R-2458)');
