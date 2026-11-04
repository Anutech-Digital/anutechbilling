-- R-2458 scenario "usd-inw-lines" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2425 / R-2427 / R-2440: foreign inward remittances on the SCN HDFC account. HDFC writes the dollar
-- amount and its own rate into the narration ("INW … USD1024.0@93.6"); the credit is the rupees.
--   · ₹95,846  $1,024 @ ₹93.60 from SCN Design Box LLC — a new export sale (0% GST under LUT).
--   · ₹1,77,000 $2,000 @ ₹88.50 from SCN Timbergloss Inc — pays INV-SCN-USD-1, raised at $2,000 @ ₹84.00
--     (₹1,68,000) → ₹9,000 forex gain.
--   · ₹93,600  $1,000 @ ₹93.60 from SCN Design Box LLC — a short remittance (billed $1,024, $24 bank charges).
-- Overseas customers (no state, country set). LUT rows for the FY: scenario lut-per-fy.

insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, contact_email, notes) values
  ('c2458000-0000-4000-8000-000000000011', :'tenant', 'SCN Design Box LLC', null, null, 'United States', 'overseas', 'business',
   'accounts@designbox.example', 'SCN scenario usd-inw-lines (R-2458)'),
  ('c2458000-0000-4000-8000-000000000012', :'tenant', 'SCN Timbergloss Inc', null, null, 'United States', 'overseas', 'business',
   'ap@timbergloss.example', 'SCN scenario usd-inw-lines (R-2458)');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, customer_country,
                             currency, fx_rate, fx_source, fx_date, gst_treatment, document_kind, line_items) values
  ('INV-SCN-USD-1', :'tenant', 'c2458000-0000-4000-8000-000000000012', 'SCN Timbergloss Inc', 168000, 'pending',
   current_date - 40, current_date - 10, 168000, 0, 0, true, 0, 'United States',
   'USD', 84.00, 'manual', current_date - 40, 'overseas', 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Export services — Timbergloss ($2,000)", "rate": 168000}]'::jsonb);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2458000-0000-4000-8000-000000000021', :'tenant', :'acct', current_date - 6,
   'INW 041126I0SCN0000021 USD1024.0@93.6 SCN DESIGN BOX LLC', 0, 95846, 'SCN-INW-2458-021', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000022', :'tenant', :'acct', current_date - 5,
   'INW 041126I0SCN0000022 USD2000.0@88.5 SCN TIMBERGLOSS INC', 0, 177000, 'SCN-INW-2458-022', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000023', :'tenant', :'acct', current_date - 4,
   'INW 041126I0SCN0000023 USD1000.0@93.6 SCN DESIGN BOX LLC', 0, 93600, 'SCN-INW-2458-023', 'csv_upload');
