\set ON_ERROR_STOP on
-- R-1567 + R-1568 (P1 money, audit 18 Oct 2026): refunding or deleting a payment must keep the
-- customer's advance credit, the TDS receivable and the receipt-voucher series honest.
-- Migration: 20261018164416_r1567_refund_delete_payment_credit.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1567_refund_delete_payment_credit.test.sql
--
-- Expect "PASS r1567_refund_delete_payment_credit". Every check is collected and listed together.
--
-- R-1567 (refund_payment)
--   R1  A ₹6,000 paid ₹10,000 → ₹4,000 credit; B ₹6,000 = ₹2,000 cash + that ₹4,000 credit.
--       Refund A → REFUSED (the ₹4,000 already paid B; a full refund pays it out twice), with the
--       next step naming quote B.
--   R2  Partly spent: A2's ₹4,000 credit, ₹1,500 of it applied to B2 → refund A2 REFUSED too.
--   R3  Refund B (the payment that USED credit) → B refunded, the ₹4,000 credit is open again
--       (source A), the result's cash amount is ₹2,000. Then refund A is allowed and closes it.
--   R4  Refund a payment with TDS → its tds_receivable row is 'reversed'.
-- R-1568 (delete_payment)
--   D1  F ₹6,000 paid ₹10,000 → ₹4,000 open credit; delete F → no open credit left from F.
--   D2  G's credit used by H → delete G REFUSED ("pehle … hatao"), G still there.
--   D3  Delete H (used ₹4,000 credit) → the credit is open again; then delete G works.
--   D4  Delete a payment with TDS → its tds_receivable row is 'reversed'.
--   D5  The deleted payment's receipt voucher number is kept as a cancelled voucher, and the
--       next receipt voucher is a NEW number.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1567000-0000-4000-8000-0000000000a2', 'r1567-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1567000-0000-0000-0000-0000000000a0', 'R1567 A', 'r1567a@example.in', '07', 'R157');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1567000-0000-4000-8000-0000000000a2', 'e1567000-0000-0000-0000-0000000000a0', 'r1567-owner@example.in', 'R1567 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1567000-0000-4000-8000-0000000000c1', 'e1567000-0000-0000-0000-0000000000a0', 'R1567 Cust', '07', 'India'),
  ('e1567000-0000-4000-8000-0000000000c2', 'e1567000-0000-0000-0000-0000000000a0', 'R1567 Cust Two', '07', 'India'),
  ('e1567000-0000-4000-8000-0000000000c3', 'e1567000-0000-0000-0000-0000000000a0', 'R1567 Cust Three', '07', 'India'),
  ('e1567000-0000-4000-8000-0000000000c4', 'e1567000-0000-0000-0000-0000000000a0', 'R1567 Cust Four', '07', 'India');
-- One-off quotes (no subscription side effects), not invoiced.
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R1567-' || k, 'e1567000-0000-0000-0000-0000000000a0', null, c::uuid,
       'R1567 Cust', amt, round(amt / 1.18), 18, 'accepted', 'awaiting', '[]'::jsonb
  from (values ('A',  6000, 'e1567000-0000-4000-8000-0000000000c1'),
               ('B',  6000, 'e1567000-0000-4000-8000-0000000000c1'),
               ('A2', 6000, 'e1567000-0000-4000-8000-0000000000c2'),
               ('B2', 6000, 'e1567000-0000-4000-8000-0000000000c2'),
               ('E', 10000, 'e1567000-0000-4000-8000-0000000000c2'),
               ('F',  6000, 'e1567000-0000-4000-8000-0000000000c3'),
               ('G',  6000, 'e1567000-0000-4000-8000-0000000000c4'),
               ('H',  6000, 'e1567000-0000-4000-8000-0000000000c4'),
               ('T', 10000, 'e1567000-0000-4000-8000-0000000000c3'),
               ('N',  1000, 'e1567000-0000-4000-8000-0000000000c3')) v(k, amt, c);

create temp table r1567_fail (msg text) on commit drop;
grant all on r1567_fail to authenticated;
create function pg_temp.r1567_open(p_customer uuid) returns integer language sql as $$
  select coalesce(sum(amount), 0)::int from public.customer_credits
   where customer_id = p_customer and status = 'open' $$;
grant execute on function pg_temp.r1567_open(uuid) to authenticated;

do $$
declare
  c1 constant uuid := 'e1567000-0000-4000-8000-0000000000c1';
  c2 constant uuid := 'e1567000-0000-4000-8000-0000000000c2';
  c3 constant uuid := 'e1567000-0000-4000-8000-0000000000c3';
  c4 constant uuid := 'e1567000-0000-4000-8000-0000000000c4';
  v_r jsonb; v_a uuid; v_b uuid; v_a2 uuid; v_b2 uuid; v_e uuid; v_f uuid; v_g uuid; v_h uuid; v_t uuid; v_n uuid;
  v_msg text; v_rv text; v_rv_next text; v_ok boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e1567000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- ════ R1: refund A after its credit paid B ════════════════════════════════════════
  v_r := public.record_desk_payment('Q-R1567-A', 10000, 'bank_transfer', 'R1567-A', null, null, 0, '2026-09-10', null);
  v_a := (v_r->>'payment_id')::uuid;
  v_r := public.record_desk_payment('Q-R1567-B', 2000, 'bank_transfer', 'R1567-B', null, c1, 4000, '2026-10-05', null);
  v_b := (v_r->>'payment_id')::uuid;
  if pg_temp.r1567_open(c1) <> 0 then
    insert into r1567_fail values ('R1 setup: open credit ' || pg_temp.r1567_open(c1) || ' after B (want 0)');
  end if;

  v_msg := null;
  begin
    perform public.refund_payment(v_a, 'Customer ne cancel kiya');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r1567_fail values ('R1: refund of A went through although its ₹4,000 credit already paid quote B (₹4,000 paid out twice)');
  elsif v_msg not like '%Q-R1567-B%' then
    insert into r1567_fail values ('R1: refusal does not name quote B as the next step: ' || v_msg);
  end if;

  -- ════ R2: partly spent credit ═════════════════════════════════════════════════════
  v_r := public.record_desk_payment('Q-R1567-A2', 10000, 'bank_transfer', 'R1567-A2', null, null, 0, '2026-09-11', null);
  v_a2 := (v_r->>'payment_id')::uuid;
  v_r := public.record_desk_payment('Q-R1567-B2', 4500, 'bank_transfer', 'R1567-B2', null, c2, 1500, '2026-10-05', null);
  v_b2 := (v_r->>'payment_id')::uuid;
  if pg_temp.r1567_open(c2) <> 2500 then
    insert into r1567_fail values ('R2 setup: open credit ' || pg_temp.r1567_open(c2) || ' after B2 (want 2500)');
  end if;
  v_msg := null;
  begin
    perform public.refund_payment(v_a2, 'Customer ne cancel kiya');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r1567_fail values ('R2: refund of A2 went through although ₹1,500 of its credit already paid quote B2');
  end if;

  -- ════ R3: refund B (used credit) gives the credit back; then A can be refunded ═══
  v_msg := null;
  begin
    v_r := public.refund_payment(v_b, 'Galat quote par lagaya');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1567_fail values ('R3: refund of B refused: ' || v_msg);
  else
    if (v_r->>'amount')::int is distinct from 2000 then
      insert into r1567_fail values ('R3: refund of B returns cash amount ' || coalesce(v_r->>'amount', 'null') || ' (want 2000 — the ₹4,000 was credit, not cash)');
    end if;
    if pg_temp.r1567_open(c1) <> 4000 then
      insert into r1567_fail values ('R3: after refunding B the customer''s open credit is ' || pg_temp.r1567_open(c1) || ' (want 4000 back)');
    end if;
    v_msg := null;
    begin
      v_r := public.refund_payment(v_a, 'Customer ne cancel kiya');
    exception when others then v_msg := sqlerrm; end;
    if v_msg is not null then
      insert into r1567_fail values ('R3: refund of A refused after B gave the credit back: ' || v_msg);
    elsif pg_temp.r1567_open(c1) <> 0 then
      insert into r1567_fail values ('R3: after refunding A the open credit is ' || pg_temp.r1567_open(c1) || ' (want 0 — the ₹4,000 went back as cash)');
    end if;
  end if;

  -- ════ R4: refund with TDS reverses the TDS receivable ═════════════════════════════
  v_r := public.record_desk_payment('Q-R1567-E', 10000, 'bank_transfer', 'R1567-E', null, null, 0, '2026-10-01', null,
                                    1000, 10000, 9000, '194J', 10, 'ABCD12345E', null, null);
  v_e := (v_r->>'payment_id')::uuid;
  if not exists (select 1 from public.tds_receivable where payment_id = v_e) then
    insert into r1567_fail values ('R4 setup: no TDS receivable for E');
  end if;
  v_msg := null;
  begin
    perform public.refund_payment(v_e, 'Customer ne cancel kiya');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1567_fail values ('R4: refund of E refused: ' || v_msg);
  elsif exists (select 1 from public.tds_receivable where payment_id = v_e and status <> 'reversed') then
    insert into r1567_fail values ('R4: TDS receivable of the refunded payment is still ' ||
      (select string_agg(status, ',') from public.tds_receivable where payment_id = v_e) || ' (want reversed)');
  end if;

  -- ════ D1: delete an overpayment → its open credit goes ═════════════════════════════
  v_r := public.record_desk_payment('Q-R1567-F', 10000, 'bank_transfer', 'R1567-F', null, null, 0, '2026-09-12', null);
  v_f := (v_r->>'payment_id')::uuid;
  v_rv := v_r->>'receipt_voucher_no';
  if pg_temp.r1567_open(c3) <> 4000 then
    insert into r1567_fail values ('D1 setup: open credit ' || pg_temp.r1567_open(c3) || ' after F (want 4000)');
  end if;
  v_msg := null;
  begin
    perform public.delete_payment(v_f);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1567_fail values ('D1: delete of F refused: ' || v_msg);
  elsif pg_temp.r1567_open(c3) <> 0 then
    insert into r1567_fail values ('D1: after deleting F the customer still has open credit ' || pg_temp.r1567_open(c3) || ' (want 0 — no money behind it)');
  end if;

  -- ════ D5: the deleted payment's receipt voucher number is kept, never re-used ════
  if v_rv is null then
    insert into r1567_fail values ('D5 setup: F got no receipt voucher number');
  else
    if to_regclass('public.cancelled_vouchers') is null then
      insert into r1567_fail values ('D5: receipt voucher ' || v_rv || ' of the deleted payment is gone from the record (no cancelled_vouchers)');
    else
      execute 'select exists(select 1 from public.cancelled_vouchers where doc_type = ''receipt_voucher'' and doc_no = $1 and payment_id = $2 and amount = 10000)'
        into v_ok using v_rv, v_f;
      if not v_ok then
        insert into r1567_fail values ('D5: receipt voucher ' || v_rv || ' of the deleted payment is not kept as cancelled');
      end if;
    end if;
    v_r := public.record_desk_payment('Q-R1567-N', 1000, 'upi', 'R1567-N', null, null, 0, '2026-10-07', null);
    v_n := (v_r->>'payment_id')::uuid;
    v_rv_next := v_r->>'receipt_voucher_no';
    if v_rv_next is null or v_rv_next = v_rv then
      insert into r1567_fail values ('D5: next receipt voucher ' || coalesce(v_rv_next, 'null') || ' re-uses or lacks a number (deleted ' || v_rv || ')');
    end if;
  end if;

  -- ════ D2 / D3: delete the payment whose credit was used / the one that used it ════
  v_r := public.record_desk_payment('Q-R1567-G', 10000, 'bank_transfer', 'R1567-G', null, null, 0, '2026-09-13', null);
  v_g := (v_r->>'payment_id')::uuid;
  v_r := public.record_desk_payment('Q-R1567-H', 2000, 'bank_transfer', 'R1567-H', null, c4, 4000, '2026-10-05', null);
  v_h := (v_r->>'payment_id')::uuid;
  v_msg := null;
  begin
    perform public.delete_payment(v_g);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r1567_fail values ('D2: delete of G went through although its ₹4,000 credit already paid quote H');
  elsif v_msg not ilike '%pehle%' or v_msg not like '%Q-R1567-H%' then
    insert into r1567_fail values ('D2: refusal does not say to remove the quote H payment first: ' || v_msg);
  end if;

  v_msg := null;
  begin
    perform public.delete_payment(v_h);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1567_fail values ('D3: delete of H refused: ' || v_msg);
  elsif pg_temp.r1567_open(c4) <> 4000 then
    insert into r1567_fail values ('D3: after deleting H the open credit is ' || pg_temp.r1567_open(c4) || ' (want the ₹4,000 back)');
  else
    v_msg := null;
    begin
      perform public.delete_payment(v_g);
    exception when others then v_msg := sqlerrm; end;
    if v_msg is not null then
      insert into r1567_fail values ('D3: delete of G still refused after H gave the credit back: ' || v_msg);
    elsif pg_temp.r1567_open(c4) <> 0 then
      insert into r1567_fail values ('D3: after deleting G the open credit is ' || pg_temp.r1567_open(c4) || ' (want 0)');
    end if;
  end if;

  -- ════ D4: delete with TDS reverses the TDS receivable ═════════════════════════════
  v_r := public.record_desk_payment('Q-R1567-T', 10000, 'bank_transfer', 'R1567-T', null, null, 0, '2026-10-01', null,
                                    1000, 10000, 9000, '194J', 10, 'ABCD12345E', null, null);
  v_t := (v_r->>'payment_id')::uuid;
  if not exists (select 1 from public.tds_receivable where payment_id = v_t) then
    insert into r1567_fail values ('D4 setup: no TDS receivable for T');
  end if;
  v_msg := null;
  begin
    perform public.delete_payment(v_t);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1567_fail values ('D4: delete of T refused: ' || v_msg);
  elsif exists (select 1 from public.tds_receivable
                 where tenant_id = 'e1567000-0000-0000-0000-0000000000a0' and gross_amount = 10000
                   and fiscal_year is not null and status <> 'reversed'
                   and (payment_id = v_t or payment_id is null)
                   and customer_tan = 'ABCD12345E' and payment_received_date = '2026-10-01'
                   and id <> coalesce((select id from public.tds_receivable where payment_id = v_e), '')) then
    insert into r1567_fail values ('D4: TDS receivable of the deleted payment is still open (want reversed)');
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r1567_fail;
  if v_list is not null then
    raise exception E'FAIL r1567_refund_delete_payment_credit:\n  %', v_list;
  end if;
  raise notice 'PASS r1567_refund_delete_payment_credit';
end $$;

rollback;
