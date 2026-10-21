-- R-1703 (21 Oct 2026): a renewal payment must not wipe the unpaid previous term.
--
-- The owner's path (local billing audit, T-A2): the subscription's own quote (year 1) was
-- accepted and never paid — subscription owed ₹9,629, payment_due_date set. Renewals →
-- Generate quote → the renewal quote was paid ₹9,629 → record_payment's roll-forward wrote
-- outstanding_amount = 0 and the customer left Payments → Subscription dues.
--
--   1. Owner's path: prior term (sub's own quote, accepted, no invoice) unpaid → after the
--      renewal is paid, outstanding = the prior ₹9,629 and payment_due_date = the prior due date.
--   2. Prior term paid (and a sent-but-never-accepted quote for the sub lying around) →
--      outstanding 0, payment_due_date cleared. The roll-forward itself still happens.
--   3. Prior term invoiced, part paid → outstanding = the invoice's unpaid part, due date = the
--      invoice's due date.
--
-- Fixture owns its data and rolls back.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd170300-0000-4000-8000-00000000a001', 'R1703 Tenant', 'r1703@test.invalid', '07');
insert into public.customers (id, tenant_id, name) values
  ('dd170300-0000-4000-8000-00000000c001', 'dd170300-0000-4000-8000-00000000a001', 'R1703 Cust A'),
  ('dd170300-0000-4000-8000-00000000c002', 'dd170300-0000-4000-8000-00000000a001', 'R1703 Cust B'),
  ('dd170300-0000-4000-8000-00000000c003', 'dd170300-0000-4000-8000-00000000a001', 'R1703 Cust C');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd170300-0000-4000-8000-00000000a001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9700);

-- ── 1. owner's path: sub's own quote accepted, unpaid ───────────────────────
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, extension_months)
  values ('Q-R1703-A-Y1', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c001',
          'R1703 Cust A', 9629, 'accepted', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1632,"commitment":"annual_yearly"}]'::jsonb, 12);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, renewal_quote_id, quote_id, outstanding_amount, payment_due_date)
  values ('dd170300-0000-4000-8000-00000000b001', 'dd170300-0000-4000-8000-00000000a001',
          'dd170300-0000-4000-8000-00000000c001', 'R1703 Cust A',
          'Google Workspace Business Starter', 'google', 5, 680, 'active', 12,
          current_date - 355, current_date + 10, 'reminder_1', null, 'Q-R1703-A-Y1', 9629, current_date + 4);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, status, payment_status, line_items, is_renewal, extension_months, renewal_subscription_id, renewal_term_date)
  values ('Q-R1703-A-REN', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c001',
          'R1703 Cust A', 9629, 8160, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1632,"commitment":"annual_yearly"}]'::jsonb,
          true, 12, 'dd170300-0000-4000-8000-00000000b001', current_date + 10);

-- ── 2. prior term paid; a stray sent quote for the sub must not count ───────
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, extension_months)
  values ('Q-R1703-B-Y1', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c002',
          'R1703 Cust B', 9629, 'accepted', 'received',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1632,"commitment":"annual_yearly"}]'::jsonb, 12);
insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, status)
  values ('dd170300-0000-4000-8000-00000000a001', 'Q-R1703-B-Y1', 'dd170300-0000-4000-8000-00000000c002', 9629, 'upi', 'r1703-b-y1', 'received');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, renewal_quote_id, quote_id, outstanding_amount, payment_due_date)
  values ('dd170300-0000-4000-8000-00000000b002', 'dd170300-0000-4000-8000-00000000a001',
          'dd170300-0000-4000-8000-00000000c002', 'R1703 Cust B',
          'Google Workspace Business Starter', 'google', 5, 680, 'active', 12,
          current_date - 355, current_date + 10, 'reminder_1', null, 'Q-R1703-B-Y1', 0, current_date - 20);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, status, payment_status, line_items, is_renewal, extension_months, renewal_subscription_id, renewal_term_date)
  values ('Q-R1703-B-REN', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c002',
          'R1703 Cust B', 9629, 8160, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1632,"commitment":"annual_yearly"}]'::jsonb,
          true, 12, 'dd170300-0000-4000-8000-00000000b002', current_date + 10),
         ('Q-R1703-B-OLD', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c002',
          'R1703 Cust B', 5000, 5000, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1000,"commitment":"annual_yearly"}]'::jsonb,
          true, 12, 'dd170300-0000-4000-8000-00000000b002', current_date - 1);

-- ── 3. prior term invoiced, part paid ───────────────────────────────────────
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, extension_months)
  values ('Q-R1703-C-Y1', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c003',
          'R1703 Cust C', 9629, 'accepted', 'invoiced',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1632,"commitment":"annual_yearly"}]'::jsonb, 12);
insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, amount, net_payable, paid_amount, status, invoice_date, due_date)
  values ('INV-R1703-C', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c003', 'R1703 Cust C',
          'Q-R1703-C-Y1', 9629, 9629, 4000, 'pending', current_date - 30, current_date - 15);
update public.quotes set invoice_id = 'INV-R1703-C' where id = 'Q-R1703-C-Y1';
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, renewal_quote_id, quote_id, outstanding_amount, payment_due_date)
  values ('dd170300-0000-4000-8000-00000000b003', 'dd170300-0000-4000-8000-00000000a001',
          'dd170300-0000-4000-8000-00000000c003', 'R1703 Cust C',
          'Google Workspace Business Starter', 'google', 5, 680, 'active', 12,
          current_date - 355, current_date + 10, 'reminder_1', null, 'Q-R1703-C-Y1', 5629, current_date + 30);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, status, payment_status, line_items, is_renewal, extension_months, renewal_subscription_id, renewal_term_date)
  values ('Q-R1703-C-REN', 'dd170300-0000-4000-8000-00000000a001', 'dd170300-0000-4000-8000-00000000c003',
          'R1703 Cust C', 9629, 8160, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1632,"commitment":"annual_yearly"}]'::jsonb,
          true, 12, 'dd170300-0000-4000-8000-00000000b003', current_date + 10);

-- Renewals → Generate quote links the renewal quote on the subscription.
update public.subscriptions s set renewal_quote_id = q.id
  from public.quotes q
 where q.renewal_subscription_id = s.id and q.id like 'Q-R1703-%-REN';

do $$
declare
  v_s record;
  v_r jsonb;
begin
  -- 1. owner's path
  v_r := public.record_payment('Q-R1703-A-REN', 9629, 'bank_transfer', 'r1703-a-ren');
  if not coalesce((v_r->>'renewal_rolled_forward')::boolean, false) then
    raise exception 'FAIL 1a: the renewal did not roll forward: %', v_r;
  end if;
  select * into v_s from public.subscriptions where id = 'dd170300-0000-4000-8000-00000000b001';
  if v_s.renewal_date <> current_date + 10 + interval '12 months' then
    raise exception 'FAIL 1b: renewal_date % — the roll-forward itself must be unchanged', v_s.renewal_date;
  end if;
  if v_s.outstanding_amount <> 9629 then
    raise exception 'FAIL 1: the renewal payment wiped the unpaid previous term — outstanding_amount = % (expected 9629, year-1 quote still unpaid). This is the R-1703 bug.', v_s.outstanding_amount;
  end if;
  if v_s.payment_due_date is distinct from current_date + 4 then
    raise exception 'FAIL 1c: payment_due_date = % (expected the prior term''s %)', v_s.payment_due_date, current_date + 4;
  end if;
  raise notice 'PASS 1: renewal paid while prior term unpaid → outstanding 9629 kept, due date kept, sub still in dues';

  -- 2. prior paid
  v_r := public.record_payment('Q-R1703-B-REN', 9629, 'bank_transfer', 'r1703-b-ren');
  select * into v_s from public.subscriptions where id = 'dd170300-0000-4000-8000-00000000b002';
  if v_s.outstanding_amount <> 0 then
    raise exception 'FAIL 2: prior term paid, a sent-but-not-accepted quote must not count — outstanding = %', v_s.outstanding_amount;
  end if;
  if v_s.payment_due_date is not null then
    raise exception 'FAIL 2b: nothing owed but payment_due_date still %', v_s.payment_due_date;
  end if;
  if v_s.renewal_date <> current_date + 10 + interval '12 months' then
    raise exception 'FAIL 2c: renewal_date %', v_s.renewal_date;
  end if;
  raise notice 'PASS 2: prior term paid → outstanding 0, payment_due_date cleared';

  -- 3. prior invoiced, part paid
  v_r := public.record_payment('Q-R1703-C-REN', 9629, 'bank_transfer', 'r1703-c-ren');
  select * into v_s from public.subscriptions where id = 'dd170300-0000-4000-8000-00000000b003';
  if v_s.outstanding_amount <> 5629 then
    raise exception 'FAIL 3: prior invoice owes 5629, outstanding = %', v_s.outstanding_amount;
  end if;
  if v_s.payment_due_date is distinct from current_date - 15 then
    raise exception 'FAIL 3b: payment_due_date = % (expected the unpaid invoice''s due date %)', v_s.payment_due_date, current_date - 15;
  end if;
  raise notice 'PASS 3: prior invoice part paid → outstanding 5629, due = invoice due date';
end $$;

rollback;
