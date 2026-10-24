-- Regression test: generate_invoice (migration 0163) sets the invoice DUE DATE from the
-- quote's payment_terms_days (Net 15 / 30 / 45), falling back to net-30 when it is null.
--
-- ─── REWRITTEN 22 Aug 2026 ──────────────────────────────────────────────────
-- It hardcoded the live tenant and a live customer, so it inserted TESTQ-PT15 and
-- TESTQ-PTNULL into ANUTECH's quote table and raised two invoices there, held back only by
-- the closing exception. It also asserted nothing — the two due dates were formatted into a
-- message with the expected values beside them, for a human to compare. And it had stopped
-- running: customer 53db44e6… was deleted. See AGENTS.md L11.
--
-- The dates are asserted relative to public.ist_today(), never as literals, so this cannot rot.
-- R-1616 (19 Oct 2026): it compared against current_date, which is the UTC day in the DB.
-- generate_invoice stamps dates from public.ist_today() (an invoice day is the IST day,
-- R-1581), so between 00:00 and 05:30 IST the test expected yesterday and failed.

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
  values ('c0de0003-0000-4000-8000-000000000001', 'PAYMENT TERMS TEST', 'pt@example.in', '07', 'PTT1');

insert into public.customers (id, tenant_id, name, country, state_code, state)
  values ('c0de0003-0000-4000-8000-0000000000c1', 'c0de0003-0000-4000-8000-000000000001',
          'Terms Cust', 'India', '07', 'Delhi');

do $$
declare
  v_tenant uuid := 'c0de0003-0000-4000-8000-000000000001';
  v_cust   uuid := 'c0de0003-0000-4000-8000-0000000000c1';
  v_due date;
begin
  -- ── Net 15: the term is honoured ──────────────────────────────────────────
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status, payment_terms_days)
    values ('TESTQ-PT15', v_tenant, v_cust, 'Terms Cust', 11800, 10000, 18, '[]'::jsonb, 'sent', 'awaiting', 15);
  perform public.generate_invoice('TESTQ-PT15');

  select due_date into v_due from public.invoices where quote_id = 'TESTQ-PT15';
  if v_due is null then
    raise exception 'FAIL net15: no due_date stamped at all';
  end if;
  if v_due <> public.ist_today() + 15 then
    raise exception 'FAIL net15: due_date % , expected % (today + 15)', v_due, public.ist_today() + 15;
  end if;

  -- ── NULL term: falls back to net-30, and the fallback is the whole point ──
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status, payment_terms_days)
    values ('TESTQ-PTNULL', v_tenant, v_cust, 'Terms Cust', 11800, 10000, 18, '[]'::jsonb, 'sent', 'awaiting', null);
  perform public.generate_invoice('TESTQ-PTNULL');

  select due_date into v_due from public.invoices where quote_id = 'TESTQ-PTNULL';
  if v_due is null then
    /* A tax invoice with no due date is one the dunning cron can never chase, so it ages
       quietly instead of being followed up. */
    raise exception 'FAIL null-term: no due_date stamped — the net-30 fallback did not fire';
  end if;
  if v_due <> public.ist_today() + 30 then
    raise exception 'FAIL null-term: due_date %, expected % (today + 30 fallback)', v_due, public.ist_today() + 30;
  end if;

  raise notice 'PASS: Net 15 honoured, null term falls back to net-30';
end $$;

select 'PASS' as generate_invoice_payment_terms;

rollback;
