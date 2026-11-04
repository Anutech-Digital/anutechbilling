-- R-2230 (Zoho Billing audit A6): every payment-request part has a due date, and the customer's
-- "unpaid now" / credit limit counts what those requests still owe.
-- Migration 20261101184900_r2230_part_due_dates.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Annual commitment billed quarterly: ₹2,000 taxable a part → ₹2,360 with 18% GST.
--   A. Customer on Net 15                 → part 2's request is due part start + 15 (stored on the
--                                           part: subscription_billings.due_on), the request says so
--                                           and carries payment terms 15. Amount unchanged (₹2,360).
--   B. Customer without terms, sale Net 10 → due part start + 10 (the sale quote's terms).
--   C. Neither has terms                    → due on the part start (R-2044: prepaid, terms 0).
--   D. open_part_requests (as the owner)    → A's request: ₹2,360 still due, its due date; after a
--                                           ₹1,000 part payment ₹1,360; never another company's.
--   E. Pay later / credit limit             → customer A (limit ₹3,000) owes ₹1,360 on the request;
--                                           a ₹1,180 credit sale is OVER the limit (before R-2230 the
--                                           request was not counted and it went through).
--   F. A paid request leaves the list       → nothing still due.

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

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000223001','R2230 Co','r2230@example.in','07','RA30'),
  ('dddddddd-0000-0000-0000-000000223002','R2230 Other','r2230o@example.in','07','RA31');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000223001','owner2230@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000223001','dddddddd-0000-0000-0000-000000223001','owner2230@example.in','Owner 2230','owner', now() - interval '1 day');

-- 1 = Net 15 (limit ₹3,000), 2 = no terms (sale quote Net 10), 3 = no terms anywhere, 4 = other company.
insert into public.customers (id, tenant_id, name, state_code, country, payment_terms_days, credit_limit) values
  ('cccccccc-0000-0000-0000-000000223001','dddddddd-0000-0000-0000-000000223001','Net15 2230','07','India', 15, 3000),
  ('cccccccc-0000-0000-0000-000000223002','dddddddd-0000-0000-0000-000000223001','SaleTerms 2230','07','India', null, null),
  ('cccccccc-0000-0000-0000-000000223003','dddddddd-0000-0000-0000-000000223001','NoTerms 2230','07','India', null, null),
  ('cccccccc-0000-0000-0000-000000223004','dddddddd-0000-0000-0000-000000223002','Other 2230','07','India', 7, null);

insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, line_items, payment_terms_days)
select 'TESTQ-R2230-' || n, case n when 4 then 'dddddddd-0000-0000-0000-000000223002' else 'dddddddd-0000-0000-0000-000000223001' end::uuid,
       'C' || n, ('cccccccc-0000-0000-0000-00000022300' || n)::uuid, 18, 9440, 8000, 'quarterly',
       '[{"name":"Workspace Starter","qty":1,"rate":8000,"commitment":"annual_quarterly"}]'::jsonb,
       case n when 2 then 10 else null end
  from generate_series(1, 4) n;

-- Part 1 of each sale is paid (₹2,360) — so part 2 gets its own request.
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, reference, received_at, created_at)
select gen_random_uuid(), case n when 4 then 'dddddddd-0000-0000-0000-000000223002' else 'dddddddd-0000-0000-0000-000000223001' end::uuid,
       'TESTQ-R2230-' || n, ('cccccccc-0000-0000-0000-00000022300' || n)::uuid, 2360, 'upi', 'received', 'R2230-SALE-' || n, now(), now()
  from generate_series(1, 4) n;

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status)
select ('eeeeeeee-0000-0000-0000-00000022300' || n)::uuid,
       case n when 4 then 'dddddddd-0000-0000-0000-000000223002' else 'dddddddd-0000-0000-0000-000000223001' end::uuid,
       ('cccccccc-0000-0000-0000-00000022300' || n)::uuid, 'C' || n, 'Workspace Starter', 'google'::vendor, 2, 667,
       'quarterly'::billing_cycle, 'TESTQ-R2230-' || n, public.ist_today() - 92, 'active'
  from generate_series(1, 4) n;

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-0000002230' || n || p)::uuid,
       case n when 4 then 'dddddddd-0000-0000-0000-000000223002' else 'dddddddd-0000-0000-0000-000000223001' end::uuid,
       ('eeeeeeee-0000-0000-0000-00000022300' || n)::uuid,
       public.ist_today() - 92, p,
       case p when 1 then public.ist_today() - 92 else public.ist_today() end,
       case p when 1 then public.ist_today() - 92 else public.ist_today() end,
       case p when 1 then public.ist_today() - 1 else public.ist_today() + 89 end,
       2000, 18
  from generate_series(1, 4) n, generate_series(1, 2) p;

-- The billing cron (no jwt = trusted): part 1 invoiced (paid), part 2 → its payment request.
do $$
declare r jsonb; v_q record; n int;
begin
  for n in 1..4 loop
    perform public.bill_subscription_instalment(('bbbbbbbb-0000-0000-0000-0000002230' || n || '1')::uuid, false);
    r := public.bill_subscription_instalment(('bbbbbbbb-0000-0000-0000-0000002230' || n || '2')::uuid, false);
    if r->>'action' <> 'request' then raise exception 'SETUP FAIL: part 2 of sub % → %', n, r; end if;
  end loop;

  -- A. Net 15 customer
  select q.* into v_q from public.quotes q where q.subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000223012';
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000223012')
     is distinct from public.ist_today() + 15 then
    raise exception 'A FAIL: part due_on % (want part start + 15 = %)',
      (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000223012'), public.ist_today() + 15; end if;
  if v_q.payment_terms_days is distinct from 15 then raise exception 'A FAIL: request terms % (want 15)', v_q.payment_terms_days; end if;
  if v_q.notes not like '%Due on ' || to_char(public.ist_today() + 15, 'FMDD Mon YYYY') || '%' then
    raise exception 'A FAIL: request text does not name the due date: %', v_q.notes; end if;
  if v_q.amount <> 2360 or v_q.subtotal <> 2000 or v_q.tax_rate <> 18 then
    raise exception 'A FAIL: amounts changed % / % / %', v_q.amount, v_q.subtotal, v_q.tax_rate; end if;
  raise notice 'A PASS: Net 15 → request % due %', v_q.id, public.ist_today() + 15;

  -- B. no customer terms, sale quote Net 10
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000223022')
     is distinct from public.ist_today() + 10 then
    raise exception 'B FAIL: due_on % (want + 10 from the sale quote)',
      (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000223022'); end if;
  raise notice 'B PASS: sale quote terms used when the customer has none';

  -- C. no terms anywhere → due on the part start (R-2044 prepaid)
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000223032')
     is distinct from public.ist_today() then
    raise exception 'C FAIL: due_on % (want the part start)',
      (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000223032'); end if;
  if (select payment_terms_days from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000223032') <> 0 then
    raise exception 'C FAIL: request terms not 0'; end if;
  raise notice 'C PASS: no terms → due on the part start';
end $$;

-- As the OWNER of R2230 Co (RLS applies to open_part_requests).
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000223001","role":"authenticated"}', true);
set local role authenticated;

do $$
declare v record; n int;
begin
  -- D. what the request still owes
  select count(*) into n from public.open_part_requests('cccccccc-0000-0000-0000-000000223001', null);
  if n <> 1 then raise exception 'D FAIL: % open request rows for customer 1 (want 1)', n; end if;
  select * into v from public.open_part_requests('cccccccc-0000-0000-0000-000000223001', null);
  if v.still_due <> 2360 or v.due_on <> public.ist_today() + 15 or not v.is_lead
     or v.subscription_id <> 'eeeeeeee-0000-0000-0000-000000223001' or v.period_index <> 2 then
    raise exception 'D FAIL: row %', row_to_json(v); end if;
  select count(*) into n from public.open_part_requests(null, null);
  if n <> 3 then raise exception 'D FAIL: % rows for the company (want 3 — never the other company''s)', n; end if;
  select count(*) into n from public.open_part_requests(null, 'eeeeeeee-0000-0000-0000-000000223002');
  if n <> 1 then raise exception 'D FAIL: % rows for subscription 2 (want 1)', n; end if;
  raise notice 'D PASS: open_part_requests → ₹2,360 due %, company-scoped', v.due_on;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);
do $$
declare v_q text;
begin
  select id into v_q from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000223012';
  perform public.record_payment(v_q, 1000, 'upi', 'R2230-PART-1');
  if (select still_due from public.open_part_requests('cccccccc-0000-0000-0000-000000223001', null)) <> 1360 then
    raise exception 'D FAIL: after ₹1,000 still due % (want 1360)',
      (select still_due from public.open_part_requests('cccccccc-0000-0000-0000-000000223001', null)); end if;
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000223012') is not null then
    raise exception 'D FAIL: a part payment raised the invoice'; end if;
  raise notice 'D PASS: part-paid request → ₹1,360 still due';
end $$;

-- E. Credit limit: a monthly credit sale of ₹1,180 for customer 1 (limit ₹3,000, ₹1,360 on the request).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values ('Q-R2230-CREDIT','dddddddd-0000-0000-0000-000000223001','cccccccc-0000-0000-0000-000000223001','Net15 2230',
          2360, 2000, 0, 18, 'accepted', 'awaiting',
          '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":2000,"commitment":"monthly","domain":"shop.net15.in"}]'::jsonb);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000223001","role":"authenticated"}', true);
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.activate_quote_on_credit('Q-R2230-CREDIT', 15, false);
  exception when check_violation then
    msg := sqlerrm;
    ok := sqlerrm like '%Approve over limit%' and sqlerrm like '%3720%';
  end;
  if not ok then raise exception 'E FAIL: ₹2,360 sale + ₹1,360 open request vs limit ₹3,000 was not stopped (%)', coalesce(msg, 'it went through'); end if;
  if exists (select 1 from public.subscriptions where quote_id = 'Q-R2230-CREDIT') then raise exception 'E FAIL: refusal left subscriptions'; end if;
  raise notice 'E PASS: the open payment request counts toward the credit limit (%)', msg;
end $$;

-- F. Paying the rest closes the request → nothing still due for customer 1.
select set_config('request.jwt.claims', '', true);
do $$
declare v_q text;
begin
  select id into v_q from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000223012';
  perform public.record_payment(v_q, 1360, 'upi', 'R2230-PART-2');
  if exists (select 1 from public.open_part_requests('cccccccc-0000-0000-0000-000000223001', null)) then
    raise exception 'F FAIL: a paid request is still listed'; end if;
  raise notice 'F PASS: paid request leaves the list';
end $$;

select 'R-2230 part due dates: ALL PASS' as result;

rollback;
