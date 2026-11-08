-- R-2227 scenario "plan-change" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2227 card test (e2e/cards/R-2227.spec.ts): one customer of its own with a Google Workspace Business
-- Starter subscription, 10 seats × ₹3,240/yr (mrr ₹2,700), paid YEARLY, annual term from the 1st two
-- months ago, and that term's tax invoice paid in full (₹32,400 + 18% = ₹38,232) — so "Change plan" to
-- Business Standard credits the whole unused Starter value (R-2255: paid in full).
-- The test makes a draft plan-change quote on this customer; a reload / --clear removes the customer,
-- its subscription, quotes and invoices (_common.sql scn_drop_customer_docs).

insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, contact_name, notes) values
  ('c2227000-0000-4000-8000-000000000001', :'tenant', 'SCN Plan Change Co', 'Maharashtra', '27', 'India', 'business',
   'Ravi Kumar', 'SCN scenario plan-change (R-2227)');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate, discount_pct,
                           status, created_date, billing_cycle, currency, line_items, notes) values
  ('Q-SCN-PC-1', :'tenant', 'c2227000-0000-4000-8000-000000000001', 'SCN Plan Change Co', 'E2E Google Workspace Business Starter',
   10, 38232, 32400, 0, 18, 0, 'accepted', (date_trunc('month', current_date) - interval '2 months')::date, 'yearly', 'INR',
   '[{"id": "line-1", "item_id": "E2E-GW-STR", "qty": 10, "cost": 0, "name": "E2E Google Workspace Business Starter", "rate": 3240, "commitment": "annual_yearly"}]'::jsonb,
   'SCN scenario plan-change (R-2227)');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items, quote_id) values
  ('INV-SCN-PC-1', :'tenant', 'c2227000-0000-4000-8000-000000000001', 'SCN Plan Change Co', 38232, 'paid',
   (date_trunc('month', current_date) - interval '2 months')::date, (date_trunc('month', current_date) - interval '2 months')::date + 15,
   32400, 5832, 18, true, 38232, 'tax_invoice',
   '[{"id": "line-1", "qty": 10, "cost": 0, "name": "E2E Google Workspace Business Starter", "rate": 3240}]'::jsonb, 'Q-SCN-PC-1');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, domain, auto_renew, quote_id) values
  ('c2227000-0000-4000-8000-000000000002', :'tenant', 'c2227000-0000-4000-8000-000000000001', 'SCN Plan Change Co',
   'SCN Plan Change Starter', 'google', 'E2E-GW-STR', 10, 2700, 'yearly', 12,
   (date_trunc('month', current_date) - interval '2 months')::date,
   (date_trunc('month', current_date) + interval '10 months')::date - 1, 'active', 'scn-planchange.example', true, 'Q-SCN-PC-1');
