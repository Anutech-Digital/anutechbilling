-- R-2101 (29 Oct 2026): a part's tax invoice shows QTY = seats and the per-seat rate, not QTY 1.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Localhost money check (efbce1ecc): a quote of Business Starter 57 × ₹3,200/yr + Business
-- Standard 13 × ₹11,000/yr, annual commitment billed quarterly, paid ₹95,993 for Q1 → ONE
-- invoice (R-2092) whose lines read QTY 1 × ₹45,600 and QTY 1 × ₹35,750. A GST tax invoice shows
-- the quantity and unit value: 57 × ₹800 and 13 × ₹2,750.
--   A. the two-subscription quote, Q1 paid → ONE invoice ₹95,993, lines 57 × 800 and 13 × 2,750
--      (Standard laid at 35,751 from mrr; the quote-period rounding makes it 35,750 = 13 × 2,750)
--   B. a single subscription, 3 seats, part ₹2,000 (not a whole rupee per seat) → QTY 1 × ₹2,000,
--      seats in the description — qty × rate always equals the line's taxable
--   C. every line: qty × rate = taxable, sum of lines = taxable_value

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
  values ('dddddddd-0000-0000-0000-000000210101','R2101 MH Co','r2101a@example.in','27','R101');

insert into public.customers (id, tenant_id, name, state_code, country)
select ('cccccccc-0000-0000-0000-00000021010' || n)::uuid, 'dddddddd-0000-0000-0000-000000210101', 'Cust 2101-' || n, '27', 'India'
  from generate_series(1, 2) n;

insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
values ('TESTQ-R2101-1', 'dddddddd-0000-0000-0000-000000210101', 'Cust 2101-1', 'cccccccc-0000-0000-0000-000000210101',
        18, 383972, 325400, 'quarterly', 'accepted',
        '[{"name":"Google Workspace Business Starter","qty":57,"rate":3200,"commitment":"annual_quarterly"},
          {"name":"Google Workspace Business Standard","qty":13,"rate":11000,"commitment":"annual_quarterly"}]'::jsonb),
       ('TESTQ-R2101-2', 'dddddddd-0000-0000-0000-000000210101', 'Cust 2101-2', 'cccccccc-0000-0000-0000-000000210102',
        18, 9440, 8000, 'quarterly', 'accepted',
        '[{"name":"Google Workspace Business Plus","qty":3,"rate":2666.67,"commitment":"annual_quarterly"}]'::jsonb);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status, created_at)
values ('eeeeeeee-0000-0000-0000-000000210111', 'dddddddd-0000-0000-0000-000000210101', 'cccccccc-0000-0000-0000-000000210101', 'Cust 2101-1',
        'Google Workspace Business Starter', 'google'::vendor, 57, 15200, 'quarterly'::billing_cycle, 'TESTQ-R2101-1',
        public.ist_today() - 7, 'active', now() - interval '1 hour'),
       ('eeeeeeee-0000-0000-0000-000000210112', 'dddddddd-0000-0000-0000-000000210101', 'cccccccc-0000-0000-0000-000000210101', 'Cust 2101-1',
        'Google Workspace Business Standard', 'google'::vendor, 13, 11917, 'quarterly'::billing_cycle, 'TESTQ-R2101-1',
        public.ist_today() - 7, 'active', now() - interval '59 minutes'),
       ('eeeeeeee-0000-0000-0000-000000210121', 'dddddddd-0000-0000-0000-000000210101', 'cccccccc-0000-0000-0000-000000210102', 'Cust 2101-2',
        'Google Workspace Business Plus', 'google'::vendor, 3, 667, 'quarterly'::billing_cycle, 'TESTQ-R2101-2',
        public.ist_today() - 7, 'active', now() - interval '1 hour');

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select v.id::uuid, 'dddddddd-0000-0000-0000-000000210101', v.sub::uuid, public.ist_today() - 7, 1, public.ist_today() - 7,
       public.ist_today() - 7, (public.ist_today() - 7 + interval '3 months')::date, v.taxable, 18
  from (values ('bbbbbbbb-0000-0000-0000-000000210111', 'eeeeeeee-0000-0000-0000-000000210111', 45600),
               ('bbbbbbbb-0000-0000-0000-000000210112', 'eeeeeeee-0000-0000-0000-000000210112', 35751),
               ('bbbbbbbb-0000-0000-0000-000000210121', 'eeeeeeee-0000-0000-0000-000000210121', 2000)) v(id, sub, taxable);

do $$
begin
  perform public.record_payment('TESTQ-R2101-1', 95993, 'upi', 'R2101-PAY-1');
  perform public.record_payment('TESTQ-R2101-2', 2360, 'upi', 'R2101-PAY-2');
end $$;

do $$
declare
  r jsonb; v_i record; v_bad integer;
begin
  -- A. two subscriptions, Q1 paid → ONE invoice, QTY 57 / 13
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000210111', false);
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000210112', false);
  select * into v_i from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000210101';
  if v_i.id is null or v_i.amount <> 95993 or v_i.taxable_value <> 81350 or jsonb_array_length(v_i.line_items) <> 2 then
    raise exception 'A FAIL: invoice % amount % taxable % lines %', v_i.id, v_i.amount, v_i.taxable_value, v_i.line_items;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_i.line_items) l
                  where l->>'name' like '%Starter' and (l->>'qty')::int = 57 and (l->>'rate')::int = 800)
     or not exists (select 1 from jsonb_array_elements(v_i.line_items) l
                  where l->>'name' like '%Standard' and (l->>'qty')::int = 13 and (l->>'rate')::int = 2750) then
    raise exception 'A FAIL: lines are not 57 x 800 and 13 x 2,750: %', v_i.line_items;
  end if;
  raise notice 'A PASS: one Q1 invoice %, lines 57 x 800 + 13 x 2,750', v_i.id;

  -- B. 2,000 over 3 seats → QTY 1 × 2,000, seats in the description
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000210121', false);
  select * into v_i from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000210102';
  if v_i.id is null or jsonb_array_length(v_i.line_items) <> 1
     or (v_i.line_items->0->>'qty')::int <> 1 or (v_i.line_items->0->>'rate')::int <> 2000
     or v_i.line_items->0->>'description' not like '3 seats %' then
    raise exception 'B FAIL: % %', r, v_i.line_items;
  end if;
  raise notice 'B PASS: 2,000 over 3 seats stays QTY 1 x 2,000 (3 seats in the description)';

  -- C. qty × rate = the invoice's taxable on both
  select count(*) into v_bad from public.invoices i
   where i.customer_id in ('cccccccc-0000-0000-0000-000000210101', 'cccccccc-0000-0000-0000-000000210102')
     and (select sum((l->>'qty')::numeric * (l->>'rate')::numeric) from jsonb_array_elements(i.line_items) l) <> i.taxable_value;
  if v_bad <> 0 then raise exception 'C FAIL: % invoice(s) whose qty x rate <> taxable', v_bad; end if;
  raise notice 'C PASS: qty x rate = taxable on every line';
end $$;

select 'R-2101 part invoice qty: ALL PASS' as result;

rollback;
