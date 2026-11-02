-- R-2360 (2 Nov 2026, Find in Zoho part 2): a sale booked from a bank credit keeps the Zoho invoice
-- number on the app invoice (invoices.external_number); a Zoho number already in the app is refused
-- and nothing is saved. Migration 20261102061607_r2360_zoho_invoice_number_on_sale.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. New sale (₹1,180, one-time) with Zoho number INV/26-27/0613 → its invoice carries it.
--   B. Another bank line, new sale with " inv/26-27/0613 " → refused "Zoho invoice … is already in
--      the app as <A's invoice>"; the line stays unmatched, no new quote.
--   C. The old 10-argument call (no Zoho number) still books, external_number stays empty.
--   D. Split path: a new sale with INV/26-27/0700 → the sale's invoice carries it; a number without a
--      sale is refused.
--   E. set_invoice_external_number: C's invoice takes INV/26-27/0613 → refused (A holds it); a fresh
--      number is saved; the same number again is a no-op; a different one is refused.
--   F. Billed in parts (quarterly): no invoice yet → external_number_saved = false (the app saves it
--      on the first part's invoice).

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
  ('dddddddd-0000-0000-0000-000000236001','R2360 Zoho Co','r2360@example.in','07','R236');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000236001','owner2360@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000236001','dddddddd-0000-0000-0000-000000236001','owner2360@example.in','Owner 2360','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000236001','dddddddd-0000-0000-0000-000000236001','Zoho Buyer','07','zohobuyer.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000236001','dddddddd-0000-0000-0000-000000236001','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000236001','dddddddd-0000-0000-0000-000000236001','bbbbbbbb-0000-0000-0000-000000236001','2026-09-01','NEFT ZOHO BUYER A',0,1180,'UTR2360A','manual'),
  ('11111111-0000-0000-0000-000000236002','dddddddd-0000-0000-0000-000000236001','bbbbbbbb-0000-0000-0000-000000236001','2026-09-02','NEFT ZOHO BUYER B',0,1180,'UTR2360B','manual'),
  ('11111111-0000-0000-0000-000000236003','dddddddd-0000-0000-0000-000000236001','bbbbbbbb-0000-0000-0000-000000236001','2026-09-03','NEFT ZOHO BUYER C',0,1180,'UTR2360C','manual'),
  ('11111111-0000-0000-0000-000000236004','dddddddd-0000-0000-0000-000000236001','bbbbbbbb-0000-0000-0000-000000236001','2026-09-04','NEFT ZOHO BUYER D',0,1180,'UTR2360D','manual'),
  ('11111111-0000-0000-0000-000000236005','dddddddd-0000-0000-0000-000000236001','bbbbbbbb-0000-0000-0000-000000236001','2026-09-05','NEFT ZOHO BUYER F',0,9558,'UTR2360F','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236001","role":"authenticated"}', true);

do $$
declare
  c_line constant jsonb := '[{"item_id":null,"name":"Setup","qty":1,"rate":1000,"cost":0,"commitment":"one_time"}]';
  r jsonb; v_a text; v_c text; v_d text; ok boolean; v_msg text; n int;
begin
  -- A
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000236001', 'cccccccc-0000-0000-0000-000000236001',
         c_line, false, null, null, 0, null, null, 'yearly', 'INV/26-27/0613');
  v_a := r->>'invoice_id';
  if v_a is null then raise exception 'FAIL A setup: no invoice (%)', r; end if;
  if (select external_number from public.invoices where id = v_a) is distinct from 'INV/26-27/0613'
     or (r->>'external_number_saved')::boolean is not true then
    raise exception 'FAIL A: invoice % does not carry the Zoho number (%)', v_a, r;
  end if;
  raise notice 'A PASS: % carries INV/26-27/0613', v_a;

  -- B
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000236002', 'cccccccc-0000-0000-0000-000000236001',
              c_line, false, null, null, 0, null, null, 'yearly', ' inv/26-27/0613 ');
  exception when unique_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'Zoho invoice inv/26-27/0613 is already in the app as ' || v_a || '%';
    if not ok then raise exception 'FAIL B: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL B: a Zoho number already in the app was booked again'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000236002') is not null then
    raise exception 'FAIL B: the bank line was reconciled although the sale was refused';
  end if;
  select count(*) into n from public.quotes where tenant_id = 'dddddddd-0000-0000-0000-000000236001';
  if n <> 1 then raise exception 'FAIL B: % quotes (want 1 — the refused sale left one behind)', n; end if;
  raise notice 'B PASS: refused — %', v_msg;

  -- C
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000236003', 'cccccccc-0000-0000-0000-000000236001',
         c_line, false, null, null, 0, null, null, 'yearly');
  v_c := r->>'invoice_id';
  if v_c is null or (select external_number from public.invoices where id = v_c) is not null or r ? 'external_number' then
    raise exception 'FAIL C: the old call changed (%)', r;
  end if;
  raise notice 'C PASS: old 10-argument call unchanged';

  -- D
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000236004', 'cccccccc-0000-0000-0000-000000236001',
         '[]'::jsonb, jsonb_build_object('lines', c_line, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 1180),
         null, 'INV/26-27/0700');
  select p->>'invoice_id' into v_d from jsonb_array_elements(r->'parts') p where (p->>'new_quote')::boolean;
  if v_d is null or (select external_number from public.invoices where id = v_d) is distinct from 'INV/26-27/0700' then
    raise exception 'FAIL D: split sale invoice % does not carry the Zoho number (%)', v_d, r;
  end if;
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000236005', 'cccccccc-0000-0000-0000-000000236001',
              '[]'::jsonb, null, null, 'INV/26-27/0701');
  exception when sqlstate '22023' then ok := true;
  end;
  if not ok then raise exception 'FAIL D: a Zoho number with no new sale was accepted'; end if;
  raise notice 'D PASS: split sale % carries INV/26-27/0700', v_d;

  -- E
  ok := false;
  begin perform public.set_invoice_external_number(v_c, 'INV/26-27/0613');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'FAIL E: a second invoice took INV/26-27/0613'; end if;
  r := public.set_invoice_external_number(v_c, 'INV/26-27/0800');
  if (r->>'changed')::boolean is not true or (select external_number from public.invoices where id = v_c) <> 'INV/26-27/0800' then
    raise exception 'FAIL E: fresh number not saved (%)', r;
  end if;
  r := public.set_invoice_external_number(v_c, 'inv/26-27/0800');
  if (r->>'changed')::boolean is not false then raise exception 'FAIL E: same number again was not a no-op (%)', r; end if;
  ok := false;
  begin perform public.set_invoice_external_number(v_c, 'INV/26-27/0801');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL E: an invoice''s Zoho number was overwritten'; end if;
  raise notice 'E PASS: set_invoice_external_number guards';

  -- F
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000236005', 'cccccccc-0000-0000-0000-000000236001',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":32400,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-09-05', null, 0, null, null, 'quarterly', 'INV/26-27/0900');
  if nullif(r->>'invoice_id', '') is null then
    if (r->>'external_number_saved')::boolean is not false then raise exception 'FAIL F: no invoice but saved=true (%)', r; end if;
  elsif (select external_number from public.invoices where id = r->>'invoice_id') is distinct from 'INV/26-27/0900' then
    raise exception 'FAIL F: invoice % issued but Zoho number not kept (%)', r->>'invoice_id', r;
  end if;
  raise notice 'F PASS: billed in parts — saved = %', r->>'external_number_saved';
end $$;

select 'R-2360 Zoho invoice number on a bank sale: ALL PASS' as result;

rollback;
