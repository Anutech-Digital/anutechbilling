-- Seed the first categorisation rules for ANUTECH, derived from its OWN narrations.
--
-- Every pattern below was read off real rows in bank_transactions on 22 Aug 2026, with
-- the line count it covers. Nothing here is a guess about how Indian banks write things;
-- it is what this bank actually wrote on this account.
--
--   SALARY                 15 lines  "50100784857169-TPT-JULY SALARY-PAWAN",
--                                    "NEFT DR-...-PRATIK-...-JULY SALARY",
--                                    "IMPS-...-PARDEEP SHARMA-...-SALARY"
--   BILLDKPLAYSTOREGOOGL    2 lines  "DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL"
--   PAYUFACEBOOK            1 line   "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK"
--   STAFF WELFARE           1 line   "Petty cash: Staff Welfare"
--   ACCOUNTING SOFTWARE     1 line   "...-TPT-ACCOUNTING SOFTWARE-DEMO CO..."
--
-- WHY 'SALARY' IS THE ONE THAT MATTERS. It covers 15 of the 39 lines on this account, and
-- the built-in keyword list in lib/queries/expenses.ts deliberately REFUSES to answer it
-- ("'Salaries' is intentionally never guessed — those belong in Payroll"). That is right
-- for a typed expense note and wrong for a bank statement, so this is precisely the gap
-- the tenant-rule layer exists to fill.
--
-- ALL RULES ARE direction='debit'. Money going OUT. A credit carrying the word SALARY is
-- a refund or a reversal, and filing it as a salary expense would overstate the wage bill.
--
-- WHAT IS DELIBERATELY NOT SEEDED
--
--   '/ESIC' and the employee-advance lines. Both categories exist in the books
--   ('ESI — Employer', 'Employee Advance Disbursal') but NEITHER is in EXPENSE_CATEGORIES,
--   because they come out of payroll rather than expense entry. Seeding them would put a
--   category on screen that the dropdown cannot represent, so the operator's first edit
--   would silently change it to something else. Those lines want reconciling against a
--   payroll record, which is the matcher's job, not this one's.
--
--   'DEMO CO' — a vendor, and vendor payments are not one category. Same
--   counterparty can be a PO, software, or a reimbursement; the narration says which, so
--   a per-vendor rule would be confidently wrong.
--
--   Anything matching a payment rail (NEFT/RTGS/IMPS/UPI). Those say HOW the money moved,
--   not what for, and they appear on nearly every line.
--
-- IDEMPOTENT: on conflict does nothing, so re-running changes nothing. The unique index is
-- (tenant_id, upper(trim(pattern)), direction).

insert into public.txn_category_rules (tenant_id, pattern, category, direction)
values
  ('fbb976f1-9090-4f10-9726-0901bd144e42', 'SALARY',               'Salaries',      'debit'),
  ('fbb976f1-9090-4f10-9726-0901bd144e42', 'BILLDKPLAYSTOREGOOGL', 'Software',      'debit'),
  ('fbb976f1-9090-4f10-9726-0901bd144e42', 'PAYUFACEBOOK',         'Marketing',     'debit'),
  ('fbb976f1-9090-4f10-9726-0901bd144e42', 'STAFF WELFARE',        'Staff Welfare', 'debit'),
  ('fbb976f1-9090-4f10-9726-0901bd144e42', 'ACCOUNTING SOFTWARE',  'Software',      'debit')
on conflict do nothing
returning pattern, category, direction;
