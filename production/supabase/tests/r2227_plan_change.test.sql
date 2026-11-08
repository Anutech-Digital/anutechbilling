-- R-2227 (8 Nov 2026, Zoho Billing A3): a LICENCE plan changed mid-term, paid through record_payment.
--
-- The quote "Change plan" makes (api/subscriptions/[id]/change-plan) is linked like R-2073's support
-- upgrade (renewal_quote_id, extension_months = 0); its first line carries plan_change.
--
--   1. Owner's path: Business Starter 10 seats (mrr 2,700) → Business Standard 12 seats, net quote
--      paid in full → plan / item_id = Standard, seats 12, mrr 10,368 (from plan_change), licence cost
--      720; renewal date, renewal state, reminders, status unchanged; no PO; plan_change = true,
--      support_upgrade = false, renewal_rolled_forward = false.
--   2. Refused: plan_change naming ANOTHER subscription → exception, nothing changed.
--   3. Refused: plan_change with fewer seats than today → exception.
--   4. Control — R-2073 support upgrade still works and says support_upgrade = true, plan_change = false.
--   5. A plan-change quote with no link (renewal_quote_id not set) → refused, no new subscription.
--
-- Fails without the migration: the old record_payment treats a 0-month non-support quote as an
-- extension and drafts a vendor PO for 0 months (purchase_orders_term_months_check) — case 1 raises.
-- Fixture owns its data and rolls back.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd222700-0000-4000-8000-00000000a001', 'R2227 Tenant', 'r2227@test.invalid', '07');
insert into public.customers (id, tenant_id, name) values
  ('dd222700-0000-4000-8000-00000000c001', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Cust A'),
  ('dd222700-0000-4000-8000-00000000c002', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Cust B'),
  ('dd222700-0000-4000-8000-00000000c003', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Cust C'),
  ('dd222700-0000-4000-8000-00000000c004', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Cust D');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd222700-0000-4000-8000-00000000a001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9700);

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('GW-STR-r2227', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Business Starter', 'google', 270, 220, 'subscription',
   '{"annual":{"msrp":270,"wholesale":220}}'),
  ('GW-STD-r2227', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Business Standard', 'google', 864, 720, 'subscription',
   '{"annual":{"msrp":864,"wholesale":720}}'),
  ('SUP-STANDARD-YR-r2227', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Standard Support (Yearly)', 'support', 0, 0, 'subscription',
   '{"annual_total":{"msrp":9996,"wholesale":0}}'),
  ('SUP-ENTERPRISE-YR-r2227', 'dd222700-0000-4000-8000-00000000a001', 'R2227 Enterprise Support (Yearly)', 'support', 0, 0, 'subscription',
   '{"annual_total":{"msrp":49992,"wholesale":0}}');

-- ── 1. Starter 10 → Standard 12 ───────────────────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount, vendor_cost_per_seat_month)
  values ('dd222700-0000-4000-8000-00000000b001', 'dd222700-0000-4000-8000-00000000a001',
          'dd222700-0000-4000-8000-00000000c001', 'R2227 Cust A',
          'R2227 Business Starter', 'google', 'GW-STR-r2227', 10, 2700, 'active', 12,
          current_date - 183, current_date + 182, 'reminder_1', 2, 0, 220);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months, billing_cycle)
  values ('Q-R2227-A', 'dd222700-0000-4000-8000-00000000a001', 'dd222700-0000-4000-8000-00000000c001',
          'R2227 Cust A', 54136, 45878, 18, 'draft', 'awaiting',
          '[{"id":"plan-change-1","item_id":"GW-STD-r2227","name":"R2227 Business Standard · change from R2227 Business Starter","qty":1,"rate":45878,"cost":0,"commitment":"annual_yearly",
             "plan_change":{"subscription_id":"dd222700-0000-4000-8000-00000000b001","to_item_id":"GW-STD-r2227","seats":12,"new_mrr":10368,"cost_per_seat_month":720}}]'::jsonb,
          true, 0, 'yearly');

-- ── 2. plan_change names another subscription ─────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd222700-0000-4000-8000-00000000b002', 'dd222700-0000-4000-8000-00000000a001',
          'dd222700-0000-4000-8000-00000000c002', 'R2227 Cust B',
          'R2227 Business Starter', 'google', 'GW-STR-r2227', 5, 1350, 'active', 12,
          current_date - 100, current_date + 265, 'pending', 0, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months, billing_cycle)
  values ('Q-R2227-B', 'dd222700-0000-4000-8000-00000000a001', 'dd222700-0000-4000-8000-00000000c002',
          'R2227 Cust B', 1180, 1000, 18, 'draft', 'awaiting',
          '[{"id":"plan-change-1","item_id":"GW-STD-r2227","name":"x","qty":1,"rate":1000,"cost":0,
             "plan_change":{"subscription_id":"dd222700-0000-4000-8000-00000000b001","seats":5,"new_mrr":4320}}]'::jsonb,
          true, 0, 'yearly');

-- ── 3. fewer seats than today ─────────────────────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd222700-0000-4000-8000-00000000b003', 'dd222700-0000-4000-8000-00000000a001',
          'dd222700-0000-4000-8000-00000000c003', 'R2227 Cust C',
          'R2227 Business Starter', 'google', 'GW-STR-r2227', 5, 1350, 'active', 12,
          current_date - 100, current_date + 265, 'pending', 0, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months, billing_cycle)
  values ('Q-R2227-C', 'dd222700-0000-4000-8000-00000000a001', 'dd222700-0000-4000-8000-00000000c003',
          'R2227 Cust C', 1180, 1000, 18, 'draft', 'awaiting',
          '[{"id":"plan-change-1","item_id":"GW-STD-r2227","name":"x","qty":1,"rate":1000,"cost":0,
             "plan_change":{"subscription_id":"dd222700-0000-4000-8000-00000000b003","seats":4,"new_mrr":3456}}]'::jsonb,
          true, 0, 'yearly');

-- ── 4. control: R-2073 support upgrade ────────────────────────────────────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd222700-0000-4000-8000-00000000b004', 'dd222700-0000-4000-8000-00000000a001',
          'dd222700-0000-4000-8000-00000000c004', 'R2227 Cust D',
          'R2227 Standard Support (Yearly)', 'support', 'SUP-STANDARD-YR-r2227', 1, 833, 'active', 12,
          current_date - 183, current_date + 183, 'reminder_1', 2, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2227-D', 'dd222700-0000-4000-8000-00000000a001', 'dd222700-0000-4000-8000-00000000c004',
          'R2227 Cust D', 23598, 19998, 18, 'draft', 'awaiting',
          '[{"id":"upgrade-1","item_id":"SUP-ENTERPRISE-YR-r2227","name":"R2227 Enterprise Support (Yearly) · upgrade","qty":1,"rate":19998,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
          true, 0);

-- ── 5. plan change quote whose link was lost (renewal_quote_id never set) ─────
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
  values ('dd222700-0000-4000-8000-00000000b005', 'dd222700-0000-4000-8000-00000000a001',
          'dd222700-0000-4000-8000-00000000c001', 'R2227 Cust A',
          'R2227 Business Starter', 'google', 'GW-STR-r2227', 3, 810, 'active', 12,
          current_date - 100, current_date + 265, 'pending', 0, 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, is_renewal, extension_months, billing_cycle)
  values ('Q-R2227-E', 'dd222700-0000-4000-8000-00000000a001', 'dd222700-0000-4000-8000-00000000c001',
          'R2227 Cust A', 1180, 1000, 18, 'draft', 'awaiting',
          '[{"id":"plan-change-1","item_id":"GW-STD-r2227","name":"x","qty":1,"rate":1000,"cost":0,
             "plan_change":{"subscription_id":"dd222700-0000-4000-8000-00000000b005","seats":3,"new_mrr":2592}}]'::jsonb,
          true, 0, 'yearly');

update public.subscriptions set renewal_quote_id = 'Q-R2227-A' where id = 'dd222700-0000-4000-8000-00000000b001';
update public.subscriptions set renewal_quote_id = 'Q-R2227-B' where id = 'dd222700-0000-4000-8000-00000000b002';
update public.subscriptions set renewal_quote_id = 'Q-R2227-C' where id = 'dd222700-0000-4000-8000-00000000b003';
update public.subscriptions set renewal_quote_id = 'Q-R2227-D' where id = 'dd222700-0000-4000-8000-00000000b004';

do $$
declare
  v_s record;
  v_r jsonb;
  v_pos int;
  v_failed boolean;
begin
  -- 1. owner's path
  v_r := public.record_payment('Q-R2227-A', 54136, 'bank_transfer', 'r2227-a');
  select * into v_s from public.subscriptions where id = 'dd222700-0000-4000-8000-00000000b001';
  if v_s.plan <> 'R2227 Business Standard' or v_s.item_id <> 'GW-STD-r2227' then
    raise exception 'FAIL 1: paid plan change left the plan as % / %', v_s.plan, v_s.item_id;
  end if;
  if v_s.seats <> 12 or v_s.mrr <> 10368 or v_s.vendor_cost_per_seat_month <> 720 then
    raise exception 'FAIL 1b: seats % mrr % cost % (expected 12 / 10368 / 720)', v_s.seats, v_s.mrr, v_s.vendor_cost_per_seat_month;
  end if;
  if v_s.renewal_date <> current_date + 182 or v_s.renewal_state <> 'reminder_1' or v_s.reminder_count <> 2 or v_s.status <> 'active' then
    raise exception 'FAIL 1c: renewal % state % reminders % status % changed', v_s.renewal_date, v_s.renewal_state, v_s.reminder_count, v_s.status;
  end if;
  if v_s.renewal_quote_id is not null then raise exception 'FAIL 1d: renewal_quote_id still %', v_s.renewal_quote_id; end if;
  select count(*) into v_pos from public.purchase_orders where subscription_id = v_s.id;
  if v_pos <> 0 then raise exception 'FAIL 1e: % PO drafted for a plan change', v_pos; end if;
  if not coalesce((v_r->>'plan_change')::boolean, false) or coalesce((v_r->>'support_upgrade')::boolean, true)
     or coalesce((v_r->>'renewal_rolled_forward')::boolean, true) then
    raise exception 'FAIL 1f: result flags %', v_r;
  end if;
  raise notice 'PASS 1: Starter 10 → Standard 12, mrr 10368, cost 720, renewal date kept, no PO';

  -- 2. another subscription's plan_change
  v_failed := false;
  begin
    perform public.record_payment('Q-R2227-B', 1180, 'bank_transfer', 'r2227-b');
  exception when others then
    if sqlerrm not like 'R-2227: plan change quote % was made for another subscription%' then raise; end if;
    v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL 2: a plan_change for another subscription was accepted'; end if;
  select * into v_s from public.subscriptions where id = 'dd222700-0000-4000-8000-00000000b002';
  if v_s.plan <> 'R2227 Business Starter' or v_s.seats <> 5 then raise exception 'FAIL 2b: sub B changed'; end if;
  raise notice 'PASS 2: plan_change naming another subscription refused';

  -- 3. fewer seats
  v_failed := false;
  begin
    perform public.record_payment('Q-R2227-C', 1180, 'bank_transfer', 'r2227-c');
  exception when others then
    if sqlerrm not like 'R-2227: plan change quote % has seats or a monthly amount%' then raise; end if;
    v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL 3: a plan_change with fewer seats was accepted'; end if;
  raise notice 'PASS 3: plan_change with fewer seats refused';

  -- 4. control: support upgrade
  v_r := public.record_payment('Q-R2227-D', 23598, 'bank_transfer', 'r2227-d');
  select * into v_s from public.subscriptions where id = 'dd222700-0000-4000-8000-00000000b004';
  if v_s.item_id <> 'SUP-ENTERPRISE-YR-r2227' or v_s.mrr <> 4166 or v_s.seats <> 1
     or not coalesce((v_r->>'support_upgrade')::boolean, false) or coalesce((v_r->>'plan_change')::boolean, true) then
    raise exception 'FAIL 4: support upgrade → item % mrr % seats % result %', v_s.item_id, v_s.mrr, v_s.seats, v_r;
  end if;
  raise notice 'PASS 4: R-2073 support upgrade unchanged';

  -- 5. lost link → refused, no second subscription
  select count(*) into v_pos from public.subscriptions where tenant_id = 'dd222700-0000-4000-8000-00000000a001';
  v_failed := false;
  begin
    perform public.record_payment('Q-R2227-E', 1180, 'bank_transfer', 'r2227-e');
  exception when others then
    if sqlerrm not like 'R-2227: plan change quote % is no longer linked%' then raise; end if;
    v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL 5: an unlinked plan change quote was paid (new-sale path)'; end if;
  if (select count(*) from public.subscriptions where tenant_id = 'dd222700-0000-4000-8000-00000000a001') <> v_pos then
    raise exception 'FAIL 5b: a subscription was created';
  end if;
  raise notice 'PASS 5: unlinked plan change quote refused, no new subscription';
end $$;

rollback;
