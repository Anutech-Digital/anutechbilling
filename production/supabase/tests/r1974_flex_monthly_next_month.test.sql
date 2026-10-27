-- R-1974 (26 Oct 2026): a monthly (flex) online order is invoiced month by month, as
-- instalments — never once from the quote, and never twice.
-- No migration: this pins what the database already does for the owner's real order
-- (localhost Q-1111-27-0009: Standard x 2 monthly, Rs 2,600 ex-GST, paid Rs 3,068; month 1
-- invoiced as INV-1111-27-0006, an instalment invoice with quote_id NULL).
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Proves:
--   A. generate_invoice on the flex quote is REFUSED (split billing → one period at a time),
--      so "issue the whole quote invoice and set quote.invoice_id" is not a path the
--      online checkout can take — the instalment path is the right one.
--   B. month 1's instalment uses the payment → PAID Rs 3,068, quote_id NULL.
--   C. month 2 (next term, after the renewals cron rolls renewal_date) → PENDING Rs 3,068,
--      paid 0: the month-1 payment is not credited a second time, and the month IS invoiced.
--   D. raising month 1 again returns the same invoice (a repeat delivery makes no second one).

begin;

-- R-1643 / R-1803: a Tax Invoice needs the company's own GSTIN + address. Rolled back with the test.
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
  values ('dddddddd-0000-0000-0000-000000197401','R1974 Co','r1974@example.in','07','R1974');

insert into public.customers (id, tenant_id, name, state_code, country)
  values ('cccccccc-0000-0000-0000-000000197401','dddddddd-0000-0000-0000-000000197401','Flex Buyer 1974','07','India');

insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, subtotal, amount, status,
                           payment_status, billing_cycle, line_items)
  values ('TESTQ-R1974-FLEX', 'dddddddd-0000-0000-0000-000000197401', 'Flex Buyer 1974',
          'cccccccc-0000-0000-0000-000000197401', 18, 2600, 3068, 'accepted', 'received', 'monthly',
          '[{"name":"Google Workspace Standard — monthly (flex)","qty":2,"rate":1300,"cost":0,"commitment":"monthly"}]'::jsonb);

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at)
  values (gen_random_uuid(), 'dddddddd-0000-0000-0000-000000197401', 'TESTQ-R1974-FLEX',
          'cccccccc-0000-0000-0000-000000197401', 3068, 'razorpay', 'received', now(), now());

-- What record_payment makes for a flex line: monthly, a one-month term.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, quote_id)
  values ('eeeeeeee-0000-0000-0000-000000197401', 'dddddddd-0000-0000-0000-000000197401',
          'cccccccc-0000-0000-0000-000000197401', 'Flex Buyer 1974', 'Workspace Standard', 'google'::vendor, 2, 2600,
          'monthly'::billing_cycle, 1, public.ist_today(), (public.ist_today() + interval '1 month')::date, 'TESTQ-R1974-FLEX');

-- Month 1 (this term) and month 2 (the next term, after the roll). Both due today so the
-- RPC raises them; what is under test is the money, not the date.
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
values
  ('bbbbbbbb-0000-0000-0000-000000197401', 'dddddddd-0000-0000-0000-000000197401', 'eeeeeeee-0000-0000-0000-000000197401',
   public.ist_today(), 1, public.ist_today(), public.ist_today(), (public.ist_today() + interval '1 month')::date, 2600, 18),
  ('bbbbbbbb-0000-0000-0000-000000197402', 'dddddddd-0000-0000-0000-000000197401', 'eeeeeeee-0000-0000-0000-000000197401',
   (public.ist_today() + interval '1 month')::date, 1, public.ist_today(),
   (public.ist_today() + interval '1 month')::date, (public.ist_today() + interval '2 months')::date, 2600, 18);

do $$
declare
  r1 record; r1b record; r2 record; i record; v_refused boolean := false; v_msg text;
begin
  -- A. the whole-quote invoice is refused for a monthly (flex) order
  begin
    perform public.generate_invoice('TESTQ-R1974-FLEX');
  exception when others then
    v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused then
    raise exception 'A FAIL: generate_invoice issued a whole-quote invoice for a monthly (flex) order'; end if;
  if v_msg !~* 'monthly|one period at a time|instal' then
    raise exception 'A FAIL: refused for another reason: %', v_msg; end if;
  raise notice 'A PASS: generate_invoice refused — %', left(v_msg, 120);

  -- B. month 1 is paid from the online payment
  select * into r1 from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000197401');
  select * into i from public.invoices where id = r1.invoice_id;
  if i.amount <> 3068 or i.status::text <> 'paid' or i.paid_amount <> 3068 or i.quote_id is not null then
    raise exception 'B FAIL: month 1 amount % status % paid % quote_id % (want 3068 paid 3068 NULL)',
      i.amount, i.status, i.paid_amount, i.quote_id; end if;
  raise notice 'B PASS: month 1 % — Rs % paid', i.id, i.amount;

  -- D. a repeat raise gives the same invoice, not a second one
  select * into r1b from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000197401');
  if r1b.invoice_id is distinct from r1.invoice_id or not r1b.already_raised then
    raise exception 'D FAIL: repeat raise gave % (already_raised %), want % again', r1b.invoice_id, r1b.already_raised, r1.invoice_id; end if;
  raise notice 'D PASS: repeat raise returns % (already raised)', r1b.invoice_id;

  -- C. month 2 is invoiced, and demanded — the month-1 payment is not reused
  select * into r2 from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000197402');
  select * into i from public.invoices where id = r2.invoice_id;
  if r2.invoice_id is null or r2.invoice_id = r1.invoice_id then
    raise exception 'C FAIL: month 2 not invoiced on its own (got %)', r2.invoice_id; end if;
  if i.amount <> 3068 or i.status::text <> 'pending' or coalesce(i.paid_amount, 0) <> 0 then
    raise exception 'C FAIL: month 2 amount % status % paid % (want 3068 pending 0 — month-1 money credited twice?)',
      i.amount, i.status, i.paid_amount; end if;
  raise notice 'C PASS: month 2 % — Rs % pending, paid 0', i.id, i.amount;
end $$;

select 'R-1974 flex monthly invoiced per month (refused whole-quote, month 1 paid, month 2 pending): ALL PASS' as result;

rollback;
