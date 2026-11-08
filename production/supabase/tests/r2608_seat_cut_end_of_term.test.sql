-- R-2608 (follow-ups of R-2583): what must hold before "At end of term" seat cuts are offered again.
-- Migration 20261108111500_r2608_seat_cut_end_of_term_safe. Own data, ONE transaction, rolled back.
--
--   1. Paying the renewal quote made WITH the cut (10 → 7) marks the scheduled row 'applied'
--      (mrr_after = the new MRR) — a new cut can be scheduled at once (no "already scheduled").
--   2. A renewal paid at the FULL seats → the row is 'cancelled' (never billed; no longer blocks).
--   3. Correct details-style date move without a seat change → 'cancelled', not applied.
--   4. end_of_term while a renewal quote is already linked → refused, the quote named.
--   5. end_of_term on a subscription billed in parts → refused.
--   6. Remove scheduled cut while the linked renewal quote carries the cut → refused inside
--      cancel_scheduled_seat_reduction; once the quote is unlinked → cancelled.
--   7. end_of_term with no quote, billed yearly → scheduled (control).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd260800-0000-4000-8000-00000000a001', 'R2608 Tenant', 'r2608@test.invalid', '07');
insert into public.customers (id, tenant_id, name)
  select ('dd260800-0000-4000-8000-00000000c00' || n)::uuid, 'dd260800-0000-4000-8000-00000000a001', 'R2608 Cust ' || n
    from generate_series(1, 7) n;
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd260800-0000-4000-8000-00000000a001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9400);

-- 10 seats at Rs 3,000/month = Rs 3,600 per seat a year. Cut quote: 7 × 3,600 = 25,200 + 18% = 29,736.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, seats, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2608-CUT', 'dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000c001', 'R2608 Cust 1',
          29736, 25200, 7, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":7,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2608-FULL', 'dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000c002', 'R2608 Cust 2',
          42480, 36000, 10, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2608-OPEN', 'dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000c004', 'R2608 Cust 4',
          42480, 36000, 10, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2608-HASCUT', 'dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000c006', 'R2608 Cust 6',
          29736, 25200, 7, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":7,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months, renewal_date, renewal_state, renewal_quote_id)
  select ('dd260800-0000-4000-8000-00000000b00' || n)::uuid, 'dd260800-0000-4000-8000-00000000a001',
         ('dd260800-0000-4000-8000-00000000c00' || n)::uuid, 'R2608 Cust ' || n,
         'Google Workspace Business Starter', 'google', 10, 3000, 'active', 12, current_date + 5, 'reminder_1',
         case n when 1 then 'Q-R2608-CUT' when 2 then 'Q-R2608-FULL' when 4 then 'Q-R2608-OPEN' when 6 then 'Q-R2608-HASCUT' end
    from generate_series(1, 7) n;
update public.subscriptions set billing_cycle = 'monthly' where id = 'dd260800-0000-4000-8000-00000000b005';

-- Cuts scheduled 10 → 7 for the renewal date (subs 1, 2, 3, 6).
insert into public.subscription_seat_reductions
  (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after, effective_date, mrr_before)
  select 'dd260800-0000-4000-8000-00000000a001', ('dd260800-0000-4000-8000-00000000b00' || n)::uuid, 'r2608-cut-' || n,
         'end_of_term', 'scheduled', 10, 3, 7, current_date + 5, 3000
    from unnest(array[1, 2, 3, 6]) n;

create temp table r2608_fail (msg text) on commit drop;

do $$
declare v_status text; v_mrr_after int; v_msg text; v_r jsonb;
begin
  -- 1. the cut renewal quote is paid → row applied, new cut allowed.
  perform public.record_payment('Q-R2608-CUT', 29736, 'razorpay', 'rzp_r2608_cut');
  select status, mrr_after into v_status, v_mrr_after from public.subscription_seat_reductions where idempotency_key = 'r2608-cut-1';
  if v_status is distinct from 'applied' or v_mrr_after is distinct from 2100 then
    insert into r2608_fail values ('1: paid cut quote left the row ' || coalesce(v_status, 'null') || ', mrr_after ' || coalesce(v_mrr_after::text, 'null') || ' (want applied, 2100)');
  end if;
  begin
    v_r := public.reduce_subscription_seats('dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000b001',
      2, 'end_of_term', 0, 0, 'r2608-key-1b', null, 7);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null or v_r->>'status' <> 'scheduled' then
    insert into r2608_fail values ('1b: a new cut after the applied one was refused: ' || coalesce(v_msg, v_r::text));
  end if;

  -- 2. renewal paid at the full seats → row not applied.
  perform public.record_payment('Q-R2608-FULL', 42480, 'razorpay', 'rzp_r2608_full');
  select status into v_status from public.subscription_seat_reductions where idempotency_key = 'r2608-cut-2';
  if v_status is distinct from 'cancelled' then
    insert into r2608_fail values ('2: a full-seat renewal left the cut ' || v_status || ' (want cancelled)');
  end if;

  -- 3. date moved on without a seat change → not applied.
  update public.subscriptions set renewal_date = renewal_date + 30 where id = 'dd260800-0000-4000-8000-00000000b003';
  select status into v_status from public.subscription_seat_reductions where idempotency_key = 'r2608-cut-3';
  if v_status is distinct from 'cancelled' then
    insert into r2608_fail values ('3: a date move without a seat change left the cut ' || v_status || ' (want cancelled)');
  end if;

  -- 4. renewal quote already linked → end of term refused, quote named.
  v_msg := null;
  begin
    perform public.reduce_subscription_seats('dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000b004',
      3, 'end_of_term', 0, 0, 'r2608-key-4', null, 10);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'Renewal quote Q-R2608-OPEN is already made for 10 seats.%' then
    insert into r2608_fail values ('4: end of term with a linked renewal quote: ' || coalesce(v_msg, 'was scheduled'));
  end if;

  -- 5. billed in parts → end of term refused.
  v_msg := null;
  begin
    perform public.reduce_subscription_seats('dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000b005',
      3, 'end_of_term', 0, 0, 'r2608-key-5', null, 10);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'This subscription is billed in parts%' then
    insert into r2608_fail values ('5: end of term on a split-billed subscription: ' || coalesce(v_msg, 'was scheduled'));
  end if;

  -- 6. Remove while the linked quote carries the cut → refused in SQL; unlinked → cancelled.
  v_msg := null;
  begin
    perform public.cancel_scheduled_seat_reduction('dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000b006');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'Renewal quote Q-R2608-HASCUT is already made for 7 seats with this cut.%' then
    insert into r2608_fail values ('6: Remove with a cut-seat quote linked: ' || coalesce(v_msg, 'was cancelled'));
  end if;
  update public.subscriptions set renewal_quote_id = null where id = 'dd260800-0000-4000-8000-00000000b006';
  v_msg := null;
  begin
    v_r := public.cancel_scheduled_seat_reduction('dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000b006');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null or v_r->>'status' <> 'cancelled' then
    insert into r2608_fail values ('6b: Remove without a quote failed: ' || coalesce(v_msg, v_r::text));
  end if;

  -- 7. control: yearly, no quote → scheduled.
  v_msg := null;
  begin
    v_r := public.reduce_subscription_seats('dd260800-0000-4000-8000-00000000a001', 'dd260800-0000-4000-8000-00000000b007',
      3, 'end_of_term', 0, 0, 'r2608-key-7', null, 10);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null or v_r->>'status' <> 'scheduled' then
    insert into r2608_fail values ('7: plain end-of-term cut: ' || coalesce(v_msg, v_r::text));
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2608_fail;
  if v_list is not null then
    raise exception E'FAIL r2608_seat_cut_end_of_term:\n  %', v_list;
  end if;
  raise notice 'PASS r2608_seat_cut_end_of_term';
end $$;

rollback;
