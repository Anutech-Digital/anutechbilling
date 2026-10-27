-- R-1957 scenario "vendor-sharma" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Serves R-1915 (part payment), R-1917 (no double cost), R-1912 (undo keeps the bill), R-1918 (new vendor
-- from a UPI line), R-1919 (learned alias). Amounts are whole rupees. Dates follow today so the
-- ±30-day matching and the default page ranges always see them.

-- Sharma Associates: services vendor, NO bank details at first (R-1918 fills them from a line).
-- Google Cloud India: a COGS supplier.
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category, state, notes) values
  ('c1957000-0000-4000-8000-000000000101', :'tenant', 'Sharma Associates', '07AAKFS1957A1Z5', 'AAKFS1957A',
   'Professional Services', 'Delhi', 'SCN scenario vendor-sharma (R-1957)'),
  ('c1957000-0000-4000-8000-000000000102', :'tenant', 'Google Cloud India Pvt Ltd', '29AACCG1957B1Z9', 'AACCG1957B',
   'COGS-Workspace', 'Karnataka', 'SCN scenario vendor-sharma (R-1957)');

-- Unpaid expense (services) bills
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid,
                             bill_type, bill_no, paid, paid_amount, payment_method, description) values
  ('EXP-SCN-PS-1', :'tenant', 'Professional Services', 'Sharma Associates', 'c1957000-0000-4000-8000-000000000101',
   current_date - 25, current_date + 5, 59000, 9000, 'gst', 'SCN-PS-1', false, 0, null,
   'SCN Sharma bill PS-1 (R-1915 part payment: 25,000 + 34,000)'),
  ('EXP-SCN-PS-2', :'tenant', 'Professional Services', 'Sharma Associates', 'c1957000-0000-4000-8000-000000000101',
   current_date - 15, current_date + 15, 11800, 1800, 'gst', 'SCN-PS-2', false, 0, null,
   'SCN Sharma bill PS-2 (R-1917: pay with Record payment, not Book as expense)');

-- Unpaid COGS bill
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category,
                                 subtotal, igst, total, status, paid_amount, notes) values
  ('BILL-SCN-G-20', :'tenant', 'c1957000-0000-4000-8000-000000000102', 'Google Cloud India Pvt Ltd', '29AACCG1957B1Z9',
   'SCN-G-20', current_date - 15, current_date + 15, 'COGS-Workspace', 10000, 1800, 11800, 'unpaid', 0,
   'SCN scenario vendor-sharma (R-1957)');

-- HDFC-style money-out lines on the SCN account (narration formats as narration-bank-details.ts reads them)
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c1957000-0000-4000-8000-000000000111', :'tenant', :'acct', current_date - 10,
   'NEFT DR-HDFC0001234-SHARMA ASSOCIATES-NETBANK, MUM-N298261957000111-XXXXXX4321-SCN PS1 PART', 25000, 0, 'SCN-N298261957000111', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000112', :'tenant', :'acct', current_date - 6,
   'IMPS-629919570112-SHARMA ASSOCIATES-HDFC-XXXXXX4321-SCN PS1 BALANCE', 34000, 0, 'SCN-629919570112', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000113', :'tenant', :'acct', current_date - 5,
   'IMPS-629919570113-SHARMA ASSOCIATES-HDFC-XXXXXX4321-SCN PS2', 11800, 0, 'SCN-629919570113', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000114', :'tenant', :'acct', current_date - 4,
   'NEFT DR-HSBC0400002-GOOGLE CLOUD INDIA PVT LTD-NETBANK, MUM-N298261957000114-SCN G20', 5000, 0, 'SCN-N298261957000114', 'csv_upload'),
  -- a payee who is NOT a vendor yet (R-1918 "＋ New vendor", then R-1919 guesses the next line)
  ('c1957000-0000-4000-8000-000000000115', :'tenant', :'acct', current_date - 3,
   'UPI-BANSAL PRINT HOUSE-bansalprint@okicici-ICIC0001234-629919570115-SCN NEWVENDOR', 7080, 0, 'SCN-629919570115', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000116', :'tenant', :'acct', current_date - 2,
   'UPI-BANSAL PRINT HOUSE-bansalprint@okicici-ICIC0001234-629919570116-SCN NEWVENDOR 2', 2360, 0, 'SCN-629919570116', 'csv_upload');
