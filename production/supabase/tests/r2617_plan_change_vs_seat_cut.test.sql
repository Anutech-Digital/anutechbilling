-- R-2617 (8 Nov 2026): while an end-of-term seat cut is scheduled for this term, the plan cannot
-- change (record_payment of a plan-change quote / Correct details); the owner removes the cut first.
--
-- Migration 20261108194500_r2617_plan_change_vs_seat_cut:
--   1.  scheduled 10 → 7 cut dated the renewal; the plan (item_id) changes, renewal date stays
--       → refused, names the cut (10 → 7) and the next step; nothing changed.
--   1b. Correct details (correct_subscription_terms) changing the plan → same refusal.
--   2.  a renewal paid with a new plan (item_id changes AND renewal_date moves on) → not this guard
--       (R-2608's trigger owns the cut then).
--   3.  cut cancelled → plan change goes through; cut 'applied' → goes through.
--   3b. a stale cut dated an EARLIER term (R-2584) → does not block.
--   4.  seats / mrr / plan NAME change without item_id → not this guard (R-2605 owns that).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd261700-0000-4000-8000-00000000a001', 'R2617 Tenant', 'r2617@test.invalid', '07');
insert into public.customers (id, tenant_id, name)
  values ('dd261700-0000-4000-8000-00000000c001', 'dd261700-0000-4000-8000-00000000a001', 'R2617 Cust');
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('GW-START-r2617', 'dd261700-0000-4000-8000-00000000a001', 'R2617 Business Starter', 'google', 1800, 1200, 'subscription',
   '{"annual":{"msrp":1800,"wholesale":1200}}'),
  ('GW-STD-r2617', 'dd261700-0000-4000-8000-00000000a001', 'R2617 Business Standard', 'google', 864, 720, 'subscription',
   '{"annual":{"msrp":864,"wholesale":720}}');

-- subs 1..6: Starter, 10 seats, renewal in 5 days.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, item_id, vendor, seats, mrr, status, term_months, renewal_date, renewal_state)
  select ('dd261700-0000-4000-8000-00000000b00' || n)::uuid, 'dd261700-0000-4000-8000-00000000a001',
         'dd261700-0000-4000-8000-00000000c001', 'R2617 Cust',
         'R2617 Business Starter', 'GW-START-r2617', 'google', 10, 1500, 'active', 12, current_date + 5, 'reminder_1'
    from generate_series(1, 6) n;
-- cuts: 1 scheduled (this renewal), 2 scheduled (renewal path), 3 cancelled, 4 applied, 5 scheduled but dated LAST term, 6 none
insert into public.subscription_seat_reductions
  (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after, effective_date, mrr_before)
  select 'dd261700-0000-4000-8000-00000000a001', ('dd261700-0000-4000-8000-00000000b00' || n)::uuid, 'r2617-cut-' || n,
         'end_of_term',
         case n when 3 then 'cancelled' when 4 then 'applied' else 'scheduled' end,
         10, 3, 7,
         case n when 5 then current_date - 360 else current_date + 5 end, 1500
    from generate_series(1, 5) n;

create temp table r2617_fail (msg text) on commit drop;

do $$
declare
  v_msg text; v_sub record;
  c_t constant uuid := 'dd261700-0000-4000-8000-00000000a001';
  v_s1 constant uuid := 'dd261700-0000-4000-8000-00000000b001';
  v_s2 constant uuid := 'dd261700-0000-4000-8000-00000000b002';
  v_s3 constant uuid := 'dd261700-0000-4000-8000-00000000b003';
  v_s4 constant uuid := 'dd261700-0000-4000-8000-00000000b004';
  v_s5 constant uuid := 'dd261700-0000-4000-8000-00000000b005';
begin
  -- 1. plan change applied (what record_payment of a plan-change quote writes) with a scheduled cut.
  begin
    update public.subscriptions
       set item_id = 'GW-STD-r2617', plan = 'R2617 Business Standard', seats = 12, mrr = 8640
     where id = v_s1;
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2617_fail values ('1: plan changed while a 10 → 7 end-of-term cut is scheduled');
  elsif v_msg not like 'R-2617: plan change refused — a seat cut 10 → 7 is scheduled for the end of this term (%). Remove the scheduled seat cut in Manage seats first, then change the plan.' then
    insert into r2617_fail values ('1: refusal message: ' || v_msg);
  end if;
  select item_id, seats, mrr into v_sub from public.subscriptions where id = v_s1;
  if v_sub.item_id <> 'GW-START-r2617' or v_sub.seats <> 10 or v_sub.mrr <> 1500 then
    insert into r2617_fail values ('1: subscription changed to ' || to_jsonb(v_sub)::text);
  end if;

  -- 1b. Correct details changing the plan.
  v_msg := null;
  begin
    perform public.correct_subscription_terms(v_s1, 'GW-STD-r2617', 10, 1500, 'R2617 wrong plan recorded');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2617_fail values ('1b: Correct details changed the plan while a cut is scheduled');
  elsif v_msg not like 'R-2617: plan change refused%' then
    insert into r2617_fail values ('1b: refusal message: ' || v_msg);
  end if;

  -- 2. renewal paid with a new plan: item_id changes AND the renewal date moves on → not this guard.
  begin
    update public.subscriptions
       set item_id = 'GW-STD-r2617', plan = 'R2617 Business Standard', seats = 7, mrr = 5040,
           renewal_date = renewal_date + interval '1 year'
     where id = v_s2;
  exception when others then insert into r2617_fail values ('2: a renewal with a new plan was refused: ' || sqlerrm); end;

  -- 3. cancelled cut → free; applied cut → free.
  begin
    update public.subscriptions set item_id = 'GW-STD-r2617', plan = 'R2617 Business Standard' where id = v_s3;
  exception when others then insert into r2617_fail values ('3: plan change refused with only a CANCELLED cut: ' || sqlerrm); end;
  begin
    update public.subscriptions set item_id = 'GW-STD-r2617', plan = 'R2617 Business Standard' where id = v_s4;
  exception when others then insert into r2617_fail values ('3: plan change refused with only an APPLIED cut: ' || sqlerrm); end;

  -- 3b. stale cut from an earlier term (R-2584) → free.
  begin
    update public.subscriptions set item_id = 'GW-STD-r2617', plan = 'R2617 Business Standard' where id = v_s5;
  exception when others then insert into r2617_fail values ('3b: plan change refused by a stale cut from an earlier term: ' || sqlerrm); end;

  -- 4. seats / mrr / plan name without item_id → not this guard.
  begin
    update public.subscriptions set seats = 12, mrr = 1800, plan = 'R2617 Business Starter (renamed)' where id = v_s1;
  exception when others then insert into r2617_fail values ('4: a seat / name change was refused by the plan-change guard: ' || sqlerrm); end;

  -- 5. once the cut is removed, the plan change on sub 1 goes through.
  update public.subscription_seat_reductions set status = 'cancelled' where subscription_id = v_s1 and tenant_id = c_t;
  begin
    update public.subscriptions set item_id = 'GW-STD-r2617', plan = 'R2617 Business Standard' where id = v_s1;
  exception when others then insert into r2617_fail values ('5: plan change still refused after the cut was removed: ' || sqlerrm); end;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2617_fail;
  if v_list is not null then
    raise exception E'FAIL r2617_plan_change_vs_seat_cut:\n  %', v_list;
  end if;
  raise notice 'PASS r2617_plan_change_vs_seat_cut';
end $$;

rollback;
