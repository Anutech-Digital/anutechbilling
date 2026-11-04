-- R-2458 scenario "zero-ref-credits" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2430 / R-2424 / R-2441: placeholder bank references ("000000000000000") are not a UTR.
--   · SCN Zero Ref Traders: INV-SCN-ZR-1 ₹11,800 unpaid + two ₹5,000 money-in lines, BOTH with reference
--     000000000000000 — book both on the same invoice → two receipts, ₹10,000 received.
--   · SCN Placeholder Labs: INV-SCN-ZR-2 ₹5,900 — Record payment with reference 000000000000000 (or
--     NEFT-000000000000) on ZR-1 and on ZR-2: both save.
--   · INV-SCN-ZR-3 ₹2,360 (Zero Ref Traders) — a real UTR (TESTUTR123456) on ZR-2 and then ZR-3: the second is refused.

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, notes) values
  ('c2458000-0000-4000-8000-000000000041', :'tenant', 'SCN Zero Ref Traders', 'Maharashtra', '27', 'business',
   'SCN scenario zero-ref-credits (R-2458)'),
  ('c2458000-0000-4000-8000-000000000042', :'tenant', 'SCN Placeholder Labs', 'Maharashtra', '27', 'business',
   'SCN scenario zero-ref-credits (R-2458)');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
  ('INV-SCN-ZR-1', :'tenant', 'c2458000-0000-4000-8000-000000000041', 'SCN Zero Ref Traders', 11800, 'pending',
   current_date - 12, current_date + 3, 10000, 1800, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Annual support (zero-ref)", "rate": 10000}]'::jsonb),
  ('INV-SCN-ZR-2', :'tenant', 'c2458000-0000-4000-8000-000000000042', 'SCN Placeholder Labs', 5900, 'pending',
   current_date - 10, current_date + 5, 5000, 900, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Setup fee (zero-ref)", "rate": 5000}]'::jsonb),
  ('INV-SCN-ZR-3', :'tenant', 'c2458000-0000-4000-8000-000000000041', 'SCN Zero Ref Traders', 2360, 'pending',
   current_date - 8, current_date + 7, 2000, 360, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Domain renewal (zero-ref)", "rate": 2000}]'::jsonb);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2458000-0000-4000-8000-000000000043', :'tenant', :'acct', current_date - 3,
   'NEFT CR-000000000000000-SCN ZERO REF TRADERS-PART 1', 0, 5000, '000000000000000', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000044', :'tenant', :'acct', current_date - 2,
   'NEFT CR-000000000000000-SCN ZERO REF TRADERS-PART 2', 0, 5000, '000000000000000', 'csv_upload');
