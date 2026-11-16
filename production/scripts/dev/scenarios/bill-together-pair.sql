-- R-2859 scenario "bill-together-pair" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Staging 16 Nov in miniature (Renewals → Overdue): one customer, two Google Workspace subscriptions on ONE
-- domain, both billed MONTHLY inside an annual commitment that ended 5 days ago — so both rows read "Part not
-- billed" and Bill together suggests them ("Same domain and period"):
--   · SCN Pair Standard — 3 seats, ₹4,755.30 a month
--   · SCN Pair Starter  — 7 seats, ₹3,151.40 a month
-- No bill is made here. A reload / --clear removes both subscriptions and anything billed for them
-- (_common.sql scn_drop_customer_docs takes every subscription of a scenario customer).

insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, contact_name, contact_email, notes) values
  ('c2859000-0000-4000-8000-000000000001', :'tenant', 'SCN Pair Works', 'Delhi', '07', 'India', 'business',
   'Meera Joshi', 'accounts@scn-pairworks.example', 'SCN scenario bill-together-pair (R-2859)');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, renewal_state, domain, auto_renew) values
  ('c2859000-0000-4000-8000-000000000021', :'tenant', 'c2859000-0000-4000-8000-000000000001', 'SCN Pair Works',
   'SCN Pair Standard', 'google', 3, 4755.3, 'monthly', 12,
   ((current_date - 4) - interval '12 months')::date, current_date - 5, 'active', 'notice_sent', 'scn-pairworks.example', true),
  ('c2859000-0000-4000-8000-000000000022', :'tenant', 'c2859000-0000-4000-8000-000000000001', 'SCN Pair Works',
   'SCN Pair Starter', 'google', 7, 3151.4, 'monthly', 12,
   ((current_date - 4) - interval '12 months')::date, current_date - 5, 'active', 'notice_sent', 'scn-pairworks.example', true);
