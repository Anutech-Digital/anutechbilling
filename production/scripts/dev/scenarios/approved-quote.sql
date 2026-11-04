-- R-2458 scenario "approved-quote" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2447 / R-2441: SCN Approved Buyer's quote Q-SCN-AP-1, approved by the E2E manager (manager tier, 10%
-- discount). 10 seats at ₹1,080 against a ₹1,000 cost: lower the rate below ₹1,000 (below cost) or past 20%
-- discount and Save → back to "Needs approval" (owner); raise it → stays Approved.
-- Q-SCN-AP-2 (approved) + Q-SCN-AP-3 (no approval needed) are accepted, for Quotes → Combine.

insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, notes) values
  ('c2458000-0000-4000-8000-000000000091', :'tenant', 'SCN Approved Buyer', 'Maharashtra', '27', 'business',
   'it@approvedbuyer.example', 'SCN scenario approved-quote (R-2458)');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           tax_rate, discount_pct, status, created_date, expires_date, billing_cycle, currency, owner_id,
                           created_by, approval_status, approval_tier, approval_requested_by, approval_requested_at,
                           approved_by, approved_at, approved_discount_bps, approved_margin_bps, below_cost, line_items, notes)
select v.id, :'tenant', 'c2458000-0000-4000-8000-000000000091', 'SCN Approved Buyer', 'Google Workspace Business Starter',
       10, v.amount, v.subtotal, 10000, 18, v.disc, v.status::public.quote_status, current_date - 3, current_date + 12, 'yearly', 'INR',
       sales.id, sales.id, v.appr::public.quote_approval_status,
       case when v.appr = 'approved' then 'manager' end::public.quote_approval_tier,
       case when v.appr = 'approved' then sales.id end, case when v.appr = 'approved' then now() - interval '2 days' end,
       case when v.appr = 'approved' then mgr.id end, case when v.appr = 'approved' then now() - interval '1 day' end,
       case when v.appr = 'approved' then v.disc * 100 end, case when v.appr = 'approved' then v.margin_bps end,
       false, v.lines::jsonb, 'SCN scenario approved-quote (R-2458)'
  from (values
    ('Q-SCN-AP-1', 'sent',     'approved',     10, 12744, 10800,  741,
     '[{"id": "line-1", "qty": 10, "cost": 1000, "name": "SCN Google Workspace Business Starter", "rate": 1080, "list_rate": 1200, "commitment": "annual_yearly"}]'),
    ('Q-SCN-AP-2', 'accepted', 'approved',     10, 12744, 10800,  741,
     '[{"id": "line-1", "qty": 10, "cost": 1000, "name": "SCN Google Workspace Business Starter", "rate": 1080, "list_rate": 1200, "commitment": "annual_yearly"}]'),
    ('Q-SCN-AP-3', 'accepted', 'not_required',  0, 14160, 12000, 1667,
     '[{"id": "line-1", "qty": 10, "cost": 1000, "name": "SCN Google Workspace Business Starter", "rate": 1200, "commitment": "annual_yearly"}]')
  ) as v(id, status, appr, disc, amount, subtotal, margin_bps, lines)
  cross join (select u.id from public.users u where u.tenant_id = :'tenant' and u.email = 'e2e-sales@example.test') sales
  cross join (select u.id from public.users u where u.tenant_id = :'tenant' and u.email = 'e2e-manager@example.test') mgr;
