\set ON_ERROR_STOP on
-- R-1682 (P1): after a credit note, the credit can be refunded — all of it or part — up to the
-- open credit-note credit, never more. Migration: 20261019132853_r1682_partial_credit_refund.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1682_partial_credit_refund.test.sql
--
-- Expect "PASS r1682_partial_credit_refund".
--
--   T19   (the staging story) ₹7,646 paid as an advance (RV), invoiced → Paid, credit note
--         ₹6,372 → ₹6,372 open credit. Full refund of the ₹7,646 payment is still refused.
--         ₹7,000 → refused (over the credit). ₹6,372 → booked: RFV, the payment split into
--         ₹1,274 kept (with its RV) + ₹6,372 refunded; credit closed; invoice still Paid;
--         quote received ₹1,274; statement closing = invoices − receipts − credit notes +
--         refunds = ₹0. A second refund → refused (no credit left).
--   PART  invoice first, ₹11,800 paid, credit note ₹2,360 → refund ₹1,500 → ₹860 credit left
--         open (the credit row is split); then the rest ₹860 → credit 0.
--   GUARD sales role, another company, ₹0, no invoice on the quote → refused.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1682000-0000-4000-8000-0000000000a2', 'r1682-owner@example.test'),
  ('e1682000-0000-4000-8000-0000000000a3', 'r1682-sales@example.test'),
  ('e1682000-0000-4000-8000-0000000000b2', 'r1682-owner-b@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1682000-0000-0000-0000-0000000000a0', 'R1682 A', 'r1682a@example.in', '07', 'R168'),
  ('e1682000-0000-0000-0000-0000000000b0', 'R1682 B', 'r1682b@example.in', '07', 'R16B');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1682000-0000-4000-8000-0000000000a2', 'e1682000-0000-0000-0000-0000000000a0', 'r1682-owner@example.in',   'R1682 Owner',   'owner', true),
  ('e1682000-0000-4000-8000-0000000000a3', 'e1682000-0000-0000-0000-0000000000a0', 'r1682-sales@example.in',   'R1682 Sales',   'sales', true),
  ('e1682000-0000-4000-8000-0000000000b2', 'e1682000-0000-0000-0000-0000000000b0', 'r1682-owner-b@example.in', 'R1682 Owner B', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1682000-0000-4000-8000-0000000000c1', 'e1682000-0000-0000-0000-0000000000a0', 'R1682 T-19',  '07', 'India'),
  ('e1682000-0000-4000-8000-0000000000c2', 'e1682000-0000-0000-0000-0000000000a0', 'R1682 Part',  '07', 'India'),
  ('e1682000-0000-4000-8000-0000000000c3', 'e1682000-0000-0000-0000-0000000000a0', 'R1682 NoInv', '07', 'India');
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R1682-T19',  'e1682000-0000-0000-0000-0000000000a0', null, 'e1682000-0000-4000-8000-0000000000c1', 'R1682 T-19',  7646,  6480, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1682-PART', 'e1682000-0000-0000-0000-0000000000a0', null, 'e1682000-0000-4000-8000-0000000000c2', 'R1682 Part', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1682-NOINV','e1682000-0000-0000-0000-0000000000a0', null, 'e1682000-0000-4000-8000-0000000000c3', 'R1682 NoInv', 1180,  1000, 18, 'accepted', 'awaiting', '[]'::jsonb);

create temp table r1682_fail (msg text) on commit drop;
grant all on r1682_fail to authenticated;

create function pg_temp.r1682_try(p_pay uuid, p_amount integer, p_reason text) returns text language plpgsql as $$
begin
  perform public.refund_credit_note_credit(p_pay, p_amount, p_reason);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1682_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1682_try(uuid, integer, text) to authenticated;
grant execute on function pg_temp.r1682_as(text) to authenticated;

do $$
declare
  c1 constant uuid := 'e1682000-0000-4000-8000-0000000000c1';
  c2 constant uuid := 'e1682000-0000-4000-8000-0000000000c2';
  v_inv text; v_inv2 text; v_pay uuid; v_pay2 uuid; v_pay3 uuid; v_r jsonb; v_e text; v_n int; v_s text; v_rv text;
  v_stmt bigint;
begin
  set local role authenticated;
  perform pg_temp.r1682_as('e1682000-0000-4000-8000-0000000000a2');

  -- ════ T19 setup: advance with RV, then the invoice, then the credit note ════════════════
  perform public.record_desk_payment('Q-R1682-T19', 7646, 'upi', '402312340079', null, null, 0, public.ist_today(), null);
  select invoice_id into v_inv from public.generate_invoice('Q-R1682-T19');
  perform public.issue_credit_note(v_inv, 6372, 'other', 'Subscription cancelled — unused part', null);
  select id, receipt_voucher_no into v_pay, v_rv from public.payments where quote_id = 'Q-R1682-T19';
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c1 and status = 'open') <> 6372 then
    insert into r1682_fail values ('T19 setup: open credit is not 6372');
  end if;

  -- the whole payment is still refused (needs ₹7,646 of credit note)
  begin
    perform public.refund_payment(v_pay, 'Customer left the service');
    insert into r1682_fail values ('T19: full refund of 7646 went through on a 6372 credit note');
  exception when others then null;
  end;
  -- over the credit
  v_e := pg_temp.r1682_try(v_pay, 7000, 'Customer left the service');
  if v_e is null or v_e not like '22023: At most ₹6372 can be refunded here%' then
    insert into r1682_fail values ('T19: 7000 not refused with the cap: ' || coalesce(v_e, 'ran'));
  end if;
  -- guards
  v_e := pg_temp.r1682_try(v_pay, 0, 'Customer left the service');
  if v_e is null or v_e not like '22023: Enter the amount to refund%' then insert into r1682_fail values ('T19: ₹0 not refused: ' || coalesce(v_e, 'ran')); end if;
  v_e := pg_temp.r1682_try(v_pay, 100, 'x');
  if v_e is null or v_e not like '22023: Refund ki wajah likhiye%' then insert into r1682_fail values ('T19: no reason not refused: ' || coalesce(v_e, 'ran')); end if;
  perform pg_temp.r1682_as('e1682000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r1682_try(v_pay, 100, 'Customer left the service');
  if v_e is null or v_e not like '42501: Refunds are for an owner, manager or accountant%' then insert into r1682_fail values ('T19: sales refunded: ' || coalesce(v_e, 'ran')); end if;
  perform pg_temp.r1682_as('e1682000-0000-4000-8000-0000000000b2');
  v_e := pg_temp.r1682_try(v_pay, 100, 'Customer left the service');
  if v_e is null or v_e not like '42501: That payment was not found in your company%' then insert into r1682_fail values ('T19: other company refunded: ' || coalesce(v_e, 'ran')); end if;
  perform pg_temp.r1682_as('e1682000-0000-4000-8000-0000000000a2');

  -- the refund of the credit-note credit
  begin
    v_r := public.refund_credit_note_credit(v_pay, 6372, 'Subscription cancelled, unused part returned');
    if coalesce(v_r->>'refund_voucher_no', '') not like 'RFV-%' or (v_r->>'amount')::int <> 6372
       or not (v_r->>'split')::boolean or (v_r->>'kept_amount')::int <> 1274 then
      insert into r1682_fail values ('T19: result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1682_fail values ('T19: refund raised: ' || sqlerrm);
  end;

  set local role postgres;
  if (select amount::text || '|' || status || '|' || coalesce(receipt_voucher_no, '-') from public.payments where id = v_pay)
     is distinct from '1274|received|' || coalesce(v_rv, '-') then
    insert into r1682_fail values ('T19: kept payment wrong: ' || (select amount::text || '|' || status || '|' || coalesce(receipt_voucher_no, '-') from public.payments where id = v_pay));
  end if;
  select count(*) into v_n from public.payments
   where quote_id = 'Q-R1682-T19' and id <> v_pay and amount = 6372 and status = 'refunded'
     and refund_voucher_no like 'RFV-%' and receipt_voucher_no is null and method = 'upi';
  if v_n <> 1 then insert into r1682_fail values ('T19: want one ₹6,372 refunded row with an RFV, got ' || v_n); end if;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c1 and status = 'open') <> 0 then
    insert into r1682_fail values ('T19: credit still open after paying it out');
  end if;
  select status::text into v_s from public.invoices where id = v_inv;
  if v_s <> 'paid' then insert into r1682_fail values ('T19: invoice moved to ' || v_s); end if;
  if (select payment_amount from public.quotes where id = 'Q-R1682-T19') <> 1274 then
    insert into r1682_fail values ('T19: quote received is not 1274');
  end if;
  -- statement: invoices + debit notes − receipts − credit notes + refunds
  select (select coalesce(sum(amount), 0) from public.invoices where customer_id = c1)
       + (select coalesce(sum(amount), 0) from public.debit_notes where customer_id = c1)
       - (select coalesce(sum(amount), 0) from public.payments where customer_id = c1)
       - (select coalesce(sum(amount), 0) from public.credit_notes where customer_id = c1)
       + (select coalesce(sum(amount), 0) from public.payments where customer_id = c1 and status = 'refunded')
    into v_stmt;
  if v_stmt <> 0 then insert into r1682_fail values ('T19: statement closing is ' || v_stmt || ' (want 0)'); end if;

  set local role authenticated;
  v_e := pg_temp.r1682_try(v_pay, 100, 'Customer left the service');
  if v_e is null or v_e not like '22023: Invoice % has no open credit from a credit note%' then
    insert into r1682_fail values ('T19: second refund not refused: ' || coalesce(v_e, 'ran'));
  end if;

  -- ════ PART: part of the credit, then the rest ═══════════════════════════════════════════
  select invoice_id into v_inv2 from public.generate_invoice('Q-R1682-PART');
  perform public.record_desk_payment('Q-R1682-PART', 11800, 'bank_transfer', 'UTRR1682PART01', null, null, 0, public.ist_today(), null);
  perform public.issue_credit_note(v_inv2, 2360, 'other', 'Two seats removed', null);
  select id into v_pay2 from public.payments where quote_id = 'Q-R1682-PART';
  begin
    v_r := public.refund_credit_note_credit(v_pay2, 1500, 'Part of the credit back');
    if (v_r->>'credit_note_credit_left')::int <> 860 then insert into r1682_fail values ('PART: credit left not 860: ' || v_r::text); end if;
  exception when others then insert into r1682_fail values ('PART: refund 1500 raised: ' || sqlerrm);
  end;
  set local role postgres;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c2 and status = 'open') <> 860 then
    insert into r1682_fail values ('PART: open credit is not 860');
  end if;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c2 and status = 'refunded' and source = 'credit_note') <> 1500 then
    insert into r1682_fail values ('PART: 1500 not closed as refunded credit-note credit');
  end if;
  if (select paid_amount from public.invoices where id = v_inv2) <> 10300 then
    insert into r1682_fail values ('PART: invoice paid_amount is ' || (select paid_amount from public.invoices where id = v_inv2) || ' (want 10300)');
  end if;
  set local role authenticated;
  select id into v_pay3 from public.payments where quote_id = 'Q-R1682-PART' and status = 'received';
  begin
    v_r := public.refund_credit_note_credit(v_pay3, 860, 'The rest of the credit back');
  exception when others then insert into r1682_fail values ('PART: refund rest 860 raised: ' || sqlerrm);
  end;
  set local role postgres;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c2 and status = 'open') <> 0 then
    insert into r1682_fail values ('PART: credit left after refunding the rest');
  end if;
  if (select coalesce(sum(amount), 0) from public.payments where quote_id = 'Q-R1682-PART' and status = 'received') <> 9440 then
    insert into r1682_fail values ('PART: kept receipt is not 9440');
  end if;
  if (select status::text from public.invoices where id = v_inv2) <> 'paid' then
    insert into r1682_fail values ('PART: invoice not paid any more');
  end if;

  -- ════ GUARD: no invoice on the quote ═══════════════════════════════════════════════════
  set local role authenticated;
  perform public.record_desk_payment('Q-R1682-NOINV', 1180, 'upi', '402312340099', null, null, 0, public.ist_today(), null);
  select id into v_pay from public.payments where quote_id = 'Q-R1682-NOINV';
  v_e := pg_temp.r1682_try(v_pay, 100, 'Customer left the service');
  if v_e is null or v_e not like '22023: This payment''s quote has no GST invoice%' then
    insert into r1682_fail values ('NOINV: not refused: ' || coalesce(v_e, 'ran'));
  end if;
  set local role postgres;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r1682_fail;
  if v_msgs is not null then
    raise exception E'FAIL r1682_partial_credit_refund:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r1682_partial_credit_refund';
end $$;

rollback;
