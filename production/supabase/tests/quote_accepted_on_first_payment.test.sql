-- Regression test for migration 20260821210000_accept_quote_on_first_payment.sql
--
-- WHAT THIS PROVES, AND WHY IT NEEDED PROVING IN SQL
--   `record_payment` already did the irreversible half of "accepted" on the FIRST payment
--   of any size: it inserts the customer row (lead -> customer) and creates the
--   subscription. Only the status label lagged, gated on v_is_fully_paid. So a quote
--   holding Rs 50,000 of Rs 50,027 sat at 'sent', the lifecycle bar said "Waiting for the
--   customer to accept", and the page offered a "Mark accepted" button whose stated job
--   -- "convert the lead into a customer" -- had already been done. Found by Pardeep on
--   Q-ADPL-2026-27-0026 (deltaco), 21 Aug 2026.
--
--   This is a SECURITY DEFINER money RPC. Nothing in the TypeScript suite executes it, so
--   a green `npm run test` says nothing at all about this change. This file is the test.
--
-- THE CASES (each FAILS LOUDLY -- the file is self-asserting)
--   1. A PARTIAL payment promotes a 'sent' quote to 'accepted'.        <- the change
--   2. ...and payment_status is still 'partial'.                       <- money untouched
--   3. ...and the customer row was created by the same call.           <- why 1 is honest
--   4. Deleting that payment demotes the quote back to 'sent'.         <- symmetric
--   5. A FULL payment still lands 'accepted' + 'received'.             <- no regression
--   6. A 'rejected' quote is NOT promoted by a payment.                <- forward only
--      (since R-1575 the payment itself is refused -- see below)
--   7. A 'viewed' quote is promoted by its first payment too.          <- guard lets it through
--
-- ON CASE 6: the promotion has always been written as `status in ('draft','sent','viewed')`
--   and this change did not touch that list. It is asserted anyway, because the whole
--   point of removing a condition from a CASE arm is that it is easy to remove one too
--   many, and "rejected quote silently becomes accepted when money arrives" is the kind of
--   bug that would be found by an accountant, not by us.
--
-- R-1616 (19 Oct 2026): case 6 used to RECORD a payment on the rejected quote and check
--   only that the label stayed 'rejected'. R-1575 (20261018165435_r1575_closed_quote_guard.sql,
--   trg_payment_closed_quote_guard) now refuses any 'received' payment on a rejected or
--   replaced quote, so that setup raised before the assertion. The guard is right and the
--   scenario was outdated: case 6 now expects the refusal (check_violation), no payment
--   row, and the quote still 'rejected' -- stronger than before. Case 7 proves the guard
--   does not block a legitimate first payment on a 'viewed' quote.
--
-- SAFETY: synthetic tenant, synthetic quote, one transaction, ends in ROLLBACK. No real
-- row is read into an assertion or written. The receipt-voucher number that record_payment
-- allocates is rolled back with everything else, so no live document series is consumed.

begin;

-- service_role context: record_payment takes the tenant carve-out only because it has no
-- auth.uid() here. This is the same reasoning as the RLS tests -- auth.role() reads
-- request.jwt.claims, and set_config supplies it.
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier)
values ('0a17e511-0000-4000-8000-000000000001', 'ZZ RPC TEST TENANT', 'zz-rpc-test@example.invalid', 'ZZRPC', 'reseller');

-- Two quotes in the same synthetic tenant: one to part-pay, one to reject then pay.
insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, status, payment_status, discount_pct, line_items)
values
  ('ZZ-RPC-PARTIAL', '0a17e511-0000-4000-8000-000000000001', 'ZZ Test Buyer', 50027, 42396, 'sent',     'none', 0, '[]'::jsonb),
  ('ZZ-RPC-FULL',    '0a17e511-0000-4000-8000-000000000001', 'ZZ Test Buyer', 10000, 10000, 'sent',     'none', 0, '[]'::jsonb),
  ('ZZ-RPC-REJECTED','0a17e511-0000-4000-8000-000000000001', 'ZZ Test Buyer', 10000, 10000, 'rejected', 'none', 0, '[]'::jsonb),
  ('ZZ-RPC-VIEWED',  '0a17e511-0000-4000-8000-000000000001', 'ZZ Test Buyer', 10000, 10000, 'viewed',   'none', 0, '[]'::jsonb);

do $$
declare
  v_status      text;
  v_pay_status  text;
  v_customers   integer;
  v_payment_id  uuid;
  v_result      jsonb;
  v_refused     boolean := false;
  v_pay_count   integer;
begin
  -- ── 1 + 2 + 3: a PARTIAL payment ────────────────────────────────────────────
  v_result := public.record_payment(
    p_quote_id => 'ZZ-RPC-PARTIAL',
    p_amount   => 50000,                       -- Rs 27 short, exactly like the real row
    p_method   => 'bank_transfer',
    p_reference=> 'ZZ-TEST-PARTIAL-1'
  );

  select status::text, payment_status::text into v_status, v_pay_status
    from public.quotes where id = 'ZZ-RPC-PARTIAL';

  if v_status <> 'accepted' then
    raise exception 'CASE 1 FAIL: partial payment left the quote at "%" instead of accepted', v_status;
  end if;
  if v_pay_status <> 'partial' then
    raise exception 'CASE 2 FAIL: payment_status became "%" -- this change must not touch the money columns', v_pay_status;
  end if;

  -- The reason case 1 is honest rather than merely convenient: the same call already
  -- created the customer. If this ever stops being true, "accepted" would start running
  -- ahead of the conversion instead of catching up with it.
  select count(*) into v_customers
    from public.customers where tenant_id = '0a17e511-0000-4000-8000-000000000001';
  if v_customers < 1 then
    raise exception 'CASE 3 FAIL: no customer row was created by the first payment (found %)', v_customers;
  end if;

  -- ── 4: deleting it demotes the quote again ──────────────────────────────────
  -- delete_payment was NOT modified by this migration. This asserts that the reversal it
  -- already had covers the new promotion too, which is why no DDL was written for it.
  select id into v_payment_id
    from public.payments where quote_id = 'ZZ-RPC-PARTIAL' and status = 'received' limit 1;
  if v_payment_id is null then
    raise exception 'CASE 4 SETUP FAIL: could not find the payment that was just recorded';
  end if;

  perform public.delete_payment(v_payment_id);

  select status::text, payment_status::text into v_status, v_pay_status
    from public.quotes where id = 'ZZ-RPC-PARTIAL';
  if v_status <> 'sent' then
    raise exception 'CASE 4 FAIL: after deleting the only payment the quote is "%" -- a wrong entry would leave it accepted forever', v_status;
  end if;

  -- ── 5: full payment still behaves as it always did ──────────────────────────
  v_result := public.record_payment(
    p_quote_id => 'ZZ-RPC-FULL',
    p_amount   => 10000,
    p_method   => 'upi',
    p_reference=> 'ZZ-TEST-FULL-1'
  );
  select status::text, payment_status::text into v_status, v_pay_status
    from public.quotes where id = 'ZZ-RPC-FULL';
  if v_status <> 'accepted' or v_pay_status <> 'received' then
    raise exception 'CASE 5 FAIL: full payment gave status="%" payment_status="%"', v_status, v_pay_status;
  end if;

  -- ── 6: forward only -- a rejected quote is left alone ───────────────────────
  -- Since R-1575 the late payment is refused outright (the owner must press Reopen
  -- first), so nothing can promote or reopen the rejected quote.
  begin
    v_result := public.record_payment(
      p_quote_id => 'ZZ-RPC-REJECTED',
      p_amount   => 10000,
      p_method   => 'cash',
      p_reference=> 'ZZ-TEST-REJECTED-1'
    );
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'CASE 6 FAIL: a payment on a rejected quote went through -- the R-1575 guard did not fire';
  end if;
  select count(*) into v_pay_count from public.payments where quote_id = 'ZZ-RPC-REJECTED';
  select status::text into v_status from public.quotes where id = 'ZZ-RPC-REJECTED';
  if v_pay_count <> 0 or v_status <> 'rejected' then
    raise exception 'CASE 6 FAIL: rejected quote now has % payment(s) and status "%"', v_pay_count, v_status;
  end if;

  -- ── 7: a 'viewed' quote's first payment accepts it (guard not in the way) ───
  v_result := public.record_payment(
    p_quote_id => 'ZZ-RPC-VIEWED',
    p_amount   => 4000,
    p_method   => 'upi',
    p_reference=> 'ZZ-TEST-VIEWED-1'
  );
  select status::text, payment_status::text into v_status, v_pay_status
    from public.quotes where id = 'ZZ-RPC-VIEWED';
  if v_status <> 'accepted' or v_pay_status <> 'partial' then
    raise exception 'CASE 7 FAIL: first payment on a viewed quote gave status="%" payment_status="%"', v_status, v_pay_status;
  end if;

  raise notice 'ALL 7 CASES PASS';
end $$;

-- One row, and it is the proof: any failure above raises and aborts the transaction, so
-- reaching this select at all means every assertion held.
select 'PASS' as result;

rollback;
