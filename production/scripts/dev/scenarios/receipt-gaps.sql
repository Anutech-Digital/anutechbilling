-- R-2192 scenario "receipt-gaps" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Small receipt differences (G-ZOHO audit: banking.md §4, sales.md rows 24 + 30):
--   · SCN Round Off Traders: INV-SCN-RG-1 ₹13,106 unpaid + a ₹13,105 NEFT money-in line naming them —
--     ₹1 short: Banking shows "Matches INV-SCN-RG-1 · ₹1 round-off"; Match & record payment → Paid in full.
--   · SCN Wire Exports: INV-SCN-RG-2 ₹50,000 unpaid + a ₹49,500 RTGS wire — the bank kept ₹500:
--     Reconcile → This money is for → INV-SCN-RG-2 → "Bank / SWIFT charge ₹500 — settled in full" → Paid,
--     ₹500 Bank Charges expense on the line.

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, notes) values
  ('c2192000-0000-4000-8000-000000000001', :'tenant', 'SCN Round Off Traders', 'Maharashtra', '27', 'business',
   'SCN scenario receipt-gaps (R-2192)'),
  ('c2192000-0000-4000-8000-000000000002', :'tenant', 'SCN Wire Exports', 'Maharashtra', '27', 'business',
   'SCN scenario receipt-gaps (R-2192)');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate, discount_pct,
                           status, payment_status, created_date, billing_cycle, currency, is_one_off, line_items, notes) values
  ('Q-SCN-RG-1', :'tenant', 'c2192000-0000-4000-8000-000000000001', 'SCN Round Off Traders', 'SCN Annual support (round-off)', 1, 13106, 11107, 0, 18, 0,
   'accepted', 'awaiting', current_date - 14, 'yearly', 'INR', true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Annual support (round-off)", "rate": 11107, "one_time": true}]'::jsonb, 'SCN scenario receipt-gaps (R-2192)'),
  ('Q-SCN-RG-2', :'tenant', 'c2192000-0000-4000-8000-000000000002', 'SCN Wire Exports', 'SCN Implementation (wire)', 1, 50000, 42373, 0, 18, 0,
   'accepted', 'awaiting', current_date - 12, 'yearly', 'INR', true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Implementation (wire)", "rate": 42373, "one_time": true}]'::jsonb, 'SCN scenario receipt-gaps (R-2192)');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items, quote_id) values
  ('INV-SCN-RG-1', :'tenant', 'c2192000-0000-4000-8000-000000000001', 'SCN Round Off Traders', 13106, 'pending',
   current_date - 12, current_date + 3, 11107, 1999, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Annual support (round-off)", "rate": 11107}]'::jsonb, 'Q-SCN-RG-1'),
  ('INV-SCN-RG-2', :'tenant', 'c2192000-0000-4000-8000-000000000002', 'SCN Wire Exports', 50000, 'pending',
   current_date - 10, current_date + 5, 42373, 7627, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Implementation (wire)", "rate": 42373}]'::jsonb, 'Q-SCN-RG-2');

update public.quotes q set invoice_id = v.inv
  from (values ('Q-SCN-RG-1', 'INV-SCN-RG-1'), ('Q-SCN-RG-2', 'INV-SCN-RG-2')) as v(qid, inv)
 where q.id = v.qid and q.tenant_id = :'tenant';

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2192000-0000-4000-8000-000000000003', :'tenant', :'acct', current_date - 2,
   'NEFT CR-HDFC0000240-SCN ROUND OFF TRADERS-OUR COMPANY-HDFCN52026110713105', 0, 13105, 'HDFCN52026110713105', 'csv_upload'),
  ('c2192000-0000-4000-8000-000000000004', :'tenant', :'acct', current_date - 1,
   'RTGS CR-CITI0000002-SCN WIRE EXPORTS-OUR COMPANY-CITIR52026110749500', 0, 49500, 'CITIR52026110749500', 'csv_upload');
