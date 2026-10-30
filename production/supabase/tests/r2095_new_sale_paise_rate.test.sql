-- R-2095 (30 Oct 2026, staging reconcile): Reconcile → "A new sale" refused a paise unit price —
-- Zoho bills ₹103.5 and ₹1,347.5 a seat, so the sale could never match the bank line.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. 2 × ₹1,347.5 a year (one-time sale of the year, yearly) → quote line rate 1347.5, subtotal
--      ₹2,695, amount ₹3,180 (= the bank line).
--   B. 3 × ₹103.5 → ₹310.5 → subtotal ₹311 (rounded once), amount ₹367.
--   C. Three decimals are refused (22023).

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
  ('dddddddd-0000-0000-0000-000000209551','R2095 Paise Co','r2095p@example.in','07','R95P');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000209551','owner2095p@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209551','dddddddd-0000-0000-0000-000000209551','owner2095p@example.in','Owner 2095','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000209551','dddddddd-0000-0000-0000-000000209551','Acme 2095','07','acme2095.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000209551','dddddddd-0000-0000-0000-000000209551','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209551','dddddddd-0000-0000-0000-000000209551','bbbbbbbb-0000-0000-0000-000000209551','2026-10-21','NEFT ACME 2095 A',0,3180,'UTR2095A','manual'),
  ('11111111-0000-0000-0000-000000209552','dddddddd-0000-0000-0000-000000209551','bbbbbbbb-0000-0000-0000-000000209551','2026-10-21','NEFT ACME 2095 B',0,367,'UTR2095B','manual'),
  ('11111111-0000-0000-0000-000000209553','dddddddd-0000-0000-0000-000000209551','bbbbbbbb-0000-0000-0000-000000209551','2026-10-21','NEFT ACME 2095 C',0,100,'UTR2095C','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000209551","role":"authenticated"}', true);

do $$
declare r jsonb; q record; ok boolean := false;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209551', 'cccccccc-0000-0000-0000-000000209551',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":2,"rate":1347.5,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         false, null, null, 0, null, null, 'yearly');
  select * into q from public.quotes where id = r->>'quote_id';
  if q.subtotal is distinct from 2695 or q.amount is distinct from 3180 or (q.line_items->0->>'rate')::numeric <> 1347.5 then
    raise exception 'FAIL A: subtotal % amount % rate % (want 2,695 / 3,180 / 1347.5)', q.subtotal, q.amount, q.line_items->0->>'rate';
  end if;

  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209552', 'cccccccc-0000-0000-0000-000000209551',
         '[{"item_id":null,"name":"Storage add-on","qty":3,"rate":103.5,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, null);
  select * into q from public.quotes where id = r->>'quote_id';
  if q.subtotal is distinct from 311 or q.amount is distinct from 367 then
    raise exception 'FAIL B: subtotal % amount % (want 311 / 367)', q.subtotal, q.amount;
  end if;

  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209553', 'cccccccc-0000-0000-0000-000000209551',
         '[{"item_id":null,"name":"X","qty":1,"rate":84.745,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, null);
  exception when sqlstate '22023' then ok := true;
  end;
  if not ok then raise exception 'FAIL C: a three-decimal rate was taken'; end if;
end $$;

select 'R-2095 new sale paise rate: ALL PASS' as result;

rollback;
