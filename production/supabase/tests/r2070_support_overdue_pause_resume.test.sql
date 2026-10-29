-- R-2070 (decision D4, 29 Oct 2026): a support plan paused by the dunning cron for an
-- invoice more than 7 days overdue comes back on when that invoice is PAID through
-- record_payment — no app code, the existing trigger trg_invoices_overdue_resume. A Workspace
-- subscription of the same customer, paused for its OWN unpaid invoice, stays paused.
-- The row written below is exactly what runSupportOverduePause writes
-- (src/lib/collections/support-overdue-pause.server.ts).
-- Rolled back; safe anywhere. Exit 0 = pass.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, doc_code, tier)
values ('20700000-0000-4000-8000-000000000001', 'ZZ R2070 TEST', 'zz-r2070@example.invalid', 'ZZ2070', 'reseller');

insert into public.customers (id, tenant_id, name, state_code, state)
values ('20700000-0000-4000-8000-0000000000c1', '20700000-0000-4000-8000-000000000001', 'ZZ R2070 Buyer', '07', 'Delhi');

insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active, item_type, kind, prices) values
  ('SUP-STANDARD-MO-r2070', '20700000-0000-4000-8000-000000000001', 'Standard Support (Monthly)', 'support', '998313',
   999, 0, true, 'subscription', 'main', '{}'::jsonb);

-- The support plan's renewal invoice, 10 days past due, and the Workspace invoice, also overdue.
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, due_date, quote_id) values
  ('INV-R2070-SUP', '20700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-0000000000c1', 'ZZ R2070 Buyer',
   999, 'overdue', public.ist_today() - 10, null),
  ('INV-R2070-GWS', '20700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-0000000000c1', 'ZZ R2070 Buyer',
   16560, 'overdue', public.ist_today() - 40, null);

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, status, payment_status,
                           discount_pct, billing_cycle, invoice_id, line_items)
values
  ('ZZ-R2070-SUP', '20700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-0000000000c1',
   'ZZ R2070 Buyer', 999, 999, 'accepted', 'none', 0, 'monthly', 'INV-R2070-SUP',
   '[{"id":"sup-standard-monthly-1","item_id":"SUP-STANDARD-MO-r2070","name":"Standard Support (Monthly)","qty":1,"rate":999,"cost":0,"commitment":"monthly"}]'::jsonb);
update public.invoices set quote_id = 'ZZ-R2070-SUP' where id = 'INV-R2070-SUP';

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, quote_id, item_id) values
  ('20700000-0000-4000-8000-0000000000a1', '20700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-0000000000c1',
   'ZZ R2070 Buyer', 'Standard Support (Monthly)', 'support', 1, 999, 'active', 'ZZ-R2070-SUP', 'SUP-STANDARD-MO-r2070'),
  ('20700000-0000-4000-8000-0000000000a2', '20700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-0000000000c1',
   'ZZ R2070 Buyer', 'Business Starter', 'google', 10, 1380, 'active', null, null);

do $$
declare
  s record;
  n integer;
begin
  -- The cron's writes (service role, guarded on status 'active').
  update public.subscriptions
     set status = 'paused', suspended_at = now(), suspended_by = 'automation',
         suspended_invoice_id = 'INV-R2070-SUP',
         suspend_reason = 'Invoice INV-R2070-SUP is 10 days overdue (support plans: 7 days grace).'
   where id = '20700000-0000-4000-8000-0000000000a1' and status = 'active';
  update public.subscriptions
     set status = 'paused', suspended_at = now(), suspended_by = 'automation',
         suspended_invoice_id = 'INV-R2070-GWS', suspend_reason = 'Invoice INV-R2070-GWS is 40 days overdue.'
   where id = '20700000-0000-4000-8000-0000000000a2' and status = 'active';

  select * into s from public.subscriptions where id = '20700000-0000-4000-8000-0000000000a1';
  if s.status::text <> 'paused' or s.suspended_by is distinct from 'automation' then
    raise exception 'CASE 1 FAIL: support pause did not stick (status %, by %)', s.status, s.suspended_by;
  end if;

  -- 2. Part payment through record_payment → still paused.
  perform public.record_payment('ZZ-R2070-SUP', 500, 'bank_transfer', 'ZZ-R2070-1');
  select * into s from public.subscriptions where id = '20700000-0000-4000-8000-0000000000a1';
  if s.status::text <> 'paused' then
    raise exception 'CASE 2 FAIL: a part payment turned the support plan back on (status %)', s.status;
  end if;

  -- 3. The rest paid → invoice paid → support plan active again, pause fields cleared, logged.
  perform public.record_payment('ZZ-R2070-SUP', 499, 'bank_transfer', 'ZZ-R2070-2');
  if (select status::text from public.invoices where id = 'INV-R2070-SUP') <> 'paid' then
    raise exception 'CASE 3 FAIL: invoice not paid after full payment (status %)',
      (select status::text from public.invoices where id = 'INV-R2070-SUP');
  end if;
  select * into s from public.subscriptions where id = '20700000-0000-4000-8000-0000000000a1';
  if s.status::text <> 'active' then
    raise exception 'CASE 3 FAIL: paid support invoice did not turn the plan back on (status %)', s.status;
  end if;
  if s.suspended_at is not null or s.suspended_by is not null or s.suspended_invoice_id is not null or s.suspend_reason is not null then
    raise exception 'CASE 3 FAIL: pause fields not cleared on resume';
  end if;
  select count(*) into n from public.ai_action_log
   where entity_id = '20700000-0000-4000-8000-0000000000a1' and action = 'subscription.overdue_resume' and outcome = 'did';
  if n <> 1 then raise exception 'CASE 3 FAIL: expected 1 resume log row, got %', n; end if;

  -- 4. The Workspace subscription, paused for its own unpaid invoice, is untouched.
  select * into s from public.subscriptions where id = '20700000-0000-4000-8000-0000000000a2';
  if s.status::text <> 'paused' or s.suspended_invoice_id is distinct from 'INV-R2070-GWS' then
    raise exception 'CASE 4 FAIL: Workspace subscription changed by the support payment (status %, invoice %)',
      s.status, s.suspended_invoice_id;
  end if;

  raise notice 'R-2070: ALL 4 CASES PASS';
end $$;

select 'PASS' as result;

rollback;
