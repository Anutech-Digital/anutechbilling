-- R-1677: a customer made from a US lead's quote is saved as United States, not India.
-- Self-asserting; rolled back.
--
-- Proves:
--   1. accept_quote on a US lead's quote → the new customer's country is United States
--      (it was the column default, India — "Invoice now" then refused: no state on record).
--   2. An Indian lead's quote → the customer stays India.
--   3. An existing customer with an Indian state / GSTIN is never re-labelled by a quote.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('eeeeeeee-0000-0000-0000-000000001677','R1677 Co','r1677@example.in','07','R167');

insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone, stage, source, priority, country)
  values ('L-R1677-US','eeeeeeee-0000-0000-0000-000000001677','Acme Inc','Jo','jo@acme.example','+12025550100','quote','manual','medium','United States'),
         ('L-R1677-IN','eeeeeeee-0000-0000-0000-000000001677','Desi Pvt Ltd','Ravi','ravi@desi.example','+919800000077','quote','manual','medium','India');
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, currency, exchange_rate, line_items)
  values ('Q-R1677-US','eeeeeeee-0000-0000-0000-000000001677','L-R1677-US',null,'Acme Inc',32400,32400,0,'sent','none','USD',95.7485,
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":3240,"commitment":"annual_yearly"}]'::jsonb),
         ('Q-R1677-IN','eeeeeeee-0000-0000-0000-000000001677','L-R1677-IN',null,'Desi Pvt Ltd',38232,32400,18,'sent','none','INR',1,
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":3240,"commitment":"annual_yearly"}]'::jsonb);

do $$
declare v_res jsonb; v_country text;
begin
  v_res := public.accept_quote('Q-R1677-US');
  select country into v_country from public.customers where id = (v_res->>'customer_id')::uuid;
  if v_country is distinct from 'United States' then
    raise exception 'FAIL 1: US lead customer country expected United States, got %', v_country;
  end if;

  v_res := public.accept_quote('Q-R1677-IN');
  select country into v_country from public.customers where id = (v_res->>'customer_id')::uuid;
  if lower(coalesce(v_country, 'india')) <> 'india' then
    raise exception 'FAIL 2: Indian lead customer country expected India, got %', v_country;
  end if;
end $$;

-- 3) existing Indian customer (state on record) linked to a foreign-prospect quote: untouched
insert into public.customers (id, tenant_id, name, state_code, state)
  values ('eeeeeeee-0000-0000-0000-00000000c677','eeeeeeee-0000-0000-0000-000000001677','Mumbai Co','27','Maharashtra');
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, prospect_country, line_items)
  values ('Q-R1677-X','eeeeeeee-0000-0000-0000-000000001677',null,null,'Mumbai Co',100,100,0,'draft','none','United States','[]'::jsonb);
update public.quotes set customer_id = 'eeeeeeee-0000-0000-0000-00000000c677' where id = 'Q-R1677-X';
do $$
declare v_country text;
begin
  select country into v_country from public.customers where id = 'eeeeeeee-0000-0000-0000-00000000c677';
  if lower(coalesce(v_country, 'india')) <> 'india' then
    raise exception 'FAIL 3: customer with a state was re-labelled to %', v_country;
  end if;
  raise notice 'PASS r1677_export_customer_country';
end $$;
rollback;
