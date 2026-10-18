-- R-1561 (18 Oct 2026): an instalment invoice subtracts money already received ONCE.
-- Migration 20261018030414_r1561_instalment_due_once.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Every balance screen (invoiceAmountDue, invoiceBalance, Aging, /collections, dunning)
-- reads due = net_payable − paid_amount. raise_subscription_billing wrote BOTH
-- net_payable = gross − credit AND paid_amount = credit, so a ₹2,360 instalment with
-- ₹1,000 already received showed ₹360 due instead of ₹1,360.
--
-- Proves (taxable ₹2,000 @ 18% = ₹2,360 per instalment, same state):
--   A. ₹0 received        → net_payable 2360, paid 0,    due 2360, pending
--   B. ₹1,000 received    → net_payable 2360, paid 1000, due 1360, pending   (was 360)
--   C. ₹2,360 received    → paid, paid 2360, due 0
--   D. ₹3,000 received, two instalments → #1 paid in full, #2 gets the ₹640 left over:
--      paid 640, due 1720 (the "applied" sum still sees #1's ₹2,360 — no credit reused)

begin;

select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000156101','R1561 Co','r1561@example.in','07','R1561');

insert into public.customers (id, tenant_id, name, state_code, country)
  values ('cccccccc-0000-0000-0000-000000156101','dddddddd-0000-0000-0000-000000156101','Delhi 1561','07','India');

insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount)
select 'TESTQ-R1561-' || n, 'dddddddd-0000-0000-0000-000000156101', 'Delhi 1561',
       'cccccccc-0000-0000-0000-000000156101', 18, 28320
  from generate_series(1, 4) n;

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at)
select gen_random_uuid(), 'dddddddd-0000-0000-0000-000000156101', 'TESTQ-R1561-' || n,
       'cccccccc-0000-0000-0000-000000156101', amt, 'upi', 'received', now(), now()
  from (values (2, 1000), (3, 2360), (4, 3000)) v(n, amt);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id)
select ('eeeeeeee-0000-0000-0000-00000015610' || n)::uuid, 'dddddddd-0000-0000-0000-000000156101',
       'cccccccc-0000-0000-0000-000000156101', 'Delhi 1561', 'Workspace Starter', 'google'::vendor, 2, 2000,
       'quarterly'::billing_cycle, 'TESTQ-R1561-' || n
  from generate_series(1, 4) n;

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-00000015610' || n)::uuid, 'dddddddd-0000-0000-0000-000000156101',
       ('eeeeeeee-0000-0000-0000-00000015610' || n)::uuid,
       public.ist_today(), 1, public.ist_today(), public.ist_today(), public.ist_today() + 89, 2000, 18
  from generate_series(1, 4) n;

-- D's second instalment
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
values ('bbbbbbbb-0000-0000-0000-000000156105', 'dddddddd-0000-0000-0000-000000156101',
        'eeeeeeee-0000-0000-0000-000000156104',
        public.ist_today(), 2, public.ist_today(), public.ist_today() + 90, public.ist_today() + 179, 2000, 18);

-- v_due = the due every screen computes (amount-due.ts invoiceAmountDue, kpis.ts invoiceBalance).
do $$
declare
  r record; i record; v_due integer;
  c record;
begin
  for c in
    select * from (values
      ('A', 'bbbbbbbb-0000-0000-0000-000000156101'::uuid, 2360,    0, 2360, 'pending'),
      ('B', 'bbbbbbbb-0000-0000-0000-000000156102'::uuid, 2360, 1000, 1360, 'pending'),
      ('C', 'bbbbbbbb-0000-0000-0000-000000156103'::uuid, 2360, 2360,    0, 'paid'),
      ('D1','bbbbbbbb-0000-0000-0000-000000156104'::uuid, 2360, 2360,    0, 'paid'),
      ('D2','bbbbbbbb-0000-0000-0000-000000156105'::uuid, 2360,  640, 1720, 'pending')
    ) t(label, billing, want_net, want_paid, want_due, want_status)
  loop
    select * into r from public.raise_subscription_billing(c.billing);
    select * into i from public.invoices where id = r.invoice_id;
    v_due := case when i.status::text in ('paid', 'void') then 0
                  else greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0)) end;
    if i.amount <> 2360 then
      raise exception '% FAIL: amount % (want 2360)', c.label, i.amount; end if;
    if i.net_payable is distinct from c.want_net or i.paid_amount is distinct from c.want_paid then
      raise exception '% FAIL: net_payable % / paid_amount % (want % / %) — money received subtracted twice?',
        c.label, i.net_payable, i.paid_amount, c.want_net, c.want_paid; end if;
    if v_due <> c.want_due then
      raise exception '% FAIL: due % (want %)', c.label, v_due, c.want_due; end if;
    if i.status::text <> c.want_status then
      raise exception '% FAIL: status % (want %)', c.label, i.status, c.want_status; end if;
    raise notice '% PASS: net % · paid % · due % · %', c.label, i.net_payable, i.paid_amount, v_due, i.status;
  end loop;
end $$;

select 'R-1561 instalment due subtracts received money once: ALL PASS' as result;

rollback;
