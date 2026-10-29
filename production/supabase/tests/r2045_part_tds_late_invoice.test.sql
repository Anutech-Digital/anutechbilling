\set ON_ERROR_STOP on
-- R-2045 follow-up (28 Oct 2026, localhost check): a part payment request paid net of TDS whose
-- tax invoice could NOT be raised at payment (the customer has no state — "the next billing run
-- will issue it") left its TDS receivable with invoice_id NULL for good, even after the billing
-- run raised the invoice. Now the moment the request gets its invoice (quotes.invoice_id), the
-- TDS receivable rows of that request's payments that name no invoice get it.
-- Migration 20261028094457_r2045_part_tds_late_invoice. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2045_part_tds_late_invoice.test.sql
--
--   A. Customer with no state: part request ₹2,443 (taxable ₹2,070) paid ₹2,236 bank + ₹207 TDS
--      → paid in full, no tax invoice yet, TDS receivable ₹207 with no invoice.
--   B. State added, billing run (bill_subscription_instalment) → the part's tax invoice, paid
--      ₹2,443; the request points at it; the TDS receivable now names that invoice.
--   C. Another quote's TDS row (no invoice) is never touched. Rows that already name an invoice
--      are left alone by the migration's own `invoice_id is null` rule.

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

insert into auth.users (id, email) values ('e2045100-0000-4000-8000-0000000000a2', 'r2045b-billing@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000204511','R2045B Co','r2045b@example.in','07','R245B');
insert into public.users (id, tenant_id, email, full_name, role, is_active)
  values ('e2045100-0000-4000-8000-0000000000a2','dddddddd-0000-0000-0000-000000204511','r2045b-billing@example.in','R2045B Billing','billing',true);
insert into public.customers (id, tenant_id, name, state_code, country)
  values ('cccccccc-0000-0000-0000-000000204511','dddddddd-0000-0000-0000-000000204511','No-state 2045', null, 'India');

-- A quarterly sale (nothing paid on the sale quote, so part 2 gets its own request).
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, line_items)
  values ('TESTQ-R2045B-1', 'dddddddd-0000-0000-0000-000000204511', 'No-state 2045', 'cccccccc-0000-0000-0000-000000204511',
          18, 9772, 8280, 'quarterly',
          '[{"name":"Workspace Starter","qty":1,"rate":8280,"commitment":"annual_quarterly"}]'::jsonb);
-- An unrelated quote with its own TDS row (C: never touched).
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, line_items)
  values ('TESTQ-R2045B-X', 'dddddddd-0000-0000-0000-000000204511', 'No-state 2045', 'cccccccc-0000-0000-0000-000000204511',
          18, 1180, 1000, '[]'::jsonb);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status)
  values ('eeeeeeee-0000-0000-0000-000000204511', 'dddddddd-0000-0000-0000-000000204511',
          'cccccccc-0000-0000-0000-000000204511', 'No-state 2045', 'Workspace Starter', 'google'::vendor, 2, 690,
          'quarterly'::billing_cycle, 'TESTQ-R2045B-1', public.ist_today() - 92, 'active');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
  values ('bbbbbbbb-0000-0000-0000-000000204512', 'dddddddd-0000-0000-0000-000000204511',
          'eeeeeeee-0000-0000-0000-000000204511', public.ist_today() - 92, 2,
          public.ist_today(), public.ist_today(), public.ist_today() + 89, 2070, 18);

create temp table r2045b (k text primary key, v text) on commit drop;
grant all on r2045b to authenticated;
create temp table r2045b_fail (msg text) on commit drop;
grant all on r2045b_fail to authenticated;

do $$
declare r jsonb;
begin
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204512', false);
  if r->>'action' <> 'request' or (r->>'gross')::int <> 2443 then raise exception 'setup: part 2 → % (want a ₹2,443 request)', r; end if;
  insert into r2045b values ('q', r->>'quote_id');
end $$;

do $$
declare v_q text; v_r jsonb; v_pay uuid; v_inv text; v_tinv text; v_n int;
begin
  select v into v_q from r2045b where k = 'q';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2045100-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- A. paid in full with TDS; the invoice cannot be raised (no state) — the payment stays.
  v_r := public.record_desk_payment(v_q, 2236 + 207, 'bank_transfer', 'R2045B-A', null, null, 0,
                                    public.ist_today(), null, 207, 2070, 2236, '194J', 10, null, null, null);
  v_pay := (v_r->>'payment_id')::uuid;
  -- C setup: a TDS row on an unrelated quote with no invoice — it must not change.
  v_r := public.record_desk_payment('TESTQ-R2045B-X', 1080, 'bank_transfer', 'R2045B-X', null, null, 0,
                                    public.ist_today(), null, 100, 1000, 980, '194J', 10, null, null, null);
  set local role postgres;
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204512') is not null then
    insert into r2045b_fail values ('A: the part was invoiced although the customer has no state (setup wrong)');
  end if;
  select t.invoice_id, count(*) over () into v_tinv, v_n from public.tds_receivable t where t.payment_id = v_pay;
  if v_n is distinct from 1 or v_tinv is not null then
    insert into r2045b_fail values (format('A: want one TDS row with no invoice, got %s row(s), invoice %s', v_n, v_tinv));
  end if;

  -- B. state added; the billing run raises the part's invoice.
  update public.customers set state_code = '07' where id = 'cccccccc-0000-0000-0000-000000204511';
  v_r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000204512', false);
  select invoice_id into v_inv from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204512';
  if v_inv is null then
    insert into r2045b_fail values ('B: the billing run raised no invoice: ' || v_r::text);
  else
    if (select status::text || '/' || amount from public.invoices where id = v_inv) <> 'paid/2443' then
      insert into r2045b_fail values ('B: invoice ' || v_inv || ' is ' || (select status::text || '/' || amount from public.invoices where id = v_inv) || ' (want paid/2443)');
    end if;
    if (select invoice_id from public.quotes where id = v_q) is distinct from v_inv then
      insert into r2045b_fail values ('B: the request does not point at its invoice');
    end if;
    select t.invoice_id into v_tinv from public.tds_receivable t where t.payment_id = v_pay;
    if v_tinv is distinct from v_inv then
      insert into r2045b_fail values (format('B: TDS receivable is on invoice %s, not on the part''s invoice %s', coalesce(v_tinv, 'none'), v_inv));
    end if;
  end if;

  -- C. another quote's TDS row is never touched.
  if exists (select 1 from public.tds_receivable t join public.payments p on p.id = t.payment_id
              where p.quote_id = 'TESTQ-R2045B-X' and t.invoice_id is not null) then
    insert into r2045b_fail values ('C: another quote''s TDS row was linked');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2045b_fail;
  if v_msgs is not null then raise exception E'R-2045 late-invoice FAIL:\n%', v_msgs; end if;
  raise notice 'PASS r2045_part_tds_late_invoice';
end $$;

rollback;
