-- R-2458 scenario "usd-inw-lines" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2425 / R-2427 / R-2440: foreign inward remittances on the SCN HDFC account. HDFC writes the dollar
-- amount and its own rate into the narration ("INW … USD1024.0@93.6"); the credit is the rupees.
--   · ₹95,846  $1,024 @ ₹93.60 from SCN Design Box LLC — a new export sale (0% GST under LUT).
--   · ₹1,77,000 $2,000 @ ₹88.50 from SCN Timbergloss Inc — pays INV-SCN-USD-1, raised at $2,000 @ ₹84.00
--     (₹1,68,000) → ₹9,000 forex gain (Reconcile → "An open quote / invoice", R-2466).
--   · ₹93,600  $1,000 @ ₹93.60 from SCN Design Box LLC — a short remittance (billed $1,024, $24 bank charges).
-- Overseas customers (no state, country set). LUT rows for the FY: scenario lut-per-fy.
-- R-2466: INV-SCN-USD-1 came from its USD quote Q-SCN-USD-1, as every export sale in the app does
-- (a payment needs its quote — tg_payments_opening_invoice; R-2425 / R-2427 sales make one).

insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, contact_email, notes) values
  ('c2458000-0000-4000-8000-000000000011', :'tenant', 'SCN Design Box LLC', null, null, 'United States', 'overseas', 'business',
   'accounts@designbox.example', 'SCN scenario usd-inw-lines (R-2458)'),
  ('c2458000-0000-4000-8000-000000000012', :'tenant', 'SCN Timbergloss Inc', null, null, 'United States', 'overseas', 'business',
   'ap@timbergloss.example', 'SCN scenario usd-inw-lines (R-2458)');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate, discount_pct,
                           status, payment_status, created_date, billing_cycle, currency, exchange_rate, is_one_off, line_items, notes) values
  ('Q-SCN-USD-1', :'tenant', 'c2458000-0000-4000-8000-000000000012', 'SCN Timbergloss Inc', 'SCN Export services', 1, 168000, 168000, 0, 0, 0,
   'accepted', 'awaiting', current_date - 42, 'yearly', 'USD', 84.00, true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Export services — Timbergloss ($2,000)", "rate": 168000, "one_time": true}]'::jsonb,
   'SCN scenario usd-inw-lines (R-2458 / R-2466)');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, customer_country,
                             currency, fx_rate, fx_source, fx_date, gst_treatment, document_kind, line_items, quote_id) values
  ('INV-SCN-USD-1', :'tenant', 'c2458000-0000-4000-8000-000000000012', 'SCN Timbergloss Inc', 168000, 'pending',
   current_date - 40, current_date - 10, 168000, 0, 0, true, 0, 'United States',
   'USD', 84.00, 'manual', current_date - 40, 'overseas', 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Export services — Timbergloss ($2,000)", "rate": 168000}]'::jsonb, 'Q-SCN-USD-1');

update public.quotes set invoice_id = 'INV-SCN-USD-1' where id = 'Q-SCN-USD-1' and tenant_id = :'tenant';

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2458000-0000-4000-8000-000000000021', :'tenant', :'acct', current_date - 6,
   'INW 041126I0SCN0000021 USD1024.0@93.6 SCN DESIGN BOX LLC', 0, 95846, 'SCN-INW-2458-021', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000022', :'tenant', :'acct', current_date - 5,
   'INW 041126I0SCN0000022 USD2000.0@88.5 SCN TIMBERGLOSS INC', 0, 177000, 'SCN-INW-2458-022', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000023', :'tenant', :'acct', current_date - 4,
   'INW 041126I0SCN0000023 USD1000.0@93.6 SCN DESIGN BOX LLC', 0, 93600, 'SCN-INW-2458-023', 'csv_upload');
