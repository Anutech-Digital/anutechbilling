\set ON_ERROR_STOP on
-- R-2415 (G-COLLECT): one Razorpay pay link per open invoice / statement total, booked ONCE.
-- Migration: 20261103151556_r2415_invoice_payment_links (invoice_payment_links,
-- settle_invoice_payment_link). Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2415_invoice_payment_links.test.sql
--
-- Expect "PASS r2415_invoice_payment_links". Every check is collected and failures listed together.
--
--   PAY        payment_link.paid → one payment on the invoice (method razorpay, ref = payment id),
--              invoice paid, link paid
--   REPLAY     the same event again → already_recorded, still one payment
--   AMOUNT     Razorpay paid a different amount → needs_review, nothing booked
--   CLOSED     the bill was paid another way first → needs_review, nothing more booked
--   STATEMENT  one link over two invoices → one payment on each, both paid
--   ONE LIVE   a second live link for the same bill → refused (unique index)
--   CANCELLED  a payment on a cancelled link → needs_review, nothing booked
--   WRITTEN OFF the bill was written off → needs_review, nothing booked
--   UNKNOWN    a link id we never made → found false
--   GRANTS     a signed-in user cannot call settle (only the webhook / service role)
--   RLS        a user reads only their company's links and cannot write one

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2415000-0000-4000-8000-0000000000a2', 'r2415-billing@example.test'),
  ('e2415000-0000-4000-8000-0000000000b2', 'r2415-billing-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2415000-0000-0000-0000-0000000000a0', 'R2415 A', 'r2415a@example.in', '07', 'R24A'),
  ('e2415000-0000-0000-0000-0000000000b0', 'R2415 B', 'r2415b@example.in', '07', 'R24B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2415000-0000-4000-8000-0000000000a2', 'e2415000-0000-0000-0000-0000000000a0', 'r2415-billing@example.in',   'R2415 Billing',   'billing', true),
  ('e2415000-0000-4000-8000-0000000000b2', 'e2415000-0000-0000-0000-0000000000b0', 'r2415-billing-b@example.in', 'R2415 Billing B', 'billing', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2415000-0000-4000-8000-0000000000c1', 'e2415000-0000-0000-0000-0000000000a0', 'R2415 Cust', '07', 'India'),
  ('e2415000-0000-4000-8000-0000000000cb', 'e2415000-0000-0000-0000-0000000000b0', 'R2415 B Cust', '07', 'India');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
select v.id, v.t::uuid, 'R2415', v.c::uuid, 1180, 1180, 1000, '2026-10-01'::date, null
  from (values
    ('R24-I1', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1'),
    ('R24-I2', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1'),
    ('R24-I3', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1'),
    ('R24-I4', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1'),
    ('R24-I5', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1'),
    ('R24-I6', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1'),
    ('R24-I7', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1'),
    ('R24-BI', 'e2415000-0000-0000-0000-0000000000b0', 'e2415000-0000-4000-8000-0000000000cb')
  ) v(id, t, c);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-' || i.id, i.tenant_id, null, i.customer_id, 'R2415', i.amount, i.taxable_value, 18, 'accepted', 'invoiced', '[]'::jsonb, i.id
  from public.invoices i where i.id like 'R24-%';
update public.invoices set quote_id = 'Q-' || id where id like 'R24-%';

-- Links as the server makes them (service role writes).
insert into public.invoice_payment_links (id, tenant_id, customer_id, scope, invoice_id, link_key, allocations, bill_amount, amount, mode, status, razorpay_link_id, short_url)
values
  ('e2415000-0000-4000-8000-0000000001a1', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1', 'invoice', 'R24-I1', 'invoice:R24-I1',
   '[{"invoice_id":"R24-I1","quote_id":"Q-R24-I1","amount":1180}]', 1180, 1180, 'test', 'active', 'plink_R2415one', 'https://rzp.io/i/one'),
  ('e2415000-0000-4000-8000-0000000001a2', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1', 'invoice', 'R24-I2', 'invoice:R24-I2',
   '[{"invoice_id":"R24-I2","quote_id":"Q-R24-I2","amount":1180}]', 1180, 1180, 'test', 'active', 'plink_R2415two', 'https://rzp.io/i/two'),
  ('e2415000-0000-4000-8000-0000000001a3', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1', 'invoice', 'R24-I3', 'invoice:R24-I3',
   '[{"invoice_id":"R24-I3","quote_id":"Q-R24-I3","amount":1180}]', 1180, 1180, 'test', 'active', 'plink_R2415three', 'https://rzp.io/i/three'),
  ('e2415000-0000-4000-8000-0000000001a4', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1', 'statement', null, 'statement:e2415000-0000-4000-8000-0000000000c1',
   '[{"invoice_id":"R24-I4","quote_id":"Q-R24-I4","amount":1180},{"invoice_id":"R24-I5","quote_id":"Q-R24-I5","amount":1180}]', 2360, 2360, 'test', 'active', 'plink_R2415stmt', 'https://rzp.io/i/stmt'),
  ('e2415000-0000-4000-8000-0000000001a6', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1', 'invoice', 'R24-I6', 'invoice:R24-I6',
   '[{"invoice_id":"R24-I6","quote_id":"Q-R24-I6","amount":1180}]', 1180, 1180, 'test', 'cancelled', 'plink_R2415gone', 'https://rzp.io/i/gone'),
  ('e2415000-0000-4000-8000-0000000001a7', 'e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1', 'invoice', 'R24-I7', 'invoice:R24-I7',
   '[{"invoice_id":"R24-I7","quote_id":"Q-R24-I7","amount":1180}]', 1180, 1180, 'test', 'active', 'plink_R2415woff', 'https://rzp.io/i/woff'),
  ('e2415000-0000-4000-8000-0000000001b1', 'e2415000-0000-0000-0000-0000000000b0', 'e2415000-0000-4000-8000-0000000000cb', 'invoice', 'R24-BI', 'invoice:R24-BI',
   '[{"invoice_id":"R24-BI","quote_id":"Q-R24-BI","amount":1180}]', 1180, 1180, 'test', 'active', 'plink_R2415bbb', 'https://rzp.io/i/bbb');

create temp table r2415_fail (msg text) on commit drop;
grant all on r2415_fail to authenticated;

create function pg_temp.r2415_settle(p_link text, p_pay text, p_paise bigint) returns jsonb language plpgsql as $$
begin
  return public.settle_invoice_payment_link(p_link, p_pay, p_paise, 'evt_test');
exception when others then
  return jsonb_build_object('error', sqlstate || ': ' || sqlerrm);
end $$;
grant execute on function pg_temp.r2415_settle(text, text, bigint) to authenticated;

-- As the webhook: the service role.
do $$
declare
  v_r jsonb; v_n int; v_s text;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- ════ PAY ══════════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2415_settle('plink_R2415one', 'pay_R2415one', 118000);
  if not coalesce((v_r->>'recorded')::boolean, false) then insert into r2415_fail values ('PAY not recorded: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R24-I1' and reference = 'pay_R2415one' and method = 'razorpay' and amount = 1180 and status = 'received';
  if v_n <> 1 then insert into r2415_fail values ('PAY: expected 1 razorpay payment of 1180, got ' || v_n); end if;
  select status::text into v_s from public.invoices where id = 'R24-I1';
  if v_s <> 'paid' then insert into r2415_fail values ('PAY: invoice status ' || v_s || ', expected paid'); end if;
  select status into v_s from public.invoice_payment_links where id = 'e2415000-0000-4000-8000-0000000001a1';
  if v_s <> 'paid' then insert into r2415_fail values ('PAY: link status ' || v_s); end if;

  -- ════ REPLAY ═══════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2415_settle('plink_R2415one', 'pay_R2415one', 118000);
  if not coalesce((v_r->>'already_recorded')::boolean, false) then insert into r2415_fail values ('REPLAY not already_recorded: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R24-I1';
  if v_n <> 1 then insert into r2415_fail values ('REPLAY: payments on I1 = ' || v_n); end if;

  -- ════ AMOUNT ═══════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2415_settle('plink_R2415two', 'pay_R2415two', 100000);
  if not coalesce((v_r->>'review')::boolean, false) then insert into r2415_fail values ('AMOUNT not review: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R24-I2';
  if v_n <> 0 then insert into r2415_fail values ('AMOUNT booked ' || v_n || ' payment(s)'); end if;
  select status into v_s from public.invoice_payment_links where id = 'e2415000-0000-4000-8000-0000000001a2';
  if v_s <> 'needs_review' then insert into r2415_fail values ('AMOUNT: link status ' || v_s); end if;

  -- ════ CLOSED: paid at the desk first ═══════════════════════════════════════════════
  perform public.record_payment('Q-R24-I3', 1180, 'cash', 'CASH-R2415', null);
  v_r := pg_temp.r2415_settle('plink_R2415three', 'pay_R2415three', 118000);
  if not coalesce((v_r->>'review')::boolean, false) then insert into r2415_fail values ('CLOSED not review: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R24-I3';
  if v_n <> 1 then insert into r2415_fail values ('CLOSED: payments on I3 = ' || v_n || ' (expected only the cash one)'); end if;

  -- ════ STATEMENT ════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2415_settle('plink_R2415stmt', 'pay_R2415stmt', 236000);
  if not coalesce((v_r->>'recorded')::boolean, false) then insert into r2415_fail values ('STATEMENT not recorded: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id in ('Q-R24-I4', 'Q-R24-I5') and reference = 'pay_R2415stmt' and amount = 1180;
  if v_n <> 2 then insert into r2415_fail values ('STATEMENT: expected 2 payments, got ' || v_n); end if;
  select count(*) into v_n from public.invoices where id in ('R24-I4', 'R24-I5') and status::text = 'paid';
  if v_n <> 2 then insert into r2415_fail values ('STATEMENT: paid invoices ' || v_n); end if;

  -- ════ CANCELLED ════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2415_settle('plink_R2415gone', 'pay_R2415gone', 118000);
  if not coalesce((v_r->>'review')::boolean, false) then insert into r2415_fail values ('CANCELLED not review: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R24-I6';
  if v_n <> 0 then insert into r2415_fail values ('CANCELLED booked ' || v_n); end if;

  -- ════ WRITTEN OFF ═════════════════════════════════════════════════════════════════
  update public.invoices set written_off_at = now() where id = 'R24-I7';
  v_r := pg_temp.r2415_settle('plink_R2415woff', 'pay_R2415woff', 118000);
  if not coalesce((v_r->>'review')::boolean, false) then insert into r2415_fail values ('WRITTEN OFF not review: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R24-I7';
  if v_n <> 0 then insert into r2415_fail values ('WRITTEN OFF booked ' || v_n); end if;

  -- ════ UNKNOWN ══════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2415_settle('plink_R2415none', 'pay_x', 100);
  if coalesce((v_r->>'found')::boolean, true) then insert into r2415_fail values ('UNKNOWN: ' || v_r::text); end if;

  -- ════ ONE LIVE ═════════════════════════════════════════════════════════════════════
  begin
    insert into public.invoice_payment_links (tenant_id, customer_id, scope, invoice_id, link_key, allocations, bill_amount, amount, status)
    values ('e2415000-0000-0000-0000-0000000000b0', 'e2415000-0000-4000-8000-0000000000cb', 'invoice', 'R24-BI', 'invoice:R24-BI',
            '[{"invoice_id":"R24-BI","quote_id":"Q-R24-BI","amount":1180}]', 1180, 1180, 'creating');
    insert into r2415_fail values ('ONE LIVE: a second live link for R24-BI was accepted');
  exception when unique_violation then null;
  end;
  begin
    insert into public.invoice_payment_links (tenant_id, customer_id, scope, link_key, allocations, bill_amount, amount, status)
    values ('e2415000-0000-0000-0000-0000000000b0', 'e2415000-0000-4000-8000-0000000000cb', 'invoice', 'invoice:R24-BI',
            '[{"invoice_id":"R24-BI","quote_id":"Q-R24-BI","amount":1180}]', 1180, 1000, 'failed');
    insert into r2415_fail values ('a link asking less than the bill was accepted');
  exception when check_violation then null;
  end;
end $$;

-- As a signed-in billing user of company A.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e2415000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
do $$
declare v_r jsonb; v_n int;
begin
  -- ════ GRANTS ═══════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2415_settle('plink_R2415bbb', 'pay_forged', 118000);
  if coalesce(v_r->>'error', '') not like '42501:%' then insert into r2415_fail values ('GRANTS: a signed-in user reached settle: ' || v_r::text); end if;

  -- ════ RLS ══════════════════════════════════════════════════════════════════════════
  select count(*) into v_n from public.invoice_payment_links where tenant_id = 'e2415000-0000-0000-0000-0000000000b0';
  if v_n <> 0 then insert into r2415_fail values ('RLS: company A sees ' || v_n || ' of company B''s links'); end if;
  select count(*) into v_n from public.invoice_payment_links where tenant_id = 'e2415000-0000-0000-0000-0000000000a0';
  if v_n <> 6 then insert into r2415_fail values ('RLS: company A sees ' || v_n || ' of its own 6 links'); end if;
  begin
    insert into public.invoice_payment_links (tenant_id, customer_id, scope, link_key, allocations, bill_amount, amount)
    values ('e2415000-0000-0000-0000-0000000000a0', 'e2415000-0000-4000-8000-0000000000c1', 'invoice', 'invoice:R24-X',
            '[{"invoice_id":"R24-X","quote_id":"Q","amount":1}]', 1, 1);
    insert into r2415_fail values ('RLS: a user wrote a link row directly');
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2415_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2415_invoice_payment_links:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2415_invoice_payment_links';
end $$;

rollback;
