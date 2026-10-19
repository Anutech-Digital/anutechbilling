-- Regression test: accept_quote + record_payment reuse an existing same-email
-- customer instead of creating a duplicate (migrations 0064/0065). Rolled back.
--
-- Proves:
--   1. record_payment: lead email matches an existing customer → reuse (no new
--      customer), quote links to the existing one.
--   2. NO-REGRESSION: lead email with NO existing customer → new customer
--      created + subscription mrr ex-GST (8640).
--   3. accept_quote: same dedup on the no-payment accept path.
--
-- R-137 (3 Oct 2026): reuse now needs the SAME BUSINESS — same email AND a matching name
-- (or the same GSTIN). The leads here spell the existing name with a legal suffix; the
-- "same email, different business" case lives in customer_match_needs_name.test.sql.

-- 1) record_payment dedup
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants (id,name,email,state_code,doc_code) values ('11110000-0000-0000-0000-0000000000d1','DD1','dd1@x.in','07','DDA1');
insert into public.customers (id,tenant_id,name,contact_email) values ('cccccccc-0000-0000-0000-0000000000d1','11110000-0000-0000-0000-0000000000d1','Existing Co','dup@x.in');
insert into public.document_series (tenant_id,doc_type,fiscal_year,prefix,last_number) values ('11110000-0000-0000-0000-0000000000d1','purchase_order',public.indian_fiscal_year(current_date),'PO', 9000);
insert into public.leads (id,tenant_id,company,contact_email,stage,source,priority) values ('L-DD1','11110000-0000-0000-0000-0000000000d1','Existing Co Pvt. Ltd.','dup@x.in','new','manual','medium');
insert into public.quotes (id,tenant_id,lead_id,customer_id,customer_name,amount,subtotal,tax_rate,status,payment_status,line_items) values ('Q-DD1','11110000-0000-0000-0000-0000000000d1','L-DD1',null,'Existing Co Pvt. Ltd.',122342,103680,18,'sent','awaiting','[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
do $$ declare n int; qc uuid; begin
  perform public.record_payment('Q-DD1',122342,'upi','dd1ref');
  select count(*) into n from public.customers where tenant_id='11110000-0000-0000-0000-0000000000d1' and lower(contact_email)='dup@x.in';
  if n<>1 then raise exception 'FAIL dedup-rp: expected 1 customer (reuse), got %',n; end if;
  select customer_id into qc from public.quotes where id='Q-DD1';
  if qc<>'cccccccc-0000-0000-0000-0000000000d1' then raise exception 'FAIL dedup-rp: linked to NEW customer %, not existing',qc; end if;
  raise notice 'PASS record_payment dedup';
end $$;
rollback;

-- 2) no-regression: new sale creates a customer + mrr 8640
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants (id,name,email,state_code,doc_code) values ('11110000-0000-0000-0000-0000000000d2','DD2','dd2@x.in','07','DDA2');
insert into public.document_series (tenant_id,doc_type,fiscal_year,prefix,last_number) values ('11110000-0000-0000-0000-0000000000d2','purchase_order',public.indian_fiscal_year(current_date),'PO', 9000);
insert into public.leads (id,tenant_id,company,contact_email,stage,source,priority) values ('L-DD2','11110000-0000-0000-0000-0000000000d2','Fresh Co','fresh@x.in','new','manual','medium');
insert into public.quotes (id,tenant_id,lead_id,customer_id,customer_name,amount,subtotal,tax_rate,status,payment_status,line_items) values ('Q-DD2','11110000-0000-0000-0000-0000000000d2','L-DD2',null,'Fresh Co',122342,103680,18,'sent','awaiting','[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
do $$ declare n int; m int; begin
  perform public.record_payment('Q-DD2',122342,'upi','dd2ref');
  select count(*) into n from public.customers where tenant_id='11110000-0000-0000-0000-0000000000d2' and lower(contact_email)='fresh@x.in';
  if n<>1 then raise exception 'FAIL noreg: expected 1 new customer, got %',n; end if;
  select mrr into m from public.subscriptions where tenant_id='11110000-0000-0000-0000-0000000000d2';
  if m<>8640 then raise exception 'FAIL noreg mrr: expected 8640, got %',m; end if;
  raise notice 'PASS no-regression: new customer + mrr 8640';
end $$;
rollback;

-- 3) accept_quote dedup
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants (id,name,email,state_code,doc_code) values ('11110000-0000-0000-0000-0000000000d3','DD3','dd3@x.in','07','DDA3');
insert into public.customers (id,tenant_id,name,contact_email) values ('cccccccc-0000-0000-0000-0000000000d3','11110000-0000-0000-0000-0000000000d3','Existing 3','dup3@x.in');
insert into public.leads (id,tenant_id,company,contact_email,stage,source,priority) values ('L-DD3','11110000-0000-0000-0000-0000000000d3','Existing 3 Pvt Ltd','dup3@x.in','quote','manual','medium');
insert into public.quotes (id,tenant_id,lead_id,customer_id,customer_name,amount,subtotal,tax_rate,status,payment_status,line_items) values ('Q-DD3','11110000-0000-0000-0000-0000000000d3','L-DD3',null,'New 3',122342,103680,18,'sent','none','[]'::jsonb);
do $$ declare res jsonb; n int; begin
  res := public.accept_quote('Q-DD3');
  select count(*) into n from public.customers where tenant_id='11110000-0000-0000-0000-0000000000d3' and lower(contact_email)='dup3@x.in';
  if n<>1 then raise exception 'FAIL accept-dedup: expected 1 customer (reuse), got %',n; end if;
  if (res->>'customer_id')::uuid <> 'cccccccc-0000-0000-0000-0000000000d3' then raise exception 'FAIL accept-dedup: linked to new customer'; end if;
  raise notice 'PASS accept_quote dedup';
end $$;
rollback;
