-- R-1706 (21 Oct 2026): accepting a PROSPECT quote (no lead, no customer) creates the customer, so
-- "Invoice now" works. Migration 20261021025234_r1706_accept_prospect_creates_customer.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves (the owner's real path: New quote → New prospect WITHOUT email, place of supply Delhi):
--   A. accept_quote on the prospect quote → a customer exists, named as the quote, state 07 / Delhi,
--      country India, linked as quote.customer_id; converted_now true.
--      Fails on the old accept_quote: customer_id stays NULL.
--   B. generate_invoice ("Invoice now") then issues the invoice (intra-state: Delhi → Delhi).
--      Old code: "has no state on record … Customers → <name> → Edit".
--   C. accepting again creates no second customer.
--   D. a LEAD quote still converts the lead (unchanged), and an existing-customer quote is untouched.
--   E. the helper is not callable by a signed-in user; a no-company login still cannot accept (§17c).

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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
  values ('dddddddd-0000-0000-0000-000000170601','R1706 Co','r1706@example.in','07','R1706');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000170601','owner1706@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000170602','nocompany1706@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000170601','dddddddd-0000-0000-0000-000000170601','owner1706@example.in','Owner 1706','owner', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code)
  values ('cccccccc-0000-0000-0000-000000170601','dddddddd-0000-0000-0000-000000170601','Existing 1706','07');
insert into public.leads (id, tenant_id, company, contact_name, contact_email, state_code, state)
  values ('eeeeeeee-0000-0000-0000-000000170601','dddddddd-0000-0000-0000-000000170601','Lead Co 1706','Ravi','ravi@leadco1706.in','07','Delhi');

-- Workspace Starter 5 x 3,240 = 16,200 + 18% = 19,116.
insert into public.quotes (id, tenant_id, customer_id, lead_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, prospect_state_code, prospect_state, prospect_country, line_items)
values
  ('Q-R1706-P','dddddddd-0000-0000-0000-000000170601', null, null, 'T-A1 Prospect 1706',
   19116, 16200, 0, 18, 'sent', 'awaiting', 'yearly', '07', 'Delhi', null,
   '[{"name":"Google Workspace Business Starter","qty":5,"rate":3240,"commitment":"annual_yearly"}]'::jsonb),
  ('Q-R1706-L','dddddddd-0000-0000-0000-000000170601', null, 'eeeeeeee-0000-0000-0000-000000170601', 'Lead Co 1706',
   19116, 16200, 0, 18, 'sent', 'awaiting', 'yearly', null, null, null,
   '[{"name":"Google Workspace Business Starter","qty":5,"rate":3240,"commitment":"annual_yearly"}]'::jsonb),
  ('Q-R1706-C','dddddddd-0000-0000-0000-000000170601','cccccccc-0000-0000-0000-000000170601', null, 'Existing 1706',
   19116, 16200, 0, 18, 'sent', 'awaiting', 'yearly', null, null, null,
   '[{"name":"Google Workspace Business Starter","qty":5,"rate":3240,"commitment":"annual_yearly"}]'::jsonb);

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000170601","role":"authenticated"}', true);

-- A. Mark accepted on the prospect quote
do $$
declare r jsonb; v_q record; v_c record;
begin
  r := public.accept_quote('Q-R1706-P');
  select * into v_q from public.quotes where id = 'Q-R1706-P';
  if v_q.customer_id is null then
    raise exception 'FAIL A: prospect quote accepted but no customer linked (customer_id NULL)'; end if;
  if (r->>'customer_id')::uuid is distinct from v_q.customer_id or (r->>'converted_now')::boolean is not true then
    raise exception 'FAIL A: result % does not report the new customer', r; end if;
  select * into v_c from public.customers where id = v_q.customer_id;
  if v_c.tenant_id <> 'dddddddd-0000-0000-0000-000000170601' or v_c.name <> 'T-A1 Prospect 1706'
     or v_c.state_code <> '07' or v_c.state <> 'Delhi' or v_c.country <> 'India' then
    raise exception 'FAIL A: customer shape % / % / % / % / %', v_c.tenant_id, v_c.name, v_c.state_code, v_c.state, v_c.country; end if;
  if v_q.status <> 'accepted' or v_q.payment_status <> 'awaiting' then
    raise exception 'FAIL A: quote % / %', v_q.status, v_q.payment_status; end if;
  raise notice 'PASS A: prospect accepted -> customer "%" state % (%), linked', v_c.name, v_c.state_code, v_c.state;
end $$;

-- B. Invoice now
do $$
declare v_inv record;
begin
  perform public.generate_invoice('Q-R1706-P');
  select * into v_inv from public.invoices where quote_id = 'Q-R1706-P';
  if v_inv.id is null then raise exception 'FAIL B: no invoice'; end if;
  if v_inv.customer_id is distinct from (select customer_id from public.quotes where id = 'Q-R1706-P') then
    raise exception 'FAIL B: invoice customer % is not the quote one', v_inv.customer_id; end if;
  if v_inv.inter_state is not false or v_inv.net_payable <> 19116 then
    raise exception 'FAIL B: inter_state % net %', v_inv.inter_state, v_inv.net_payable; end if;
  raise notice 'PASS B: Invoice now -> % for Rs % (CGST+SGST, Delhi to Delhi)', v_inv.id, v_inv.net_payable;
end $$;

-- C. Accept again — no second customer
do $$
declare n int; before_id uuid;
begin
  select customer_id into before_id from public.quotes where id = 'Q-R1706-P';
  perform public.accept_quote('Q-R1706-P');
  select count(*) into n from public.customers
   where tenant_id = 'dddddddd-0000-0000-0000-000000170601' and name = 'T-A1 Prospect 1706';
  if n <> 1 then raise exception 'FAIL C: % customers after a second accept (want 1)', n; end if;
  if (select customer_id from public.quotes where id = 'Q-R1706-P') <> before_id then
    raise exception 'FAIL C: customer link changed'; end if;
  raise notice 'PASS C: second accept -> still 1 customer';
end $$;

-- D. Lead quote and existing-customer quote unchanged
do $$
declare r jsonb; v_c record; n_before int; n_after int;
begin
  r := public.accept_quote('Q-R1706-L');
  select c.* into v_c from public.customers c join public.quotes q on q.customer_id = c.id where q.id = 'Q-R1706-L';
  if v_c.name <> 'Lead Co 1706' or v_c.contact_email <> 'ravi@leadco1706.in' then
    raise exception 'FAIL D: lead conversion changed: % %', v_c.name, v_c.contact_email; end if;
  if (select stage from public.leads where id = 'eeeeeeee-0000-0000-0000-000000170601') <> 'won' then
    raise exception 'FAIL D: lead not won'; end if;

  select count(*) into n_before from public.customers where tenant_id = 'dddddddd-0000-0000-0000-000000170601';
  r := public.accept_quote('Q-R1706-C');
  select count(*) into n_after from public.customers where tenant_id = 'dddddddd-0000-0000-0000-000000170601';
  if n_after <> n_before or (r->>'converted_now')::boolean is not false
     or (select customer_id from public.quotes where id = 'Q-R1706-C') <> 'cccccccc-0000-0000-0000-000000170601' then
    raise exception 'FAIL D: existing-customer quote changed (% -> % customers, %)', n_before, n_after, r; end if;
  raise notice 'PASS D: lead quote converts the lead; existing-customer quote untouched';
end $$;

-- E1. The helper is internal
set local role authenticated;
do $$
begin
  begin
    perform public.customer_from_prospect_quote('dddddddd-0000-0000-0000-000000170601', 'Q-R1706-L', 70);
    raise exception 'FAIL E1: a signed-in user could call customer_from_prospect_quote';
  exception when insufficient_privilege or undefined_function then
    null;
  end;
  raise notice 'PASS E1: customer_from_prospect_quote is not callable by authenticated';
end $$;
reset role;

-- E2. No-company login
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000170602","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.accept_quote('Q-R1706-P');
    raise exception 'FAIL E2: a no-company login accepted the quote';
  exception when sqlstate '28000' then
    null;
  end;
  raise notice 'PASS E2: no-company login refused (fail closed)';
end $$;

rollback;
