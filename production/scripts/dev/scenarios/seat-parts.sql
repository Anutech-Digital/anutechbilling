-- R-2226 scenario "seat-parts" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2226 card test (e2e/cards/R-2226.spec.ts): one customer of its own with two Google Workspace
-- subscriptions at ₹3,240/seat/yr (10 seats, mrr ₹2,700), annual commitment that began on the 1st two
-- months ago — so the CURRENT part of the monthly one is this calendar month:
--   · SCN Seat Parts Monthly — billed monthly: adding a seat for the whole month is ₹270 (the part's
--     own rate), never ₹266 / ₹275 (₹3,240 × 30 or 31 ÷ 365).
--   · SCN Seat Parts Yearly  — paid yearly: unchanged, ₹3,240 × days left ÷ 365.
-- The test only opens Manage seats and reads the preview — it makes no quote. A reload / --clear removes
-- both subscriptions (_common.sql scn_drop_customer_docs takes every subscription of a scenario customer).

insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, contact_name, notes) values
  ('c2226000-0000-4000-8000-000000000001', :'tenant', 'SCN Seat Parts Co', 'Maharashtra', '27', 'India', 'business',
   'Asha Rao', 'SCN scenario seat-parts (R-2226)');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, domain, auto_renew) values
  ('c2226000-0000-4000-8000-000000000002', :'tenant', 'c2226000-0000-4000-8000-000000000001', 'SCN Seat Parts Co',
   'SCN Seat Parts Monthly', 'google', 10, 2700, 'monthly', 12,
   (date_trunc('month', current_date) - interval '2 months')::date,
   (date_trunc('month', current_date) + interval '10 months')::date - 1, 'active', 'scn-seatparts.example', true),
  ('c2226000-0000-4000-8000-000000000003', :'tenant', 'c2226000-0000-4000-8000-000000000001', 'SCN Seat Parts Co',
   'SCN Seat Parts Yearly', 'google', 10, 2700, 'yearly', 12,
   (date_trunc('month', current_date) - interval '2 months')::date,
   (date_trunc('month', current_date) + interval '10 months')::date - 1, 'active', 'scn-seatparts.example', true);
