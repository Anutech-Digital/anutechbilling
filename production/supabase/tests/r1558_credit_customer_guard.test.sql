\set ON_ERROR_STOP on
-- R-1558 (P2 money, audit 18 Oct 2026): a payment may only use the advance credit of the
-- customer it is FOR. record_desk_payment redeemed redeem_customer_credits(p_credit_customer_id)
-- without checking that customer against the quote's (or the invoice's) customer, so a billing
-- user could settle customer B's quote with customer A's advance — both ledgers wrong.
-- Migration: 20261018185647_r1558_credit_customer_guard.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1558_credit_customer_guard.test.sql
--
-- Expect "PASS r1558_credit_customer_guard". Every check is collected and listed together.
--
-- Customer A has ₹4,000 open advance credit (and B has ₹1,000).
--   D1  B's quote, ₹2,000 cash + ₹4,000 of A's credit → REFUSED 42501 with the next step;
--       A's credit is still ₹4,000 open, no payment on B's quote.
--   D2  A's quote, A's credit, but p_invoice_id is B's invoice → REFUSED 42501.
--   D3  A quote with no customer on it + A's credit → REFUSED 42501.
--   D4  A's quote, ₹2,000 cash + ₹4,000 of A's own credit → recorded, credit_applied 4000,
--       A's open credit 0.
--   I1  record_instalment_payment on B's instalment invoice with A's credit → REFUSED 42501,
--       invoice untouched, A's credit untouched.
--   I2  record_instalment_payment on B's instalment invoice with B's own ₹1,000 credit → recorded.
--   M   record_multi_invoice_payment takes no credit customer (it passes null / 0 to
--       record_desk_payment), so it cannot carry another customer's credit — nothing to test.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1558000-0000-4000-8000-0000000000a2', 'r1558-billing@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1558000-0000-0000-0000-0000000000a0', 'R1558 A', 'r1558a@example.in', '07', 'R158');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1558000-0000-4000-8000-0000000000a2', 'e1558000-0000-0000-0000-0000000000a0', 'r1558-billing@example.in', 'R1558 Billing', 'billing', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1558000-0000-4000-8000-0000000000c1', 'e1558000-0000-0000-0000-0000000000a0', 'R1558 Cust A', '07', 'India'),
  ('e1558000-0000-4000-8000-0000000000c2', 'e1558000-0000-0000-0000-0000000000a0', 'R1558 Cust B', '07', 'India');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R1558-A',  'e1558000-0000-0000-0000-0000000000a0', 'e1558000-0000-4000-8000-0000000000c1', 'R1558 Cust A', 6000, 5085, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1558-B',  'e1558000-0000-0000-0000-0000000000a0', 'e1558000-0000-4000-8000-0000000000c2', 'R1558 Cust B', 6000, 5085, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1558-N',  'e1558000-0000-0000-0000-0000000000a0', null,                                   'R1558 Walk-in', 6000, 5085, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1558-S',  'e1558000-0000-0000-0000-0000000000a0', 'e1558000-0000-4000-8000-0000000000c2', 'R1558 Cust B', 9440, 8000, 18, 'accepted', 'none', '[]'::jsonb);
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id) values
  ('R158-BINV', 'e1558000-0000-0000-0000-0000000000a0', 'R1558 Cust B', 'e1558000-0000-4000-8000-0000000000c2', 1180, 1180, 1000, '2026-09-01', null);

insert into public.customer_credits (tenant_id, customer_id, amount, source, note, status) values
  ('e1558000-0000-0000-0000-0000000000a0', 'e1558000-0000-4000-8000-0000000000c1', 4000, 'manual', 'R1558 A advance', 'open'),
  ('e1558000-0000-0000-0000-0000000000a0', 'e1558000-0000-4000-8000-0000000000c2', 1000, 'manual', 'R1558 B advance', 'open');

-- B's quarterly subscription, sold on Q-R1558-S, instalment 1 raised (₹2,360 due).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id) values
  ('e1558000-0000-4000-8000-0000000000e1', 'e1558000-0000-0000-0000-0000000000a0', 'e1558000-0000-4000-8000-0000000000c2', 'R1558 Cust B', 'Workspace Starter', 'google'::vendor, 2, 667, 'quarterly'::billing_cycle, 'Q-R1558-S');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate) values
  ('e1558000-0000-4000-8000-000000000101', 'e1558000-0000-0000-0000-0000000000a0', 'e1558000-0000-4000-8000-0000000000e1',
   date '2026-07-01', 1, date '2026-07-01', date '2026-07-01', date '2026-09-28', 2000, 18);

create temp table r1558_inv (id text) on commit drop;
create temp table r1558_fail (msg text) on commit drop;
grant all on r1558_inv, r1558_fail to authenticated;
insert into r1558_inv select invoice_id from public.raise_subscription_billing('e1558000-0000-4000-8000-000000000101');

create function pg_temp.r1558_open(p_customer uuid) returns integer language sql as $$
  select coalesce(sum(amount), 0)::int from public.customer_credits
   where customer_id = p_customer and status = 'open' $$;
create function pg_temp.r1558_pays(p_quote text) returns integer language sql as $$
  select count(*)::int from public.payments where quote_id = p_quote $$;
-- record_desk_payment → null on success, else 'SQLSTATE: message'
create function pg_temp.r1558_desk(p_quote text, p_ref text, p_credit_cust uuid, p_credit int, p_inv text default null)
returns text language plpgsql as $$
begin
  perform public.record_desk_payment(p_quote, 2000, 'upi', p_ref, null, p_credit_cust, p_credit,
            null, null, 0, 0, 0, null, null, null, p_inv, null);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1558_inst(p_inv text, p_ref text, p_credit_cust uuid, p_credit int)
returns text language plpgsql as $$
begin
  perform public.record_instalment_payment(p_inv, 1000, 'upi', p_ref, null, p_credit_cust, p_credit);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r1558_open(uuid) to authenticated;
grant execute on function pg_temp.r1558_pays(text) to authenticated;
grant execute on function pg_temp.r1558_desk(text, text, uuid, int, text) to authenticated;
grant execute on function pg_temp.r1558_inst(text, text, uuid, int) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'e1558000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare
  v_e text; v_n int; v_inv text; v_ca int;
  c_a constant uuid := 'e1558000-0000-4000-8000-0000000000c1';
  c_b constant uuid := 'e1558000-0000-4000-8000-0000000000c2';
begin
  select id into v_inv from r1558_inv;

  -- D1: A's credit on B's quote
  v_e := pg_temp.r1558_desk('Q-R1558-B', 'R1558-D1', c_a, 4000);
  if v_e is null or v_e not like '42501:%' then
    insert into r1558_fail values ('D1 A''s credit on B''s quote was not refused 42501: ' || coalesce(v_e, 'it was RECORDED'));
  elsif v_e not like '%R1558 Cust A%' or v_e not like '%R1558 Cust B%' or v_e not ilike '%record%' then
    insert into r1558_fail values ('D1 refusal does not name both customers + the next step (§24): ' || v_e);
  end if;
  if pg_temp.r1558_open(c_a) <> 4000 then
    insert into r1558_fail values ('D1 A''s open credit is ' || pg_temp.r1558_open(c_a) || ', expected 4000');
  end if;
  if pg_temp.r1558_pays('Q-R1558-B') <> 0 then
    insert into r1558_fail values ('D1 a payment was left on B''s quote');
  end if;

  -- D2: A's quote, A's credit, but B's invoice
  v_e := pg_temp.r1558_desk('Q-R1558-A', 'R1558-D2', c_a, 4000, 'R158-BINV');
  if v_e is null or v_e not like '42501:%' then
    insert into r1558_fail values ('D2 A''s credit with B''s invoice was not refused 42501: ' || coalesce(v_e, 'it was RECORDED'));
  end if;

  -- D3: quote with no customer
  v_e := pg_temp.r1558_desk('Q-R1558-N', 'R1558-D3', c_a, 4000);
  if v_e is null or v_e not like '42501:%' then
    insert into r1558_fail values ('D3 A''s credit on a no-customer quote was not refused 42501: ' || coalesce(v_e, 'it was RECORDED'));
  end if;
  if pg_temp.r1558_open(c_a) <> 4000 then
    insert into r1558_fail values ('D2/D3 A''s open credit is ' || pg_temp.r1558_open(c_a) || ', expected 4000');
  end if;

  -- I1: A's credit on B's instalment invoice
  v_e := pg_temp.r1558_inst(v_inv, 'R1558-I1', c_a, 500);
  if v_e is null or v_e not like '42501:%' then
    insert into r1558_fail values ('I1 A''s credit on B''s instalment was not refused 42501: ' || coalesce(v_e, 'it was RECORDED'));
  end if;
  if pg_temp.r1558_open(c_a) <> 4000 then
    insert into r1558_fail values ('I1 A''s open credit is ' || pg_temp.r1558_open(c_a) || ', expected 4000');
  end if;
  if (select coalesce(paid_amount, 0) from public.invoices where id = v_inv) <> 0 then
    insert into r1558_fail values ('I1 B''s instalment invoice was touched');
  end if;

  -- D4: A's own credit on A's quote
  v_e := pg_temp.r1558_desk('Q-R1558-A', 'R1558-D4', c_a, 4000);
  if v_e is not null then
    insert into r1558_fail values ('D4 A''s own credit on A''s quote was refused: ' || v_e);
  else
    select credit_applied into v_ca from public.payments where quote_id = 'Q-R1558-A' and reference = 'R1558-D4';
    if coalesce(v_ca, -1) <> 4000 then
      insert into r1558_fail values ('D4 credit_applied is ' || coalesce(v_ca::text, 'null') || ', expected 4000');
    end if;
    if pg_temp.r1558_open(c_a) <> 0 then
      insert into r1558_fail values ('D4 A''s open credit is ' || pg_temp.r1558_open(c_a) || ', expected 0');
    end if;
  end if;

  -- I2: B's own credit on B's instalment
  v_e := pg_temp.r1558_inst(v_inv, 'R1558-I2', c_b, 1000);
  if v_e is not null then
    insert into r1558_fail values ('I2 B''s own credit on B''s instalment was refused: ' || v_e);
  elsif pg_temp.r1558_open(c_b) <> 0 then
    insert into r1558_fail values ('I2 B''s open credit is ' || pg_temp.r1558_open(c_b) || ', expected 0');
  elsif (select coalesce(paid_amount, 0) from public.invoices where id = v_inv) <> 2000 then
    insert into r1558_fail values ('I2 instalment paid_amount is '
      || (select coalesce(paid_amount, 0) from public.invoices where id = v_inv) || ', expected 2000 (₹1,000 cash + ₹1,000 credit)');
  end if;
end $$;

reset role;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r1558_fail;
  if v_list is not null then
    raise exception E'FAIL r1558_credit_customer_guard:\n  %', v_list;
  end if;
  raise notice 'PASS r1558_credit_customer_guard';
end $$;

rollback;
