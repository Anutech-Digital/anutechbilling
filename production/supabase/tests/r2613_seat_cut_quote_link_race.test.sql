-- R-2613 (R-2608 review follow-ups, money rule N5): a full-seat renewal / extension quote must not
-- be made or linked once an end-of-term seat cut is scheduled; moving the renewal date earlier
-- moves (or cancels) the cut. Migration 20261108142224_r2613_seat_cut_quote_link_race.
-- Own data, ONE transaction, rolled back.
--
--   1.  create_renewal_quote priced at 10 seats after a 10 → 7 cut was saved → refused, nothing made.
--   1b. the same call at the cut's 7 seats → made and linked (the retry after a refusal).
--   2.  create_renewal_quote re-linking an older same-term quote at 10 seats → refused, not linked.
--   3.  an extension quote at 10 seats linked by a plain UPDATE (as createExtensionQuote does) → refused.
--   4.  an extension quote at the cut's 7 seats → linked.
--   5.  a cut that no longer applies (made on 12 seats, the subscription has 10) → a 10-seat quote links.
--   5b. a plan-change quote (extension_months 0) → links (not a renewal).
--   6.  renewal date moved EARLIER, still in the future → the cut moves to the new date.
--   7.  renewal date moved into the past → the cut is cancelled.
--   7b. renewal date cleared → the cut is cancelled.
--   8.  control: no cut → create_renewal_quote makes the 10-seat quote.
--   9.  the other way round: priced WITH a 10 → 7 cut that was removed meanwhile → refused, nothing made.
--   9b. a 7-seat extension quote linked after its cut was removed → refused.
--   10. date moved into the past while a 7-seat renewal quote made with the cut is linked → refused,
--       the cut stays scheduled.
--   10b. the same subscription, date moved earlier but still ahead → saved, the cut moves with it.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd261300-0000-4000-8000-00000000a001', 'R2613 Tenant', 'r2613@test.invalid', '07');
insert into public.customers (id, tenant_id, name)
  select ('dd261300-0000-4000-8000-00000000c00' || n)::uuid, 'dd261300-0000-4000-8000-00000000a001', 'R2613 Cust ' || n
    from generate_series(1, 9) n;

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months, renewal_date, renewal_state)
  select ('dd261300-0000-4000-8000-00000000b00' || n)::uuid, 'dd261300-0000-4000-8000-00000000a001',
         ('dd261300-0000-4000-8000-00000000c00' || n)::uuid, 'R2613 Cust ' || n,
         'Google Workspace Business Starter', 'google', 10, 3000, 'active', 12, current_date + 5, 'reminder_1'
    from generate_series(1, 9) n;

-- 10 → 7 cuts for the renewal date (subs 1, 2, 3, 5, 6, 7, 8); sub 4's cut was made on 12 seats.
insert into public.subscription_seat_reductions
  (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after, effective_date, mrr_before)
  select 'dd261300-0000-4000-8000-00000000a001', ('dd261300-0000-4000-8000-00000000b00' || n)::uuid, 'r2613-cut-' || n,
         'end_of_term', 'scheduled', case n when 4 then 12 else 10 end, 3, case n when 4 then 9 else 7 end, current_date + 5, 3000
    from unnest(array[1, 2, 3, 4, 5, 6, 7, 8]) n;

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, seats, status, payment_status, line_items, is_renewal, extension_months, renewal_subscription_id, renewal_term_date)
  values ('Q-R2613-OLD', 'dd261300-0000-4000-8000-00000000a001', 'dd261300-0000-4000-8000-00000000c002', 'R2613 Cust 2',
          42480, 36000, 10, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12,
          'dd261300-0000-4000-8000-00000000b002', current_date + 5);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, seats, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2613-EXT10', 'dd261300-0000-4000-8000-00000000a001', 'dd261300-0000-4000-8000-00000000c003', 'R2613 Cust 3',
          42480, 36000, 10, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter · 1-year extension","qty":10,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2613-EXT7', 'dd261300-0000-4000-8000-00000000a001', 'dd261300-0000-4000-8000-00000000c003', 'R2613 Cust 3',
          29736, 25200, 7, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter · 1-year extension","qty":7,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2613-EXT4', 'dd261300-0000-4000-8000-00000000a001', 'dd261300-0000-4000-8000-00000000c004', 'R2613 Cust 4',
          42480, 36000, 10, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter · 1-year extension","qty":10,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2613-PLAN', 'dd261300-0000-4000-8000-00000000a001', 'dd261300-0000-4000-8000-00000000c005', 'R2613 Cust 5',
          11800, 10000, 10, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Standard","qty":10,"rate":1000,"cost":0,"plan_change":{"from":"Starter"}}]'::jsonb, true, 0);

-- Subs d1..d3 (cases 9, 9b, 10): d1/d2 have a REMOVED 10 → 7 cut; d3 a scheduled one with its 7-seat quote linked.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months, renewal_date, renewal_state)
  select ('dd261300-0000-4000-8000-00000000d00' || n)::uuid, 'dd261300-0000-4000-8000-00000000a001',
         'dd261300-0000-4000-8000-00000000c001', 'R2613 Cust 1',
         'Google Workspace Business Starter', 'google', 10, 3000, 'active', 12, current_date + 5, 'reminder_1'
    from generate_series(1, 3) n;
insert into public.subscription_seat_reductions
  (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after, effective_date, mrr_before)
  select 'dd261300-0000-4000-8000-00000000a001', ('dd261300-0000-4000-8000-00000000d00' || n)::uuid, 'r2613-cut-d' || n,
         'end_of_term', case n when 3 then 'scheduled' else 'cancelled' end, 10, 3, 7, current_date + 5, 3000
    from generate_series(1, 3) n;
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, seats, status, payment_status, line_items, is_renewal, extension_months)
  values ('Q-R2613-D2', 'dd261300-0000-4000-8000-00000000a001', 'dd261300-0000-4000-8000-00000000c001', 'R2613 Cust 1',
          29736, 25200, 7, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter · 1-year extension","qty":7,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12),
         ('Q-R2613-D3', 'dd261300-0000-4000-8000-00000000a001', 'dd261300-0000-4000-8000-00000000c001', 'R2613 Cust 1',
          29736, 25200, 7, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":7,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb, true, 12);
-- d3's cut-seat quote was linked while the cut stood (an insert, so no link trigger runs).
update public.subscriptions set renewal_quote_id = 'Q-R2613-D3' where id = 'dd261300-0000-4000-8000-00000000d003';

create temp table r2613_fail (msg text) on commit drop;

do $$
declare v_msg text; v_r jsonb; v_link text; v_status text; v_eff date; v_n int;
  v_q10 jsonb := '{"plan":"Google Workspace Business Starter","seats":10,"amount":42480,"subtotal":36000,"tax_rate":18,"extension_months":12,
                   "line_items":[{"name":"Google Workspace Business Starter","qty":10,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]}';
  v_q7 jsonb := '{"plan":"Google Workspace Business Starter","seats":7,"amount":29736,"subtotal":25200,"tax_rate":18,"extension_months":12,
                  "line_items":[{"name":"Google Workspace Business Starter","qty":7,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]}';
begin
  -- 1. priced at 10 seats, cut to 7 saved meanwhile → refused, nothing stored.
  begin
    v_r := public.create_renewal_quote('dd261300-0000-4000-8000-00000000b001', 'dd261300-0000-4000-8000-00000000a001', v_q10);
  exception when others then v_msg := sqlerrm; end;
  select count(*) into v_n from public.quotes where renewal_subscription_id = 'dd261300-0000-4000-8000-00000000b001';
  if v_msg is null or v_msg not like 'A seat cut to 7 seats was scheduled for % while this renewal quote was being made for 10 seats%' or v_n <> 0 then
    insert into r2613_fail values ('1: full-seat renewal quote after a cut: ' || coalesce(v_msg, 'made ' || v_r::text) || ' (quotes stored ' || v_n || ')');
  end if;

  -- 1b. the retry at the cut's seats → made and linked.
  v_msg := null; v_r := null;
  begin
    v_r := public.create_renewal_quote('dd261300-0000-4000-8000-00000000b001', 'dd261300-0000-4000-8000-00000000a001', v_q7);
  exception when others then v_msg := sqlerrm; end;
  select renewal_quote_id into v_link from public.subscriptions where id = 'dd261300-0000-4000-8000-00000000b001';
  if v_msg is not null or (v_r->>'created')::boolean is not true or v_link is distinct from v_r->>'quote_id' then
    insert into r2613_fail values ('1b: cut-seat renewal quote: ' || coalesce(v_msg, v_r::text));
  end if;

  -- 2. an older same-term quote at 10 seats is not re-linked.
  v_msg := null; v_r := null;
  begin
    v_r := public.create_renewal_quote('dd261300-0000-4000-8000-00000000b002', 'dd261300-0000-4000-8000-00000000a001', v_q7);
  exception when others then v_msg := sqlerrm; end;
  select renewal_quote_id into v_link from public.subscriptions where id = 'dd261300-0000-4000-8000-00000000b002';
  if v_msg is null or v_msg not like 'Renewal quote Q-R2613-OLD for this term is for 10 seats, but a seat cut to 7 seats%' or v_link is not null then
    insert into r2613_fail values ('2: re-link of a full-seat quote: ' || coalesce(v_msg, v_r::text) || ' (link ' || coalesce(v_link, 'none') || ')');
  end if;

  -- 3. a 10-seat extension quote linked by a plain update → refused.
  v_msg := null;
  begin
    update public.subscriptions set renewal_quote_id = 'Q-R2613-EXT10' where id = 'dd261300-0000-4000-8000-00000000b003';
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'A seat cut to 7 seats is scheduled for % — quote Q-R2613-EXT10 is for 10 seats, so it was not linked%' then
    insert into r2613_fail values ('3: full-seat extension link: ' || coalesce(v_msg, 'was linked'));
  end if;

  -- 4. a 7-seat extension quote → linked.
  v_msg := null;
  begin
    update public.subscriptions set renewal_quote_id = 'Q-R2613-EXT7' where id = 'dd261300-0000-4000-8000-00000000b003';
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r2613_fail values ('4: cut-seat extension link refused: ' || v_msg);
  end if;

  -- 5. a cut that no longer applies (made on 12 seats) → a 10-seat quote links.
  v_msg := null;
  begin
    update public.subscriptions set renewal_quote_id = 'Q-R2613-EXT4' where id = 'dd261300-0000-4000-8000-00000000b004';
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r2613_fail values ('5: link refused for a cut that no longer applies: ' || v_msg);
  end if;

  -- 5b. a plan-change quote is not a renewal → links.
  v_msg := null;
  begin
    update public.subscriptions set renewal_quote_id = 'Q-R2613-PLAN' where id = 'dd261300-0000-4000-8000-00000000b005';
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r2613_fail values ('5b: plan-change quote link refused: ' || v_msg);
  end if;

  -- 6. date moved earlier, still ahead → the cut moves with it.
  update public.subscriptions set renewal_date = current_date + 2 where id = 'dd261300-0000-4000-8000-00000000b006';
  select status, effective_date into v_status, v_eff from public.subscription_seat_reductions where idempotency_key = 'r2613-cut-6';
  if v_status is distinct from 'scheduled' or v_eff is distinct from current_date + 2 then
    insert into r2613_fail values ('6: date moved earlier left the cut ' || v_status || ' on ' || v_eff || ' (want scheduled on ' || (current_date + 2) || ')');
  end if;

  -- 7. date moved into the past → cancelled.
  update public.subscriptions set renewal_date = current_date - 3 where id = 'dd261300-0000-4000-8000-00000000b007';
  select status into v_status from public.subscription_seat_reductions where idempotency_key = 'r2613-cut-7';
  if v_status is distinct from 'cancelled' then
    insert into r2613_fail values ('7: date moved into the past left the cut ' || v_status || ' (want cancelled)');
  end if;

  -- 7b. date cleared → cancelled.
  update public.subscriptions set renewal_date = null where id = 'dd261300-0000-4000-8000-00000000b008';
  select status into v_status from public.subscription_seat_reductions where idempotency_key = 'r2613-cut-8';
  if v_status is distinct from 'cancelled' then
    insert into r2613_fail values ('7b: date cleared left the cut ' || v_status || ' (want cancelled)');
  end if;

  -- 8. control: no cut → the 10-seat quote is made.
  v_msg := null; v_r := null;
  begin
    v_r := public.create_renewal_quote('dd261300-0000-4000-8000-00000000b009', 'dd261300-0000-4000-8000-00000000a001', v_q10);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null or (v_r->>'created')::boolean is not true then
    insert into r2613_fail values ('8: control renewal quote: ' || coalesce(v_msg, v_r::text));
  end if;

  -- 9. priced with a cut that was removed meanwhile → refused, nothing made.
  v_msg := null; v_r := null;
  begin
    v_r := public.create_renewal_quote('dd261300-0000-4000-8000-00000000d001', 'dd261300-0000-4000-8000-00000000a001', v_q7);
  exception when others then v_msg := sqlerrm; end;
  select count(*) into v_n from public.quotes where renewal_subscription_id = 'dd261300-0000-4000-8000-00000000d001';
  if v_msg is null or v_msg not like 'The seat cut to 7 seats for % was removed while this renewal quote was being made%' or v_n <> 0 then
    insert into r2613_fail values ('9: cut-seat quote after the cut was removed: ' || coalesce(v_msg, 'made ' || v_r::text));
  end if;

  -- 9b. a 7-seat extension quote linked after the cut was removed → refused.
  v_msg := null;
  begin
    update public.subscriptions set renewal_quote_id = 'Q-R2613-D2' where id = 'dd261300-0000-4000-8000-00000000d002';
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like 'Quote Q-R2613-D2 is for 7 seats, made with a seat cut that was removed%' then
    insert into r2613_fail values ('9b: cut-seat link after the cut was removed: ' || coalesce(v_msg, 'was linked'));
  end if;

  -- 10. date into the past while the cut-seat renewal quote is linked → refused, cut stays.
  v_msg := null;
  begin
    update public.subscriptions set renewal_date = current_date - 3 where id = 'dd261300-0000-4000-8000-00000000d003';
  exception when others then v_msg := sqlerrm; end;
  select status into v_status from public.subscription_seat_reductions where idempotency_key = 'r2613-cut-d3';
  if v_msg is null or v_msg not like 'Renewal quote Q-R2613-D3 is made with the seat cut scheduled for %' or v_status <> 'scheduled' then
    insert into r2613_fail values ('10: date into the past with a cut-seat quote linked: ' || coalesce(v_msg, 'saved') || ' (cut ' || v_status || ')');
  end if;

  -- 10b. earlier but still ahead → saved, the cut moves with it.
  v_msg := null;
  begin
    update public.subscriptions set renewal_date = current_date + 1 where id = 'dd261300-0000-4000-8000-00000000d003';
  exception when others then v_msg := sqlerrm; end;
  select status, effective_date into v_status, v_eff from public.subscription_seat_reductions where idempotency_key = 'r2613-cut-d3';
  if v_msg is not null or v_status <> 'scheduled' or v_eff is distinct from current_date + 1 then
    insert into r2613_fail values ('10b: date moved earlier with a cut-seat quote linked: ' || coalesce(v_msg, v_status || ' on ' || v_eff));
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2613_fail;
  if v_list is not null then
    raise exception E'FAIL r2613_seat_cut_quote_link_race:\n  %', v_list;
  end if;
  raise notice 'PASS r2613_seat_cut_quote_link_race';
end $$;

rollback;
