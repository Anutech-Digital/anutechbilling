-- R-2048 (28 Oct 2026, follow-up to R-2044): the FIRST part of a sale is tax-invoiced only when
-- money covers it. Migration 20261028043325_r2048_unpaid_first_part_no_invoice.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Found on localhost: an accepted-but-unpaid quarterly sale got an UNPAID tax invoice for its
-- first part from the billing job, and a second unpaid sale (customer with no state) made the
-- job report "errors 1" (raise_subscription_billing refused it).
--
-- Annual commitment, billed quarterly: ₹2,000 taxable a part + 18% = ₹2,360.
--   A. Sale quote accepted, nothing paid (dry run and live) → NO invoice, NO new request: the
--      open sale quote is the request ('request_open', sale_quote)
--   B. The sale quote is paid ₹2,360 → the next run invoices part 1, paid
--   C. Sale quote paid at the sale → part 1 invoiced, paid (unchanged)
--   D. Unpaid, customer's "Invoice on due date" ON → part 1 invoiced on its date (pending)
--   E. Unpaid, sale quote rejected → part 1 gets its own payment request, no invoice
--   F. Unpaid, customer has no state → no error, no invoice (the "errors 1")

begin;

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
  values ('dddddddd-0000-0000-0000-000000204801','R2048 Co','r2048@example.in','07','R2048');

insert into public.customers (id, tenant_id, name, state_code, country, invoice_parts_on_due_date)
  values ('cccccccc-0000-0000-0000-000000204801','dddddddd-0000-0000-0000-000000204801','Delhi 2048','07','India', false),
         ('cccccccc-0000-0000-0000-000000204802','dddddddd-0000-0000-0000-000000204801','Due-date 2048','07','India', true),
         ('cccccccc-0000-0000-0000-000000204803','dddddddd-0000-0000-0000-000000204801','No-state 2048', null, 'India', false);

-- Sale quotes 1..5, all accepted; customer per case. Sale 4 is rejected.
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
select 'TESTQ-R2048-' || n, 'dddddddd-0000-0000-0000-000000204801', 'Delhi 2048', c::uuid, 18, 9440, 8000, 'quarterly', 'accepted',
       '[{"name":"Workspace Starter","qty":1,"rate":8000,"commitment":"annual_quarterly"}]'::jsonb
  from (values (1, 'cccccccc-0000-0000-0000-000000204801'), (2, 'cccccccc-0000-0000-0000-000000204801'),
               (3, 'cccccccc-0000-0000-0000-000000204802'), (4, 'cccccccc-0000-0000-0000-000000204801'),
               (5, 'cccccccc-0000-0000-0000-000000204803')) v(n, c);
update public.quotes set status = 'rejected' where id = 'TESTQ-R2048-4';

-- Only sale 2 was paid at the sale.
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, reference, received_at, created_at)
values (gen_random_uuid(), 'dddddddd-0000-0000-0000-000000204801', 'TESTQ-R2048-2',
        'cccccccc-0000-0000-0000-000000204801', 2360, 'upi', 'received', 'R2048-SALE-2', now(), now());

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status)
select ('eeeeeeee-0000-0000-0000-00000020480' || n)::uuid, 'dddddddd-0000-0000-0000-000000204801',
       q.customer_id, 'Delhi 2048', 'Workspace Starter', 'google'::vendor, 2, 667,
       'quarterly'::billing_cycle, q.id, public.ist_today() - 17, 'active'
  from generate_series(1, 5) n join public.quotes q on q.id = 'TESTQ-R2048-' || n;

-- Part 1 began 17 days ago (due).
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-0000002048' || n || '1')::uuid, 'dddddddd-0000-0000-0000-000000204801',
       ('eeeeeeee-0000-0000-0000-00000020480' || n)::uuid,
       public.ist_today() - 17, 1, public.ist_today() - 17, public.ist_today() - 17, public.ist_today() + 75,
       2000, 18
  from generate_series(1, 5) n;

do $$
declare
  r jsonb; v_i record; v_n integer;
begin
  -- A. accepted, unpaid → no invoice, no new request; the sale quote is the request
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204811', true);
  if r->>'action' <> 'request_open' or r->>'quote_id' <> 'TESTQ-R2048-1' then raise exception 'A FAIL (dry): %', r; end if;
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204811', false);
  if r->>'action' <> 'request_open' or r->>'quote_id' <> 'TESTQ-R2048-1'
     or coalesce((r->>'sale_quote')::boolean, false) is not true then raise exception 'A FAIL: %', r; end if;
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204811') is not null then
    raise exception 'A FAIL: unpaid first part got a tax invoice'; end if;
  select count(*) into v_n from public.invoices where tenant_id = 'dddddddd-0000-0000-0000-000000204801';
  if v_n <> 0 then raise exception 'A FAIL: % invoice(s) for an unpaid sale', v_n; end if;
  if exists (select 1 from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000204811') then
    raise exception 'A FAIL: a second request was made next to the open sale quote'; end if;
  raise notice 'A PASS: accepted, unpaid → no invoice, sale quote is the request';

  -- B. the sale quote is paid → part 1 invoiced, paid
  perform public.record_payment('TESTQ-R2048-1', 2360, 'upi', 'R2048-PAY-1');
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204811', false);
  if r->>'action' <> 'invoice' then raise exception 'B FAIL: %', r; end if;
  select * into v_i from public.invoices where id = r->>'invoice_id';
  if v_i.status::text <> 'paid' or v_i.amount <> 2360 then raise exception 'B FAIL: % / %', v_i.status, v_i.amount; end if;
  raise notice 'B PASS: sale quote paid → % paid', v_i.id;

  -- C. paid at the sale → invoiced, paid
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204821', false);
  if r->>'action' <> 'invoice' then raise exception 'C FAIL: %', r; end if;
  if (select status::text from public.invoices where id = r->>'invoice_id') <> 'paid' then raise exception 'C FAIL: not paid'; end if;
  raise notice 'C PASS: paid first part still invoiced';

  -- D. Invoice on due date ON → invoiced on its date, unpaid
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204831', false);
  if r->>'action' <> 'invoice' then raise exception 'D FAIL: %', r; end if;
  if (select status::text from public.invoices where id = r->>'invoice_id') <> 'pending' then raise exception 'D FAIL: not pending'; end if;
  raise notice 'D PASS: Invoice on due date → pending invoice';

  -- E. sale quote rejected → its own request
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204841', false);
  if r->>'action' <> 'request' or coalesce((r->>'created')::boolean, false) is not true then raise exception 'E FAIL: %', r; end if;
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204841') is not null then
    raise exception 'E FAIL: invoiced'; end if;
  raise notice 'E PASS: rejected sale quote → request %', r->>'quote_id';

  -- F. no state on the customer, unpaid → no error, no invoice
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204851', false);
  if r->>'action' <> 'request_open' or r->>'quote_id' <> 'TESTQ-R2048-5' then raise exception 'F FAIL: %', r; end if;
  raise notice 'F PASS: unpaid sale without a state → no error';
end $$;

select 'R-2048 unpaid first part: ALL PASS' as result;

rollback;
