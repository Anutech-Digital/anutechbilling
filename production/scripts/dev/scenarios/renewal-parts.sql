-- R-2569 scenario "renewal-parts" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2548 card test (e2e/cards/R-2548.spec.ts): three customers of its OWN, so no other card test's scenario
-- (R-2544 reloads "small-leftover") can take away the subscriptions the test adds. No subscription here —
-- the card test adds them through the real "Add / Onboard Subscription" form; a reload / --clear removes
-- those too (_common.sql scn_drop_customer_docs takes every subscription of a scenario customer).
--   · SCN Part Bill Studio  — A: Annual · Half-yearly, renews in 30 days
--   · SCN Part Bill Late Co — B: Annual · Half-yearly, renews in 3 days (Payment Follow-up ≤ 7 days)
--   · SCN Part Bill Yearly  — C: Annual · paid Yearly → "Send renewal quote"

insert into public.customers (id, tenant_id, name, domain, state, state_code, customer_type, contact_email, notes) values
  ('c2569000-0000-4000-8000-000000000001', :'tenant', 'SCN Part Bill Studio', 'scn-partbill-studio.example', 'Maharashtra', '27',
   'business', 'hello@scn-partbill-studio.example', 'SCN scenario renewal-parts (R-2569)'),
  ('c2569000-0000-4000-8000-000000000002', :'tenant', 'SCN Part Bill Late Co', 'scn-partbill-late.example', 'Maharashtra', '27',
   'business', 'accounts@scn-partbill-late.example', 'SCN scenario renewal-parts (R-2569)'),
  ('c2569000-0000-4000-8000-000000000003', :'tenant', 'SCN Part Bill Yearly', 'scn-partbill-yearly.example', 'Maharashtra', '27',
   'business', 'billing@scn-partbill-yearly.example', 'SCN scenario renewal-parts (R-2569)');
