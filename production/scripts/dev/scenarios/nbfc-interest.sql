-- R-2458 scenario "nbfc-interest" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2376: TDS on loan interest to a NON-BANK lender (old 194A, ₹10,000 a year per lender).
--   · SCN Bajaj Finance Ltd (an NBFC) — term loan ₹5,00,000; two EMIs this FY with ₹6,500 interest each
--     (₹13,000 > ₹10,000) → Business Loans shows the "TDS on loan interest" box, asks "Is … a bank?".
--   · SCN HDFC Bank — term loan; ₹8,000 interest this FY → a bank, nothing due.
--   · A money-out line "ACH DR-SCN BAJAJ FINANCE LTD-EMI" ₹15,000 (₹6,500 interest) to book as Loan / EMI.

insert into public.business_loans (id, tenant_id, lender, purpose, principal, interest_rate, tenure_months, emi_amount,
                                   disbursed_on, deposit_account_id, status, kind, notes) values
  ('c2458000-0000-4000-8000-000000000071', :'tenant', 'SCN Bajaj Finance Ltd', 'Working capital', 500000, 15.5, 36, 15000,
   current_date - 240, :'acct', 'active', 'term', 'SCN scenario nbfc-interest (R-2458)'),
  ('c2458000-0000-4000-8000-000000000072', :'tenant', 'SCN HDFC Bank', 'Vehicle loan', 800000, 9.5, 60, 17000,
   current_date - 240, :'acct', 'active', 'term', 'SCN scenario nbfc-interest (R-2458)');

-- EMIs on or after this FY's 1 April (the box sums interest booked in the FY)
insert into public.business_loan_payments (id, tenant_id, loan_id, amount, principal_part, interest_part, paid_on, bank_account_id, notes) values
  ('c2458000-0000-4000-8000-000000000073', :'tenant', 'c2458000-0000-4000-8000-000000000071', 15000, 8500, 6500,
   make_date(extract(year from current_date - interval '3 months')::int, 4, 1) + 9, :'acct', 'SCN scenario nbfc-interest (R-2458)'),
  ('c2458000-0000-4000-8000-000000000074', :'tenant', 'c2458000-0000-4000-8000-000000000071', 15000, 8500, 6500,
   make_date(extract(year from current_date - interval '3 months')::int, 4, 1) + 39, :'acct', 'SCN scenario nbfc-interest (R-2458)'),
  ('c2458000-0000-4000-8000-000000000075', :'tenant', 'c2458000-0000-4000-8000-000000000072', 17000, 9000, 8000,
   make_date(extract(year from current_date - interval '3 months')::int, 4, 1) + 9, :'acct', 'SCN scenario nbfc-interest (R-2458)');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2458000-0000-4000-8000-000000000076', :'tenant', :'acct', current_date - 3,
   'ACH DR-SCN BAJAJ FINANCE LTD-EMI 2458076', 15000, 0, 'SCN-EMI-2458-076', 'csv_upload');
