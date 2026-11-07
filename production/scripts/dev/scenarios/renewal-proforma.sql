-- R-2519 scenario "renewal-proforma" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Staging BITDECENTRO (6 Nov 2026) in miniature: SCN Bit Labs, Google Workspace Business Starter, MONTHLY
-- (flexible), 17 seats at ₹300 = ₹5,100 a month. Its current month (began 25 days ago) was billed the
-- old way — Q-SCN-PF-1, 1 × ₹5,100 "One-time" + IGST = ₹6,018, Sent, nothing emailed — like
-- Q-A378-27-0947. The customer wants 18 seats: cancel Q-SCN-PF-1, then Renewals → Bill next part.

insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, contact_name, notes) values
  ('c2458000-0000-4000-8000-000000000201', :'tenant', 'SCN Bit Labs', 'Maharashtra', '27', 'India', 'business',
   'Kunal Mehta', 'SCN scenario renewal-proforma (R-2519)');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, domain, auto_renew) values
  ('c2458000-0000-4000-8000-000000000202', :'tenant', 'c2458000-0000-4000-8000-000000000201', 'SCN Bit Labs',
   'Google Workspace Business Starter', 'google', 17, 5100, 'monthly', 1,
   current_date - 56, (current_date - 25 + interval '1 month')::date - 1, 'active', 'scnbitlabs.in', true);

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate, due_on) values
  ('c2458000-0000-4000-8000-000000000203', :'tenant', 'c2458000-0000-4000-8000-000000000202',
   current_date - 25, 1, current_date - 25, current_date - 25, (current_date - 25 + interval '1 month')::date, 5100, 18,
   current_date - 25);

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           tax_rate, discount_pct, status, payment_status, created_date, expires_date, billing_cycle,
                           currency, is_one_off, payment_terms_days, domain, subscription_billing_id, line_items, notes) values
  ('Q-SCN-PF-1', :'tenant', 'c2458000-0000-4000-8000-000000000201', 'SCN Bit Labs',
   'Google Workspace Business Starter', 17, 6018, 5100, 0, 18, 0, 'sent', 'awaiting', current_date, null, 'yearly',
   'INR', true, 0, 'scnbitlabs.in', 'c2458000-0000-4000-8000-000000000203',
   jsonb_build_array(jsonb_build_object('id', 'part-1', 'qty', 1, 'rate', 5100, 'cost', 0, 'one_time', true,
     'name', 'Google Workspace Business Starter · scnbitlabs.in · 17 seats · '
             || to_char(current_date - 25, 'FMDD Mon') || '–' || to_char((current_date - 25 + interval '1 month')::date - 1, 'FMDD Mon YYYY') || ' (part 1 of 1)',
     'description', 'Advance payment for month 1')),
   'SCN scenario renewal-proforma (R-2519): the old one-click request, like Q-A378-27-0947');
