-- R-1957 scenario "vendor-advance" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Serves R-1913 (₹30,000 advance set off against a ₹50,000 bill) and R-1952 (a ₹3,000 advance on a
-- ₹5,000 bill: payment run / bulk Mark paid / Balance Sheet show ₹2,000 due).

insert into public.vendors (id, tenant_id, name, gstin, pan, default_category, state, notes) values
  ('c1957000-0000-4000-8000-000000000201', :'tenant', 'Verma Traders', '07AAKFV1957A1Z5', 'AAKFV1957A',
   'Repairs & Maintenance', 'Delhi', 'SCN scenario vendor-advance (R-1957)');

-- The advances arrive as plain money-out lines; recording them as an advance is the card's own step.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c1957000-0000-4000-8000-000000000211', :'tenant', :'acct', current_date - 12,
   'NEFT DR-PUNB0123400-VERMA TRADERS-NETBANK, MUM-N298261957000211-SCN ADVANCE', 30000, 0, 'SCN-N298261957000211', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000212', :'tenant', :'acct', current_date - 9,
   'NEFT DR-PUNB0123400-VERMA TRADERS-NETBANK, MUM-N298261957000212-SCN ADVANCE 2', 3000, 0, 'SCN-N298261957000212', 'csv_upload');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid,
                             bill_type, bill_no, paid, paid_amount, payment_method, description) values
  ('EXP-SCN-VT-1', :'tenant', 'Repairs & Maintenance', 'Verma Traders', 'c1957000-0000-4000-8000-000000000201',
   current_date - 3, current_date + 27, 50000, 0, 'none', 'SCN-VT-1', false, 0, null,
   'SCN Verma bill VT-1 (R-1913: apply the 30,000 advance, 20,000 stays due)'),
  ('EXP-SCN-VT-2', :'tenant', 'Repairs & Maintenance', 'Verma Traders', 'c1957000-0000-4000-8000-000000000201',
   current_date - 2, current_date + 28, 5000, 0, 'none', 'SCN-VT-2', false, 0, null,
   'SCN Verma bill VT-2 (R-1952: apply the 3,000 advance, 2,000 stays due)');
