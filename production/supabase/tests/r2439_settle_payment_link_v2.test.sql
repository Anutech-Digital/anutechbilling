\set ON_ERROR_STOP on
-- R-2439 (fix from the independent money review of R-2415): settle_invoice_payment_link v2.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2439_settle_payment_link_v2.test.sql
--
-- Expect "PASS r2439_settle_payment_link_v2". Every check is collected and failures listed together.
--
--   TRANSIENT   the booking hits a passing DB error (out of memory 53200, connection 08006,
--               deadlock-like 40001) → the error is RAISED (the webhook answers 5xx, Razorpay
--               retries); the link stays active and nothing is booked — a retry can still book it.
--               Before R-2439 'when others' turned these into a permanent needs_review.
--   RETRY       after the passing error is gone, the same payment books normally.
--   REFUSAL     a business refusal (plain raise, P0001) still goes to needs_review, nothing booked;
--               so does 53400 (configuration limit — no retry fixes it).
--   REVIEW+2ND  a different payment on a link that is waiting for a check → review with
--               same_payment false and paid_payment_id = the earlier payment.
--   SECOND      a DIFFERENT payment on an already-paid link → already_recorded, same_payment false,
--               and paid_payment_id names the payment that DID book it (the webhook flags the
--               second one for review / refund); still only one payment on the bill.

begin;
select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2439000-0000-0000-0000-0000000000a0', 'R2439 A', 'r2439a@example.in', '07', 'R39A');

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2439000-0000-4000-8000-0000000000c1', 'e2439000-0000-0000-0000-0000000000a0', 'R2439 Cust', '07', 'India');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
select v.id, 'e2439000-0000-0000-0000-0000000000a0'::uuid, 'R2439', 'e2439000-0000-4000-8000-0000000000c1'::uuid, 1180, 1180, 1000, '2026-10-01'::date, null
  from (values ('R39-I1'), ('R39-I2'), ('R39-I3'), ('R39-I4')) v(id);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-' || i.id, i.tenant_id, null, i.customer_id, 'R2439', i.amount, i.taxable_value, 18, 'accepted', 'invoiced', '[]'::jsonb, i.id
  from public.invoices i where i.id like 'R39-%';
update public.invoices set quote_id = 'Q-' || id where id like 'R39-%';

insert into public.invoice_payment_links (id, tenant_id, customer_id, scope, invoice_id, link_key, allocations, bill_amount, amount, mode, status, razorpay_link_id, short_url)
select ('e2439000-0000-4000-8000-00000000010' || n)::uuid, 'e2439000-0000-0000-0000-0000000000a0', 'e2439000-0000-4000-8000-0000000000c1', 'invoice',
       'R39-I' || n, 'invoice:R39-I' || n,
       jsonb_build_array(jsonb_build_object('invoice_id', 'R39-I' || n, 'quote_id', 'Q-R39-I' || n, 'amount', 1180)),
       1180, 1180, 'test', 'active', 'plink_R2439n' || n, 'https://rzp.io/i/r2439n' || n
  from generate_series(1, 4) n;

-- A test-only trigger that makes the payment insert fail with a chosen SQLSTATE (rolled back).
create temp table r2439_boom (code text) on commit drop;
create function public.r2439_test_boom() returns trigger language plpgsql as $$
declare v_code text;
begin
  select code into v_code from r2439_boom limit 1;
  if v_code is not null and new.reference like 'pay_R2439%' then
    raise exception 'R-2439 test: simulated error %', v_code using errcode = v_code;
  end if;
  return new;
end $$;
create trigger r2439_test_boom before insert on public.payments
  for each row execute function public.r2439_test_boom();

create temp table r2439_fail (msg text) on commit drop;

create function pg_temp.r2439_settle(p_link text, p_pay text) returns jsonb language plpgsql as $$
begin
  return public.settle_invoice_payment_link(p_link, p_pay, 118000, 'evt_r2439');
exception when others then
  return jsonb_build_object('raised', sqlstate);
end $$;

do $$
declare
  v_r jsonb; v_n int; v_s text; v_code text;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- ════ TRANSIENT ════════════════════════════════════════════════════════════════════
  foreach v_code in array array['53200', '08006', '40001', '58030'] loop
    delete from r2439_boom; insert into r2439_boom values (v_code);
    v_r := pg_temp.r2439_settle('plink_R2439n1', 'pay_R2439one');
    if coalesce(v_r->>'raised', '') <> v_code then
      insert into r2439_fail values ('TRANSIENT ' || v_code || ': expected the error to be raised, got ' || v_r::text);
    end if;
    select status into v_s from public.invoice_payment_links where id = 'e2439000-0000-4000-8000-000000000101';
    if v_s <> 'active' then
      insert into r2439_fail values ('TRANSIENT ' || v_code || ': link is ' || v_s || ' (a retry could never book it)');
      update public.invoice_payment_links set status = 'active', razorpay_payment_id = null, review_reason = null
       where id = 'e2439000-0000-4000-8000-000000000101';
    end if;
    select count(*) into v_n from public.payments where quote_id = 'Q-R39-I1';
    if v_n <> 0 then insert into r2439_fail values ('TRANSIENT ' || v_code || ': booked ' || v_n); end if;
  end loop;

  -- ════ RETRY ════════════════════════════════════════════════════════════════════════
  delete from r2439_boom;
  v_r := pg_temp.r2439_settle('plink_R2439n1', 'pay_R2439one');
  if not coalesce((v_r->>'recorded')::boolean, false) then insert into r2439_fail values ('RETRY not recorded: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R39-I1' and reference = 'pay_R2439one' and amount = 1180;
  if v_n <> 1 then insert into r2439_fail values ('RETRY: expected 1 payment, got ' || v_n); end if;

  -- ════ REFUSAL ══════════════════════════════════════════════════════════════════════
  delete from r2439_boom; insert into r2439_boom values ('P0001');
  v_r := pg_temp.r2439_settle('plink_R2439n2', 'pay_R2439two');
  if not coalesce((v_r->>'review')::boolean, false) then insert into r2439_fail values ('REFUSAL not review: ' || v_r::text); end if;
  select status into v_s from public.invoice_payment_links where id = 'e2439000-0000-4000-8000-000000000102';
  if v_s <> 'needs_review' then insert into r2439_fail values ('REFUSAL: link is ' || v_s); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R39-I2';
  if v_n <> 0 then insert into r2439_fail values ('REFUSAL booked ' || v_n); end if;
  delete from r2439_boom;

  -- ════ REVIEW+2ND: another payment on the link that is waiting for a check ═════════════════
  v_r := pg_temp.r2439_settle('plink_R2439n2', 'pay_R2439twoB');
  if not coalesce((v_r->>'review')::boolean, false)
     or coalesce((v_r->>'same_payment')::boolean, true)
     or coalesce(v_r->>'paid_payment_id', '') <> 'pay_R2439two' then
    insert into r2439_fail values ('REVIEW+2ND: expected review, same_payment false, paid_payment_id pay_R2439two; got ' || v_r::text);
  end if;
  v_r := pg_temp.r2439_settle('plink_R2439n2', 'pay_R2439two');
  if not coalesce((v_r->>'same_payment')::boolean, false) then insert into r2439_fail values ('REVIEW+2ND: retry of the first is not same_payment: ' || v_r::text); end if;

  -- ════ 53400: configuration limit → review, not a retry loop ═══════════════════════════════
  insert into r2439_boom values ('53400');
  v_r := pg_temp.r2439_settle('plink_R2439n4', 'pay_R2439four');
  if not coalesce((v_r->>'review')::boolean, false) then insert into r2439_fail values ('53400 not review: ' || v_r::text); end if;
  delete from r2439_boom;

  -- ════ SECOND ═══════════════════════════════════════════════════════════════════════
  v_r := pg_temp.r2439_settle('plink_R2439n3', 'pay_R2439first');
  if not coalesce((v_r->>'recorded')::boolean, false) then insert into r2439_fail values ('SECOND: first not recorded: ' || v_r::text); end if;
  v_r := pg_temp.r2439_settle('plink_R2439n3', 'pay_R2439second');
  if not coalesce((v_r->>'already_recorded')::boolean, false)
     or coalesce((v_r->>'same_payment')::boolean, true)
     or coalesce(v_r->>'paid_payment_id', '') <> 'pay_R2439first' then
    insert into r2439_fail values ('SECOND: expected already_recorded, same_payment false, paid_payment_id pay_R2439first; got ' || v_r::text);
  end if;
  v_r := pg_temp.r2439_settle('plink_R2439n3', 'pay_R2439first');
  if not coalesce((v_r->>'same_payment')::boolean, false) then insert into r2439_fail values ('SECOND: replay of the first is not same_payment: ' || v_r::text); end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R39-I3';
  if v_n <> 1 then insert into r2439_fail values ('SECOND: payments on I3 = ' || v_n); end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2439_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2439_settle_payment_link_v2:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2439_settle_payment_link_v2';
end $$;

rollback;
