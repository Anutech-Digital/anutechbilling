-- R-2621 scenario "gst-filed" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- No NEW sale from a bank line of a GST-filed month (Accounting → Overview → GST returns filed up to).
--   · SCN Filed Month Traders (Delhi) with one FY sale imported from Zoho: ZB-SCN-GF-1 ₹11,800 dated 10 Sep 2026
--     (the way import_zoho_fy_sales writes it: zoho_invoice_id + its Zoho number, no quote).
--   · Money-in lines on SCN HDFC Current ··7788:
--       15 Sep 2026 ₹11,800 — pays ZB-SCN-GF-1 (Reconcile → An open quote / invoice) even when Sep is filed;
--       20 Sep 2026 ₹5,900  — a NEW sale on it is refused once GST is filed up to Sep 2026;
--        5 Oct 2026 ₹5,900  — an open month: a new sale books as before.
-- The setting itself is the owner's (the card's howToCheck sets and clears it); this file does not touch it.

insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country, customer_type, contact_email, notes) values
  ('c2621000-0000-4000-8000-000000000001', :'tenant', 'SCN Filed Month Traders', '07AAHCF2621K1Z5', 'Nehru Place', 'New Delhi',
   'Delhi', '07', '110019', 'India', 'business', 'accounts@scn-filedmonth.example', 'SCN scenario gst-filed (R-2621)');

-- The import batch the Zoho sale belongs to (invoices_zoho_sale_shape). A reload / --clear removes the invoice
-- with its customer; the emptied batch row of an earlier load goes first.
delete from public.zoho_fy_import_batches b
 where b.id = 'c2621000-0000-4000-8000-000000000002'
   and not exists (select 1 from public.invoices i where i.sale_import_batch_id = b.id);
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy, imported_count, taxable_total, tax_total, amount_total)
values ('c2621000-0000-4000-8000-000000000002', :'tenant', 'invoices', '2026-27', 1, 10000, 1800, 11800)
on conflict (id) do nothing;

select set_config('app.zoho_sale_import', 'on', true);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
                             invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state, line_items,
                             external_number, zoho_invoice_id, sale_import_batch_id) values
  ('ZB-SCN-GF-1', :'tenant', 'c2621000-0000-4000-8000-000000000001', 'SCN Filed Month Traders', 11800, 11800, 0, 'overdue',
   '2026-09-10', '2026-09-25', 10000, 1800, 18, false,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Workspace (filed in Zoho, Sep 2026)", "rate": 10000, "amount": 10000}]'::jsonb,
   'ZB-SCN-GF-1', 'scn-zoho-gf-1', 'c2621000-0000-4000-8000-000000000002');
select set_config('app.zoho_sale_import', '', true);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2621000-0000-4000-8000-000000000011', :'tenant', :'acct', '2026-09-15',
   'NEFT CR-HDFC0000001-SCN FILED MONTH TRADERS-ZB-SCN-GF-1', 0, 11800, 'SCN-GF-2621-011', 'csv_upload'),
  ('c2621000-0000-4000-8000-000000000012', :'tenant', :'acct', '2026-09-20',
   'NEFT CR-HDFC0000001-SCN FILED MONTH TRADERS-SEPT', 0, 5900, 'SCN-GF-2621-012', 'csv_upload'),
  ('c2621000-0000-4000-8000-000000000013', :'tenant', :'acct', '2026-10-05',
   'NEFT CR-HDFC0000001-SCN FILED MONTH TRADERS-OCT', 0, 5900, 'SCN-GF-2621-013', 'csv_upload');
