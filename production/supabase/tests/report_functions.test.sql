-- Regression test: S17 report functions (migration 20260928110000_report_functions.sql)
--   report_balance_sheet, report_pnl, report_pnl_monthly, report_party_ledger,
--   report_ledger_vendors
--
-- Kya saabit karta hai:
--   1. Har figure ek HAATH SE GINA hua number hai (neeche fixture ke saath hisaab likha
--      hai) — "kuch to aaya" nahi, balki exact rupaye.
--   2. Doosre tenant (B) ki rows kisi total me nahi aati — B me jaan-boojh kar bade,
--      pehchaane jaane wale number rakhe hain (999999, 77777) taaki leak turant dikhe.
--   3. Bina tenant ke login par function RAISE karta hai, 0 nahi lautata (L10).
--
-- Fixture apna data khud banata hai (L11) — koi live id nahi. Poora `begin … rollback`.
-- tests/parity/reports-parity.test.ts isi fixture ko (FIXTURE:BEGIN … FIXTURE:END ke beech
-- ka hissa) padh kar purane TS computation se milata hai — fixture badlo to dono jagah asar.

begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- FIXTURE:BEGIN
insert into public.tenants (id, name, email, state_code) values
  ('d1700000-0000-0000-0000-0000000000a1', 'S17 REPORT TEST A', 's17-a@example.in', '07'),
  ('d1700000-0000-0000-0000-0000000000b1', 'S17 REPORT TEST B', 's17-b@example.in', '07');
insert into auth.users (id, email) values
  ('d1700000-0000-0000-0000-0000000000a2', 's17-user-a@example.test'),
  ('d1700000-0000-0000-0000-0000000000c2', 's17-orphan@example.test');
-- The reader is the OWNER (R-138, 3 Oct 2026): since role hardening (20260930175000) only
-- owner / manager / accountant may read salary_payments, and this file checks the arithmetic,
-- not who may see it. A default-role user read salary_payable as 0 and failed here.
insert into public.users (id, tenant_id, email, role) values
  ('d1700000-0000-0000-0000-0000000000a2', 'd1700000-0000-0000-0000-0000000000a1', 's17-user-a@example.in', 'owner');

insert into public.customers (id, tenant_id, name) values
  ('d1700000-0000-0000-0000-00000000c001', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Customer One'),
  ('d1700000-0000-0000-0000-00000000c0b1', 'd1700000-0000-0000-0000-0000000000b1', 'S17 Customer B');

-- Bank: current 100000 + 50000 − 20000 = 130000; card −8000 (payable 8000); overpaid card +500 (cash).
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('d1700000-0000-0000-0000-0000000ba001', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Current', 'HDFC', 'current', 100000, '2026-04-01'),
  ('d1700000-0000-0000-0000-0000000ba002', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Card', 'HDFC', 'credit_card', 0, '2026-04-01'),
  ('d1700000-0000-0000-0000-0000000ba003', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Card 2', 'ICICI', 'credit_card', 0, '2026-04-01'),
  ('d1700000-0000-0000-0000-0000000bab01', 'd1700000-0000-0000-0000-0000000000b1', 'S17 B Bank', 'SBI', 'current', 999999, '2026-04-01');
insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, credit, debit, source) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-0000000ba001', '2026-05-01', 'in',  50000, 0, 'manual'),
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-0000000ba001', '2026-05-02', 'out', 0, 20000, 'manual'),
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-0000000ba002', '2026-05-03', 'card', 0, 8000, 'manual'),
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-0000000ba003', '2026-05-04', 'card refund', 500, 0, 'manual');

-- Invoices (tenant A, sab customer One):
--   INV1 pending  11800 (net 10000, taxable 10000, tax 1800) 2026-05-10
--   INV2 overdue   5900 (sab null → taxable 5000, tax 900 reverse-derived) 2026-06-01
--   INV3 paid     23600 (20000 / 3600) 2026-07-01
--   INV4 pending  50000 (42373 / 7627) 2026-08-01 — project milestone ka invoice
--   INV5 void     99999 — kahin nahi ginna
--   INV6 paid     11800 (10000 / 1800) 2026-03-15 — pichhla FY, ledger ka opening
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, taxable_value, tax_amount, tax_rate, status, invoice_date) values
  ('S17-INV1', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', 11800, 10000, 10000, 1800, 18, 'pending', '2026-05-10'),
  ('S17-INV2', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One',  5900, null,  null,  null, 18, 'overdue', '2026-06-01'),
  ('S17-INV3', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', 23600, 23600, 20000, 3600, 18, 'paid',    '2026-07-01'),
  ('S17-INV4', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', 50000, 50000, 42373, 7627, 18, 'pending', '2026-08-01'),
  ('S17-INV5', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', 99999, 99999, 84745, 15254, 18, 'void', '2026-05-01'),
  ('S17-INV6', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', 11800, 11800, 10000, 1800, 18, 'paid',    '2026-03-15'),
  ('S17-INVB', 'd1700000-0000-0000-0000-0000000000b1', 'd1700000-0000-0000-0000-00000000c0b1', 'S17 Customer B',   77777, 77777, 65913, 11864, 18, 'pending', '2026-05-10');

insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, credit_date, reason_code, amount, taxable_value, tax_amount, tax_rate, inter_state) values
  ('S17-CN1', 'd1700000-0000-0000-0000-0000000000a1', 'S17-INV3', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', '2026-07-10', 'other', 1180, 1000, 180, 18, false);
insert into public.debit_notes (id, tenant_id, invoice_id, customer_id, customer_name, debit_date, reason_code, amount, taxable_value, tax_amount, tax_rate, inter_state) values
  ('S17-DN1', 'd1700000-0000-0000-0000-0000000000a1', 'S17-INV1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', '2026-07-15', 'other', 590, 500, 90, 18, false);

-- Quotes/payments: Q1 par invoice nahi → P1 (7000 received) advance hai. P2 Q2 (invoiced) par.
-- P3 refunded: ledger me Receipt + Refund dono, advance me nahi (status received nahi).
-- P2 20:00 UTC = 01:30 IST agle din — ledger UTC din dikhata hai (migration ka IST note).
insert into public.quotes (id, tenant_id, customer_id, customer_name, invoice_id) values
  ('S17-Q1', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', null),
  ('S17-Q2', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', 'S17-INV3'),
  ('S17-QB', 'd1700000-0000-0000-0000-0000000000b1', 'd1700000-0000-0000-0000-00000000c0b1', 'S17 Customer B', null);
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, refunded_at, receipt_voucher_no) values
  ('d1700000-0000-0000-0000-0000000fa001', 'd1700000-0000-0000-0000-0000000000a1', 'S17-Q1', 'd1700000-0000-0000-0000-00000000c001',  7000, 'upi', 'UTR1', 'received', '2026-05-20 10:00+00', null, 'S17-RV1'),
  ('d1700000-0000-0000-0000-0000000fa002', 'd1700000-0000-0000-0000-0000000000a1', 'S17-Q2', 'd1700000-0000-0000-0000-00000000c001', 23600, 'bank_transfer', null,  'received', '2026-07-02 20:00+00', null, 'S17-RV2'),
  ('d1700000-0000-0000-0000-0000000fa003', 'd1700000-0000-0000-0000-0000000000a1', 'S17-Q1', 'd1700000-0000-0000-0000-00000000c001',  3000, 'upi', '',     'refunded', '2026-06-01 10:00+00', '2026-06-05 10:00+00', null),
  ('d1700000-0000-0000-0000-0000000fab01', 'd1700000-0000-0000-0000-0000000000b1', 'S17-QB', 'd1700000-0000-0000-0000-00000000c0b1', 55555, 'upi', null,  'received', '2026-05-20 10:00+00', null, null);

-- Project: invoiced milestone 50000 (INV4) − received 20000 = 30000; un-invoiced 30000 nahi ginta.
insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, status) values
  ('d1700000-0000-0000-0000-00000000f001', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000c001', 'S17 Customer One', 'S17 Project', 67797, 12203, 80000, 'active');
insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, invoice_id) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000f001', 1, 'M1', 50000, 'S17-INV4'),
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000f001', 2, 'M2', 30000, null);
insert into public.project_payments (tenant_id, project_id, amount, received_at) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000f001', 20000, '2026-08-10');

-- TDS receivable: open = 1000 + 500 = 1500 (claimed 700 nahi).
insert into public.tds_receivable (id, tenant_id, customer_name, section, rate_pct, gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status) values
  ('S17-TDS1', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Customer One', '194J', 10, 10000, 1000,  9000, 'FY2627', '2026-05-20', 'pending_cert'),
  ('S17-TDS2', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Customer One', '194J', 10,  5000,  500,  4500, 'FY2627', '2026-06-20', 'verified_26as'),
  ('S17-TDS3', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Customer One', '194J', 10,  7000,  700,  6300, 'FY2526', '2025-06-20', 'claimed'),
  ('S17-TDSB', 'd1700000-0000-0000-0000-0000000000b1', 'S17 Customer B',   '194J', 10, 55550, 5555, 49995, 'FY2627', '2026-05-20', 'pending_cert');

-- Employee loan 20000 − 5000 = 15000. Prepaid 12000−4000 = 8000 (+ overconsumed → 0).
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on) values
  ('d1700000-0000-0000-0000-00000000e101', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Staff', 20000, '2026-04-10');
insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e101', 5000, '2026-05-10', 'salary_deduction');
insert into public.prepaid_advances (tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date) values
  ('d1700000-0000-0000-0000-0000000000a1', 'S17 Prepaid Co', 'Software', 12000, 4000, '2026-04-15'),
  ('d1700000-0000-0000-0000-0000000000a1', 'S17 Prepaid Co', 'Software',  1000, 1500, '2026-04-15');

-- EMI asset: cost 60000, financed 50000 − principal 10000 = 40000 loan.
insert into public.emi_purchases (id, tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on) values
  ('d1700000-0000-0000-0000-00000000e201', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Laptop', 'equipment', 60000, 10000, 50000, 10, 5200, '2026-04-20');
insert into public.emi_payments (tenant_id, purchase_id, amount, principal_part, interest_part, paid_on) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e201', 10400, 10000, 400, '2026-05-20');

-- Business loan 100000 − 25000 = 75000.
insert into public.business_loans (id, tenant_id, lender, principal, disbursed_on) values
  ('d1700000-0000-0000-0000-00000000e301', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Bank', 100000, '2026-04-01');
insert into public.business_loan_payments (tenant_id, loan_id, amount, principal_part, interest_part, paid_on) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e301', 27000, 25000, 2000, '2026-06-01');

-- Vendor bills: VB1 COGS unpaid 11800 − 1800 = payable 10000 (GST 1800); VB2 paid Rent (IGST 900).
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount) values
  ('S17-VB1', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Distributor', 'D-1', '2026-06-05', 'COGS-Google', 10000, 900, 900, 0, 11800, 'partial', 1800),
  ('S17-VB2', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Landlord',    'L-1', '2026-06-10', 'Rent',         5000,   0,   0, 900, 5900, 'paid', 5900);

-- Vendor master: GSTIN wala vendor (ITC ke liye). Tenant B ka bhi ek, kahin na dikhe.
insert into public.vendors (id, tenant_id, name, gstin) values
  ('d1700000-0000-0000-0000-00000000fe01', 'd1700000-0000-0000-0000-0000000000a1', 'Acme Cloud', '07ABCDE1234F1Z5'),
  ('d1700000-0000-0000-0000-00000000feb1', 'd1700000-0000-0000-0000-0000000000b1', 'Acme Cloud', '07ABCDE1234F1Z5');

-- Expenses (amount GST-inclusive):
--   E1 Software 11800 (GST 1800, GST bill, GSTIN vendor → ITC eligible) paid
--   E2 Rent 20000, vendor TDS 2000 withheld
--   E3 '' → Uncategorised; naam me space (vendor picker trim karta hai, ledger exact match)
--   E4 pichhla FY, staff
--   E5 Staff Welfare 1180 (GST 180 — s.17(5) blocked)
--   E6 project-tagged 3000 (project direct cost)
--   E7 Salaries 28000 in-window (project-cost ka salary pool)
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, bill_type, expense_date, amount, gst_paid, tds_amount, bill_no, paid, paid_date, payment_method, project_id, description) values
  ('S17-E1', 'd1700000-0000-0000-0000-0000000000a1', 'Software',      'Acme Cloud',     'd1700000-0000-0000-0000-00000000fe01', 'gst',  '2026-06-15', 11800, 1800,    0, 'B-1', true,  '2026-06-20', 'card', null, null),
  ('S17-E2', 'd1700000-0000-0000-0000-0000000000a1', 'Rent',          'Acme Cloud',     null,                                   'none', '2026-07-01', 20000,    0, 2000, null,  false, null, null, null, null),
  ('S17-E3', 'd1700000-0000-0000-0000-0000000000a1', '',              ' Acme Cloud ',   null,                                   'none', '2026-08-01',   500,    0,    0, null,  false, null, null, null, null),
  ('S17-E4', 'd1700000-0000-0000-0000-0000000000a1', 'Salaries',      'Staff One',      null,                                   'none', '2026-03-10', 30000,    0,    0, null,  true,  '2026-03-10', 'bank', null, null),
  ('S17-E5', 'd1700000-0000-0000-0000-0000000000a1', 'Staff Welfare', 'S17 Caterer',    'd1700000-0000-0000-0000-00000000fe01', 'gst',  '2026-08-10',  1180,  180,    0, null,  false, null, null, null, null),
  ('S17-E6', 'd1700000-0000-0000-0000-0000000000a1', 'Software',      'S17 Freelancer', null,                                   'none', '2026-08-12',  3000,    0,    0, null,  false, null, null, 'd1700000-0000-0000-0000-00000000f001', 'module build'),
  ('S17-E7', 'd1700000-0000-0000-0000-0000000000a1', 'Salaries',      'Staff One',      null,                                   'none', '2026-08-31', 28000,    0,    0, null,  false, null, null, null, null),
  ('S17-EB', 'd1700000-0000-0000-0000-0000000000b1', 'Software',      'Acme Cloud',     'd1700000-0000-0000-0000-00000000feb1', 'gst',  '2026-06-15', 44444, 4444, 4444, null,  false, null, null, null, null);

-- Salary: net payable = unpaid 26000 − 6000 = 20000. Statutory: TDS 1000, PF 1800+1800,
-- ESI 200+650 (har booked row, employer share bhi) + vendor TDS 2000 − challan 1000 = 6450.
insert into public.employees (id, tenant_id, name) values
  ('d1700000-0000-0000-0000-00000000e401', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Employee');
insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, net, paid_amount, tds, pf, esi, pf_employer, esi_employer, paid_status) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e401', '2026-07', '2026-07-31', 28000, 25000, 25000, 1000, 1800, 200, 1800, 650, 'paid'),
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e401', '2026-08', '2026-08-31', 28000, 26000,  6000,    0,    0,   0,    0,   0, 'partial');

-- Fixed assets: EMI laptop register me (current FY → cost 60000); purana furniture
-- (FY 25-26, 10% WDV → 9000). Doosra EMI (15000) register me nahi → cost par.
insert into public.emi_purchases (id, tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on) values
  ('d1700000-0000-0000-0000-00000000e202', 'd1700000-0000-0000-0000-0000000000a1', 'S17 AC', 'equipment', 15000, 15000, 0, 0, 0, '2026-05-01');
insert into public.fixed_assets (tenant_id, name, block, cost, put_to_use, emi_purchase_id) values
  ('d1700000-0000-0000-0000-0000000000a1', 'S17 Laptop', 'computers', 60000, '2026-04-20', 'd1700000-0000-0000-0000-00000000e201'),
  ('d1700000-0000-0000-0000-0000000000a1', 'S17 Desk',   'furniture', 10000, '2025-05-01', null);

-- Tax challans: GST 1000 (June return), advance tax 5000 (FY 2026-27).
insert into public.tax_payments (tenant_id, kind, amount, period, fy, paid_on) values
  ('d1700000-0000-0000-0000-0000000000a1', 'gst',         1000, '2026-06', null,      '2026-07-20'),
  ('d1700000-0000-0000-0000-0000000000a1', 'advance_tax', 5000, null,      '2026-27', '2026-09-15');
insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on) values
  ('d1700000-0000-0000-0000-0000000000a1', 'tds', 1000, '2026-08-07');

-- Reimbursements: pending 1500 hi.
insert into public.reimbursements (tenant_id, person_name, purpose, category, amount, incurred_on, status) values
  ('d1700000-0000-0000-0000-0000000000a1', 'S17 Staff', 'Taxi', 'Travel', 1500, '2026-08-02', 'pending'),
  ('d1700000-0000-0000-0000-0000000000a1', 'S17 Staff', 'Food', 'Meals',   700, '2026-08-03', 'settled');

-- Referral commission: 2000 ginta hai, cancelled 999 nahi.
insert into public.referral_partners (id, tenant_id, name) values
  ('d1700000-0000-0000-0000-00000000e501', 'd1700000-0000-0000-0000-0000000000a1', 'S17 Partner');
insert into public.referral_agreements (id, tenant_id, partner_id) values
  ('d1700000-0000-0000-0000-00000000e502', 'd1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e501');
insert into public.referral_commissions (tenant_id, agreement_id, partner_id, base_amount, basis, gross_commission, tds_amount, net_payable, status, earned_date) values
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e502', 'd1700000-0000-0000-0000-00000000e501', 20000, 'percent', 2000, 0, 2000, 'earned',    '2026-08-05'),
  ('d1700000-0000-0000-0000-0000000000a1', 'd1700000-0000-0000-0000-00000000e502', 'd1700000-0000-0000-0000-00000000e501',  9990, 'percent',  999, 0,  999, 'cancelled', '2026-08-06');
-- FIXTURE:END

-- ── Identity: tenant A ka user (ids upar literal hain — L14 ka SELECT-before-role jaal nahi) ──
select set_config('request.jwt.claims',
  '{"sub":"d1700000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;

-- ── 1. Balance sheet ─────────────────────────────────────────────────────────
do $$
declare r record;
begin
  select * into r from public.report_balance_sheet('2026-09-28');
  if r.cash_and_bank           <> 130500 then raise exception 'FAIL BS cash_and_bank: expected 130500 (130000 current + 500 overpaid card), got %', r.cash_and_bank; end if;
  if r.credit_card_payable     <>   8000 then raise exception 'FAIL BS credit_card_payable: expected 8000, got %', r.credit_card_payable; end if;
  if r.receivables             <>  15900 then raise exception 'FAIL BS receivables: expected 15900 (INV1 net 10000 + INV2 5900; INV4 project, INV5 void excluded), got %', r.receivables; end if;
  -- S45-TB: + 1180 — INV3 paid in full (23600) then CN1 1180 → that 1180 is owed back to the customer.
  if r.advances_from_customers <>   8180 then raise exception 'FAIL BS advances: expected 8180 (P1 7000 advance + 1180 owed back on INV3 after CN1), got %', r.advances_from_customers; end if;
  if r.project_receivable      <>  30000 then raise exception 'FAIL BS project_receivable: expected 30000, got %', r.project_receivable; end if;
  if r.tds_receivable          <>   1500 then raise exception 'FAIL BS tds_receivable: expected 1500, got %', r.tds_receivable; end if;
  if r.employee_loans          <>  15000 then raise exception 'FAIL BS employee_loans: expected 15000, got %', r.employee_loans; end if;
  if r.prepaid_advances        <>   8000 then raise exception 'FAIL BS prepaid: expected 8000, got %', r.prepaid_advances; end if;
  if r.emi_unregistered_cost   <>  15000 then raise exception 'FAIL BS emi_unregistered_cost: expected 15000 (AC not in register; laptop is), got %', r.emi_unregistered_cost; end if;
  if jsonb_array_length(r.fixed_assets) <> 2 then raise exception 'FAIL BS fixed_assets register rows: expected 2, got %', r.fixed_assets; end if;
  if r.emi_loans_payable       <>  40000 then raise exception 'FAIL BS emi_loans: expected 40000, got %', r.emi_loans_payable; end if;
  if r.business_loans_payable  <>  75000 then raise exception 'FAIL BS business_loans: expected 75000, got %', r.business_loans_payable; end if;
  if r.payables                <>  10000 then raise exception 'FAIL BS payables: expected 10000, got %', r.payables; end if;
  if r.salary_payable          <>  20000 then raise exception 'FAIL BS salary_payable: expected 20000, got %', r.salary_payable; end if;
  if r.dues_salary_tds <> 1000 or r.dues_pf <> 3600 or r.dues_esi <> 850 or r.dues_vendor_tds <> 2000 then
    raise exception 'FAIL BS statutory parts: expected 1000/3600/850/2000, got %/%/%/%', r.dues_salary_tds, r.dues_pf, r.dues_esi, r.dues_vendor_tds;
  end if;
  if r.dues_paid <> '[{"kind":"tds","amount":1000}]'::jsonb then raise exception 'FAIL BS dues_paid: got %', r.dues_paid; end if;
  if r.reimbursements_payable  <>   1500 then raise exception 'FAIL BS reimbursements: expected 1500, got %', r.reimbursements_payable; end if;
  -- Cumulative output: 1800 + 900 + 3600 + 7627 + 1800 (INV6) − 180 + 90 = 15637. Bills 1800 + 900.
  if r.gst_output              <>  15637 then raise exception 'FAIL BS gst_output: expected 15637, got %', r.gst_output; end if;
  if r.bills_gst               <>   2700 then raise exception 'FAIL BS bills_gst: expected 2700, got %', r.bills_gst; end if;
  if not (r.itc_groups @> '[{"bill_type":"gst","category":"Software","vendorGstin":"07ABCDE1234F1Z5","gst_paid":1800,"n":1}]'::jsonb
          and r.itc_groups @> '[{"bill_type":"gst","category":"Staff Welfare","gst_paid":180,"n":1}]'::jsonb
          and jsonb_array_length(r.itc_groups) = 2) then
    raise exception 'FAIL BS itc_groups: got %', r.itc_groups;
  end if;
  if jsonb_array_length(r.tax_payments) <> 2 then raise exception 'FAIL BS tax_payments: got %', r.tax_payments; end if;
  if r.fy_label <> 'FY 2026-27' or r.fy_start_year <> 2026 or r.as_of <> '2026-09-28' then
    raise exception 'FAIL BS fy: got % % %', r.fy_label, r.fy_start_year, r.as_of;
  end if;
  -- March me as-of = pichhla FY; cut-off se pehle ka hi GST.
  select * into r from public.report_balance_sheet('2027-03-05');
  if r.fy_label <> 'FY 2026-27' then raise exception 'FAIL BS March FY: got %', r.fy_label; end if;
  select * into r from public.report_balance_sheet('2026-03-31');
  if r.fy_label <> 'FY 2025-26' or r.gst_output <> 1800 then
    raise exception 'FAIL BS prior cut-off: expected FY 2025-26 with output 1800 (INV6 only), got % / %', r.fy_label, r.gst_output;
  end if;
  raise notice 'PASS 1: balance sheet — every figure exact, tenant B''s 999999/77777/55555/5555/4444 in none of them';
end $$;

-- ── 2. P&L ───────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
  select * into r from public.report_pnl('2026-04-01', '2026-09-30');
  -- taxable 10000 + 5000 + 20000 + 42373 = 77373; tax 1800 + 900 + 3600 + 7627 = 13927
  if r.inv_taxable <> 77373 or r.inv_tax <> 13927 or r.revenue_count <> 4 then
    raise exception 'FAIL PNL invoices: expected 77373/13927/4, got %/%/%', r.inv_taxable, r.inv_tax, r.revenue_count;
  end if;
  if r.cn_taxable <> 1000 or r.cn_tax <> 180 or r.dn_taxable <> 500 or r.dn_tax <> 90 then
    raise exception 'FAIL PNL notes: got cn %/% dn %/%', r.cn_taxable, r.cn_tax, r.dn_taxable, r.dn_tax;
  end if;
  if r.revenue_by_project <> '[{"project_id":"d1700000-0000-0000-0000-00000000f001","revenue":42373}]'::jsonb then
    raise exception 'FAIL PNL revenue_by_project: got %', r.revenue_by_project;
  end if;
  if r.cogs <> 10000 or r.cogs_count <> 1 or r.bills_gst <> 1800 then
    raise exception 'FAIL PNL cogs: expected 10000/1/1800, got %/%/%', r.cogs, r.cogs_count, r.bills_gst;
  end if;
  -- expenses in window: 11800 + 20000 + 500 + 1180 + 3000 + 28000 = 64480 across 6 rows
  if (select sum((g->>'amount')::bigint) from jsonb_array_elements(r.expense_groups) g) <> 64480
     or (select sum((g->>'n')::int) from jsonb_array_elements(r.expense_groups) g) <> 6 then
    raise exception 'FAIL PNL expense_groups: expected 64480 over 6 rows, got %', r.expense_groups;
  end if;
  if jsonb_array_length(r.itc_groups) <> 2 then raise exception 'FAIL PNL itc_groups: got %', r.itc_groups; end if;
  if r.unassigned_by_category @> '[{"category":"Software","amount":14800}]'::jsonb
     or not r.unassigned_by_category @> '[{"category":"Software","amount":11800},{"category":"Salaries","amount":28000}]'::jsonb then
    raise exception 'FAIL PNL unassigned_by_category (project row E6 must be excluded): got %', r.unassigned_by_category;
  end if;
  if r.project_expenses <> '[{"project_id":"d1700000-0000-0000-0000-00000000f001","amount":3000,"category":"Software","expense_date":"2026-08-12","vendor_name":"S17 Freelancer","description":"module build"}]'::jsonb then
    raise exception 'FAIL PNL project_expenses: got %', r.project_expenses;
  end if;
  if r.commissions <> 2000 or r.commissions_count <> 1 then
    raise exception 'FAIL PNL commissions: expected 2000/1 (cancelled 999 excluded), got %/%', r.commissions, r.commissions_count;
  end if;

  -- S39: July = INV3 20000 − CN1 1000 + DN1 500 (headline P&L jaisa; pehle trend notes chhodta tha).
  if public.report_pnl_monthly('2026-04-01', '2027-03-31') <>
     '[{"month":"2026-05","revenue":10000,"expenses":0},{"month":"2026-06","revenue":5000,"expenses":11800},{"month":"2026-07","revenue":19500,"expenses":20000},{"month":"2026-08","revenue":42373,"expenses":32680}]'::jsonb then
    raise exception 'FAIL PNL monthly: got %', public.report_pnl_monthly('2026-04-01', '2027-03-31');
  end if;
  begin
    perform public.report_pnl('2026-09-30', '2026-04-01');
    raise exception 'FAIL PNL: reversed range did not raise';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS 2: P&L aggregates and monthly trend exact';
end $$;

-- ── 3. Ledger ────────────────────────────────────────────────────────────────
do $$
declare j jsonb; v_closing bigint;
begin
  j := public.report_party_ledger('customer', 'd1700000-0000-0000-0000-00000000c001', '2026-04-01', '2027-03-31');
  if (j->>'opening')::bigint <> 11800 then raise exception 'FAIL LEDGER opening: expected 11800 (INV6 of FY 25-26), got %', j->>'opening'; end if;
  if jsonb_array_length(j->'entries') <> 10 then raise exception 'FAIL LEDGER entries: expected 10, got % — %', jsonb_array_length(j->'entries'), j->'entries'; end if;
  select (j->>'opening')::bigint + sum(case when (e->>'increasesLiability')::boolean then (e->>'amount')::bigint else -(e->>'amount')::bigint end)
    into v_closing from jsonb_array_elements(j->'entries') e;
  if v_closing <> 71910 then raise exception 'FAIL LEDGER closing: expected 71910, got %', v_closing; end if;
  if not (j->'entries') @> '[{"voucher":"Refund","reference":"d1700000-0000-0000-0000-0000000fa003 · refunded","date":"2026-06-05","amount":3000}]'::jsonb then
    raise exception 'FAIL LEDGER refund line missing: %', j->'entries';
  end if;
  if not (j->'entries') @> '[{"voucher":"Receipt","reference":"S17-RV2","date":"2026-07-03","narration":"bank_transfer"}]'::jsonb then
    -- S39: 2026-07-02 20:00 UTC = 3 Jul 01:30 IST — khata IST din dikhata hai (pehle UTC din 07-02).
    raise exception 'FAIL LEDGER P2 receipt (IST day 2026-07-03, narration bank_transfer): %', j->'entries';
  end if;
  if not (j->'entries') @> '[{"voucher":"Receipt","reference":"S17-RV1","narration":"upi · UTR1"}]'::jsonb then
    raise exception 'FAIL LEDGER P1 narration: %', j->'entries';
  end if;

  j := public.report_party_ledger('vendor', 'Acme Cloud', '2026-04-01', '2027-03-31');
  if (j->>'opening')::bigint <> 0 or jsonb_array_length(j->'entries') <> 3 then
    raise exception 'FAIL VENDOR LEDGER: expected opening 0 + 3 entries (E1 bill+payment, E2; not the untrimmed E3, not tenant B), got %', j;
  end if;

  j := public.report_ledger_vendors();
  if j <> '[{"name":"Staff One","billed":58000,"bills":2,"categories":["Salaries"]},{"name":"Acme Cloud","billed":32300,"bills":3,"categories":["Rent","Software"]},{"name":"S17 Freelancer","billed":3000,"bills":1,"categories":["Software"]},{"name":"S17 Caterer","billed":1180,"bills":1,"categories":["Staff Welfare"]}]'::jsonb then
    raise exception 'FAIL LEDGER VENDORS: got %', j;
  end if;

  begin
    perform public.report_party_ledger('customer', 'not-a-uuid', '2026-04-01', '2027-03-31');
    raise exception 'FAIL LEDGER: a bad customer id did not raise';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS 3: ledger opening, window, closing, refund/receipt lines and vendor picker exact';
end $$;

-- ── 4. Bina tenant ke login → raise, 0 nahi ─────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"d1700000-0000-0000-0000-0000000000c2","role":"authenticated"}', true);
do $$
declare ok int := 0;
begin
  begin perform public.report_balance_sheet(null); exception when insufficient_privilege then ok := ok + 1; end;
  begin perform public.report_pnl('2026-04-01', '2026-09-30'); exception when insufficient_privilege then ok := ok + 1; end;
  begin perform public.report_pnl_monthly('2026-04-01', '2026-09-30'); exception when insufficient_privilege then ok := ok + 1; end;
  begin perform public.report_party_ledger('vendor', 'x', '2026-04-01', '2026-09-30'); exception when insufficient_privilege then ok := ok + 1; end;
  begin perform public.report_ledger_vendors(); exception when insufficient_privilege then ok := ok + 1; end;
  if ok <> 5 then raise exception 'FAIL 4: only % of 5 report functions refused a login with no tenant', ok; end if;
  raise notice 'PASS 4: no-tenant login is refused by all five, not answered with zeros';
end $$;

reset role;

-- ── 5. Grants: anon ko execute nahi ─────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.report_balance_sheet(date)', 'execute')
     or has_function_privilege('anon', 'public.report_party_ledger(text, text, date, date)', 'execute') then
    raise exception 'FAIL 5: anon can execute a report function';
  end if;
  if not has_function_privilege('authenticated', 'public.report_pnl(date, date)', 'execute') then
    raise exception 'FAIL 5: authenticated cannot execute report_pnl';
  end if;
  raise notice 'PASS 5: anon has no execute, authenticated does';
end $$;

select 'PASS report_functions' as result;
rollback;
