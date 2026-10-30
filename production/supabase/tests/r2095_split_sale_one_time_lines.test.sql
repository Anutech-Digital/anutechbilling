-- R-2095 (30 Oct 2026, September reconcile): a sale billed quarterly with a one-time setup line never
-- invoiced the setup (parts come from the subscriptions; a whole-quote invoice is refused for a
-- split-billed quote). Migration 20261030140100_r2095_split_sale_one_time_lines.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   Sale from a bank line: Workspace 10 × ₹3,240/yr (annual, billed quarterly) + Setup ₹5,000 (one-time).
--   A. Q1 invoice = ₹8,100 (a quarter) + ₹5,000 setup = ₹13,100 taxable, the setup line tagged one_time_of.
--   B. Q2 invoice = ₹8,100 only.
--   C. quote_one_time_lines answers nothing once Q1 carries them (never twice).

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
  ('dddddddd-0000-0000-0000-000000209581','R2095 Setup Co','r2095st@example.in','07','R95T');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000209581','owner2095st@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209581','dddddddd-0000-0000-0000-000000209581','owner2095st@example.in','Owner ST','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000209581','dddddddd-0000-0000-0000-000000209581','Setup Buyer','07','setupbuyer.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000209581','dddddddd-0000-0000-0000-000000209581','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209581','dddddddd-0000-0000-0000-000000209581','bbbbbbbb-0000-0000-0000-000000209581','2026-09-01','NEFT SETUP BUYER',0,15458,'UTR2095ST','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000209581","role":"authenticated"}', true);

do $$
declare r jsonb; v_sub uuid; v_b1 uuid := gen_random_uuid(); v_b2 uuid := gen_random_uuid(); i record; v_q text; v_inv text;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000209581', 'cccccccc-0000-0000-0000-000000209581',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":10,"rate":3240,"cost":0,"commitment":"annual_yearly"},
           {"item_id":null,"name":"Setup","qty":1,"rate":5000,"cost":0,"commitment":"one_time"}]'::jsonb,
         true, '2026-09-01', null, 0, null, null, 'quarterly');
  v_q := r->>'quote_id';
  select s.id into v_sub from public.subscriptions s where s.quote_id = v_q limit 1;
  if v_sub is null then raise exception 'FAIL setup: no subscription (%)', r; end if;
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate) values
    (v_b1, 'dddddddd-0000-0000-0000-000000209581', v_sub, '2026-09-01', 1, '2026-09-01', '2026-09-01', '2026-12-01', 8100, 18),
    (v_b2, 'dddddddd-0000-0000-0000-000000209581', v_sub, '2026-09-01', 2, '2026-12-01', '2026-12-01', '2027-03-01', 8100, 18);

  -- A
  select x.invoice_id into v_inv from public.raise_subscription_billing(v_b1) x;
  select * into i from public.invoices where id = v_inv;
  if i.id is null then raise exception 'FAIL A: no Q1 invoice (%)', v_inv; end if;
  if i.taxable_value <> 13100 then raise exception 'FAIL A: Q1 taxable % (want 13,100 = 8,100 + 5,000 setup)', i.taxable_value; end if;
  if not (i.line_items @> jsonb_build_array(jsonb_build_object('one_time_of', v_q, 'rate', 5000))) then
    raise exception 'FAIL A: no setup line on Q1 (%)', i.line_items; end if;
  raise notice 'A PASS: Q1 % = 8,100 + setup 5,000 (%)', i.id, i.status;

  -- B
  select x.invoice_id into v_inv from public.raise_subscription_billing(v_b2) x;
  select * into i from public.invoices where id = v_inv;
  if i.id is null then raise exception 'FAIL B: no Q2 invoice (%)', v_inv; end if;
  if i.taxable_value <> 8100 then raise exception 'FAIL B: Q2 taxable % (want 8,100)', i.taxable_value; end if;
  raise notice 'B PASS: Q2 subscription only';

  -- C
  if (select taxable from public.quote_one_time_lines(v_q)) <> 0 then raise exception 'FAIL C: setup offered twice'; end if;
  raise notice 'C PASS: setup billed once';
end $$;

select 'R-2095 split sale one-time lines: ALL PASS' as result;

rollback;
