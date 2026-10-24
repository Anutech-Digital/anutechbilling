-- A paid MONTHLY renewal moves the date one month, not twelve (R-012, 28 Sep 2026).
--
-- WHAT IT PROVES
--   1. THE CONTROL FIRST. An ANNUAL renewal still rolls forward twelve months and keeps
--      its MRR. A fix that made every renewal one month would pass "the monthly case is
--      one month" and quietly halve a year off every annual subscription in the book,
--      and nothing on screen would say so (L107).
--   2. A monthly renewal (quote `extension_months = 1`) moves `renewal_date` exactly one
--      month and leaves `mrr` alone. Before R-012 the quote always carried 12, so
--      Pawan measured: a Rs 250/month subscription renewing 25 Oct 2026 was paid Rs 295
--      and came back dated 25 Oct 2027 with its MRR at 21. Twelve months of service for
--      one month's money, and the recurring revenue figure wrong by 12x in the other
--      direction.
--   3. No second subscription is created either way.
--
-- WHAT IT DOES NOT TOUCH
--   `record_payment` is correct here and is not under test — it reads
--   `quotes.extension_months` and does as it is told. The defect was the quote builder
--   writing 12 into that field, so what this pins is the CONSEQUENCE of the field being
--   right. The builder's own half is `create-renewal-quote.wiring.test.ts`.
--
-- The fixture owns its data (L11) and rolls back.

-- ── Control: an ANNUAL renewal still moves twelve months ─────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd012000-0000-4000-8000-00000000a001', 'R012 Annual Tenant', 'r012a@test.invalid', '07');
insert into public.customers (id, tenant_id, name)
  values ('dd012000-0000-4000-8000-00000000c001', 'dd012000-0000-4000-8000-00000000a001', 'R012 Annual Cust');
-- The roll-forward raises an automatic PO; seed the series high so its id cannot collide.
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd012000-0000-4000-8000-00000000a001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9100);

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R012-ANNUAL', 'dd012000-0000-4000-8000-00000000a001', 'dd012000-0000-4000-8000-00000000c001',
          'R012 Annual Cust', 35400, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":3000,"cost":1320,"commitment":"annual_yearly"}]'::jsonb,
          true, 12);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months, renewal_date, renewal_state, renewal_quote_id)
  values ('dd012000-0000-4000-8000-00000000b001', 'dd012000-0000-4000-8000-00000000a001',
          'dd012000-0000-4000-8000-00000000c001', 'R012 Annual Cust',
          'Google Workspace Business Starter', 'google', 10, 2500, 'active', 12,
          current_date, 'reminder_2', 'Q-R012-ANNUAL');

do $$
declare
  v_n     integer;
  v_renew date;
  v_mrr   integer;
begin
  perform public.record_payment('Q-R012-ANNUAL', 35400, 'razorpay', 'rzp_r012_annual');

  select count(*), max(renewal_date), max(mrr) into v_n, v_renew, v_mrr
    from public.subscriptions
   where customer_id = 'dd012000-0000-4000-8000-00000000c001';

  if v_n <> 1 then
    raise exception 'FAIL 1: expected 1 subscription, got % — a renewal created a duplicate', v_n;
  end if;
  if v_renew <> (current_date + interval '12 months')::date then
    raise exception 'FAIL 1b: an ANNUAL renewal moved to % , expected %. A fix that makes every renewal one month would silently take a year off every annual subscription.',
      v_renew, (current_date + interval '12 months')::date;
  end if;
  if v_mrr <> 2500 then
    raise exception 'FAIL 1c: MRR moved to % on an annual renewal, expected 2500', v_mrr;
  end if;

  raise notice 'PASS control: an annual renewal still moves 12 months and keeps its MRR';
end $$;

rollback;

-- ── The bug: a MONTHLY renewal must move ONE month ───────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd012000-0000-4000-8000-00000000a002', 'R012 Monthly Tenant', 'r012m@test.invalid', '07');
insert into public.customers (id, tenant_id, name)
  values ('dd012000-0000-4000-8000-00000000c002', 'dd012000-0000-4000-8000-00000000a002', 'R012 Monthly Cust');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd012000-0000-4000-8000-00000000a002', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9200);

-- Pawan's case: Rs 250/month hosting. One month, ex-GST 250, payable 295.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R012-MONTHLY', 'dd012000-0000-4000-8000-00000000a002', 'dd012000-0000-4000-8000-00000000c002',
          'R012 Monthly Cust', 295, 'sent', 'awaiting',
          '[{"name":"Hosting Starter","qty":1,"rate":250,"cost":0,"commitment":"monthly"}]'::jsonb,
          true, 1);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months, renewal_date, renewal_state, renewal_quote_id)
  values ('dd012000-0000-4000-8000-00000000b002', 'dd012000-0000-4000-8000-00000000a002',
          'dd012000-0000-4000-8000-00000000c002', 'R012 Monthly Cust',
          'Hosting Starter', 'hosting', 1, 250, 'active', 1,
          current_date, 'reminder_2', 'Q-R012-MONTHLY');

do $$
declare
  v_n     integer;
  v_renew date;
  v_mrr   integer;
begin
  perform public.record_payment('Q-R012-MONTHLY', 295, 'razorpay', 'rzp_r012_monthly');

  select count(*), max(renewal_date), max(mrr) into v_n, v_renew, v_mrr
    from public.subscriptions
   where customer_id = 'dd012000-0000-4000-8000-00000000c002';

  if v_n <> 1 then
    raise exception 'FAIL 2: expected 1 subscription, got %', v_n;
  end if;

  if v_renew <> (current_date + interval '1 month')::date then
    raise exception
      'FAIL 2b: a MONTHLY renewal moved the date to % , expected % — the customer paid for one month and got %. This is the R-012 bug.',
      v_renew, (current_date + interval '1 month')::date,
      case when v_renew = (current_date + interval '12 months')::date then 'a whole year' else v_renew::text end;
  end if;

  if v_mrr <> 250 then
    raise exception
      'FAIL 2c: MRR moved to % on a monthly renewal, expected 250. Paying one month must not change the run rate (it fell to 21 before this fix).',
      v_mrr;
  end if;

  raise notice 'PASS: a paid monthly renewal moves the date one month and leaves MRR at 250';
end $$;

rollback;

-- ── MONTH-END: what record_payment actually does, recorded not corrected ─────
--
-- Pardeep/Pawan asked for this to be FLAGGED, not fixed — `record_payment` and the
-- migrations are out of scope for R-012. So this block asserts the CURRENT behaviour
-- on purpose, and its message says what the right answer would be.
--
-- Since 11 Sep 2026 `renewal_date` is the LAST COVERED DAY, inclusive. The next term
-- therefore starts the day after, and its last covered day is `(d + 1) + 1 month - 1 day`.
-- `record_payment` does `d + 1 month`, which is right mid-month and short at month ends:
--
--     30 Nov -> 30 Dec   (should be 31 Dec)   1 day short
--     28 Feb -> 28 Mar   (should be 31 Mar)   3 days short
--     30 Apr -> 30 May   (should be 31 May)   1 day short
--
-- And it STICKS: a subscription that lands on the 28th stays on the 28th for ever, so a
-- month-end customer loses 2-3 days of service every month from then on. Measured by
-- rolling 2026-01-31 forward eight times: 28 Feb, 28 Mar, 28 Apr ... never 31 again.
--
-- This block turns red the day somebody fixes it — which is the point. Read the message,
-- then delete the block.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd012000-0000-4000-8000-00000000a003', 'R012 Month End Tenant', 'r012e@test.invalid', '07');
insert into public.customers (id, tenant_id, name)
  values ('dd012000-0000-4000-8000-00000000c003', 'dd012000-0000-4000-8000-00000000a003', 'R012 Month End Cust');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd012000-0000-4000-8000-00000000a003', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9300);

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R012-MONTHEND', 'dd012000-0000-4000-8000-00000000a003', 'dd012000-0000-4000-8000-00000000c003',
          'R012 Month End Cust', 295, 'sent', 'awaiting',
          '[{"name":"Hosting Starter","qty":1,"rate":250,"cost":0,"commitment":"monthly"}]'::jsonb,
          true, 1);

-- Term ends 30 Nov 2026. The next month's term should end 31 Dec 2026.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months, renewal_date, renewal_state, renewal_quote_id)
  values ('dd012000-0000-4000-8000-00000000b003', 'dd012000-0000-4000-8000-00000000a003',
          'dd012000-0000-4000-8000-00000000c003', 'R012 Month End Cust',
          'Hosting Starter', 'hosting', 1, 250, 'active', 1,
          date '2026-11-30', 'reminder_2', 'Q-R012-MONTHEND');

do $$
declare
  v_renew   date;
  v_correct date := ((date '2026-11-30' + 1) + interval '1 month' - interval '1 day')::date;  -- 2026-12-31
begin
  perform public.record_payment('Q-R012-MONTHEND', 295, 'razorpay', 'rzp_r012_monthend');

  select renewal_date into v_renew from public.subscriptions
   where id = 'dd012000-0000-4000-8000-00000000b003';

  if v_renew = v_correct then
    raise exception
      'MONTH-END IS NOW CORRECT (% = %). record_payment has been fixed since this was written — delete this block, it exists only to record the old behaviour.',
      v_renew, v_correct;
  end if;

  if v_renew <> date '2026-12-30' then
    raise exception 'FAIL month-end: expected the KNOWN-WRONG 2026-12-30, got % (correct would be %)', v_renew, v_correct;
  end if;

  raise notice 'FLAGGED (not a failure): a term ending 30 Nov rolled to % ; the last covered day should be %. One day of service short, and a month-end subscription pinned to the 28th after February loses 2-3 days EVERY month. record_payment is out of scope for R-012 — Pardeep/Pawan to decide.',
    v_renew, v_correct;
end $$;

rollback;
