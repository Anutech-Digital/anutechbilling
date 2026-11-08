-- R-2589 (8 Nov 2026, independent review of R-2227 = BLOCK): a plan-change quote must not put back
-- seats that Reduce seats already credited.
--
-- The double credit, in the owner's order:
--   Business Starter 10 seats, paid + invoiced → "Change plan" drafts a quote for Standard at 10
--   seats (linked through renewal_quote_id) → Manage seats → Reduce seats NOW to 7 (credit note for
--   the 3 seats' unused value, R-2252) → the plan-change quote is paid → record_payment set seats
--   back to 10. The 3 seats were credited AND are back on the subscription.
--
-- Migration 20261108051500_r2589_plan_change_seat_guard fixes both sides:
--   A. reduce_subscription_seats refuses while a plan-change quote is open for the subscription
--      (the message names the quote) — nothing booked, no credit note, seats stay 10.
--   B. record_payment refuses a plan-change quote whose subscription no longer has the seats /
--      monthly amount / plan it was priced on (plan_change.from_seats / from_mrr / from_plan) —
--      nothing recorded, the subscription unchanged. A quote with no from_seats (made before this
--      check) is refused the same way: make a new plan-change quote.
--   C. Control: the same quote with matching from_* is paid → the plan changes (Standard, 10 seats).
--
-- Before the migration: A's seat cut goes through, the quote is then paid and seats go back to 10
-- → FAIL A1/A2. B's quote is paid → FAIL B.
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

insert into auth.users (id, email) values ('e2589000-0000-4000-8000-0000000000a2', 'r2589-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e2589000-0000-0000-0000-0000000000a0', 'R2589 Co', 'r2589@example.in', '07', 'R2589');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2589000-0000-4000-8000-0000000000a2', 'e2589000-0000-0000-0000-0000000000a0', 'r2589-owner@example.in', 'R2589 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2589000-0000-4000-8000-0000000000c1', 'e2589000-0000-0000-0000-0000000000a0', 'R2589 Seat Co', '07', 'India');
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('GW-STD-r2589', 'e2589000-0000-0000-0000-0000000000a0', 'R2589 Business Standard', 'google', 864, 720, 'subscription',
   '{"annual":{"msrp":864,"wholesale":720}}');

-- Two sales of Business Starter, 10 seats × ₹1,800/yr = ₹18,000 + 18% = ₹21,240, paid + invoiced.
insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle,
                           status, payment_status, line_items)
select 'TESTQ-R2589-' || k, 'e2589000-0000-0000-0000-0000000000a0', 'e2589000-0000-4000-8000-0000000000c1', 'R2589 Seat Co',
       18, 21240, 18000, 'yearly', 'accepted', 'awaiting',
       '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"}]'::jsonb
  from unnest(array['A', 'B']) k;

create temp table r2589_fail (msg text) on commit drop;
grant all on r2589_fail to authenticated, service_role;
create temp table r2589_ids (k text primary key, v text) on commit drop;
grant all on r2589_ids to authenticated, service_role;

do $$
declare v_inv text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2589000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  perform public.record_payment('TESTQ-R2589-A', 21240, 'bank_transfer', 'R2589-UTR-A');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2589-A');
  insert into r2589_ids values ('inv_a', v_inv);
  perform public.record_payment('TESTQ-R2589-B', 21240, 'bank_transfer', 'R2589-UTR-B');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2589-B');
  insert into r2589_ids values ('inv_b', v_inv);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

insert into r2589_ids
select 'sub_' || lower(substring(s.quote_id from 13)), s.id::text
  from public.subscriptions s where s.quote_id like 'TESTQ-R2589-%';

-- The plan-change quotes, as Change plan writes them (from_* = the subscription when the draft was made).
do $$
declare v_sub record; v_k text; v_from jsonb;
begin
  foreach v_k in array array['a', 'b', 'legacy'] loop
    select id, seats, mrr, plan into v_sub from public.subscriptions
     where id = (select v::uuid from r2589_ids where r2589_ids.k = 'sub_' || case when v_k = 'legacy' then 'b' else v_k end);
    if v_sub.seats <> 10 or v_sub.mrr <> 1500 then raise exception 'SETUP: subscription % has % seats / mrr %', v_k, v_sub.seats, v_sub.mrr; end if;
    v_from := case when v_k = 'legacy' then '{}'::jsonb
                   else jsonb_build_object('from_seats', v_sub.seats, 'from_mrr', v_sub.mrr, 'from_plan', v_sub.plan) end;
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                               line_items, is_renewal, extension_months, billing_cycle)
    values ('Q-R2589-PC-' || upper(v_k), 'e2589000-0000-0000-0000-0000000000a0', 'e2589000-0000-4000-8000-0000000000c1', 'R2589 Seat Co',
            11800, 10000, 18, 'draft', 'awaiting',
            jsonb_build_array(jsonb_build_object(
              'id', 'plan-change-1', 'item_id', 'GW-STD-r2589', 'name', 'R2589 Business Standard · change', 'qty', 1,
              'rate', 10000, 'cost', 0, 'commitment', 'annual_yearly',
              'plan_change', jsonb_build_object('subscription_id', v_sub.id, 'to_item_id', 'GW-STD-r2589',
                                                'seats', 10, 'new_mrr', 7200, 'cost_per_seat_month', 720) || v_from)),
            true, 0, 'yearly');
  end loop;
  update public.subscriptions set renewal_quote_id = 'Q-R2589-PC-A' where id = (select v::uuid from r2589_ids where k = 'sub_a');
  update public.subscriptions set renewal_quote_id = 'Q-R2589-PC-B' where id = (select v::uuid from r2589_ids where k = 'sub_b');
end $$;

do $$
declare
  v_msg text; v_r jsonb; v_sub record; v_n int;
  c_t constant uuid := 'e2589000-0000-0000-0000-0000000000a0';
  c_a constant uuid := 'e2589000-0000-4000-8000-0000000000a2';
  v_sub_a uuid := (select v::uuid from r2589_ids where k = 'sub_a');
  v_sub_b uuid := (select v::uuid from r2589_ids where k = 'sub_b');
begin
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- A. the owner's order: Reduce seats NOW 10 → 7 while the plan-change quote is open.
  begin
    v_r := public.reduce_subscription_seats(c_t, v_sub_a, 3, 'now', 6000, 1050, 'r2589-key-a-1', c_a, 10);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2589_fail values ('A1: Reduce seats went through while plan-change quote Q-R2589-PC-A is open');
  elsif v_msg not like '%Q-R2589-PC-A%' then
    insert into r2589_fail values ('A1: the refusal does not name the quote: ' || v_msg);
  end if;
  select count(*) into v_n from public.credit_notes where invoice_id = (select v from r2589_ids where k = 'inv_a');
  if v_n <> 0 then insert into r2589_fail values ('A1: ' || v_n || ' credit note(s) booked for the refused cut'); end if;

  -- … the quote is then paid. Seats may only be 10 here if no seat was credited.
  v_msg := null;
  begin
    perform public.record_payment('Q-R2589-PC-A', 11800, 'bank_transfer', 'r2589-pc-a');
  exception when others then v_msg := sqlerrm; end;
  select seats, mrr, plan, renewal_quote_id into v_sub from public.subscriptions where id = v_sub_a;
  select count(*) into v_n from public.credit_notes where invoice_id = (select v from r2589_ids where k = 'inv_a');
  if v_msg is null and v_n > 0 and v_sub.seats = 10 then
    insert into r2589_fail values ('A2: DOUBLE CREDIT — 3 seats credited (' || v_n || ' credit note) and the paid quote put seats back to 10');
  end if;
  -- C. control: with the cut refused, the quote matches the subscription and is paid → Standard, 10 seats.
  if v_msg is not null then
    insert into r2589_fail values ('C: a plan-change quote that still matches its subscription was refused: ' || v_msg);
  elsif v_sub.plan <> 'R2589 Business Standard' or v_sub.seats <> 10 or v_sub.mrr <> 7200 or v_sub.renewal_quote_id is not null then
    insert into r2589_fail values ('C: after payment ' || to_jsonb(v_sub)::text || ' (want Standard / 10 / 7200 / unlinked)');
  end if;

  -- B. the subscription changed after the draft (here: a seat cut made another way, 10 → 7).
  update public.subscriptions set seats = 7, mrr = 1050 where id = v_sub_b;
  v_msg := null;
  begin
    perform public.record_payment('Q-R2589-PC-B', 11800, 'bank_transfer', 'r2589-pc-b');
  exception when others then v_msg := sqlerrm; end;
  select seats, mrr, plan into v_sub from public.subscriptions where id = v_sub_b;
  if v_msg is null then
    insert into r2589_fail values ('B: a plan-change quote priced at 10 seats was paid on a 7-seat subscription → seats ' || v_sub.seats);
  elsif v_msg not like '%changed since this quote%' then
    insert into r2589_fail values ('B: refusal message: ' || v_msg);
  end if;
  if v_sub.seats <> 7 or v_sub.mrr <> 1050 then insert into r2589_fail values ('B: subscription changed to ' || to_jsonb(v_sub)::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R2589-PC-B';
  if v_n <> 0 then insert into r2589_fail values ('B: ' || v_n || ' payment(s) recorded on the refused quote'); end if;

  -- D. a plan-change quote with no from_seats (made before R-2589) → refused, make a new one.
  update public.subscriptions set seats = 10, mrr = 1500, renewal_quote_id = 'Q-R2589-PC-LEGACY' where id = v_sub_b;
  v_msg := null;
  begin
    perform public.record_payment('Q-R2589-PC-LEGACY', 11800, 'bank_transfer', 'r2589-pc-legacy');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2589_fail values ('D: a plan-change quote without from_seats was paid');
  elsif v_msg not like '%plan-change quote%' then
    insert into r2589_fail values ('D: refusal message: ' || v_msg);
  end if;

  -- E. no plan-change quote open → Reduce seats still works (sub A is now Standard, 10 seats, unlinked).
  begin
    v_r := public.reduce_subscription_seats(c_t, v_sub_a, 1, 'end_of_term', 0, 0, 'r2589-key-a-2', c_a, 10);
  exception when others then
    insert into r2589_fail values ('E: Reduce seats refused with no plan-change quote open: ' || sqlerrm);
  end;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2589_fail;
  if v_list is not null then
    raise exception E'FAIL r2589_plan_change_seat_guard:\n  %', v_list;
  end if;
  raise notice 'PASS r2589_plan_change_seat_guard';
end $$;

rollback;
