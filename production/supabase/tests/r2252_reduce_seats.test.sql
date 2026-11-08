-- R-2252 (Zoho Billing audit A17): Reduce seats in Manage seats, with the credit shown — and the
-- server books the SAME split as the preview (R-2255 splitChangeCredit): the unused value first
-- lowers what the part's invoice still asks for, the rest is credit only up to money received.
-- Migration 20261108013626_r2252_reduce_subscription_seats.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- 10 seats × ₹1,800/seat/year = ₹18,000 + 18% = ₹21,240, yearly. Unused value of 2 seats = ₹4,000
-- (the route works it out with Add seats' pricing; here it is given).
--   A. PAID invoice, now: one credit note ₹4,000, all of it the customer's credit; seats 10 → 8,
--      mrr 1,500 → 1,200; the row says lower 0 / credit 4,000.
--   B. the same key again → the first answer, replayed, still ONE credit note.
--   C. UNPAID invoice (₹1,000 received, ₹20,240 open): credit note ₹4,000 that only LOWERS the open
--      amount — no customer credit (Zoho's mistake: crediting money never received).
--   D. part paid where the open part is smaller than the unused value: open first, then credit from
--      money received only.
--   E. end of term → scheduled row, seats and money untouched; another cut while one is scheduled
--      is refused.
--   F. refused: a signed-in user calling it directly (server-only), removing every seat, an unused
--      value above what the seats cost for the whole term, no tax invoice for the part.

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

insert into auth.users (id, email) values ('e2252000-0000-4000-8000-0000000000a2', 'r2252-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e2252000-0000-0000-0000-0000000000a0', 'R2252 Co', 'r2252@example.in', '07', 'R2252');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2252000-0000-4000-8000-0000000000a2', 'e2252000-0000-0000-0000-0000000000a0', 'r2252-owner@example.in', 'R2252 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2252000-0000-4000-8000-0000000000c1', 'e2252000-0000-0000-0000-0000000000a0', 'R2252 Seat Co', '07', 'India');

insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle,
                           status, payment_status, line_items)
select 'TESTQ-R2252-' || k, 'e2252000-0000-0000-0000-0000000000a0', 'e2252000-0000-4000-8000-0000000000c1', 'R2252 Seat Co',
       18, 21240, 18000, 'yearly', 'accepted', 'awaiting',
       '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"}]'::jsonb
  from unnest(array['PAID', 'OPEN', 'PART']) k;

create temp table r2252_fail (msg text) on commit drop;
grant all on r2252_fail to authenticated, service_role;
create temp table r2252_ids (k text primary key, v text) on commit drop;
grant all on r2252_ids to authenticated, service_role;

-- Receipts + invoices (Record payment, then the tax invoice), as the owner.
do $$
declare v_inv text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2252000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  perform public.record_payment('TESTQ-R2252-PAID', 21240, 'bank_transfer', 'R2252-UTR-1');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2252-PAID');
  insert into r2252_ids values ('inv_paid', v_inv);
  perform public.record_payment('TESTQ-R2252-OPEN', 1000, 'bank_transfer', 'R2252-UTR-2');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2252-OPEN');
  insert into r2252_ids values ('inv_open', v_inv);
  perform public.record_payment('TESTQ-R2252-PART', 18240, 'bank_transfer', 'R2252-UTR-3');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2252-PART');
  insert into r2252_ids values ('inv_part', v_inv);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

insert into r2252_ids
select 'sub_' || lower(substring(s.quote_id from 13)), s.id::text
  from public.subscriptions s where s.quote_id like 'TESTQ-R2252-%';

-- SETUP
do $$
declare v_n int; v_sub record;
begin
  select count(*) into v_n from r2252_ids where k like 'sub_%';
  if v_n <> 3 then raise exception 'SETUP: % subscriptions from the three quotes (want 3)', v_n; end if;
  select seats, mrr, status::text as status into v_sub from public.subscriptions where id = (select v::uuid from r2252_ids where k = 'sub_paid');
  if v_sub.seats <> 10 or v_sub.mrr <> 1500 or v_sub.status <> 'active' then
    raise exception 'SETUP: paid subscription %', to_jsonb(v_sub);
  end if;
  if (select status::text from public.invoices where id = (select v from r2252_ids where k = 'inv_paid')) <> 'paid' then
    raise exception 'SETUP: the paid quote''s invoice is not Paid';
  end if;
  if (select status::text from public.invoices where id = (select v from r2252_ids where k = 'inv_open')) = 'paid' then
    raise exception 'SETUP: the open quote''s invoice is Paid';
  end if;
end $$;

-- F1. a signed-in user cannot call it (server-only — the route checks role + company).
do $$
declare v_msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2252000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    perform public.reduce_subscription_seats('e2252000-0000-0000-0000-0000000000a0', (select v::uuid from r2252_ids where k = 'sub_paid'),
      2, 'now', 4000, 1200, 'r2252-key-direct', 'e2252000-0000-4000-8000-0000000000a2');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then insert into r2252_fail values ('F1: a signed-in user ran reduce_subscription_seats directly'); end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- A/B/C/D/E/F as the server.
do $$
declare
  v_r jsonb; v_r2 jsonb; v_sub record; v_inv record; v_cn record; v_msg text; v_credit int; v_n int;
  c_t constant uuid := 'e2252000-0000-0000-0000-0000000000a0';
  c_a constant uuid := 'e2252000-0000-4000-8000-0000000000a2';
begin
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- A. paid invoice, now.
  v_r := public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_paid'), 2, 'now', 4000, 1200, 'r2252-key-paid-1', c_a);
  select seats, mrr into v_sub from public.subscriptions where id = (select v::uuid from r2252_ids where k = 'sub_paid');
  if v_sub.seats <> 8 or v_sub.mrr <> 1200 then
    insert into r2252_fail values ('A: seats/mrr after the cut ' || to_jsonb(v_sub) || ' (want 8 / 1200)');
  end if;
  select count(*), coalesce(sum(amount), 0) into v_cn from public.credit_notes where invoice_id = (select v from r2252_ids where k = 'inv_paid');
  if v_cn.count <> 1 or v_cn.coalesce <> 4000 then
    insert into r2252_fail values ('A: credit notes on the paid invoice ' || to_jsonb(v_cn) || ' (want one, ₹4,000)');
  end if;
  select coalesce(sum(amount), 0) into v_credit from public.customer_credits
   where source = 'credit_note' and source_invoice_id = (select v from r2252_ids where k = 'inv_paid');
  if v_credit <> 4000 then insert into r2252_fail values ('A: customer credit ₹' || v_credit || ' (want ₹4,000 — the invoice was paid)'); end if;
  if (v_r->>'lower_open_amount')::int <> 0 or (v_r->>'credit_amount')::int <> 4000 or (v_r->>'not_given_amount')::int <> 0
     or v_r->>'status' <> 'done' or v_r->>'credit_note_id' is null then
    insert into r2252_fail values ('A: result ' || v_r::text);
  end if;

  -- B. replay.
  v_r2 := public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_paid'), 2, 'now', 4000, 1200, 'r2252-key-paid-1', c_a);
  if (v_r2->>'replayed')::boolean is not true or v_r2->>'credit_note_id' <> v_r->>'credit_note_id' then
    insert into r2252_fail values ('B: replay gave ' || v_r2::text);
  end if;
  select count(*) into v_n from public.credit_notes where invoice_id = (select v from r2252_ids where k = 'inv_paid');
  if v_n <> 1 then insert into r2252_fail values ('B: ' || v_n || ' credit notes after the replay (want 1)'); end if;
  if (select seats from public.subscriptions where id = (select v::uuid from r2252_ids where k = 'sub_paid')) <> 8 then
    insert into r2252_fail values ('B: the replay cut the seats again');
  end if;

  -- C. unpaid invoice: the unused value only lowers what they owe.
  select coalesce(net_payable, amount) - paid_amount as open into v_inv from public.invoices where id = (select v from r2252_ids where k = 'inv_open');
  v_r := public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_open'), 2, 'now', 4000, 1200, 'r2252-key-open-1', c_a);
  if (v_r->>'lower_open_amount')::int <> 4000 or (v_r->>'credit_amount')::int <> 0 then
    insert into r2252_fail values ('C: result ' || v_r::text || ' (want lower 4,000, credit 0)');
  end if;
  select coalesce(sum(amount), 0) into v_credit from public.customer_credits
   where source = 'credit_note' and source_invoice_id = (select v from r2252_ids where k = 'inv_open');
  if v_credit <> 0 then insert into r2252_fail values ('C: customer credit ₹' || v_credit || ' on an unpaid invoice (want 0 — money never received)'); end if;
  if (select coalesce(net_payable, amount) - paid_amount from public.invoices where id = (select v from r2252_ids where k = 'inv_open')) <> v_inv.open - 4000 then
    insert into r2252_fail values ('C: the open amount did not drop by ₹4,000');
  end if;

  -- D. part paid: ₹3,000 open, ₹4,000 unused → lower 3,000, credit 1,000 (from money received).
  v_r := public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_part'), 2, 'now', 4000, 1200, 'r2252-key-part-1', c_a);
  if (v_r->>'lower_open_amount')::int <> 3000 or (v_r->>'credit_amount')::int <> 1000 or (v_r->>'not_given_amount')::int <> 0 then
    insert into r2252_fail values ('D: result ' || v_r::text || ' (want lower 3,000, credit 1,000)');
  end if;
  select coalesce(sum(amount), 0) into v_credit from public.customer_credits
   where source = 'credit_note' and source_invoice_id = (select v from r2252_ids where k = 'inv_part');
  if v_credit <> 1000 then insert into r2252_fail values ('D: customer credit ₹' || v_credit || ' (want ₹1,000)'); end if;

  -- E. end of term: scheduled, nothing else.
  v_r := public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_paid'), 3, 'end_of_term', 0, 0, 'r2252-key-eot-1', c_a);
  if v_r->>'status' <> 'scheduled' or (v_r->>'seats_after')::int <> 5
     or (v_r->>'effective_date')::date is distinct from (select renewal_date from public.subscriptions where id = (select v::uuid from r2252_ids where k = 'sub_paid')) then
    insert into r2252_fail values ('E: scheduled row ' || v_r::text);
  end if;
  if (select seats from public.subscriptions where id = (select v::uuid from r2252_ids where k = 'sub_paid')) <> 8 then
    insert into r2252_fail values ('E: end of term changed the seats now');
  end if;
  v_msg := null;
  begin
    perform public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_paid'), 1, 'now', 500, 1050, 'r2252-key-eot-2', c_a);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%already scheduled%' then
    insert into r2252_fail values ('E: a cut while one is scheduled was not refused: ' || coalesce(v_msg, 'ran'));
  end if;

  -- F2. every seat.
  v_msg := null;
  begin
    perform public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_open'), 8, 'now', 0, 0, 'r2252-key-all-1', c_a);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%At least 1 seat must stay%' then
    insert into r2252_fail values ('F2: removing every seat not refused: ' || coalesce(v_msg, 'ran'));
  end if;

  -- F3. unused value above the seats' whole-term cost (1 seat × 1,800 × 1.18 ≈ 2,124).
  v_msg := null;
  begin
    perform public.reduce_subscription_seats(c_t, (select v::uuid from r2252_ids where k = 'sub_open'), 1, 'now', 99999, 1050, 'r2252-key-cap-1', c_a);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%more than the removed seats cost%' then
    insert into r2252_fail values ('F3: an inflated unused value was not refused: ' || coalesce(v_msg, 'ran'));
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- F4. no tax invoice for the part → refused (no invoice to credit).
do $$
declare v_sub uuid; v_msg text;
begin
  insert into public.subscriptions (tenant_id, customer_name, plan, vendor, seats, mrr, domain, start_date, renewal_date, billing_cycle, term_months)
  values ('e2252000-0000-0000-0000-0000000000a0', 'R2252 Seat Co', 'Google Workspace Business Starter', 'google', 5, 750, 'r2252-noinv.in',
          public.ist_today() - 30, public.ist_today() + 335, 'yearly', 12)
  returning id into v_sub;
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  begin
    perform public.reduce_subscription_seats('e2252000-0000-0000-0000-0000000000a0', v_sub, 1, 'now', 1500, 600, 'r2252-key-noinv-1', 'e2252000-0000-4000-8000-0000000000a2');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%no tax invoice%' then
    insert into r2252_fail values ('F4: a cut with no invoice to credit was not refused: ' || coalesce(v_msg, 'ran'));
  end if;
  if (select seats from public.subscriptions where id = v_sub) <> 5 then
    insert into r2252_fail values ('F4: the refused cut still changed the seats');
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- G. grants: server-only function, read-only table.
do $$
begin
  if has_function_privilege('authenticated', 'public.reduce_subscription_seats(uuid,uuid,integer,text,integer,integer,text,uuid)', 'execute')
     or has_function_privilege('anon', 'public.reduce_subscription_seats(uuid,uuid,integer,text,integer,integer,text,uuid)', 'execute') then
    insert into r2252_fail values ('G: reduce_subscription_seats is executable by anon/authenticated');
  end if;
  if has_table_privilege('authenticated', 'public.subscription_seat_reductions', 'insert')
     or has_table_privilege('anon', 'public.subscription_seat_reductions', 'select') then
    insert into r2252_fail values ('G: subscription_seat_reductions is writable by authenticated or readable by anon');
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2252_fail;
  if v_list is not null then
    raise exception E'FAIL r2252_reduce_seats:\n  %', v_list;
  end if;
  raise notice 'PASS r2252_reduce_seats';
end $$;

rollback;
