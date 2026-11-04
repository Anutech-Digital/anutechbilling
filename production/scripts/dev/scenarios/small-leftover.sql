-- R-2458 scenario "small-leftover" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2421 / R-2413: Payment Follow-up.
--   · SCN Leftover Hosting: INV-SCN-LO-1 ₹354 — nothing paid (stays in the main list, not "Small leftovers");
--     INV-SCN-LO-2 ₹5,900 with ₹5,845 received → ₹55 left → "Small leftovers" → Write off.
--   · SCN Late Payer Co: INV-SCN-LO-3 ₹23,600, 40 days late.
--   · SCN Slow Pay Studio: INV-SCN-LO-4 ₹11,800, 20 days late (a third customer to tick for bulk actions).

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, notes) values
  ('c2458000-0000-4000-8000-000000000051', :'tenant', 'SCN Leftover Hosting', 'Maharashtra', '27', 'business',
   'billing@leftover.example', 'SCN scenario small-leftover (R-2458)'),
  ('c2458000-0000-4000-8000-000000000052', :'tenant', 'SCN Late Payer Co', 'Maharashtra', '27', 'business',
   'accounts@latepayer.example', 'SCN scenario small-leftover (R-2458)'),
  ('c2458000-0000-4000-8000-000000000053', :'tenant', 'SCN Slow Pay Studio', 'Maharashtra', '27', 'business',
   'hello@slowpay.example', 'SCN scenario small-leftover (R-2458)');

-- LO-2 came from an accepted quote (a payment needs its quote, tg_payments_opening_invoice)
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate, discount_pct,
                           status, created_date, billing_cycle, currency, is_one_off, line_items, notes) values
  ('Q-SCN-LO-2', :'tenant', 'c2458000-0000-4000-8000-000000000051', 'SCN Leftover Hosting', 'SCN Hosting annual', 1, 5900, 5000, 0, 18, 0,
   'accepted', current_date - 32, 'yearly', 'INR', true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Hosting annual", "rate": 5000}]'::jsonb, 'SCN scenario small-leftover (R-2458)');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items, quote_id) values
  ('INV-SCN-LO-1', :'tenant', 'c2458000-0000-4000-8000-000000000051', 'SCN Leftover Hosting', 354, 'overdue',
   current_date - 25, current_date - 10, 300, 54, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Hosting (small bill)", "rate": 300}]'::jsonb, null),
  ('INV-SCN-LO-2', :'tenant', 'c2458000-0000-4000-8000-000000000051', 'SCN Leftover Hosting', 5900, 'overdue',
   current_date - 30, current_date - 15, 5000, 900, 18, false, 5845, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Hosting annual", "rate": 5000}]'::jsonb, 'Q-SCN-LO-2'),
  ('INV-SCN-LO-3', :'tenant', 'c2458000-0000-4000-8000-000000000052', 'SCN Late Payer Co', 23600, 'overdue',
   current_date - 55, current_date - 40, 20000, 3600, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Workspace licences", "rate": 20000}]'::jsonb, null),
  ('INV-SCN-LO-4', :'tenant', 'c2458000-0000-4000-8000-000000000053', 'SCN Slow Pay Studio', 11800, 'overdue',
   current_date - 35, current_date - 20, 10000, 1800, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Website care", "rate": 10000}]'::jsonb, null);

update public.quotes set invoice_id = 'INV-SCN-LO-2' where id = 'Q-SCN-LO-2' and tenant_id = :'tenant';

-- the ₹5,845 already received on LO-2
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, bank_account_id, notes) values
  ('c2458000-0000-4000-8000-000000000054', :'tenant', 'Q-SCN-LO-2', 'c2458000-0000-4000-8000-000000000051', 5845,
   'bank_transfer', 'SCNUTR2458054', 'received', now() - interval '12 days', :'acct', 'SCN scenario small-leftover (R-2458)');
