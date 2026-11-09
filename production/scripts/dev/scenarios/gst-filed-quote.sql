-- R-2627 scenario "gst-filed-quote" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Paying an accepted QUOTE that has no invoice yet from a bank line of a GST-filed month must not raise a new tax
-- invoice in that month (Accounting → Overview → GST returns filed up to).
--   · SCN Filed Quote Buyer (Delhi) with accepted quote Q-SCN-GFQ-1 ₹5,900 (₹5,000 + 18% GST), no invoice yet.
--   · Money-in lines on SCN HDFC Current ··7788:
--       18 Sep 2026 ₹5,900 — Reconcile → An open quote / invoice → Q-SCN-GFQ-1 is refused once GST is filed up to Sep 2026;
--        6 Oct 2026 ₹5,900 — an open month: the quote is paid and invoiced on 6 Oct as before.
-- The setting itself is the owner's (the card's howToCheck sets and clears it); this file does not touch it.

insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country, customer_type, contact_email, notes) values
  ('c2627000-0000-4000-8000-000000000001', :'tenant', 'SCN Filed Quote Buyer', '07AAHCF2627K1Z5', 'Saket', 'New Delhi',
   'Delhi', '07', '110017', 'India', 'business', 'accounts@scn-filedquote.example', 'SCN scenario gst-filed-quote (R-2627)');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct, status,
                           payment_status, created_date, billing_cycle, currency, line_items, is_one_off, notes) values
  ('Q-SCN-GFQ-1', :'tenant', 'c2627000-0000-4000-8000-000000000001', 'SCN Filed Quote Buyer', 'SCN Workspace setup', 1,
   5900, 5000, 18, 0, 'accepted', 'awaiting', '2026-09-05', 'yearly', 'INR',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Workspace setup (one time)", "rate": 5000, "one_time": true}]'::jsonb,
   true, 'SCN scenario gst-filed-quote (R-2627)');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2627000-0000-4000-8000-000000000011', :'tenant', :'acct', '2026-09-18',
   'NEFT CR-HDFC0000001-SCN FILED QUOTE BUYER-SEPT', 0, 5900, 'SCN-GFQ-2627-011', 'csv_upload'),
  ('c2627000-0000-4000-8000-000000000012', :'tenant', :'acct', '2026-10-06',
   'NEFT CR-HDFC0000001-SCN FILED QUOTE BUYER-OCT', 0, 5900, 'SCN-GFQ-2627-012', 'csv_upload');
