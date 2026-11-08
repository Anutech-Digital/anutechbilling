-- R-2584 (review of R-2252): a seat cut "scheduled" for a date that has already passed (its renewal
-- went by without it being applied) stays status 'scheduled' for ever — and reduce_subscription_seats
-- refused EVERY later cut with "A seat cut is already scheduled". A scheduled row dated before today
-- (IST) must no longer block; one dated today or later still does.
-- Migration 20261108043428_r2584_seat_cut_ignore_past_schedules.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. stale scheduled row (yesterday) → a "now" cut goes through (seats 10 → 8, one credit note).
--   B. scheduled row for a future date → the next cut is still refused ("already scheduled").
--   C. Remove scheduled cut with a stale + a live row → both cancelled (no "more than one row").

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

insert into auth.users (id, email) values ('e2584000-0000-4000-8000-0000000000a2', 'r2584-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e2584000-0000-0000-0000-0000000000a0', 'R2584 Co', 'r2584@example.in', '07', 'R2584');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2584000-0000-4000-8000-0000000000a2', 'e2584000-0000-0000-0000-0000000000a0', 'r2584-owner@example.in', 'R2584 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2584000-0000-4000-8000-0000000000c1', 'e2584000-0000-0000-0000-0000000000a0', 'R2584 Seat Co', '07', 'India');

insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle,
                           status, payment_status, line_items)
values ('TESTQ-R2584-PAID', 'e2584000-0000-0000-0000-0000000000a0', 'e2584000-0000-4000-8000-0000000000c1', 'R2584 Seat Co',
        18, 21240, 18000, 'yearly', 'accepted', 'awaiting',
        '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"}]'::jsonb);

create temp table r2584_fail (msg text) on commit drop;
grant all on r2584_fail to authenticated, service_role;
create temp table r2584_ids (k text primary key, v text) on commit drop;
grant all on r2584_ids to authenticated, service_role;

do $$
declare v_inv text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2584000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  perform public.record_payment('TESTQ-R2584-PAID', 21240, 'bank_transfer', 'R2584-UTR-1');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2584-PAID');
  insert into r2584_ids values ('inv', v_inv);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

insert into r2584_ids select 'sub', s.id::text from public.subscriptions s where s.quote_id = 'TESTQ-R2584-PAID';

do $$
begin
  if (select seats from public.subscriptions where id = (select v::uuid from r2584_ids where k = 'sub')) is distinct from 10 then
    raise exception 'SETUP: the subscription from the paid quote does not have 10 seats';
  end if;
end $$;

-- A stale scheduled cut: its date (yesterday, IST) has passed and nothing applied it.
insert into public.subscription_seat_reductions
  (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after, effective_date)
values ('e2584000-0000-0000-0000-0000000000a0', (select v::uuid from r2584_ids where k = 'sub'), 'r2584-stale-1',
        'end_of_term', 'scheduled', 10, 3, 7, public.ist_today() - 1);

-- A. the stale row does not block a "now" cut.
do $$
declare v_r jsonb; v_msg text; v_n int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  begin
    v_r := public.reduce_subscription_seats('e2584000-0000-0000-0000-0000000000a0', (select v::uuid from r2584_ids where k = 'sub'),
      2, 'now', 4000, 1200, 'r2584-key-now-1', 'e2584000-0000-4000-8000-0000000000a2', 10);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r2584_fail values ('A: a stale (yesterday) scheduled cut still blocked the cut: ' || v_msg);
  elsif v_r->>'status' <> 'done' then
    insert into r2584_fail values ('A: result ' || v_r::text);
  end if;
  if (select seats from public.subscriptions where id = (select v::uuid from r2584_ids where k = 'sub')) is distinct from 8 then
    insert into r2584_fail values ('A: seats after the cut are not 8');
  end if;
  select count(*) into v_n from public.credit_notes where invoice_id = (select v from r2584_ids where k = 'inv');
  if v_n <> 1 then insert into r2584_fail values ('A: ' || v_n || ' credit notes (want 1)'); end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- A cut scheduled for a future date (not yet due).
insert into public.subscription_seat_reductions
  (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after, effective_date)
values ('e2584000-0000-0000-0000-0000000000a0', (select v::uuid from r2584_ids where k = 'sub'), 'r2584-future-1',
        'end_of_term', 'scheduled', 8, 1, 7, public.ist_today() + 30);

-- B. the future-dated row still blocks the next cut.
do $$
declare v_msg text;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  begin
    perform public.reduce_subscription_seats('e2584000-0000-0000-0000-0000000000a0', (select v::uuid from r2584_ids where k = 'sub'),
      1, 'now', 1000, 1050, 'r2584-key-now-2', 'e2584000-0000-4000-8000-0000000000a2', 8);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%already scheduled%' then
    insert into r2584_fail values ('B: a cut while a future one is scheduled was not refused: ' || coalesce(v_msg, 'ran'));
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- C. Remove scheduled cut with a stale AND a live row: both cancelled, the live one is returned
--    (the old "update … returning into" failed with more than one row).
do $$
declare v_r jsonb; v_msg text; v_n int;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  begin
    v_r := public.cancel_scheduled_seat_reduction('e2584000-0000-0000-0000-0000000000a0', (select v::uuid from r2584_ids where k = 'sub'));
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r2584_fail values ('C: Remove scheduled cut failed with a stale + a live row: ' || v_msg);
  elsif v_r->>'idempotency_key' <> 'r2584-future-1' or v_r->>'status' <> 'cancelled' then
    insert into r2584_fail values ('C: cancel returned ' || v_r::text || ' (want the future row, cancelled)');
  end if;
  select count(*) into v_n from public.subscription_seat_reductions
   where subscription_id = (select v::uuid from r2584_ids where k = 'sub') and status = 'scheduled';
  if v_n <> 0 then insert into r2584_fail values ('C: ' || v_n || ' rows still scheduled after Remove (want 0)'); end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2584_fail;
  if v_list is not null then
    raise exception E'FAIL r2584_seat_cut_past_schedule:\n  %', v_list;
  end if;
  raise notice 'PASS r2584_seat_cut_past_schedule';
end $$;

rollback;
