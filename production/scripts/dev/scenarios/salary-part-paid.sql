-- R-2458 scenario "salary-part-paid" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2428 (payroll):
--   · SCN Ravi Kumar — last month's salary ₹30,000 made with Payroll (pay_salary, as the E2E owner), and a
--     ₹25,000 bank line linked to it → the record is "Partially paid" (₹5,000 owed) → ⋯ → Edit salary — set LOP.
--   · SCN Sunita Rao — a money-out line "… FULL N FINAL SALARY-SUNITA RAO" (₹52,000, last month) → Reconcile →
--     the Employee tile has "Full & final settlement" ticked → Book as salary → Start exit; and this month's
--     "… SALARY-SUNITA RAO" line, which must then say she left.

insert into public.employees (id, tenant_id, name, monthly_gross, joining_date, designation, is_active, notes) values
  ('c2458000-0000-4000-8000-000000000061', :'tenant', 'SCN Ravi Kumar', 30000, current_date - 400, 'Support Executive', true,
   'SCN scenario salary-part-paid (R-2458)'),
  ('c2458000-0000-4000-8000-000000000062', :'tenant', 'SCN Sunita Rao', 52000, current_date - 300, 'Sales Manager', true,
   'SCN scenario salary-part-paid (R-2458)');

-- Last month's salary for Ravi, made the way Payroll makes it (the RPC checks the caller's role).
select set_config('request.jwt.claims', json_build_object('sub',
  (select u.id from public.users u where u.tenant_id = :'tenant' and u.email = 'e2e-owner@example.test'),
  'role', 'authenticated')::text, true);
select public.pay_salary('c2458000-0000-4000-8000-000000000061', to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM'),
  (date_trunc('month', current_date) - interval '1 day')::date, 30000, 0, 0, 0, null, 0, 0, 0, 0, :'acct',
  'SCN scenario salary-part-paid (R-2458)');
select set_config('request.jwt.claims', '', true);

-- ₹25,000 of it paid from the bank (linking the line marks the record partially paid — sync_salary_paid_status).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source,
                                      matched_to_type, matched_to_id, matched_at, match_confidence) values
  ('c2458000-0000-4000-8000-000000000063', :'tenant', :'acct', (date_trunc('month', current_date) + interval '1 day')::date,
   'NEFT DR-SCN0000063-SALARY-SCN RAVI KUMAR', 25000, 0, 'SCN-SAL-2458-063', 'csv_upload',
   'salary', (select s.id::text from public.salary_payments s where s.employee_id = 'c2458000-0000-4000-8000-000000000061'), now(), 'manual');

-- Sunita's full & final (last month) and a salary line this month (after she left).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2458000-0000-4000-8000-000000000064', :'tenant', :'acct', (date_trunc('month', current_date) - interval '6 days')::date,
   '50100508724580-TPT-FULL N FINAL SALARY-SCN SUNITA RAO', 52000, 0, 'SCN-SAL-2458-064', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000065', :'tenant', :'acct', current_date - 1,
   '50100508724580-TPT-SALARY-SCN SUNITA RAO', 52000, 0, 'SCN-SAL-2458-065', 'csv_upload');
