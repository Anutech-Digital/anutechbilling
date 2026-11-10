-- R-1473 scenario "money-owed-archived" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Pawan's staging case of 24 Oct 2026 in miniature (✗ Galat on R-1473): the dashboard said ₹67,855 to
-- collect, Companies › Has receivables listed only one company, Renewals added up to ₹44,746.
--   · SCN Kochi Hosting (active): Google Workspace subscription, ₹25,488 unpaid.
--   · SCN Delhi Traders — ARCHIVED: Microsoft 365 subscription ₹19,258 unpaid + project "SCN ERP setup",
--     instalment 1 invoiced (INV-SCN-MO-1 ₹23,109), nothing paid.
-- Expected everywhere: ₹67,855 = subscriptions ₹44,746 + project invoices ₹23,109; both companies listed.

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, is_active, notes) values
  ('c2458000-0000-4000-8000-000000000301', :'tenant', 'SCN Kochi Hosting', 'Kerala', '32', 'business', true,
   'SCN scenario money-owed-archived (R-1473)'),
  ('c2458000-0000-4000-8000-000000000302', :'tenant', 'SCN Delhi Traders', 'Delhi', '07', 'business', false,
   'SCN scenario money-owed-archived (R-1473) — archived while it still owes');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, domain, auto_renew, outstanding_amount) values
  ('c2458000-0000-4000-8000-000000000311', :'tenant', 'c2458000-0000-4000-8000-000000000301', 'SCN Kochi Hosting',
   'Google Workspace Business Standard', 'google', 20, 1800, 'yearly', 12,
   current_date - 340, current_date + 25, 'active', 'scnkochi.in', true, 25488),
  ('c2458000-0000-4000-8000-000000000312', :'tenant', 'c2458000-0000-4000-8000-000000000302', 'SCN Delhi Traders',
   'Microsoft 365 Business Basic', 'microsoft', 10, 1360, 'yearly', 12,
   current_date - 330, current_date + 35, 'active', 'scndelhitraders.in', true, 19258);

insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, gst_rate, inter_state,
                                  taxable_amount, gst_amount, total_amount, status, accepted_at) values
  ('c2458000-0000-4000-8000-000000000321', :'tenant', 'c2458000-0000-4000-8000-000000000302', 'SCN Delhi Traders',
   'SCN ERP setup', 18, false, 39168, 7050, 46218, 'active', now() - interval '40 days');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items, quote_id) values
  ('INV-SCN-MO-1', :'tenant', 'c2458000-0000-4000-8000-000000000302', 'SCN Delhi Traders', 23109, 'overdue',
   current_date - 30, current_date - 15, 19584, 3525, 18, false, 0, 'tax_invoice',
   '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN ERP setup — instalment 1", "rate": 19584}]'::jsonb, null);

insert into public.project_milestones (id, tenant_id, project_id, seq, label, total_amount, due_date, status, invoice_id) values
  ('c2458000-0000-4000-8000-000000000322', :'tenant', 'c2458000-0000-4000-8000-000000000321', 1, 'Instalment 1 — setup',
   23109, current_date - 15, 'pending', 'INV-SCN-MO-1'),
  ('c2458000-0000-4000-8000-000000000323', :'tenant', 'c2458000-0000-4000-8000-000000000321', 2, 'Instalment 2 — go-live',
   23109, current_date + 30, 'pending', null);
