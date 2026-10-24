-- Regression test for the recurring option on create_direct_invoice (0159).
--
-- Proves the one-time / recurring choice drives whether paying the invoice creates a
-- subscription:
--   RECURRING (p_recurring = true)  → quotes.is_one_off = false → paying it creates a
--                                     yearly subscription.
--   ONE-TIME  (p_recurring = false) → quotes.is_one_off = true  → paying it creates NONE.
--
-- ─── REWRITTEN 22 Aug 2026 ──────────────────────────────────────────────────
-- It borrowed a live customer (`53db44e6…`, since deleted) and did
-- `update customers set country='India'` on that real row, so it both broke and wrote to
-- ANUTECH's books; and it asserted nothing, ending `raise exception 'TESTRESULT >> %'` with
-- the expected values in a header comment. See AGENTS.md L11.
--
-- ⚠️ THE ONE-TIME HALF IS EXPECTED TO FAIL RIGHT NOW, and that is the point.
--    `record_payment` does not contain the string `is_one_off` at all — migration 0157's
--    guard is gone — so paying a one-time direct invoice creates a subscription anyway. This
--    file reaches that conclusion independently of
--    `record_payment_one_off_guard.test.sql`, which found it the same evening from the other
--    direction. Two tests, one missing guard, neither of them run for months.
--
--    Restoring the guard is a migration and a money-code decision. Making this test agree
--    with the code instead would retire the guard in silence — see AGENTS.md L8.

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c0de0002-0000-4000-8000-000000000001', 'DIRECT INVOICE RECURRING TEST', 'dir@example.in', '07', 'DIR1');

insert into public.customers (id, tenant_id, name, country, state_code, state)
  values ('c0de0002-0000-4000-8000-0000000000c1', 'c0de0002-0000-4000-8000-000000000001',
          'AMC Cust', 'India', '07', 'Delhi');

do $$
declare
  v_cust uuid := 'c0de0002-0000-4000-8000-0000000000c1';
  -- subtotal 120000, gross 141600 @ 18%
  v_li jsonb := '[{"name":"Website AMC","qty":1,"rate":120000}]'::jsonb;
  r record; n int; v_oneoff boolean;
begin
  -- ── RECURRING: the flag is false, and paying it DOES create a subscription ──
  select * into r from public.create_direct_invoice(v_cust, v_li, 'rec', true);

  select is_one_off into v_oneoff from public.quotes where id = r.quote_id;
  if v_oneoff is not false then
    raise exception 'FAIL recurring: quote.is_one_off is %, expected false', v_oneoff;
  end if;

  perform public.record_payment(r.quote_id, 141600, 'upi', 'REF-REC-1', null);
  select count(*) into n from public.subscriptions where quote_id = r.quote_id;
  if n <> 1 then
    raise exception 'FAIL recurring: expected 1 subscription after payment, got %', n;
  end if;

  -- ── ONE-TIME: the flag is true, and paying it must create NOTHING ──────────
  select * into r from public.create_direct_invoice(v_cust, v_li, 'one', false);

  select is_one_off into v_oneoff from public.quotes where id = r.quote_id;
  if v_oneoff is not true then
    raise exception 'FAIL one-time: quote.is_one_off is %, expected true', v_oneoff;
  end if;

  perform public.record_payment(r.quote_id, 141600, 'upi', 'REF-ONE-1', null);
  select count(*) into n from public.subscriptions where quote_id = r.quote_id;
  if n <> 0 then
    /* A ₹1,20,000 AMC billed once, now sitting in MRR as if it recurred, and in the renewal
       cron ready to chase the customer next year for something they bought outright. */
    raise exception 'FAIL one-time: % subscription(s) created for a one-time invoice, expected 0 — migration 0157 guard is missing from record_payment', n;
  end if;

  raise notice 'PASS: recurring creates a subscription on payment, one-time creates none';
end $$;

select 'PASS' as create_direct_invoice_recurring;

rollback;
