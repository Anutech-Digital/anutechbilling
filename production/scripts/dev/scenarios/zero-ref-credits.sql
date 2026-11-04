-- R-2458 scenario "zero-ref-credits" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2430 / R-2424 / R-2441: placeholder bank references ("000000000000000") are not a UTR.
--   · SCN Zero Ref Traders: INV-SCN-ZR-1 ₹11,800 unpaid + two ₹5,000 money-in lines, BOTH with reference
--     000000000000000 — book both on the same invoice → two receipts, ₹10,000 received.
--   · SCN Placeholder Labs: INV-SCN-ZR-2 ₹5,900 — Record payment with reference 000000000000000 (or
--     NEFT-000000000000) on ZR-1 and on ZR-2: both save.
--   · INV-SCN-ZR-3 ₹2,360 (Zero Ref Traders) — a real UTR (TESTUTR123456) on ZR-2 and then ZR-3: the second is refused.
--   · R-2466: SCN-ZB-0042 ₹11,800 — SCN Zero Ref Traders' unpaid invoice from last year, imported from Zoho
--     (an opening invoice, no quote). Reconcile → "An open quote / invoice" lists it as "Opening invoice
--     (from Zoho)"; the two ₹5,000 lines can go on it instead → two receipts, ₹10,000 received.
-- R-2466: ZR-1..3 came from their quotes, as every invoice raised in the app does (a payment needs its
-- quote — tg_payments_opening_invoice); only a Zoho opening invoice is paid without one.

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, notes) values
  ('c2458000-0000-4000-8000-000000000041', :'tenant', 'SCN Zero Ref Traders', 'Maharashtra', '27', 'business',
   'SCN scenario zero-ref-credits (R-2458)'),
  ('c2458000-0000-4000-8000-000000000042', :'tenant', 'SCN Placeholder Labs', 'Maharashtra', '27', 'business',
   'SCN scenario zero-ref-credits (R-2458)');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate, discount_pct,
                           status, payment_status, created_date, billing_cycle, currency, is_one_off, line_items, notes) values
  ('Q-SCN-ZR-1', :'tenant', 'c2458000-0000-4000-8000-000000000041', 'SCN Zero Ref Traders', 'SCN Annual support (zero-ref)', 1, 11800, 10000, 0, 18, 0,
   'accepted', 'awaiting', current_date - 14, 'yearly', 'INR', true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Annual support (zero-ref)", "rate": 10000, "one_time": true}]'::jsonb, 'SCN scenario zero-ref-credits (R-2466)'),
  ('Q-SCN-ZR-2', :'tenant', 'c2458000-0000-4000-8000-000000000042', 'SCN Placeholder Labs', 'SCN Setup fee (zero-ref)', 1, 5900, 5000, 0, 18, 0,
   'accepted', 'awaiting', current_date - 12, 'yearly', 'INR', true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Setup fee (zero-ref)", "rate": 5000, "one_time": true}]'::jsonb, 'SCN scenario zero-ref-credits (R-2466)'),
  ('Q-SCN-ZR-3', :'tenant', 'c2458000-0000-4000-8000-000000000041', 'SCN Zero Ref Traders', 'SCN Domain renewal (zero-ref)', 1, 2360, 2000, 0, 18, 0,
   'accepted', 'awaiting', current_date - 10, 'yearly', 'INR', true,
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Domain renewal (zero-ref)", "rate": 2000, "one_time": true}]'::jsonb, 'SCN scenario zero-ref-credits (R-2466)');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items, quote_id) values
  ('INV-SCN-ZR-1', :'tenant', 'c2458000-0000-4000-8000-000000000041', 'SCN Zero Ref Traders', 11800, 'pending',
   current_date - 12, current_date + 3, 10000, 1800, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Annual support (zero-ref)", "rate": 10000}]'::jsonb, 'Q-SCN-ZR-1'),
  ('INV-SCN-ZR-2', :'tenant', 'c2458000-0000-4000-8000-000000000042', 'SCN Placeholder Labs', 5900, 'pending',
   current_date - 10, current_date + 5, 5000, 900, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Setup fee (zero-ref)", "rate": 5000}]'::jsonb, 'Q-SCN-ZR-2'),
  ('INV-SCN-ZR-3', :'tenant', 'c2458000-0000-4000-8000-000000000041', 'SCN Zero Ref Traders', 2360, 'pending',
   current_date - 8, current_date + 7, 2000, 360, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Domain renewal (zero-ref)", "rate": 2000}]'::jsonb, 'Q-SCN-ZR-3');

update public.quotes q set invoice_id = v.inv
  from (values ('Q-SCN-ZR-1', 'INV-SCN-ZR-1'), ('Q-SCN-ZR-2', 'INV-SCN-ZR-2'), ('Q-SCN-ZR-3', 'INV-SCN-ZR-3')) as v(qid, inv)
 where q.id = v.qid and q.tenant_id = :'tenant';

-- R-2466: last year's Zoho invoice, through the app's own import (only import_opening_invoices writes
-- an opening invoice), as the E2E owner. An earlier load's emptied import row goes first (the reset
-- removes the invoice, the import row would be left behind).
delete from public.invoice_import_batches b
 where b.tenant_id = :'tenant' and b.file_name = 'SCN zero-ref-credits (R-2466).csv'
   and not exists (select 1 from public.invoices i where i.import_batch_id = b.id);
select set_config('request.jwt.claims', json_build_object('sub', (select u.id from public.users u where u.tenant_id = :'tenant' and u.role = 'owner' order by u.created_at limit 1), 'role', 'authenticated')::text, true);
select public.import_opening_invoices(
  jsonb_build_array(jsonb_build_object(
    'number', 'SCN-ZB-0042', 'invoice_date', (current_date - 220)::text, 'due_date', (current_date - 190)::text,
    'customer_id', 'c2458000-0000-4000-8000-000000000041', 'total', 11800, 'balance', 11800, 'currency', 'INR')),
  'SCN zero-ref-credits (R-2466).csv');
select set_config('request.jwt.claims', '', true);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2458000-0000-4000-8000-000000000043', :'tenant', :'acct', current_date - 3,
   'NEFT CR-000000000000000-SCN ZERO REF TRADERS-PART 1', 0, 5000, '000000000000000', 'csv_upload'),
  ('c2458000-0000-4000-8000-000000000044', :'tenant', :'acct', current_date - 2,
   'NEFT CR-000000000000000-SCN ZERO REF TRADERS-PART 2', 0, 5000, '000000000000000', 'csv_upload');
