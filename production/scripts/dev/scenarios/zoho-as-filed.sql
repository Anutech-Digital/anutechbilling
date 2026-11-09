-- R-2540 scenario "zoho-as-filed" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Two FY sales "from Zoho", kept AS FILED (R-2536: invoices.party_from_source), on ONE registered customer:
--   · SCN As Filed Traders — Maharashtra, GSTIN 27AAHCS1234K1Z5, address Baner Road, Pune (the LIVE customer).
--   · ZB-SCN-AF-1 ₹11,800 — filed in Zoho as B2C (no GSTIN). The printed invoice must show NO buyer GSTIN.
--   · ZB-SCN-AF-2 ₹23,600 — same PAN, the Karnataka branch: GSTIN 29AAHCS1234K1Z1, Zoho's own billing address
--     in Bengaluru, place of supply 29 (IGST). The printed invoice must show that address and Karnataka —
--     never the Pune address.
-- The rows go in the way import_zoho_fy_sales writes them: its session flags on, so the snapshot trigger
-- stamps party_from_source itself and does not fill the GSTIN from the customer.

insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country, customer_type, contact_email, notes) values
  ('c2540000-0000-4000-8000-000000000001', :'tenant', 'SCN As Filed Traders', '27AAHCS1234K1Z5', 'Baner Road', 'Pune',
   'Maharashtra', '27', '411045', 'India', 'business', 'accounts@scn-asfiled.example', 'SCN scenario zoho-as-filed (R-2540)');

-- The import batch the two rows belong to (invoices_zoho_sale_shape). A reload / --clear removes the invoices
-- with their customer; the emptied batch row of an earlier load goes first.
delete from public.zoho_fy_import_batches b
 where b.id = 'c2540000-0000-4000-8000-000000000002'
   and not exists (select 1 from public.invoices i where i.sale_import_batch_id = b.id);
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy, imported_count, taxable_total, tax_total, amount_total)
values ('c2540000-0000-4000-8000-000000000002', :'tenant', 'invoices', '2025-26', 2, 30000, 5400, 35400)
on conflict (id) do nothing;

select set_config('app.zoho_sale_import', 'on', true);
select set_config('app.zoho_sale_party_as_filed', 'on', true);

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
                             invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state, line_items,
                             customer_gstin, pos_state_code, billing_address, customer_country, external_number, zoho_invoice_id, sale_import_batch_id) values
  ('ZB-SCN-AF-1', :'tenant', 'c2540000-0000-4000-8000-000000000001', 'SCN As Filed Traders', 11800, 11800, 0, 'pending',
   current_date - 20, current_date + 10, 10000, 1800, 18, false,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Hosting (as filed, B2C)", "rate": 10000, "amount": 10000}]'::jsonb,
   null, '27', null, null, 'ZB-SCN-AF-1', 'scn-zoho-af-1', 'c2540000-0000-4000-8000-000000000002'),
  ('ZB-SCN-AF-2', :'tenant', 'c2540000-0000-4000-8000-000000000001', 'SCN As Filed Traders', 23600, 23600, 0, 'pending',
   current_date - 18, current_date + 12, 20000, 3600, 18, true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Workspace (Karnataka branch)", "rate": 20000, "amount": 20000}]'::jsonb,
   '29AAHCS1234K1Z1', '29', '5th Floor, MG Road, Bengaluru, Karnataka 560001', 'India', 'ZB-SCN-AF-2', 'scn-zoho-af-2', 'c2540000-0000-4000-8000-000000000002');

select set_config('app.zoho_sale_import', '', true);
select set_config('app.zoho_sale_party_as_filed', '', true);
