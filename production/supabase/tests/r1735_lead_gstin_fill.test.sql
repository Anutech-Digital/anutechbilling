\set ON_ERROR_STOP on
-- R-1735: a prospect's GSTIN (typed on the quote builder → saved on its lead, R-1712) reaches the
-- customer even when accept_quote / record_payment REUSE an existing customer that has none.
-- Migration: 20261025004500_r1735_lead_gstin_fills_blank_customer.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1735_lead_gstin_fill.test.sql
--
-- Expect "PASS r1735_lead_gstin_fill (5/5)".
--   1 accept_quote reuses "Omega Co" (same email + name) with a blank GSTIN → it gets the lead's
--   2 record_payment reuses "Zeta Co" the same way → it gets the lead's; the invoice freezes it
--   3 a customer that already HAS a GSTIN is never overwritten by the lead's
--   4 a lead GSTIN that is not 15 GSTIN-shaped characters is never copied
--   MUTATION  with the trigger disabled, case 1 again leaves the GSTIN blank (the old bug)
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants (id,name,email,state_code,doc_code,gstin) values
  ('11110000-0000-0000-0000-000000001735','GF','gf@x.in','07','GFA1','07AAACG1735A1Z0');
insert into public.document_series (tenant_id,doc_type,fiscal_year,prefix,last_number) values
  ('11110000-0000-0000-0000-000000001735','purchase_order',public.indian_fiscal_year(public.ist_today()),'PO', 9000);
insert into public.customers (id,tenant_id,name,contact_email,gstin,state_code) values
  ('cccccccc-0000-0000-0000-000000001731','11110000-0000-0000-0000-000000001735','Omega Co','owner@omega.in',null,'07'),
  ('cccccccc-0000-0000-0000-000000001732','11110000-0000-0000-0000-000000001735','Zeta Co','acc@zeta.in','  ','07'),
  ('cccccccc-0000-0000-0000-000000001733','11110000-0000-0000-0000-000000001735','Kappa Co','a@kappa.in','07AAACK1111K1Z1','07'),
  ('cccccccc-0000-0000-0000-000000001734','11110000-0000-0000-0000-000000001735','Mu Co','a@mu.in',null,'07'),
  ('cccccccc-0000-0000-0000-000000001736','11110000-0000-0000-0000-000000001735','Nu Co','a@nu.in',null,'07');

insert into public.leads (id,tenant_id,company,contact_email,gstin,stage,source,priority) values
  ('L-GF1','11110000-0000-0000-0000-000000001735','Omega Co Pvt Ltd','OWNER@omega.in','07AAACR5055K1Z9','new','manual','medium'),
  ('L-GF2','11110000-0000-0000-0000-000000001735','Zeta Co','acc@zeta.in','07AAACZ2222Z1Z2','new','manual','medium'),
  ('L-GF3','11110000-0000-0000-0000-000000001735','Kappa Co','a@kappa.in','07AAACK9999K1Z9','new','manual','medium'),
  ('L-GF4','11110000-0000-0000-0000-000000001735','Mu Co','a@mu.in','not-a-gstin','new','manual','medium'),
  ('L-GF5','11110000-0000-0000-0000-000000001735','Nu Co','a@nu.in','07AAACN5555N1Z5','new','manual','medium');

insert into public.quotes (id,tenant_id,lead_id,customer_id,customer_name,amount,subtotal,tax_rate,status,payment_status,line_items,is_one_off) values
  ('Q-GF1','11110000-0000-0000-0000-000000001735','L-GF1',null,'Omega Co',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb,true),
  ('Q-GF2','11110000-0000-0000-0000-000000001735','L-GF2',null,'Zeta Co',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb,true),
  ('Q-GF3','11110000-0000-0000-0000-000000001735','L-GF3',null,'Kappa Co',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb,true),
  ('Q-GF4','11110000-0000-0000-0000-000000001735','L-GF4',null,'Mu Co',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb,true),
  ('Q-GF5','11110000-0000-0000-0000-000000001735','L-GF5',null,'Nu Co',11800,10000,18,'sent','awaiting','[{"name":"Thing","qty":1,"rate":10000}]'::jsonb,true);

do $$ declare g text; cid uuid; begin
  -- 1 accept_quote, reused customer
  perform public.accept_quote('Q-GF1');
  select customer_id into cid from public.quotes where id='Q-GF1';
  if cid is distinct from 'cccccccc-0000-0000-0000-000000001731' then raise exception 'FAIL 1: Omega not reused (got %)', cid; end if;
  select gstin into g from public.customers where id=cid;
  if g is distinct from '07AAACR5055K1Z9' then raise exception 'FAIL 1: reused customer GSTIN = %, want the lead''s', g; end if;

  -- 2 record_payment, reused customer (blank = spaces)
  perform public.record_payment('Q-GF2',11800,'upi','gf2ref');
  select customer_id into cid from public.quotes where id='Q-GF2';
  if cid is distinct from 'cccccccc-0000-0000-0000-000000001732' then raise exception 'FAIL 2: Zeta not reused (got %)', cid; end if;
  select gstin into g from public.customers where id=cid;
  if g is distinct from '07AAACZ2222Z1Z2' then raise exception 'FAIL 2: reused customer GSTIN = %, want the lead''s', g; end if;

  -- 3 never overwrite
  perform public.accept_quote('Q-GF3');
  select gstin into g from public.customers where id='cccccccc-0000-0000-0000-000000001733';
  if g is distinct from '07AAACK1111K1Z1' then raise exception 'FAIL 3: existing GSTIN overwritten (now %)', g; end if;

  -- 4 junk never copied
  perform public.accept_quote('Q-GF4');
  select gstin into g from public.customers where id='cccccccc-0000-0000-0000-000000001734';
  if g is not null then raise exception 'FAIL 4: junk lead GSTIN copied (%)', g; end if;
end $$;

-- MUTATION: the old behaviour (no trigger) must fail case 1's check.
alter table public.quotes disable trigger quotes_fill_customer_gstin_from_lead;
do $$ declare g text; begin
  perform public.accept_quote('Q-GF5');
  select gstin into g from public.customers where id='cccccccc-0000-0000-0000-000000001736';
  if g is not null then raise exception 'FAIL MUTATION: without the trigger the GSTIN still arrived — the test proves nothing'; end if;
  raise notice 'PASS r1735_lead_gstin_fill (5/5)';
end $$;
rollback;
