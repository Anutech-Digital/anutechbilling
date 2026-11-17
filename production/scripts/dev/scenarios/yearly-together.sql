-- R-2850 scenario "yearly-together" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2809 / R-2805 in miniature (Renewals → "8–30"): one customer, two YEARLY Google Workspace subscriptions
-- sold on ONE sale quote last year (Q-SCN-YT-SALE — so Bill together says "Billed together last time"; without it
-- yearly rows are not suggested), renewing in 10 and 20 days:
--   · SCN Yearly Standard — 20 seats, ₹1,080 a seat a year (₹21,600)
--   · SCN Yearly Starter  — 10 seats, ₹1,632 a seat a year (₹16,320)
-- Only the customer, last year's sale quote (a bare row: no lines, no payment, no invoice) and the two subscriptions
-- are planted. NO money row is made here: the renewal quote (Bill together), its payments, the GST invoice and the
-- renewals are made by the app when someone presses the buttons (e2e/cards/R-2850.spec.ts does). A reload / --clear
-- removes the customer, both subscriptions and everything billed / received for them (_common.sql
-- scn_drop_customer_docs).

insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, contact_name, contact_email, notes) values
  ('c2850000-0000-4000-8000-000000000001', :'tenant', 'SCN Yearly Pair Pvt Ltd', 'Delhi', '07', 'India', 'business',
   'Anil Batra', 'accounts@scn-yearlypair.example', 'SCN scenario yearly-together (R-2850)');

insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, line_items, created_date) values
  ('Q-SCN-YT-SALE', :'tenant', 'c2850000-0000-4000-8000-000000000001', 'SCN Yearly Pair Pvt Ltd', 'accepted', 44746,
   '[]'::jsonb, public.ist_today() - 355);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                  start_date, renewal_date, status, renewal_state, auto_renew, domain, quote_id) values
  ('c2850000-0000-4000-8000-000000000021', :'tenant', 'c2850000-0000-4000-8000-000000000001', 'SCN Yearly Pair Pvt Ltd',
   'SCN Yearly Standard', 'google', 20, 1800, 12, 'yearly',
   ((public.ist_today() + 10) - interval '12 months')::date, public.ist_today() + 10, 'active', 'pending', true,
   'scn-yearlypair.example', 'Q-SCN-YT-SALE'),
  ('c2850000-0000-4000-8000-000000000022', :'tenant', 'c2850000-0000-4000-8000-000000000001', 'SCN Yearly Pair Pvt Ltd',
   'SCN Yearly Starter', 'google', 10, 1360, 12, 'yearly',
   ((public.ist_today() + 20) - interval '12 months')::date, public.ist_today() + 20, 'active', 'pending', true,
   'scn-yearlypair.example', 'Q-SCN-YT-SALE');
