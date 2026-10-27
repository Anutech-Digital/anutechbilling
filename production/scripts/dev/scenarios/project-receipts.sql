-- R-1998 scenario "project-receipts" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Reconcile → Project payment: the project's open instalments, oldest ticked first, TDS, one Save.
--   · SCN Acme Website Co — project "SCN Website" with 3 instalments of ₹1,18,000;
--       ₹2,36,000 line  → kist 1 + kist 2 ticked by themselves, Save (3 clicks);
--       ₹4,00,000 line  → ₹46,000 more than everything due: no Save, the advance path is named.
--   · SCN Bharat Apps — project "SCN Mobile app" with 2 instalments of ₹1,18,000;
--       ₹2,12,400 line  → tick "TDS deducted?", TDS ₹23,600 → both kists match, Save.

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, notes) values
  ('c1957000-0000-4000-8000-000000000401', :'tenant', 'SCN Acme Website Co', 'Delhi', '07', 'business', 'SCN scenario project-receipts (R-1998)'),
  ('c1957000-0000-4000-8000-000000000402', :'tenant', 'SCN Bharat Apps', 'Delhi', '07', 'business', 'SCN scenario project-receipts (R-1998)');

insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, gst_rate, inter_state,
                                  taxable_amount, gst_amount, total_amount, status, accepted_at) values
  ('c1957000-0000-4000-8000-000000000411', :'tenant', 'c1957000-0000-4000-8000-000000000401', 'SCN Acme Website Co',
   'SCN Website', 18, false, 300000, 54000, 354000, 'active', now()),
  ('c1957000-0000-4000-8000-000000000412', :'tenant', 'c1957000-0000-4000-8000-000000000402', 'SCN Bharat Apps',
   'SCN Mobile app', 18, false, 200000, 36000, 236000, 'active', now());

insert into public.project_milestones (id, tenant_id, project_id, seq, label, total_amount, due_date, status) values
  ('c1957000-0000-4000-8000-000000000421', :'tenant', 'c1957000-0000-4000-8000-000000000411', 1, 'Kist 1 — design',  118000, current_date - 30, 'pending'),
  ('c1957000-0000-4000-8000-000000000422', :'tenant', 'c1957000-0000-4000-8000-000000000411', 2, 'Kist 2 — build',   118000, current_date - 10, 'pending'),
  ('c1957000-0000-4000-8000-000000000423', :'tenant', 'c1957000-0000-4000-8000-000000000411', 3, 'Kist 3 — go-live', 118000, current_date + 20, 'pending'),
  ('c1957000-0000-4000-8000-000000000424', :'tenant', 'c1957000-0000-4000-8000-000000000412', 1, 'Kist 1 — advance', 118000, current_date - 20, 'pending'),
  ('c1957000-0000-4000-8000-000000000425', :'tenant', 'c1957000-0000-4000-8000-000000000412', 2, 'Kist 2 — delivery', 118000, current_date - 5, 'pending');

-- Money-in lines; booking them is the card's own step.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c1957000-0000-4000-8000-000000000431', :'tenant', :'acct', current_date - 4,
   'NEFT CR-HDFC0001957-SCN ACME WEBSITE CO-KIST 1 AND 2', 0, 236000, 'SCN-N298261957000431', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000432', :'tenant', :'acct', current_date - 3,
   'NEFT CR-ICIC0001957-SCN BHARAT APPS-KIST 1 2 LESS TDS', 0, 212400, 'SCN-N298261957000432', 'csv_upload'),
  ('c1957000-0000-4000-8000-000000000433', :'tenant', :'acct', current_date - 2,
   'NEFT CR-HDFC0001957-SCN ACME WEBSITE CO-FULL AND EXTRA', 0, 400000, 'SCN-N298261957000433', 'csv_upload');
