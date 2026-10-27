-- R-1957 scenario "bills-page-paid" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Serves R-1911: a payment recorded OUTSIDE the bank + the real statement line for the same money must be
-- MATCHED, never paid twice.
--   1. COGS bill SCN-M-10 ₹10,000, ₹5,000 paid from the Bills page (pay_vendor_bill → a manual bank line),
--      and the real HDFC ₹5,000 line.
--   2. Expense bill SCN-MP-1 ₹4,720 marked paid on the Expenses page (no bank line), and its real line.

insert into public.vendors (id, tenant_id, name, gstin, pan, default_category, state, notes) values
  ('c1957000-0000-4000-8000-000000000301', :'tenant', 'Mehta Cloud Distributors', '27AAKFM1957A1Z5', 'AAKFM1957A',
   'COGS-Workspace', 'Maharashtra', 'SCN scenario bills-page-paid (R-1957)');

insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category,
                                 subtotal, igst, total, status, paid_amount, notes) values
  ('BILL-SCN-M-10', :'tenant', 'c1957000-0000-4000-8000-000000000301', 'Mehta Cloud Distributors', '27AAKFM1957A1Z5',
   'SCN-M-10', current_date - 20, current_date + 10, 'COGS-Workspace', 8475, 1525, 10000, 'unpaid', 0,
   'SCN scenario bills-page-paid (R-1957)');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid,
                             bill_type, bill_no, paid, paid_date, paid_amount, payment_method, description) values
  ('EXP-SCN-MP-1', :'tenant', 'Software & Subscriptions', 'Mehta Cloud Distributors', 'c1957000-0000-4000-8000-000000000301',
   current_date - 18, current_date + 12, 4720, 720, 'gst', 'SCN-MP-1', true, current_date - 5, 0, 'bank',
   'SCN Mehta bill MP-1, marked paid on the Expenses page (R-1911: match its bank line)');

-- Bills page → Pay ₹5,000 on SCN-M-10, as the owner (pay_vendor_bill writes the manual bank line).
select set_config('request.jwt.claims',
  json_build_object('sub', (select u.id from public.users u where u.tenant_id = :'tenant' and u.role = 'owner'
                             order by u.created_at limit 1), 'role', 'authenticated')::text, true);
select public.pay_vendor_bill('BILL-SCN-M-10', 5000, current_date - 6, :'acct', 'NEFT') is not null as bills_page_paid;
select set_config('request.jwt.claims', '', true);

-- The real statement lines for the same money
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c1957000-0000-4000-8000-000000000311', :'tenant', :'acct', current_date - 6,
   'NEFT DR-HDFC0004567-MEHTA CLOUD DISTRIBUTORS-NETBANK, MUM-N298261957000311-SCN M10 PART', 5000, 0, 'SCN-N298261957000311', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000312', :'tenant', :'acct', current_date - 5,
   'IMPS-629919570312-MEHTA CLOUD DISTRIBUTORS-HDFC-XXXXXX8899-SCN MP1', 4720, 0, 'SCN-629919570312', 'csv_upload');
