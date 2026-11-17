-- R-2911 (17 Nov 2026, p0 paisa, G-FY2526): corrects R-2681's salary part. A Zoho salary (a line on a
-- salary-named Zoho account) comes in UNLESS Payroll already books it; R-2681's other refusals are
-- unchanged. The same cases as src/lib/integrations/zoho-books/purchase-import/plan-salary-r2911.test.ts:
--   S1  payee names an employee whose only payslip is in another month (Prashant: Jun 2026) → imported,
--       Salaries, paid; a rerun is "already".
--   S2  the named employee's payslip for that month → refused; S2b last month's payslip paid within 7
--       days of the row → refused; S2c the same payslip does NOT cover a row of 30 Jun → imported.
--   S3  payee names employee A (no payslip) while employee B has one that month → imported.
--   S4  payee names no employee and a payslip covers the date → refused; S4b none covers it → imported.
--   S5  a salary-named account whose Zoho TYPE is not an expense (Salary advance) → "Not an expense"
--       (new wording "is an account of type …").
--   S6  a Zoho expense with NO vendor on the salary account → imported vendor-less as Salaries.
--   S7  salary line + an unmapped non-salary line → the whole document left out ("not mapped").
--   S8  a Zoho salary BILL → stays out (no pay path for an unpaid Salaries row).
--   S9  a Zoho salary with TDS → stays out (192 is Payroll's).
--   S10 a MAPPED salary account (Director Salary → Director's Remuneration) is still checked: covered
--       month refused, another month imported under the mapped category.
--   S11 "Sewage charges" is not a salary → unmapped, left out as before.
-- Self-asserting; the whole file rolls back. Red without the migration (S1 refused "Payroll books salaries").
begin;

insert into auth.users (id, email) values
  ('b2911000-0000-0000-0000-0000000000a1', 'r2911-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2911000-0000-0000-0000-0000000000f0', 'R2911 T', 'r2911@example.test', '07', '07AAACR2911A1Z5', 'R2911');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2911000-0000-0000-0000-0000000000a1', 'b2911000-0000-0000-0000-0000000000f0', 'r2911-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2911000-0000-0000-0000-0000000000f0';
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('b2911000-0000-0000-0000-0000000000e1', 'b2911000-0000-0000-0000-0000000000f0', 'HDFC 4523', 'HDFC', 'current');

-- Payroll: Prashant's first payslip is Jun 2026 (as on staging); Ravi Kumar has May 2025, paid 3 Jun 2025;
-- director Anil Sharma has Aug 2025, paid 31 Aug 2025.
insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('b2911000-0000-0000-0000-0000000000c1', 'b2911000-0000-0000-0000-0000000000f0', 'Prashant', 17850),
  ('b2911000-0000-0000-0000-0000000000c2', 'b2911000-0000-0000-0000-0000000000f0', 'Ravi Kumar', 20000),
  ('b2911000-0000-0000-0000-0000000000c3', 'b2911000-0000-0000-0000-0000000000f0', 'Anil Sharma', 100000);
insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, net) values
  ('b2911000-0000-0000-0000-0000000000f0', 'b2911000-0000-0000-0000-0000000000c1', '2026-06', '2026-07-03', 7700, 7700),
  ('b2911000-0000-0000-0000-0000000000f0', 'b2911000-0000-0000-0000-0000000000c2', '2025-05', '2025-06-03', 20000, 20000),
  ('b2911000-0000-0000-0000-0000000000f0', 'b2911000-0000-0000-0000-0000000000c3', '2025-08', '2025-08-31', 100000, 100000);

-- Zoho's chart of accounts for this company (the server's one-statement write).
select public.save_zoho_account_types('b2911000-0000-0000-0000-0000000000f0', '[
  {"zoho_account_id":"A-RENT","zoho_account_name":"Rent","account_type":"expense"},
  {"zoho_account_id":"A-SAL","zoho_account_name":"Salaries and wages","account_type":"expense"},
  {"zoho_account_id":"A-SADV","zoho_account_name":"Salary advance","account_type":"other_current_asset"},
  {"zoho_account_id":"A-UNMAP","zoho_account_name":"Misc charges","account_type":"other_expense"},
  {"zoho_account_id":"A-DIR","zoho_account_name":"Director Salary","account_type":"expense"},
  {"zoho_account_id":"A-SEW","zoho_account_name":"Sewage charges","account_type":"expense"}]');

create function pg_temp.ln(acct text, nm text, taxable int, descr text) returns jsonb language sql as $f$
  select jsonb_build_object('accountId', acct, 'accountName', nm, 'description', descr, 'hsn', '', 'qty', 1,
    'taxable', taxable, 'tax', 0, 'itcEligible', true);
$f$;
create function pg_temp.doc(kind text, zid text, d text, taxable int, lines jsonb, vendor text, tds int) returns jsonb language sql as $f$
  select jsonb_build_object('kind', kind, 'zohoId', zid, 'number', case when kind = 'bills' then 'SAL-' || zid else '' end, 'date', d, 'dueDate', d,
    'status', case when kind = 'bills' then 'open' else 'nonbillable' end,
    'vendorZohoId', case when vendor = '' then '' else 'VZ-' || md5(vendor) end, 'vendorName', vendor, 'gstin', '', 'gstTreatment', '', 'currency', 'INR',
    'taxable', taxable, 'igst', 0, 'cgst', 0, 'sgst', 0, 'tax', 0, 'total', taxable,
    'rcm', false, 'rcmTax', 0, 'tdsAmount', tds, 'tdsSection', case when tds > 0 then '192' end, 'lines', lines,
    'paidThrough', 'HDFC 4523', 'reference', '', 'problems', '[]'::jsonb);
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2911000-0000-0000-0000-0000000000f0', x.p->>'kind', '2025-26', x.zid, x.p->>'number', (x.p->>'date')::date, x.p->>'status', x.p, now()
from (values
  ('s1',  pg_temp.doc('expenses', 's1',  '2025-04-30', 17000, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 17000, 'April salary')), 'Emp Prashant ( Salary )', 0)),
  ('s2',  pg_temp.doc('expenses', 's2',  '2025-05-31', 20000, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 20000, '')), 'Ravi Kumar', 0)),
  ('s2b', pg_temp.doc('expenses', 's2b', '2025-06-04', 1500,  jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 1500, 'salary to Ravi')), 'Staff Payouts', 0)),
  ('s2c', pg_temp.doc('expenses', 's2c', '2025-06-30', 20001, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 20001, '')), 'Ravi Kumar', 0)),
  ('s3',  pg_temp.doc('expenses', 's3',  '2025-05-30', 17001, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 17001, 'May salary')), 'Emp Prashant ( Salary )', 0)),
  ('s4',  pg_temp.doc('expenses', 's4',  '2025-05-28', 9000,  jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 9000, '')), 'Mohan Lal', 0)),
  ('s4b', pg_temp.doc('expenses', 's4b', '2025-07-31', 9001,  jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 9001, '')), 'Mohan Lal', 0)),
  ('s5',  pg_temp.doc('expenses', 's5',  '2025-08-10', 5000,  jsonb_build_array(pg_temp.ln('A-SADV', 'Salary advance', 5000, '')), 'Emp Prashant ( Salary )', 0)),
  ('s6',  pg_temp.doc('expenses', 's6',  '2025-08-31', 17002, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 17002, 'Salary Prashant Aug')), '', 0)),
  ('s7',  pg_temp.doc('expenses', 's7',  '2025-09-30', 17600, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 17000, ''), pg_temp.ln('A-UNMAP', 'Misc charges', 600, '')), 'Emp Prashant ( Salary )', 0)),
  ('s8',  pg_temp.doc('bills',    's8',  '2025-10-31', 17003, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 17003, '')), 'Emp Prashant ( Salary )', 0)),
  ('s9',  pg_temp.doc('expenses', 's9',  '2025-11-30', 17004, jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 17004, '')), 'Emp Prashant ( Salary )', 1700)),
  ('s10', pg_temp.doc('expenses', 's10', '2025-08-31', 100000, jsonb_build_array(pg_temp.ln('A-DIR', 'Director Salary', 100000, '')), 'Anil Sharma', 0)),
  ('s10b',pg_temp.doc('expenses', 's10b','2025-10-31', 100001, jsonb_build_array(pg_temp.ln('A-DIR', 'Director Salary', 100001, '')), 'Anil Sharma', 0)),
  ('s11', pg_temp.doc('expenses', 's11', '2025-12-15', 800,   jsonb_build_array(pg_temp.ln('A-SEW', 'Sewage charges', 800, '')), 'Jal Board', 0))
) as x(zid, p);

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.pick(zid text) returns jsonb language sql as $f$
  select jsonb_build_object('zoho_id', zid, 'vendor_id', null, 'account_id', 'b2911000-0000-0000-0000-0000000000e1');
$f$;
create function pg_temp.reason(r jsonb, zid text) returns text language sql as $f$
  select s->>'reason' from jsonb_array_elements(r->'skipped') s where s->>'zoho_id' = zid limit 1;
$f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.pick(text), pg_temp.reason(jsonb, text) to authenticated;
set local role authenticated;

do $$
declare r jsonb; rb jsonb;
  ravi_may constant text := 'Payroll already books this salary — Ravi Kumar''s payslip for May 2025 (paid 03 Jun 2025) is in Payroll, so this Zoho salary is not imported (it would count twice). If it is a different payment, add it by hand.';
begin
  perform pg_temp.as_user('b2911000-0000-0000-0000-0000000000a1');
  r := public.save_zoho_account_categories('[{"zoho_account_id":"A-RENT","zoho_account_name":"Rent","category":"Office Rent"},
    {"zoho_account_id":"A-DIR","zoho_account_name":"Director Salary","category":"Director''s Remuneration"}]');

  r := public.import_zoho_fy_purchases('expenses', '2025-26',
    jsonb_build_array(pg_temp.pick('s1'), pg_temp.pick('s2'), pg_temp.pick('s2b'), pg_temp.pick('s2c'), pg_temp.pick('s3'), pg_temp.pick('s4'),
                      pg_temp.pick('s4b'), pg_temp.pick('s5'), pg_temp.pick('s6'), pg_temp.pick('s7'), pg_temp.pick('s9'),
                      pg_temp.pick('s10'), pg_temp.pick('s10b'), pg_temp.pick('s11')), false);
  rb := public.import_zoho_fy_purchases('bills', '2025-26', '[{"zoho_id":"s8","vendor_id":null}]', false);

  -- S1: Prashant's Apr 2025 salary — his only payslip is Jun 2026 → imported as Salaries, paid.
  if not exists (select 1 from public.expenses where zoho_doc_id = 'expenses:s1' and category = 'Salaries' and amount = 17000 and paid) then
    raise exception 'FAIL S1: Prashant Apr 2025 must import as a paid Salaries expense: %', r; end if;
  -- S2 / S2b / S2c: Ravi Kumar's May 2025 payslip, paid 3 Jun 2025.
  if pg_temp.reason(r, 's2') is distinct from ravi_may then raise exception 'FAIL S2: payslip for the month must refuse: %', r; end if;
  if pg_temp.reason(r, 's2b') is distinct from ravi_may then raise exception 'FAIL S2b: last month''s payslip paid within 7 days must refuse: %', r; end if;
  if not exists (select 1 from public.expenses where zoho_doc_id = 'expenses:s2c' and category = 'Salaries' and amount = 20001) then
    raise exception 'FAIL S2c: June''s salary is not covered by May''s payslip: %', r; end if;
  -- S3: Prashant in May 2025 — Ravi has a payslip that month, Prashant has none → imported.
  if not exists (select 1 from public.expenses where zoho_doc_id = 'expenses:s3' and category = 'Salaries' and amount = 17001) then
    raise exception 'FAIL S3: a named employee with no payslip that month must import: %', r; end if;
  -- S4 / S4b: Mohan Lal is not in Payroll.
  if pg_temp.reason(r, 's4') is distinct from 'Payroll has salaries for May 2025 and Zoho''s payee is not an employee in Payroll — add it by hand if it is someone else (it could count twice).' then
    raise exception 'FAIL S4: untied payee in a Payroll month must refuse: %', r; end if;
  if not exists (select 1 from public.expenses where zoho_doc_id = 'expenses:s4b' and category = 'Salaries' and amount = 9001) then
    raise exception 'FAIL S4b: untied payee in a month with no payslip must import: %', r; end if;
  -- S5: R-2681's type rule first, with the corrected wording.
  if pg_temp.reason(r, 's5') is distinct from 'Not an expense — needs another path: in Zoho, "Salary advance" is an account of type "other current asset". Fixed deposits, loans, GST, assets and advances are never booked as an expense.' then
    raise exception 'FAIL S5: salary advance must stay Not an expense: %', r; end if;
  -- S6: no vendor → vendor-less Salaries expense.
  if not exists (select 1 from public.expenses where zoho_doc_id = 'expenses:s6' and category = 'Salaries' and amount = 17002 and vendor_id is null and bill_type = 'none') then
    raise exception 'FAIL S6: no-vendor salary must import vendor-less: %', r; end if;
  -- S7: an unmapped non-salary line still leaves the whole document out.
  if pg_temp.reason(r, 's7') is distinct from 'Zoho account "Misc charges" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.' then
    raise exception 'FAIL S7: unmapped misc line must leave the document out: %', r; end if;
  -- S8 / S9: a salary bill and a salary with TDS stay out.
  if pg_temp.reason(rb, 's8') is distinct from 'A Zoho salary bill stays out — an unpaid salary has no pay path in the app. Pay it in Payroll, or add it by hand as a paid expense.' then
    raise exception 'FAIL S8: a salary bill must stay out: %', rb; end if;
  if pg_temp.reason(r, 's9') is distinct from 'A Zoho salary with TDS stays out — salary TDS (section 192) is booked by Payroll. Add this salary in Payroll.' then
    raise exception 'FAIL S9: a salary with TDS must stay out: %', r; end if;
  -- S10: a mapped salary account is still checked against Payroll; another month imports under its own category.
  if pg_temp.reason(r, 's10') is distinct from 'Payroll already books this salary — Anil Sharma''s payslip for Aug 2025 (paid 31 Aug 2025) is in Payroll, so this Zoho salary is not imported (it would count twice). If it is a different payment, add it by hand.' then
    raise exception 'FAIL S10: a mapped salary account in a Payroll month must refuse: %', r; end if;
  if not exists (select 1 from public.expenses where zoho_doc_id = 'expenses:s10b' and category = 'Director''s Remuneration' and amount = 100001) then
    raise exception 'FAIL S10b: a mapped salary account in a free month imports under its category: %', r; end if;
  -- S11: "Sewage charges" is not a salary.
  if pg_temp.reason(r, 's11') is distinct from 'Zoho account "Sewage charges" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.' then
    raise exception 'FAIL S11: sewage is not a salary: %', r; end if;

  if exists (select 1 from public.expenses where zoho_doc_id in ('expenses:s2', 'expenses:s2b', 'expenses:s4', 'expenses:s5', 'expenses:s9', 'expenses:s10', 'expenses:s11')
                                            or zoho_doc_id like 'expenses:s7%' or zoho_doc_id = 'bills:s8') then
    raise exception 'FAIL: a refused document was written'; end if;
  if (r->>'imported')::int <> 6 then raise exception 'FAIL: want 6 imported (s1 s2c s3 s4b s6 s10b): %', r; end if;
  if exists (select 1 from public.expenses where tenant_id = 'b2911000-0000-0000-0000-0000000000f0' and category = 'Unmapped — review') then
    raise exception 'FAIL: an Unmapped — review row was written'; end if;

  -- Rerun: already, no second row.
  r := public.import_zoho_fy_purchases('expenses', '2025-26', jsonb_build_array(pg_temp.pick('s1')), true);
  if (r->>'already')::int <> 1 or (r->>'imported')::int <> 0 then raise exception 'FAIL S1 rerun must be already: %', r; end if;
end $$;

rollback;
