-- R-137: a shared email no longer merges different businesses (migration 20261003130000).
-- Rolled back. Proves:
--   1. accept_quote: same email, different company -> NEW customer (the Sri Ganga case);
--   2. accept_quote: same email, same company spelled differently ("Pvt Ltd") -> reused;
--   3. record_payment: same GSTIN, different email -> reused;
--   4. record_payment: same email, different company -> NEW customer.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants (id,name,email,state_code,doc_code) values ('11110000-0000-0000-0000-0000000001d7','CM','cm@x.in','07','CMA1');
insert into public.document_series (tenant_id,doc_type,fiscal_year,prefix,last_number) values ('11110000-0000-0000-0000-0000000001d7','purchase_order',public.indian_fiscal_year(current_date),'PO',990000);
insert into public.customers (id,tenant_id,name,contact_email,gstin) values
  ('cccccccc-0000-0000-0000-0000000001d1','11110000-0000-0000-0000-0000000001d7','Sri Ganga Technologies','owner@x.in',null),
  ('cccccccc-0000-0000-0000-0000000001d2','11110000-0000-0000-0000-0000000001d7','Demo Co Pvt Ltd','acc@x.in','07AAACE1234F1Z5');

insert into public.leads (id,tenant_id,company,contact_email,stage,source,priority) values
  ('L-CM1','11110000-0000-0000-0000-0000000001d7','Demo Company','owner@x.in','new','manual','medium'),
  ('L-CM2','11110000-0000-0000-0000-0000000001d7','Sri Ganga Technologies Pvt. Ltd.','OWNER@x.in','new','manual','medium'),
  ('L-CM3','11110000-0000-0000-0000-0000000001d7','Demo Co','someone-else@y.in','new','manual','medium'),
  ('L-CM4','11110000-0000-0000-0000-0000000001d7','Third Firm','acc@x.in','new','manual','medium');
update public.leads set gstin='07AAACE1234F1Z5' where id='L-CM3';

insert into public.quotes (id,tenant_id,lead_id,customer_id,customer_name,amount,subtotal,tax_rate,status,payment_status,line_items) values
  ('Q-CM1','11110000-0000-0000-0000-0000000001d7','L-CM1',null,'Demo Company',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-CM2','11110000-0000-0000-0000-0000000001d7','L-CM2',null,'Sri Ganga',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-CM3','11110000-0000-0000-0000-0000000001d7','L-CM3',null,'Demo Co',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-CM4','11110000-0000-0000-0000-0000000001d7','L-CM4',null,'Third Firm',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb);

do $$ declare c1 uuid; c2 uuid; c3 uuid; c4 uuid; begin
  perform public.accept_quote('Q-CM1');
  select customer_id into c1 from public.quotes where id='Q-CM1';
  if c1 = 'cccccccc-0000-0000-0000-0000000001d1' then raise exception 'FAIL 1: Demo Company merged into Sri Ganga by email'; end if;
  perform 1 from public.customers where id=c1 and name='Demo Company';
  if not found then raise exception 'FAIL 1: no Demo Company customer'; end if;

  perform public.accept_quote('Q-CM2');
  select customer_id into c2 from public.quotes where id='Q-CM2';
  if c2 is distinct from 'cccccccc-0000-0000-0000-0000000001d1' then raise exception 'FAIL 2: same business not reused (got %)', c2; end if;

  perform public.record_payment('Q-CM3',11800,'upi','cm3ref');
  select customer_id into c3 from public.quotes where id='Q-CM3';
  if c3 is distinct from 'cccccccc-0000-0000-0000-0000000001d2' then raise exception 'FAIL 3: same GSTIN not reused (got %)', c3; end if;

  perform public.record_payment('Q-CM4',11800,'upi','cm4ref');
  select customer_id into c4 from public.quotes where id='Q-CM4';
  if c4 = 'cccccccc-0000-0000-0000-0000000001d2' then raise exception 'FAIL 4: Third Firm merged into Excel by email'; end if;

  raise notice 'PASS customer_match_needs_name (4/4)';
end $$;
rollback;
