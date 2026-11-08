-- R-2605 (8 Nov 2026, R-2589 follow-ups 2-4; money rule C3): while a plan-change quote is open,
-- the subscription's seats / monthly amount / plan cannot change; a rejected (cancelled) or expired
-- plan-change quote is no longer "open".
--
-- Migration 20261108181100_r2605_plan_change_freeze:
--   A. open plan-change quote linked → a seat change (Add seats writes seats + mrr), Correct details
--      (correct_subscription_data) and a plan change by hand are refused, naming the quote; nothing
--      changes. Dates still change (B).
--   C. control: the quote itself is paid → the new plan and seats land (link cleared in the same update).
--   D. the quote is rejected (Cancel quote) but still linked → Reduce seats NOW goes through, and a seat
--      change too. Before: "Plan change quote … is open" (FAIL D1) / the change went through anyway
--      while open (FAIL A — no guard on Add seats / Correct details).
--   E. expired → not open; a renewal quote (extension_months > 0) → not a plan-change quote.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values ('e2605000-0000-4000-8000-0000000000a2', 'r2605-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e2605000-0000-0000-0000-0000000000a0', 'R2605 Co', 'r2605@example.in', '07', 'R2605');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2605000-0000-4000-8000-0000000000a2', 'e2605000-0000-0000-0000-0000000000a0', 'r2605-owner@example.in', 'R2605 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2605000-0000-4000-8000-0000000000c1', 'e2605000-0000-0000-0000-0000000000a0', 'R2605 Seat Co', '07', 'India');
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('GW-STD-r2605', 'e2605000-0000-0000-0000-0000000000a0', 'R2605 Business Standard', 'google', 864, 720, 'subscription',
   '{"annual":{"msrp":864,"wholesale":720}}');

-- Two sales of Business Starter, 10 seats × ₹1,800/yr = ₹18,000 + 18% = ₹21,240, paid + invoiced.
insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle,
                           status, payment_status, line_items)
select 'TESTQ-R2605-' || k, 'e2605000-0000-0000-0000-0000000000a0', 'e2605000-0000-4000-8000-0000000000c1', 'R2605 Seat Co',
       18, 21240, 18000, 'yearly', 'accepted', 'awaiting',
       '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"}]'::jsonb
  from unnest(array['A', 'D']) k;

create temp table r2605_fail (msg text) on commit drop;
grant all on r2605_fail to authenticated, service_role;
create temp table r2605_ids (k text primary key, v text) on commit drop;
grant all on r2605_ids to authenticated, service_role;

do $$
declare v_inv text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2605000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  perform public.record_payment('TESTQ-R2605-A', 21240, 'bank_transfer', 'R2605-UTR-A');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2605-A');
  perform public.record_payment('TESTQ-R2605-D', 21240, 'bank_transfer', 'R2605-UTR-D');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2605-D');
  insert into r2605_ids values ('inv_d', v_inv);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

insert into r2605_ids
select 'sub_' || lower(substring(s.quote_id from 13)), s.id::text
  from public.subscriptions s where s.quote_id like 'TESTQ-R2605-%';

-- The plan-change quotes, as Change plan writes them; plus a renewal quote (not a plan change).
do $$
declare v_sub record; v_k text;
begin
  foreach v_k in array array['a', 'd'] loop
    select id, seats, mrr, plan into v_sub from public.subscriptions
     where id = (select v::uuid from r2605_ids where r2605_ids.k = 'sub_' || v_k);
    if v_sub.seats <> 10 or v_sub.mrr <> 1500 then raise exception 'SETUP: subscription % has % seats / mrr %', v_k, v_sub.seats, v_sub.mrr; end if;
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                               line_items, is_renewal, extension_months, billing_cycle)
    values ('Q-R2605-PC-' || upper(v_k), 'e2605000-0000-0000-0000-0000000000a0', 'e2605000-0000-4000-8000-0000000000c1', 'R2605 Seat Co',
            11800, 10000, 18, 'sent', 'awaiting',
            jsonb_build_array(jsonb_build_object(
              'id', 'plan-change-1', 'item_id', 'GW-STD-r2605', 'name', 'R2605 Business Standard · change', 'qty', 1,
              'rate', 10000, 'cost', 0, 'commitment', 'annual_yearly',
              'plan_change', jsonb_build_object('subscription_id', v_sub.id, 'to_item_id', 'GW-STD-r2605',
                                                'seats', 10, 'new_mrr', 7200, 'cost_per_seat_month', 720,
                                                'from_seats', v_sub.seats, 'from_mrr', v_sub.mrr, 'from_plan', v_sub.plan))),
            true, 0, 'yearly');
  end loop;
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                             line_items, is_renewal, extension_months, billing_cycle)
  values ('Q-R2605-RENEW', 'e2605000-0000-0000-0000-0000000000a0', 'e2605000-0000-4000-8000-0000000000c1', 'R2605 Seat Co',
          21240, 18000, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"}]'::jsonb,
          true, 12, 'yearly');
  update public.subscriptions set renewal_quote_id = 'Q-R2605-PC-A' where id = (select v::uuid from r2605_ids where k = 'sub_a');
  update public.subscriptions set renewal_quote_id = 'Q-R2605-PC-D' where id = (select v::uuid from r2605_ids where k = 'sub_d');
end $$;

-- A2. Correct details (owner's data correction) while the plan-change quote is open.
do $$
declare v_msg text; v_sub uuid := (select v::uuid from r2605_ids where k = 'sub_a');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2605000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    perform public.correct_subscription_data(v_sub, 12, 1800, 'R2605 record had wrong seats');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2605_fail values ('A2: Correct details changed seats while plan-change quote Q-R2605-PC-A is open');
  elsif v_msg not like '%Q-R2605-PC-A%' then
    insert into r2605_fail values ('A2: refusal does not name the quote: ' || v_msg);
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  v_msg text; v_r jsonb; v_sub record; v_n int;
  c_t constant uuid := 'e2605000-0000-0000-0000-0000000000a0';
  c_a constant uuid := 'e2605000-0000-4000-8000-0000000000a2';
  v_sub_a uuid := (select v::uuid from r2605_ids where k = 'sub_a');
  v_sub_d uuid := (select v::uuid from r2605_ids where k = 'sub_d');
begin
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- A1. Add seats (the app writes seats + mrr) while the plan-change quote is open.
  begin
    update public.subscriptions set seats = 12, mrr = 1800 where id = v_sub_a;
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2605_fail values ('A1: seats changed 10 → 12 while plan-change quote Q-R2605-PC-A is open');
  elsif v_msg not like 'Plan change quote Q-R2605-PC-A is open for this subscription%' then
    insert into r2605_fail values ('A1: refusal message: ' || v_msg);
  end if;
  -- A3. plan changed by hand.
  v_msg := null;
  begin
    update public.subscriptions set plan = 'Something else' where id = v_sub_a;
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then insert into r2605_fail values ('A3: plan changed while plan-change quote is open'); end if;
  select seats, mrr into v_sub from public.subscriptions where id = v_sub_a;
  if v_sub.seats <> 10 or v_sub.mrr <> 1500 then insert into r2605_fail values ('A: subscription changed to ' || to_jsonb(v_sub)::text); end if;

  -- B. other fields are free.
  begin
    update public.subscriptions set domain = 'r2605.example.in' where id = v_sub_a;
  exception when others then insert into r2605_fail values ('B: a domain change was refused: ' || sqlerrm); end;

  -- C. control: the quote itself is paid → Standard, 10 seats, link cleared.
  v_msg := null;
  begin
    perform public.record_payment('Q-R2605-PC-A', 11800, 'bank_transfer', 'r2605-pc-a');
  exception when others then v_msg := sqlerrm; end;
  select seats, mrr, plan, renewal_quote_id into v_sub from public.subscriptions where id = v_sub_a;
  if v_msg is not null then
    insert into r2605_fail values ('C: paying the plan-change quote was refused: ' || v_msg);
  elsif v_sub.plan <> 'R2605 Business Standard' or v_sub.seats <> 10 or v_sub.mrr <> 7200 or v_sub.renewal_quote_id is not null then
    insert into r2605_fail values ('C: after payment ' || to_jsonb(v_sub)::text || ' (want Standard / 10 / 7200 / unlinked)');
  end if;

  -- D. the plan-change quote is cancelled (stored 'rejected') but still linked → not open.
  update public.quotes set status = 'rejected' where id = 'Q-R2605-PC-D';
  if (select renewal_quote_id from public.subscriptions where id = v_sub_d) is not null then
    insert into r2605_fail values ('D0: cancelling the plan-change quote left it linked to the subscription');
  end if;
  -- a row cancelled BEFORE this migration stays linked — it must not block either.
  update public.subscriptions set renewal_quote_id = 'Q-R2605-PC-D' where id = v_sub_d;
  begin
    v_r := public.reduce_subscription_seats(c_t, v_sub_d, 3, 'now', 6000, 1050, 'r2605-key-d-1', c_a, 10);
  exception when others then
    insert into r2605_fail values ('D1: Reduce seats refused with only a CANCELLED plan-change quote linked: ' || sqlerrm);
  end;
  select count(*) into v_n from public.credit_notes where invoice_id = (select v from r2605_ids where k = 'inv_d');
  if v_n <> 1 then insert into r2605_fail values ('D1: ' || v_n || ' credit note(s) for the seat cut (want 1)'); end if;
  begin
    update public.subscriptions set seats = 8, mrr = 1200 where id = v_sub_d;
  exception when others then insert into r2605_fail values ('D2: seat change refused with a cancelled plan-change quote: ' || sqlerrm); end;
  -- … and a cancel undone later: the quote is open again but stale → record_payment refuses it (R-2589).
  update public.quotes set status = 'sent' where id = 'Q-R2605-PC-D';
  v_msg := null;
  begin
    perform public.record_payment('Q-R2605-PC-D', 11800, 'bank_transfer', 'r2605-pc-d');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then insert into r2605_fail values ('D3: a stale plan-change quote was paid after the cancel was undone'); end if;

  -- E. expired by date → not open; expired because combined into another quote → still open;
  --    a renewal quote is not a plan-change quote; another company's quote → null.
  update public.quotes set status = 'expired' where id = 'Q-R2605-PC-D';
  if public.r2605_open_plan_change_quote(c_t, 'Q-R2605-PC-D') is not null then insert into r2605_fail values ('E1: expired quote counted as open'); end if;
  update public.quotes set superseded_by = 'Q-R2605-RENEW' where id = 'Q-R2605-PC-D';
  if public.r2605_open_plan_change_quote(c_t, 'Q-R2605-PC-D') is null then insert into r2605_fail values ('E1b: a plan-change quote combined into another (superseded) counted as closed'); end if;
  if public.r2605_open_plan_change_quote(c_t, 'Q-R2605-RENEW') is not null then insert into r2605_fail values ('E2: renewal quote counted as a plan change'); end if;
  if public.r2605_open_plan_change_quote('e2605000-0000-0000-0000-0000000000ff', 'Q-R2605-PC-D') is not null then insert into r2605_fail values ('E3: other company'); end if;
  update public.subscriptions set renewal_quote_id = 'Q-R2605-RENEW' where id = v_sub_d;
  begin
    update public.subscriptions set mrr = 1150 where id = v_sub_d;
  exception when others then insert into r2605_fail values ('E4: mrr change refused with a renewal quote linked: ' || sqlerrm); end;
end $$;

-- F. a seat change made BY ANOTHER TRIGGER (as tg_quotes_add_seats_take_back does when an unpaid Add
--    seats quote is cancelled) goes through; the plan-change quote is then stale (refused at payment).
create function pg_temp.r2605_take_back() returns trigger language plpgsql as $f$
begin
  update public.subscriptions set seats = seats - 1, mrr = mrr - 150 where renewal_quote_id = 'Q-R2605-PC-F';
  return new;
end $f$;
do $$
declare v_sub uuid := (select v::uuid from r2605_ids where k = 'sub_a');
begin
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                             line_items, is_renewal, extension_months, billing_cycle)
  select 'Q-R2605-PC-F', tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, 'sent', 'awaiting',
         line_items, true, 0, 'yearly'
    from public.quotes where id = 'Q-R2605-PC-A';
  update public.subscriptions set renewal_quote_id = 'Q-R2605-PC-F' where id = v_sub;
end $$;
create trigger zz_r2605_take_back after update of notes on public.quotes
  for each row when (new.id = 'Q-R2605-PC-F') execute function pg_temp.r2605_take_back();
do $$
declare v_before int := (select seats from public.subscriptions where id = (select v::uuid from r2605_ids where k = 'sub_a'));
begin
  begin
    update public.quotes set notes = 'r2605 cascade' where id = 'Q-R2605-PC-F';
  exception when others then insert into r2605_fail values ('F: a seat change made by another trigger was refused: ' || sqlerrm); end;
  if (select seats from public.subscriptions where id = (select v::uuid from r2605_ids where k = 'sub_a')) <> v_before - 1 then
    insert into r2605_fail values ('F: the cascaded seat change did not land');
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2605_fail;
  if v_list is not null then
    raise exception E'FAIL r2605_plan_change_freeze:\n  %', v_list;
  end if;
  raise notice 'PASS r2605_plan_change_freeze';
end $$;

rollback;
