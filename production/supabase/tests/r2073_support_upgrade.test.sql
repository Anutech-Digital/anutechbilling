-- R-2073 (29 Oct 2026, decision D5): a support plan upgraded mid-term, paid through record_payment.
--
-- The quote "Upgrade plan" makes (lib/support/create-upgrade-quote.ts) is linked like an extension
-- quote (subscriptions.renewal_quote_id), with extension_months = 0 and one line whose item_id is
-- the new tier's catalogue row.
--
--   1. Owner's path: Standard yearly (₹9,996), half the term left → upgrade quote ₹19,998 ex-GST
--      paid in full → plan / item_id = Enterprise (Yearly), mrr = 49,992 / 12 = ₹4,166; renewal
--      date, seats, renewal state, reminders unchanged; no PO; support_upgrade = true and
--      renewal_rolled_forward = false.
--   2. Monthly support: Standard ₹999 → Enterprise ₹4,999 → mrr ₹4,999, renewal date unchanged.
--   3. Control — NOT support: a Google renewal quote behaves exactly as before R-2073 (rolls a
--      year, plan kept, mrr = subtotal / 12, reminders reset, PO drafted).
--   (A 0-month renewal-linked quote on a non-support line still fails at the PO term_months
--   check, as it did before — unchanged.)
--   4. Control — a support RENEWAL (extension_months 12, SUP- line) still rolls forward a year.
--
-- Fails without the migration: the old record_payment refuses the case-1 payment outright (it
-- drafts a vendor PO for 0 months → purchase_orders_term_months_check), so the upgrade could not
-- be paid at all.
-- Fixture owns its data and rolls back.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd207300-0000-4000-8000-00000000a001', 'R2073 Tenant', 'r2073@test.invalid', '07');
insert into public.customers (id, tenant_id, name) values
  ('dd207300-0000-4000-8000-00000000c001', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Cust A'),
  ('dd207300-0000-4000-8000-00000000c002', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Cust B'),
  ('dd207300-0000-4000-8000-00000000c003', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Cust C'),
  ('dd207300-0000-4000-8000-00000000c004', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Cust D');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd207300-0000-4000-8000-00000000a001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9700);

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('SUP-STANDARD-YR-r2073', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Standard Support (Yearly)', 'support', 0, 0, 'subscription',
   '{"annual_total":{"msrp":9996,"wholesale":0}}'),
  ('SUP-ENTERPRISE-YR-r2073', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Enterprise Support (Yearly)', 'support', 0, 0, 'subscription',
   '{"annual_total":{"msrp":49992,"wholesale":0}}'),
  ('SUP-STANDARD-MO-r2073', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Standard Support', 'support', 999, 0, 'subscription', '{}'),
  ('SUP-ENTERPRISE-MO-r2073', 'dd207300-0000-4000-8000-00000000a001', 'R2073 Enterprise Support', 'support', 4999, 0, 'subscription', '{}');

-- ── 1. Standard yearly → Enterprise yearly ─────────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd207300-0000-4000-8000-00000000b001', 'dd207300-0000-4000-8000-00000000a001',
          'dd207300-0000-4000-8000-00000000c001', 'R2073 Cust A',
          'R2073 Standard Support (Yearly)', 'support', 'SUP-STANDARD-YR-r2073', 1, 833, 'active', 12,
          current_date - 183, current_date + 183, 'reminder_1', 2, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2073-A-UP', 'dd207300-0000-4000-8000-00000000a001', 'dd207300-0000-4000-8000-00000000c001',
          'R2073 Cust A', 23598, 19998, 18, 'draft', 'awaiting',
          '[{"id":"upgrade-1","item_id":"SUP-ENTERPRISE-YR-r2073","name":"R2073 Enterprise Support (Yearly) · upgrade","qty":1,"rate":19998,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
          true, 0);

-- ── 2. Standard monthly → Enterprise monthly ───────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd207300-0000-4000-8000-00000000b002', 'dd207300-0000-4000-8000-00000000a001',
          'dd207300-0000-4000-8000-00000000c002', 'R2073 Cust B',
          'R2073 Standard Support', 'support', 'SUP-STANDARD-MO-r2073', 1, 999, 'active', 1,
          current_date - 15, current_date + 15, 'pending', 0, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2073-B-UP', 'dd207300-0000-4000-8000-00000000a001', 'dd207300-0000-4000-8000-00000000c002',
          'R2073 Cust B', 2360, 2000, 18, 'draft', 'awaiting',
          '[{"id":"upgrade-1","item_id":"SUP-ENTERPRISE-MO-r2073","name":"R2073 Enterprise Support · upgrade","qty":1,"rate":2000,"cost":0,"commitment":"monthly"}]'::jsonb,
          true, 0);

-- ── 3. control: Google renewal, 12 months ─────────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd207300-0000-4000-8000-00000000b003', 'dd207300-0000-4000-8000-00000000a001',
          'dd207300-0000-4000-8000-00000000c003', 'R2073 Cust C',
          'Google Workspace Business Starter', 'google', 5, 680, 'active', 12,
          current_date - 100, current_date + 265, 'reminder_1', 2, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2073-C-REN', 'dd207300-0000-4000-8000-00000000a001', 'dd207300-0000-4000-8000-00000000c003',
          'R2073 Cust C', 1180, 1000, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":200,"commitment":"annual_yearly"}]'::jsonb,
          true, 12);

-- ── 4. control: support renewal, 12 months ─────────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd207300-0000-4000-8000-00000000b004', 'dd207300-0000-4000-8000-00000000a001',
          'dd207300-0000-4000-8000-00000000c004', 'R2073 Cust D',
          'R2073 Standard Support (Yearly)', 'support', 'SUP-STANDARD-YR-r2073', 1, 833, 'active', 12,
          current_date - 355, current_date + 10, 'reminder_1', 2, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2073-D-REN', 'dd207300-0000-4000-8000-00000000a001', 'dd207300-0000-4000-8000-00000000c004',
          'R2073 Cust D', 11795, 9996, 18, 'sent', 'awaiting',
          '[{"item_id":"SUP-STANDARD-YR-r2073","name":"R2073 Standard Support (Yearly)","qty":1,"rate":9996,"commitment":"annual_yearly"}]'::jsonb,
          true, 12);

update public.subscriptions set renewal_quote_id = 'Q-R2073-A-UP'  where id = 'dd207300-0000-4000-8000-00000000b001';
update public.subscriptions set renewal_quote_id = 'Q-R2073-B-UP'  where id = 'dd207300-0000-4000-8000-00000000b002';
update public.subscriptions set renewal_quote_id = 'Q-R2073-C-REN'  where id = 'dd207300-0000-4000-8000-00000000b003';
update public.subscriptions set renewal_quote_id = 'Q-R2073-D-REN' where id = 'dd207300-0000-4000-8000-00000000b004';

do $$
declare
  v_s record;
  v_r jsonb;
  v_pos int;
begin
  -- 1. owner's path
  v_r := public.record_payment('Q-R2073-A-UP', 23598, 'bank_transfer', 'r2073-a');
  select * into v_s from public.subscriptions where id = 'dd207300-0000-4000-8000-00000000b001';
  if v_s.plan <> 'R2073 Enterprise Support (Yearly)' or v_s.item_id <> 'SUP-ENTERPRISE-YR-r2073' then
    raise exception 'FAIL 1: paid upgrade left the plan as % / % (expected Enterprise). This is the R-2073 bug.', v_s.plan, v_s.item_id;
  end if;
  if v_s.mrr <> 4166 then
    raise exception 'FAIL 1b: mrr % (expected 49992 / 12 = 4166, not the pro-rata amount)', v_s.mrr;
  end if;
  if v_s.renewal_date <> current_date + 183 then
    raise exception 'FAIL 1c: renewal_date moved to % (must stay %)', v_s.renewal_date, current_date + 183;
  end if;
  if v_s.seats <> 1 or v_s.renewal_state <> 'reminder_1' or v_s.reminder_count <> 2 or v_s.status <> 'active' then
    raise exception 'FAIL 1d: seats % state % reminders % status % changed', v_s.seats, v_s.renewal_state, v_s.reminder_count, v_s.status;
  end if;
  if v_s.renewal_quote_id is not null then
    raise exception 'FAIL 1e: renewal_quote_id still % after payment', v_s.renewal_quote_id;
  end if;
  select count(*) into v_pos from public.purchase_orders where subscription_id = v_s.id;
  if v_pos <> 0 then raise exception 'FAIL 1f: % PO drafted for a support upgrade', v_pos; end if;
  if not coalesce((v_r->>'support_upgrade')::boolean, false) or coalesce((v_r->>'renewal_rolled_forward')::boolean, true) then
    raise exception 'FAIL 1g: result flags %', v_r;
  end if;
  raise notice 'PASS 1: Standard yearly → Enterprise yearly, mrr 4166, renewal date kept, no PO';

  -- 2. monthly
  v_r := public.record_payment('Q-R2073-B-UP', 2360, 'bank_transfer', 'r2073-b');
  select * into v_s from public.subscriptions where id = 'dd207300-0000-4000-8000-00000000b002';
  if v_s.plan <> 'R2073 Enterprise Support' or v_s.mrr <> 4999 or v_s.renewal_date <> current_date + 15 then
    raise exception 'FAIL 2: monthly upgrade → plan % mrr % renewal %', v_s.plan, v_s.mrr, v_s.renewal_date;
  end if;
  raise notice 'PASS 2: Standard monthly → Enterprise monthly, mrr 4999, renewal date kept';

  -- 3. control: not support — unchanged behaviour
  v_r := public.record_payment('Q-R2073-C-REN', 1180, 'bank_transfer', 'r2073-c');
  select * into v_s from public.subscriptions where id = 'dd207300-0000-4000-8000-00000000b003';
  if v_s.plan <> 'Google Workspace Business Starter' or v_s.mrr <> 83 or v_s.reminder_count <> 0
     or v_s.renewal_date <> (current_date + 265 + interval '12 months')::date or not coalesce((v_r->>'renewal_rolled_forward')::boolean, false)
     or coalesce((v_r->>'support_upgrade')::boolean, true) then
    raise exception 'FAIL 3: non-support path changed: plan % mrr % reminders % renewal % result %',
      v_s.plan, v_s.mrr, v_s.reminder_count, v_s.renewal_date, v_r;
  end if;
  select count(*) into v_pos from public.purchase_orders where subscription_id = v_s.id;
  if v_pos <> 1 then raise exception 'FAIL 3b: % PO for the non-support path (expected 1, as before)', v_pos; end if;
  raise notice 'PASS 3: non-support renewal-linked quote unchanged';

  -- 4. control: support renewal still rolls a year
  v_r := public.record_payment('Q-R2073-D-REN', 11795, 'bank_transfer', 'r2073-d');
  select * into v_s from public.subscriptions where id = 'dd207300-0000-4000-8000-00000000b004';
  if v_s.renewal_date <> (current_date + 10 + interval '12 months')::date or v_s.plan <> 'R2073 Standard Support (Yearly)'
     or v_s.mrr <> 833 or coalesce((v_r->>'support_upgrade')::boolean, true) then
    raise exception 'FAIL 4: support renewal → renewal % plan % mrr % result %', v_s.renewal_date, v_s.plan, v_s.mrr, v_r;
  end if;
  raise notice 'PASS 4: support renewal still rolls forward 12 months';
end $$;

rollback;
