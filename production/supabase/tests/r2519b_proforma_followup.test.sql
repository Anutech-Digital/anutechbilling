-- R-2519 follow-up (independent review v9, 6 Nov 2026 — BLOCK). Migration 2026110607xxxx_r2519b_proforma_followup.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
--   J2. A sales user (or any signed-in user) INSERTs a quote that already carries the proforma columns /
--       subscription_billing_id, or a fake "cancelled" row → refused (42501). Before: a sales user set
--       a subscription to 1 seat / ₹1 MRR by inserting such a quote and accepting it.
--   J3. Proforma terms the server did not write (no set_part_request_terms marker) are never applied.
--   M.  Monthly Flexible (BITDECENTRO shape, one month a term): an EARLIER period's proforma cannot be
--       cancelled while a LATER period's proforma is open; cancel the later one first; the freed earlier
--       part is billed again by bill_subscription_instalment on THAT row.
--   N.  Billing ahead makes only a proforma — never a tax invoice for a future period, even for a
--       customer "invoiced on the due date".
--   O.  "Mark rejected" on an accepted proforma whose seats are on the subscription → refused (as Cancel).
--   P.  quote_open_balance of a cancelled quote is 0.

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

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000251951','R2519B Co','r2519b@example.in','07','RB51');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000251951','owner2519b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000251952','sales2519b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000251951','dddddddd-0000-0000-0000-000000251951','owner2519b@example.in','Owner 2519b','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000251952','dddddddd-0000-0000-0000-000000251951','sales2519b@example.in','Sales 2519b','sales', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, country, invoice_parts_on_due_date) values
  ('cccccccc-0000-0000-0000-000000251951','dddddddd-0000-0000-0000-000000251951','Bit 2519b','27','India', false),
  ('cccccccc-0000-0000-0000-000000251952','dddddddd-0000-0000-0000-000000251951','OnDue 2519b','27','India', true);

-- 1: J2/J3/O target; 2: M (monthly flexible, two months); 3: N (on-due customer, part starts in 6 days)
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain)
select ('eeeeeeee-0000-0000-0000-00000025195' || n)::uuid, 'dddddddd-0000-0000-0000-000000251951',
       case n when 3 then 'cccccccc-0000-0000-0000-000000251952' else 'cccccccc-0000-0000-0000-000000251951' end::uuid,
       'Bit 2519b', 'Google Workspace Business Starter', 'google'::vendor,
       17, 5100, 'monthly'::billing_cycle, 1, public.ist_today() - 65, public.ist_today() + 25, 'active', 'b' || n || '.in'
  from generate_series(1, 3) n;

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate) values
  ('bbbbbbbb-0000-0000-0000-000000251951', 'dddddddd-0000-0000-0000-000000251951', 'eeeeeeee-0000-0000-0000-000000251951',
   public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18),
  -- M: month A (earlier) and month B (later), each its own one-month term
  ('bbbbbbbb-0000-0000-0000-00000025195a', 'dddddddd-0000-0000-0000-000000251951', 'eeeeeeee-0000-0000-0000-000000251952',
   public.ist_today() - 35, 1, public.ist_today() - 35, public.ist_today() - 35, public.ist_today() - 5, 5100, 18),
  ('bbbbbbbb-0000-0000-0000-00000025195b', 'dddddddd-0000-0000-0000-000000251951', 'eeeeeeee-0000-0000-0000-000000251952',
   public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18),
  -- N: a future part of an on-due customer
  ('bbbbbbbb-0000-0000-0000-000000251953', 'dddddddd-0000-0000-0000-000000251951', 'eeeeeeee-0000-0000-0000-000000251953',
   public.ist_today() + 6, 1, public.ist_today() + 6, public.ist_today() + 6, public.ist_today() + 36, 5100, 18);

-- J3: a quote with proforma terms written by a trusted path but NOT by set_part_request_terms (no marker).
do $$
declare r jsonb; v_id text; v_s record;
begin
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251951', false);
  v_id := r->>'quote_id';
  update public.quotes set proforma_seats = 1, proforma_seat_rate = 1 where id = v_id;   -- trusted session: guard lets it through
  update public.quotes set status = 'accepted' where id = v_id;
  select s.seats, s.mrr into v_s from public.subscriptions s where s.id = 'eeeeeeee-0000-0000-0000-000000251951';
  if v_s.seats <> 17 or v_s.mrr <> 5100 then
    raise exception 'J3 FAIL: unmarked proforma terms reached the subscription: % seats, mrr %', v_s.seats, v_s.mrr; end if;
  raise notice 'J3 PASS: terms not written by set_part_request_terms are never applied';
  -- O. a properly changed + accepted proforma; Mark rejected is refused
  update public.quotes set status = 'sent', proforma_seats = null, proforma_seat_rate = null where id = v_id;
  perform public.set_part_request_terms(v_id, 18, 300);
  update public.quotes set status = 'accepted' where id = v_id;
  if (select seats from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000251951') <> 18 then
    raise exception 'O SETUP FAIL: marked terms not applied on accept'; end if;
  begin
    update public.quotes set status = 'rejected' where id = v_id;
    raise exception 'O FAIL: Mark rejected kept 18 seats on the subscription with nothing paid';
  exception when invalid_parameter_value then raise notice 'O PASS: %', sqlerrm; end;
end $$;

-- M. monthly Flexible: earlier vs later period
do $$
declare ra jsonb; rb jsonb; r jsonb;
begin
  ra := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025195a', false);
  rb := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025195b', false);
  if ra->>'action' <> 'request' or rb->>'action' <> 'request' then raise exception 'M SETUP FAIL: % / %', ra, rb; end if;
  begin
    perform public.cancel_quote(ra->>'quote_id', 'Earlier month first, test');
    raise exception 'M FAIL: cancelled the earlier month while % (later) is open', rb->>'quote_id';
  exception when invalid_parameter_value then
    if sqlerrm not like '%' || (rb->>'quote_id') || '%' then raise exception 'M FAIL: message does not name the later proforma: %', sqlerrm; end if;
    raise notice 'M PASS (refused): %', sqlerrm;
  end;
  perform public.cancel_quote(rb->>'quote_id', 'Later month first, test');
  perform public.cancel_quote(ra->>'quote_id', 'Then the earlier month');
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025195a', false);
  if r->>'action' <> 'request' or r->>'quote_id' = ra->>'quote_id' then raise exception 'M FAIL: freed earlier month not billed again: %', r; end if;
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-00000025195a') is null then
    raise exception 'M FAIL: re-billed month has no due date'; end if;
  raise notice 'M PASS: earlier month re-billed on its own row as %', r->>'quote_id';
end $$;

-- N. future part of an on-due customer → a proforma, no tax invoice
do $$
declare r jsonb;
begin
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251953', false);
  if r->>'action' <> 'request' then raise exception 'N FAIL: billing ahead gave % (want a proforma only)', r; end if;
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251953') is not null then
    raise exception 'N FAIL: a tax invoice was raised for a future period'; end if;
  raise notice 'N PASS: future period of an on-due customer → proforma %', r->>'quote_id';
end $$;

-- P. a cancelled quote owes nothing
do $$
declare v_id text;
begin
  select q.id into v_id from public.quotes q where q.subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000251953';
  perform public.cancel_quote(v_id, 'Balance check, test');
  if public.quote_open_balance(v_id) <> 0 then raise exception 'P FAIL: cancelled quote still owes %', public.quote_open_balance(v_id); end if;
  raise notice 'P PASS: cancelled → open balance 0';
end $$;

-- J2. as the SALES user, then the OWNER: an INSERT carrying the guarded columns is refused
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251952","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items,
                               subscription_billing_id, proforma_seats, proforma_seat_rate)
    values ('TESTQ-R2519B-FAKE1', 'dddddddd-0000-0000-0000-000000251951', 'cccccccc-0000-0000-0000-000000251951', 'Bit 2519b',
            1, 1, 0, 'sent', '[{"name":"x","qty":1,"rate":1}]'::jsonb,
            'bbbbbbbb-0000-0000-0000-00000025195b', 1, 1);
    raise exception 'J2 FAIL: a sales user inserted a quote with proforma terms on a part';
  exception when insufficient_privilege then raise notice 'J2 PASS (proforma insert refused): %', sqlerrm; end;
  begin
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items,
                               cancelled_at, cancelled_part_billing_id, cancelled_from_status)
    values ('TESTQ-R2519B-FAKE2', 'dddddddd-0000-0000-0000-000000251951', 'cccccccc-0000-0000-0000-000000251951', 'Bit 2519b',
            1, 1, 0, 'rejected', '[{"name":"x","qty":1,"rate":1}]'::jsonb,
            now(), 'bbbbbbbb-0000-0000-0000-00000025195b', 'sent');
    raise exception 'J2 FAIL: a sales user inserted a fake cancelled row';
  exception when insufficient_privilege then raise notice 'J2 PASS (fake cancelled row refused): %', sqlerrm; end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251951","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items,
                               subscription_billing_id)
    values ('TESTQ-R2519B-FAKE3', 'dddddddd-0000-0000-0000-000000251951', 'cccccccc-0000-0000-0000-000000251951', 'Bit 2519b',
            1, 1, 0, 'sent', '[{"name":"x","qty":1,"rate":1}]'::jsonb, 'bbbbbbbb-0000-0000-0000-00000025195b');
    raise exception 'J2 FAIL: an owner inserted a part request by hand';
  exception when insufficient_privilege then raise notice 'J2 PASS (owner hand-made part request refused): %', sqlerrm; end;
  -- an ordinary quote still inserts
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items)
  values ('TESTQ-R2519B-OK', 'dddddddd-0000-0000-0000-000000251951', 'cccccccc-0000-0000-0000-000000251951', 'Bit 2519b',
          1180, 1000, 18, 'draft', '[{"name":"x","qty":1,"rate":1000}]'::jsonb);
  raise notice 'J2 PASS: an ordinary quote still inserts';
end $$;
reset role;

select 'R-2519b proforma follow-up: ALL PASS' as result;

rollback;
