\set ON_ERROR_STOP on
-- R-2424 (p0 money): an all-zero bank reference ("000000000000000") is not a UTR.
-- Migration: 20261103144041_r2424_placeholder_bank_ref (bank_reference_is_real,
-- payment_ref_key redefined; trg_payments_ref_once / assert_payment_ref_unused read it).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2424_placeholder_bank_ref.test.sql
--
-- Expect "PASS r2424_placeholder_bank_ref". RED without the migration (ZEROS 2 is refused).
--
--   RULE     bank_reference_is_real / payment_ref_key on the same cases as bank-reference.test.ts
--   ZEROS    two DIFFERENT customers' credits, both with reference 000000000000000 → both book
--            (the staging case: ₹68,676 first, then ₹2,88,982)
--   ZEROS 3  the same through a direct insert (as the bank-reconcile RPCs write) and hyphenated zeros
--   REAL     a real UTR repeated on another customer's invoice → still refused, naming the receipt

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2424000-0000-4000-8000-0000000000a2', 'r2424-billing@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2424000-0000-0000-0000-0000000000a0', 'R2424 A', 'r2424a@example.in', '07', 'R24A');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2424000-0000-4000-8000-0000000000a2', 'e2424000-0000-0000-0000-0000000000a0', 'r2424-billing@example.in', 'R2424 Billing', 'billing', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2424000-0000-4000-8000-0000000000c1', 'e2424000-0000-0000-0000-0000000000a0', 'R2424 Cust One', '07', 'India'),
  ('e2424000-0000-4000-8000-0000000000c2', 'e2424000-0000-0000-0000-0000000000a0', 'R2424 Cust Two', '07', 'India');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
select v.id, 'e2424000-0000-0000-0000-0000000000a0'::uuid, 'R2424', v.c::uuid, v.amt, v.amt, v.tx, v.d::date, null
  from (values
    ('R24-I1', 'e2424000-0000-4000-8000-0000000000c1', 68676,  58200,  '2026-05-01'),
    ('R24-I2', 'e2424000-0000-4000-8000-0000000000c2', 288982, 244900, '2026-05-02'),
    ('R24-I3', 'e2424000-0000-4000-8000-0000000000c1', 1180,   1000,   '2026-05-03'),
    ('R24-I4', 'e2424000-0000-4000-8000-0000000000c2', 1180,   1000,   '2026-05-04'),
    ('R24-I5', 'e2424000-0000-4000-8000-0000000000c1', 1180,   1000,   '2026-05-05'),
    ('R24-I6', 'e2424000-0000-4000-8000-0000000000c2', 1180,   1000,   '2026-05-06')
  ) v(id, c, amt, tx, d);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-' || i.id, i.tenant_id, null, i.customer_id, 'R2424', i.amount, i.taxable_value, 18, 'accepted', 'invoiced', '[]'::jsonb, i.id
  from public.invoices i where i.id like 'R24-%';
update public.invoices set quote_id = 'Q-' || id where id like 'R24-%';

create temp table r2424_fail (msg text) on commit drop;
grant all on r2424_fail to authenticated;

-- record_payment as the current claims; null on success, else 'SQLSTATE: message'.
create function pg_temp.r2424_pay(p_quote text, p_amount integer, p_method text, p_ref text) returns text language plpgsql as $$
begin
  perform public.record_payment(p_quote, p_amount, p_method, p_ref, null);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r2424_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r2424_pay(text, integer, text, text) to authenticated;
grant execute on function pg_temp.r2424_as(text) to authenticated;

-- ════ RULE: same cases as src/lib/payments/bank-reference.test.ts ══════════════════════
do $$
declare v_ref text;
begin
  foreach v_ref in array array['', '   ', '000000000000000', '0000-0000-0000', '000000', '111111111111', 'XXXXXXXX', 'NA', '-', '0', 'N/A', 'NIL', 'x x x x x x'] loop
    if public.bank_reference_is_real(v_ref) then insert into r2424_fail values ('placeholder seen as real: ' || quote_literal(v_ref)); end if;
    if public.payment_ref_key('bank_transfer', v_ref) is not null then insert into r2424_fail values ('placeholder got a key: ' || quote_literal(v_ref)); end if;
  end loop;
  if public.bank_reference_is_real(null) then insert into r2424_fail values ('null seen as real'); end if;
  foreach v_ref in array array['TESTUTR123456', '162440272175', '0000162440272175', 'HDFCN52026051912345678', '  testutr 1234-56 ', '100000'] loop
    if not public.bank_reference_is_real(v_ref) then insert into r2424_fail values ('real ref seen as placeholder: ' || quote_literal(v_ref)); end if;
  end loop;
  if public.payment_ref_key('upi', '  testutr 1234-56 ') is distinct from 'BANK:TESTUTR123456' then
    insert into r2424_fail values ('real UTR key changed: ' || coalesce(public.payment_ref_key('upi', '  testutr 1234-56 '), 'null'));
  end if;
  if public.payment_ref_key('bank_transfer', '0000162440272175') is distinct from 'BANK:0000162440272175' then
    insert into r2424_fail values ('leading-zero UTR key changed');
  end if;
  if public.payment_ref_key('cheque', 'TESTUTR123456') is not null then insert into r2424_fail values ('cheque got a key'); end if;
end $$;

do $$
declare
  v_e text; v_n int;
begin
  set local role authenticated;
  perform pg_temp.r2424_as('e2424000-0000-4000-8000-0000000000a2');

  -- ════ ZEROS: the staging case ══════════════════════════════════════════════════════
  v_e := pg_temp.r2424_pay('Q-R24-I1', 68676, 'bank_transfer', '000000000000000');
  if v_e is not null then insert into r2424_fail values ('zero-ref credit 1 (₹68,676) refused: ' || v_e); end if;
  v_e := pg_temp.r2424_pay('Q-R24-I2', 288982, 'bank_transfer', '000000000000000');
  if v_e is not null then insert into r2424_fail values ('zero-ref credit 2 (₹2,88,982, another customer) refused: ' || v_e); end if;
  v_e := pg_temp.r2424_pay('Q-R24-I3', 1180, 'upi', '0000-0000-0000');
  if v_e is not null then insert into r2424_fail values ('hyphenated zero ref refused: ' || v_e); end if;

  -- ════ REAL: a real UTR is still recorded once ══════════════════════════════════════
  v_e := pg_temp.r2424_pay('Q-R24-I4', 1180, 'bank_transfer', 'R2424UTR778899');
  if v_e is not null then insert into r2424_fail values ('first real UTR refused: ' || v_e); end if;
  v_e := pg_temp.r2424_pay('Q-R24-I5', 1180, 'bank_transfer', 'r2424utr 778899');
  if v_e is null or v_e not like 'P0001: Ye UTR pehle se R24-I4 par hai — reference r2424utr 778899 is already recorded (R2424 Cust Two, ₹1180, %' then
    insert into r2424_fail values ('repeated real UTR not refused / wrong message: ' || coalesce(v_e, 'ran'));
  end if;

  set local role postgres;

  -- ════ ZEROS 3: a direct write, as the bank-reconcile RPCs insert payments ═══════════
  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, status)
    values ('e2424000-0000-0000-0000-0000000000a0', 'Q-R24-I6', 'e2424000-0000-4000-8000-0000000000c2', 1180, 'bank_transfer', '000000000000000', 'received');
  exception when others then
    insert into r2424_fail values ('direct zero-ref insert refused: ' || sqlerrm);
  end;

  select count(*) into v_n from public.payments
   where tenant_id = 'e2424000-0000-0000-0000-0000000000a0' and reference = '000000000000000' and status = 'received';
  if v_n <> 3 then insert into r2424_fail values ('expected 3 zero-ref receipts, found ' || v_n); end if;
  select count(*) into v_n from public.payments
   where tenant_id = 'e2424000-0000-0000-0000-0000000000a0' and upper(replace(reference, ' ', '')) = 'R2424UTR778899';
  if v_n <> 1 then insert into r2424_fail values ('real UTR should be held once, held ' || v_n); end if;

  -- zero refs are not listed as duplicates
  set local role authenticated;
  if exists (select 1 from public.payment_reference_duplicates() d where d.reference_key like '%000000%') then
    insert into r2424_fail values ('zero refs listed by payment_reference_duplicates()');
  end if;
  set local role postgres;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2424_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2424_placeholder_bank_ref:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2424_placeholder_bank_ref';
end $$;

rollback;
