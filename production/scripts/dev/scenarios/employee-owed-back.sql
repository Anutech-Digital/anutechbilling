-- R-2407 scenario "employee-owed-back" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
--   · SCN Neelam Sharma — last month's salary ₹30,000 made with Payroll (pay_salary, as the E2E owner), not paid yet.
--   · A money-in line "UPI/…/SCN NEELAM SHARMA/PAID BY MISTAKE" ₹16,000 (she paid the company by mistake; she
--     holds no advance) → Reconcile → Employee return → every employee listed → "Paid to us by mistake — we owe
--     it back" → owed back to SCN Neelam Sharma.
--   · A money-out line "NEFT DR-…-SALARY-SCN NEELAM SHARMA" ₹46,000 (her salary + the ₹16,000 back) → Reconcile
--     → Employee / salary → "Also pays back ₹16,000 owed to SCN Neelam Sharma" → salary paid, nothing owed.

insert into public.employees (id, tenant_id, name, monthly_gross, joining_date, designation, is_active, notes) values
  ('c2458000-0000-4000-8000-000000000101', :'tenant', 'SCN Neelam Sharma', 30000, current_date - 500, 'Accounts Executive', true,
   'SCN scenario employee-owed-back (R-2407)');

-- Last month's salary, made the way Payroll makes it (the RPC checks the caller's role).
select set_config('request.jwt.claims', json_build_object('sub',
  pg_temp.scn_user(:'tenant', 'owner'),
  'role', 'authenticated')::text, true);
select public.pay_salary('c2458000-0000-4000-8000-000000000101', to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM'),
  (date_trunc('month', current_date) - interval '1 day')::date, 30000, 0, 0, 0, null, 0, 0, 0, 0, :'acct',
  'SCN scenario employee-owed-back (R-2407)');
select set_config('request.jwt.claims', '', true);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2458000-0000-4000-8000-000000000103', :'tenant', :'acct', (date_trunc('month', current_date) - interval '10 days')::date,
   'UPI/510324071103/SCN NEELAM SHARMA/PAID BY MISTAKE', 0, 16000, 'SCN-OWE-2407-103', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000104', :'tenant', :'acct', current_date,
   'NEFT DR-SCN0000104-SALARY-SCN NEELAM SHARMA', 46000, 0, 'SCN-OWE-2407-104', 'csv_upload');
