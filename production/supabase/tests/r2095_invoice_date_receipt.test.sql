-- R-2095 P0 (30 Oct 2026, staging P&L): invoices raised now for money received months ago were
-- dated TODAY — 5 invoices, ₹5,02,250 taxable, received Apr / May / Sep, all dated October:
-- October revenue and GSTR-1 overstated, those months understated. Rule: an invoice raised for a
-- past receipt is dated the receipt (bank) date; a part of a subscription billed in parts is
-- dated its period's bill date; never before the books lock, never after today.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. Reconcile → new sale on a 15 Apr 2026 bank line → the invoice is dated 15 Apr 2026.
--   B. Books locked to 30 Jun 2026: a 20 May date → 1 Jul 2026 (first open day); a future date → today.
--   C. A quarterly part whose period began 7 days ago, paid today → dated its bill date.

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
  ('dddddddd-0000-0000-0000-000000209571','R2095 Date Co','r2095d@example.in','07','R95D'),
  ('dddddddd-0000-0000-0000-000000209572','R2095 Lock Co','r2095l@example.in','07','R95L');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000209571','owner2095d@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000209572','owner2095l@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209571','dddddddd-0000-0000-0000-000000209571','owner2095d@example.in','Owner D','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000209572','dddddddd-0000-0000-0000-000000209572','owner2095l@example.in','Owner L','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000209571','dddddddd-0000-0000-0000-000000209571','Acme D','07','acmed.in'),
  ('cccccccc-0000-0000-0000-000000209572','dddddddd-0000-0000-0000-000000209572','Acme L','07','acmel.in'),
  ('cccccccc-0000-0000-0000-000000209573','dddddddd-0000-0000-0000-000000209571','Acme Q','07','acmeq.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000209571','dddddddd-0000-0000-0000-000000209571','HDFC','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000209572','dddddddd-0000-0000-0000-000000209572','HDFC','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209571','dddddddd-0000-0000-0000-000000209571','bbbbbbbb-0000-0000-0000-000000209571','2026-04-15','NEFT ACME D',0,11800,'UTR2095DA','manual'),
  ('11111111-0000-0000-0000-000000209572','dddddddd-0000-0000-0000-000000209572','bbbbbbbb-0000-0000-0000-000000209572','2026-05-20','NEFT ACME L',0,11800,'UTR2095DB','manual');
update public.tenants set books_locked_until = '2026-06-30' where id = 'dddddddd-0000-0000-0000-000000209572';

do $$
declare r jsonb; v_date date;
begin
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209571","role":"authenticated"}', true);
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209571', 'cccccccc-0000-0000-0000-000000209571',
         '[{"item_id":null,"name":"Setup","qty":1,"rate":10000,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, null);
  select i.invoice_date into v_date from public.invoices i where i.customer_id = 'cccccccc-0000-0000-0000-000000209571';
  if v_date is distinct from '2026-04-15' then
    raise exception 'A FAIL: invoice for a 15 Apr 2026 receipt dated % (want 2026-04-15): %', v_date, r;
  end if;

  /* B. the payment itself cannot be dated inside locked books; a part's bill date can (the clamp). */
  v_date := public.invoice_date_for_receipt('dddddddd-0000-0000-0000-000000209572', '2026-05-20');
  if v_date is distinct from '2026-07-01' then
    raise exception 'B FAIL: books locked to 30 Jun, 20 May dated % (want 2026-07-01)', v_date;
  end if;
  if public.invoice_date_for_receipt('dddddddd-0000-0000-0000-000000209571', public.ist_today() + 5) <> public.ist_today() then
    raise exception 'B FAIL: a future date was not clamped to today';
  end if;
end $$;

-- C. a quarterly part, period began 7 days ago
select set_config('request.jwt.claims', '', true);
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
values ('TESTQ-R2095-D', 'dddddddd-0000-0000-0000-000000209571', 'Acme Q', 'cccccccc-0000-0000-0000-000000209573', 18, 4720, 4000, 'quarterly', 'accepted',
        '[{"name":"Google Workspace Business Starter","qty":1,"rate":4000,"commitment":"annual_quarterly"}]'::jsonb);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id, start_date, status)
values ('eeeeeeee-0000-0000-0000-000000209571', 'dddddddd-0000-0000-0000-000000209571', 'cccccccc-0000-0000-0000-000000209573', 'Acme Q',
        'Google Workspace Business Starter', 'google'::vendor, 1, 333, 'quarterly'::billing_cycle, 'TESTQ-R2095-D', public.ist_today() - 7, 'active');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
values ('bbbbbbbb-0000-0000-0000-000002095711', 'dddddddd-0000-0000-0000-000000209571', 'eeeeeeee-0000-0000-0000-000000209571',
        public.ist_today() - 7, 1, public.ist_today() - 7, public.ist_today() - 7, (public.ist_today() - 7 + interval '3 months')::date, 1000, 18);
do $$
declare r jsonb; v_date date;
begin
  perform public.record_payment('TESTQ-R2095-D', 1180, 'upi', 'R2095-D-PAY');
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002095711', false);
  select invoice_date into v_date from public.invoices where id = r->>'invoice_id';
  if v_date is distinct from public.ist_today() - 7 then
    raise exception 'C FAIL: Q1 part dated % (want its bill date %): %', v_date, public.ist_today() - 7, r;
  end if;
end $$;

select 'R-2095 invoice date = receipt / bill date: ALL PASS' as result;

rollback;
