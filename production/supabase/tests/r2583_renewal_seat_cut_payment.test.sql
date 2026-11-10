-- R-2583: a renewal quote made for a scheduled end-of-term seat cut (10 → 7) — paying it leaves the
-- subscription at 7 seats and the 7-seat MRR (record_payment reads the line's qty and subtotal ÷
-- months, rule N1). lib/renewals/create-renewal-quote.ts makes that quote; this pins the payment half.
-- Control: the same subscription renewed at 10 seats keeps 10 and its MRR.
-- Own data, rolled back.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd258300-0000-4000-8000-00000000a001', 'R2583 Tenant', 'r2583@test.invalid', '07');
insert into public.customers (id, tenant_id, name)
  values ('dd258300-0000-4000-8000-00000000c001', 'dd258300-0000-4000-8000-00000000a001', 'R2583 Cust'),
         ('dd258300-0000-4000-8000-00000000c002', 'dd258300-0000-4000-8000-00000000a001', 'R2583 Control');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd258300-0000-4000-8000-00000000a001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9300);

-- 10 seats at Rs 3,000/month = Rs 3,600 per seat a year. The cut quote: 7 × 3,600 = 25,200 + 18% = 29,736.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, seats, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2583-CUT', 'dd258300-0000-4000-8000-00000000a001', 'dd258300-0000-4000-8000-00000000c001', 'R2583 Cust',
          29736, 25200, 7, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":7,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2583-FULL', 'dd258300-0000-4000-8000-00000000a001', 'dd258300-0000-4000-8000-00000000c002', 'R2583 Control',
          42480, 36000, 10, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months, renewal_date, renewal_state, renewal_quote_id)
  values ('dd258300-0000-4000-8000-00000000b001', 'dd258300-0000-4000-8000-00000000a001', 'dd258300-0000-4000-8000-00000000c001',
          'R2583 Cust', 'Google Workspace Business Starter', 'google', 10, 3000, 'active', 12, current_date + 5, 'reminder_1', 'Q-R2583-CUT'),
         ('dd258300-0000-4000-8000-00000000b002', 'dd258300-0000-4000-8000-00000000a001', 'dd258300-0000-4000-8000-00000000c002',
          'R2583 Control', 'Google Workspace Business Starter', 'google', 10, 3000, 'active', 12, current_date + 5, 'reminder_1', 'Q-R2583-FULL');

do $$
declare
  v_seats integer;
  v_mrr   integer;
  v_renew date;
begin
  perform public.record_payment('Q-R2583-FULL', 42480, 'razorpay', 'rzp_r2583_full');
  select seats, mrr into v_seats, v_mrr from public.subscriptions where id = 'dd258300-0000-4000-8000-00000000b002';
  if v_seats <> 10 or v_mrr <> 3000 then
    raise exception 'FAIL control: a 10-seat renewal left % seats, MRR % (expected 10, 3000)', v_seats, v_mrr;
  end if;

  perform public.record_payment('Q-R2583-CUT', 29736, 'razorpay', 'rzp_r2583_cut');
  select seats, mrr, renewal_date into v_seats, v_mrr, v_renew from public.subscriptions where id = 'dd258300-0000-4000-8000-00000000b001';
  if v_seats <> 7 then
    raise exception 'FAIL 1: paying the cut renewal quote left % seats, expected 7', v_seats;
  end if;
  if v_mrr <> 2100 then
    raise exception 'FAIL 2: MRR % after the cut renewal, expected 2100 (25,200 / 12)', v_mrr;
  end if;
  if v_renew <> (current_date + 5 + interval '12 months')::date then
    raise exception 'FAIL 3: renewal date %, expected one term on', v_renew;
  end if;
  if (select count(*) from public.subscriptions where customer_id = 'dd258300-0000-4000-8000-00000000c001') <> 1 then
    raise exception 'FAIL 4: a second subscription was made';
  end if;
  raise notice 'PASS R-2583: paying a renewal quote made for a scheduled cut leaves 7 seats, MRR 2100; control keeps 10';
end $$;

rollback;
