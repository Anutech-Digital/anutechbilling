-- R-2044 (28 Oct 2026, Pardeep): a subscription billed in parts gets a PAYMENT REQUEST (quote)
-- for each part on its date — not a tax invoice. Paying the request raises that part's tax
-- invoice (raise_subscription_billing, the one instalment invoice path), issued paid.
-- Migration 20261028025317_r2044_part_payment_requests.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Annual commitment, billed quarterly: ₹8,000 taxable a year → ₹2,000 + 18% = ₹2,360 a part.
--   A. Part 1 of the sale (sale quote paid ₹2,360)      → its tax invoice, paid
--   B. Part 2 on its date (dry run)                      → would make a request; nothing written
--   C. Part 2 on its date                                → a ₹2,360 request linked to the part; NO invoice
--   D. The cron runs again                               → the same request, still one, still no invoice
--   E. generate_invoice on the request                   → refused (no whole invoice from a part request)
--   F. The subscription's outstanding                    → 0 (part 2 is owed on its request, not a receivable)
--   G. Pay the request (record_payment)                  → exactly one tax invoice for part 2, paid,
--                                                          linked on the request; the request is closed
--   H. "Customer stopped" on another unpaid request      → request rejected, subscription cancelled,
--                                                          no invoice for that part
--   I. Paid up front for the year (R-375)                → part 2 is invoiced, paid — no request
--   J. Customer switch "Invoice on due date" ON          → part 2 invoiced on its date (unpaid, as
--                                                          before R-2044) — no request
-- C also checks the wording (Pardeep, 28 Oct): "Advance payment for Q2 · <dates>", due on the
-- bill date (payment terms 0), no expiry.

begin;

-- R-1643 / R-1803: issuing a Tax Invoice needs the company's own GSTIN + address.
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

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000204401','R2044 Co','r2044@example.in','07','R2044');

insert into public.customers (id, tenant_id, name, state_code, country, invoice_parts_on_due_date)
  values ('cccccccc-0000-0000-0000-000000204401','dddddddd-0000-0000-0000-000000204401','Delhi 2044','07','India', false),
         ('cccccccc-0000-0000-0000-000000204402','dddddddd-0000-0000-0000-000000204401','Due-date 2044','07','India', true);

-- Three sale quotes: 1 = Q1 paid (the normal case), 2 = Q1 paid (for "Customer stopped"),
-- 3 = the whole year paid up front.
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, line_items)
select 'TESTQ-R2044-' || n, 'dddddddd-0000-0000-0000-000000204401', 'Delhi 2044',
       'cccccccc-0000-0000-0000-000000204401', 18, 9440, 8000, 'quarterly',
       '[{"name":"Workspace Starter","qty":1,"rate":8000,"commitment":"annual_quarterly"}]'::jsonb
  from generate_series(1, 4) n;
update public.quotes set customer_id = 'cccccccc-0000-0000-0000-000000204402', customer_name = 'Due-date 2044'
 where id = 'TESTQ-R2044-4';

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, reference, received_at, created_at)
select gen_random_uuid(), 'dddddddd-0000-0000-0000-000000204401', 'TESTQ-R2044-' || n,
       'cccccccc-0000-0000-0000-000000204401', amt, 'upi', 'received', 'R2044-SALE-' || n, now(), now()
  from (values (1, 2360), (2, 2360), (3, 9440), (4, 2360)) v(n, amt);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status)
select ('eeeeeeee-0000-0000-0000-00000020440' || n)::uuid, 'dddddddd-0000-0000-0000-000000204401',
       'cccccccc-0000-0000-0000-000000204401', 'Delhi 2044', 'Workspace Starter', 'google'::vendor, 2, 667,
       'quarterly'::billing_cycle, 'TESTQ-R2044-' || n, public.ist_today() - 92, 'active'
  from generate_series(1, 4) n;
update public.subscriptions set customer_id = 'cccccccc-0000-0000-0000-000000204402', customer_name = 'Due-date 2044'
 where id = 'eeeeeeee-0000-0000-0000-000000204404';

-- Part 1 began 92 days ago, part 2 is due today.
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-0000002044' || n || p)::uuid, 'dddddddd-0000-0000-0000-000000204401',
       ('eeeeeeee-0000-0000-0000-00000020440' || n)::uuid,
       public.ist_today() - 92, p,
       case p when 1 then public.ist_today() - 92 else public.ist_today() end,
       case p when 1 then public.ist_today() - 92 else public.ist_today() end,
       case p when 1 then public.ist_today() - 1 else public.ist_today() + 89 end,
       2000, 18
  from generate_series(1, 4) n, generate_series(1, 2) p;

do $$
declare
  r jsonb; r2 jsonb; v_q text; v_inv text; v_n integer; v_i record; v_owed integer; v_st text;
begin
  -- A. part 1 of the sale → invoiced, paid
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204411', false);
  if r->>'action' <> 'invoice' then raise exception 'A FAIL: %', r; end if;
  select * into v_i from public.invoices where id = r->>'invoice_id';
  if v_i.status::text <> 'paid' or v_i.amount <> 2360 then
    raise exception 'A FAIL: part 1 invoice % / % (want paid / 2360)', v_i.status, v_i.amount; end if;
  raise notice 'A PASS: part 1 of the sale → % paid', v_i.id;

  -- B. dry run on part 2 → would request, writes nothing
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204412', true);
  if r->>'action' <> 'request' or (r->>'gross')::int <> 2360 then raise exception 'B FAIL: %', r; end if;
  select count(*) into v_n from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000204412';
  if v_n <> 0 then raise exception 'B FAIL: dry run wrote % request(s)', v_n; end if;
  raise notice 'B PASS: dry run → %', r;

  -- C. part 2 → a request, no invoice
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204412', false);
  if r->>'action' <> 'request' or coalesce((r->>'created')::boolean, false) is not true then raise exception 'C FAIL: %', r; end if;
  v_q := r->>'quote_id';
  select count(*) into v_n from public.quotes
   where id = v_q and amount = 2360 and subtotal = 2000 and status = 'sent' and is_one_off
     and subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000204412'
     and payment_terms_days = 0 and expires_date is null
     and line_items->0->>'name' = 'Advance payment for Q2 · '
           || to_char(public.ist_today(), 'FMDD Mon') || '–' || to_char(public.ist_today() + 88, 'FMDD Mon YYYY');
  if v_n <> 1 then raise exception 'C FAIL: request % not as expected: %', v_q,
    (select jsonb_build_object('name', line_items->0->>'name', 'terms', payment_terms_days, 'expires', expires_date) from public.quotes where id = v_q); end if;
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204412') is not null then
    raise exception 'C FAIL: part 2 was invoiced before it was paid'; end if;
  raise notice 'C PASS: part 2 → payment request % (₹2,360), no invoice', v_q;

  -- D. the cron runs again → same request, still no invoice
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204412', false);
  if r2->>'action' <> 'request_open' or r2->>'quote_id' <> v_q then raise exception 'D FAIL: %', r2; end if;
  select count(*) into v_n from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000204412';
  if v_n <> 1 then raise exception 'D FAIL: % requests for one part', v_n; end if;
  raise notice 'D PASS: re-run keeps one request';

  -- E. no whole invoice from the request
  begin
    perform public.generate_invoice(v_q);
    raise exception 'E FAIL: generate_invoice issued a whole invoice for part request %', v_q;
  exception when check_violation then
    raise notice 'E PASS: generate_invoice refused: %', sqlerrm;
  end;

  -- F. the subscription owes nothing on the sale quote (part 2 is on its request)
  v_owed := public.split_outstanding_for('TESTQ-R2044-1', public.ist_today() - 92);
  if v_owed is distinct from 0 then raise exception 'F FAIL: subscription owes % (want 0)', v_owed; end if;
  raise notice 'F PASS: outstanding 0 while the request is unpaid';

  -- G. pay the request → one tax invoice, paid
  perform public.record_payment(v_q, 2360, 'upi', 'R2044-PART-2');
  select invoice_id into v_inv from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204412';
  if v_inv is null then raise exception 'G FAIL: paying the request raised no invoice'; end if;
  select * into v_i from public.invoices where id = v_inv;
  if v_i.status::text <> 'paid' or v_i.amount <> 2360 or v_i.quote_id is not null or v_i.invoice_date <> public.ist_today() then
    raise exception 'G FAIL: invoice % status % amount % quote % date %', v_i.id, v_i.status, v_i.amount, v_i.quote_id, v_i.invoice_date; end if;
  if (select invoice_id from public.quotes where id = v_q) is distinct from v_inv then
    raise exception 'G FAIL: the request does not point at its invoice'; end if;
  select count(*) into v_n from public.invoices i join public.subscription_billings b on b.invoice_id = i.id
   where b.subscription_id = 'eeeeeeee-0000-0000-0000-000000204401';
  if v_n <> 2 then raise exception 'G FAIL: % instalment invoices (want 2)', v_n; end if;
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204412', false);
  if r2->>'action' <> 'already_invoiced' then raise exception 'G FAIL: re-run %', r2; end if;
  raise notice 'G PASS: paid → % (paid, ₹2,360), exactly one', v_inv;

  -- H. "Customer stopped" on subscription 2's request
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204421', false);   -- its part 1
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204422', false);
  if r->>'action' <> 'request' then raise exception 'H FAIL: %', r; end if;
  r2 := public.stop_part_payment_request(r->>'quote_id', 'cancel', 'Customer stopped paying');
  select status::text into v_st from public.quotes where id = r->>'quote_id';
  if v_st <> 'rejected' then raise exception 'H FAIL: request is %', v_st; end if;
  select status::text into v_st from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000204402';
  if v_st <> 'cancelled' then raise exception 'H FAIL: subscription is %', v_st; end if;
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204422') is not null then
    raise exception 'H FAIL: stopped part has an invoice'; end if;
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204422', false);
  if r2->>'action' <> 'request_open' then raise exception 'H FAIL: re-run after stop %', r2; end if;
  raise notice 'H PASS: Customer stopped → request rejected, subscription cancelled, nothing invoiced';

  -- I. paid up front → part 2 invoiced, paid, no request
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204431', false);
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204432', false);
  if r->>'action' <> 'invoice' then raise exception 'I FAIL: %', r; end if;
  if (select status::text from public.invoices where id = r->>'invoice_id') <> 'paid' then
    raise exception 'I FAIL: up-front part 2 invoice not paid'; end if;
  if exists (select 1 from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000204432') then
    raise exception 'I FAIL: a request was made for a part already paid'; end if;
  raise notice 'I PASS: paid up front → part 2 invoiced paid, no request';

  -- J. the customer's "Invoice on due date" switch ON → the old path: invoiced on the date, unpaid
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204441', false);
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204442', false);
  if r->>'action' <> 'invoice' then raise exception 'J FAIL: %', r; end if;
  if (select status::text from public.invoices where id = r->>'invoice_id') <> 'pending' then
    raise exception 'J FAIL: on-due-date invoice should be pending (unpaid)'; end if;
  if exists (select 1 from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000204442') then
    raise exception 'J FAIL: a request was made for an invoice-on-due-date customer'; end if;
  raise notice 'J PASS: Invoice on due date → part 2 invoiced on its date (pending), no request';
end $$;

select 'R-2044 part payment requests: ALL PASS' as result;

rollback;
